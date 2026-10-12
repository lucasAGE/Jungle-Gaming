import { assertAccountingConsistent } from "./accounting-audit.js";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  deadline, resetTestDatabase, startApplication, stop,
  type Application, type Child, type LedgerResponse, type Orm, type WalletResponse,
} from "./helpers.js";

const integration = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
type Balance = WalletResponse["balance"];
interface BetInput {
  providerId: string; externalTransactionId: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: "BET"; money: Balance;
}
interface BetResponse {
  transactionId: string; status: "PROCESSED" | "REJECTED"; balance: Balance;
  idempotentReplay: boolean; failureCode?: string;
}

integration("idempotent HTTP BET with real PostgreSQL and three application processes", () => {
  let orm: Orm;
  const children: Child[] = [];
  const applications: Application[] = [];

  function app(index = 0): Application {
    const application = applications[index];
    if (!application) throw new Error(`Application ${index} is unavailable`);
    return application;
  }

  async function rows<T = Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    return orm.em.getConnection().execute<T[]>(sql, parameters);
  }

  async function request(path: string, body?: unknown, instance = 0, key?: string): Promise<Response> {
    return fetch(`${app(instance).url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(key === undefined ? {} : { "Idempotency-Key": key }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
  }

  async function wallet(amount = "100.00", instance = 0): Promise<WalletResponse> {
    const response = await request("/wallets", {
      playerId: crypto.randomUUID(), initialBalance: { amount, currency: "BRL" },
    }, instance);
    expect(response.status).toBe(201);
    return response.json() as Promise<WalletResponse>;
  }

  function betInput(target: WalletResponse, amount = "25.00"): BetInput {
    return { providerId: "provider-a", externalTransactionId: crypto.randomUUID(),
      playerId: target.playerId, walletId: target.id, roundId: crypto.randomUUID(),
      gameId: "fortune-chimp", kind: "BET", money: { amount, currency: "BRL" } };
  }

  function submit(input: BetInput, instance = 0, key = `${input.providerId}:${input.externalTransactionId}`) {
    return request("/wagering/transactions", input, instance, key);
  }

  async function readWallet(walletId: string): Promise<WalletResponse> {
    const response = await request(`/wallets/${walletId}`);
    expect(response.status).toBe(200);
    return response.json() as Promise<WalletResponse>;
  }

  async function assertReconciled(walletId: string): Promise<void> {
    const [result] = await rows<{ balance: string; calculated: string }>(`
      select w.balance::text as balance,
        coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as calculated
      from wallets w left join wallet_ledger l on l.wallet_id = w.id
      where w.id = ? group by w.id
    `, [walletId]);
    expect(result).toBeDefined();
    expect(result!.balance).toBe(result!.calculated);
  }

  async function snapshot(walletId: string) {
    return {
      wallet: await rows("select * from wallets where id = ?", [walletId]),
      transactions: await rows("select * from wager_transactions where wallet_id = ? order by id", [walletId]),
      ledger: await rows("select * from wallet_ledger where wallet_id = ? order by id", [walletId]),
      outbox: await rows("select * from outbox_messages where aggregate_id = ? order by id", [walletId]),
    };
  }

  beforeAll(async () => {
    orm = await resetTestDatabase();
    for (let index = 0; index < 3; index++) applications.push(await startApplication(children));
  }, 60_000);

  afterAll(async () => {
    await Promise.all(children.map(stop));
    if (orm) { try { await assertAccountingConsistent(orm); } finally { await orm.close(true); } }
  });

  test("migration 002 round trip preserves existing opening records and events", async () => {
    expect(new Set(applications.map(({ child }) => child.pid)).size).toBe(3);
    const target = await wallet("123.45");
    const before = await snapshot(target.id);
    await orm.getMigrator().down({ to: "Migration202610100002" });
    await orm.getMigrator().up();
    expect(await snapshot(target.id)).toEqual(before);
    await assertReconciled(target.id);
  });

  test("a processed BET persists one exact debit and two unpublished event envelopes", async () => {
    const target = await wallet();
    const input = betInput(target);
    const response = await submit(input);
    expect(response.status).toBe(200);
    const result = await response.json() as BetResponse;
    expect(result).toEqual({ transactionId: expect.any(String), status: "PROCESSED",
      balance: { amount: "75.00", currency: "BRL" }, idempotentReplay: false });
    expect(await readWallet(target.id)).toMatchObject({ balance: result.balance, version: 2 });
    const records = await rows("select * from wager_transactions where id = ?", [result.transactionId]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "BET", status: "PROCESSED", amount: "25.00",
      provider_id: input.providerId, external_transaction_id: input.externalTransactionId, result_balance: "75.00" });
    expect(await rows("select * from wallet_ledger where transaction_id = ?", [result.transactionId])).toEqual([
      expect.objectContaining({ direction: "DEBIT", amount: "25.00", balance_before: "100.00", balance_after: "75.00" }),
    ]);
    const events = await rows<{ id: string; event_type: string; payload: Record<string, unknown>; published_at: null }>(
      "select * from outbox_messages where payload->'data'->>'transactionId' = ? order by event_type", [result.transactionId]);
    expect(events.map((event) => event.event_type)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    for (const event of events) {
      expect(event.published_at).toBeNull();
      expect(event.payload).toMatchObject({ eventId: event.id, eventType: event.event_type,
        aggregateId: target.id, version: 1, correlationId: expect.any(String), occurredAt: expect.any(String),
        data: { transactionId: result.transactionId, walletId: target.id } });
    }
    await assertReconciled(target.id);
  });

  test("exact precision is preserved when a cent is debited beyond JavaScript numeric precision", async () => {
    const target = await wallet("999999999999999999.99");
    const response = await submit(betInput(target, "0.01"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ balance: { amount: "999999999999999999.98", currency: "BRL" } });
    await assertReconciled(target.id);
  });

  test("50 parallel deliveries across three processes commit exactly one debit", async () => {
    const target = await wallet();
    const input = betInput(target);
    const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => submit(input, index % 3)));
    const results = await Promise.all(responses.map((response) => response.json() as Promise<BetResponse>));
    expect(responses.flatMap((response, index) => response.status === 200
      ? [] : [{ status: response.status, body: results[index] }])).toEqual([]);
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(results.filter((result) => result.idempotentReplay)).toHaveLength(49);
    for (const result of results) expect(result.balance).toEqual({ amount: "75.00", currency: "BRL" });
    expect(await rows("select id from wager_transactions where wallet_id = ? and kind = 'BET'", [target.id])).toHaveLength(1);
    expect(await rows("select id from wallet_ledger where wallet_id = ? and direction = 'DEBIT'", [target.id])).toHaveLength(1);
    expect(await rows("select id from outbox_messages where aggregate_id = ?", [target.id])).toHaveLength(4);
    expect(await readWallet(target.id)).toMatchObject({ balance: { amount: "75.00" }, version: 2 });
    await assertReconciled(target.id);
  }, 30_000);

  test("two simultaneous bets of 80 against 100 process once and reject once without retry effects", async () => {
    const target = await wallet();
    const inputs = [betInput(target, "80.00"), betInput(target, "80.00")];
    const responses = await Promise.all(inputs.map((input, index) => submit(input, index)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
    const results = await Promise.all(responses.map((response) => response.json() as Promise<BetResponse>));
    expect(results.map((result) => result.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
    expect(results.find((result) => result.status === "REJECTED")).toMatchObject({ failureCode: "INSUFFICIENT_FUNDS" });
    for (const result of results) expect(result.balance).toEqual({ amount: "20.00", currency: "BRL" });
    const beforeRetry = await snapshot(target.id);
    for (const [index, input] of inputs.entries()) {
      const replay = await submit(input, 2);
      expect(replay.status).toBe(responses[index]!.status);
      expect(await replay.json()).toEqual({ ...results[index], idempotentReplay: true });
    }
    expect(await snapshot(target.id)).toEqual(beforeRetry);
    expect(await readWallet(target.id)).toMatchObject({ balance: { amount: "20.00" }, version: 2 });
    expect(await rows("select id from wallet_ledger where wallet_id = ? and direction = 'DEBIT'", [target.id])).toHaveLength(1);
    expect(await rows("select event_type from outbox_messages where aggregate_id = ? order by event_type", [target.id])).toEqual([
      { event_type: "WagerTransactionProcessed" }, { event_type: "WagerTransactionProcessed" },
      { event_type: "WagerTransactionRejected" }, { event_type: "WalletBalanceChanged" }, { event_type: "WalletBalanceChanged" },
    ]);
    await assertReconciled(target.id);
  });

  test("processed and rejected replays retain the original balance after later bets", async () => {
    const target = await wallet();
    const inputs = [betInput(target, "200.00"), betInput(target, "25.00")];
    const responses = await Promise.all(inputs.map((input) => submit(input)));
    const originals = await Promise.all(responses.map((response) => response.json() as Promise<BetResponse>));
    expect(originals[0]).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
    expect(originals[1]).toMatchObject({ status: "PROCESSED", balance: { amount: "75.00" } });
    expect((await submit(betInput(target, "5.00"), 1)).status).toBe(200);
    for (const [index, input] of inputs.entries()) {
      const replay = await submit(input, 2);
      expect(replay.status).toBe(responses[index]!.status);
      expect(await replay.json()).toEqual({ ...originals[index], idempotentReplay: true });
    }
    expect((await readWallet(target.id)).balance.amount).toBe("70.00");
    await assertReconciled(target.id);
  });

  test("business JSON key ordering does not change the idempotency hash", async () => {
    const target = await wallet();
    const input = betInput(target);
    const response = await submit(input);
    const result = await response.json() as BetResponse;
    const reordered = { money: { currency: "BRL", amount: "25.00" }, kind: input.kind,
      gameId: input.gameId, roundId: input.roundId, walletId: input.walletId, playerId: input.playerId,
      externalTransactionId: input.externalTransactionId, providerId: input.providerId };
    const replay = await request("/wagering/transactions", reordered, 1, `${input.providerId}:${input.externalTransactionId}`);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...result, idempotentReplay: true });
    await assertReconciled(target.id);
  });

  test("concurrent conflicting keys on different wallets roll back the losing debit", async () => {
    const targets = await Promise.all([wallet(), wallet()]);
    const key = `shared:${crypto.randomUUID()}`;
    const responses = await Promise.all(targets.map((target, index) => submit(betInput(target), index, key)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await responses.find((response) => response.status === 409)!.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await rows("select id from wager_transactions where idempotency_key = ?", [key])).toHaveLength(1);
    const balances = await Promise.all(targets.map(async (target) => (await readWallet(target.id)).balance.amount));
    expect(balances.sort()).toEqual(["100.00", "75.00"]);
    await Promise.all(targets.map((target) => assertReconciled(target.id)));
  });

  test("one provider external ID cannot charge twice under different concurrent keys", async () => {
    const target = await wallet();
    const input = betInput(target);
    const responses = await Promise.all([submit(input, 0, crypto.randomUUID()), submit(input, 1, crypto.randomUUID())]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await responses.find((response) => response.status === 409)!.json()).toMatchObject({ code: "EXTERNAL_TRANSACTION_CONFLICT" });
    expect(await rows("select id from wager_transactions where provider_id = ? and external_transaction_id = ?", [input.providerId, input.externalTransactionId])).toHaveLength(1);
    expect(await readWallet(target.id)).toMatchObject({ balance: { amount: "75.00" }, version: 2 });
    await assertReconciled(target.id);
  });

  test("different providers may use the same external ID", async () => {
    const target = await wallet();
    const input = betInput(target);
    const responses = await Promise.all([submit(input), submit({ ...input, providerId: "provider-b" }, 1)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect((await readWallet(target.id)).balance.amount).toBe("50.00");
    await assertReconciled(target.id);
  });

  test("independent wallets process in parallel across all three processes", async () => {
    const targets = await Promise.all(Array.from({ length: 12 }, (_, index) => wallet("12.34", index % 3)));
    const responses = await Promise.all(targets.map((target, index) => submit(betInput(target, "2.34"), index % 3)));
    expect(responses.map((response) => response.status)).toEqual(Array(12).fill(200));
    for (const target of targets) {
      expect((await readWallet(target.id)).balance.amount).toBe("10.00");
      await assertReconciled(target.id);
    }
  });

  test("a locked wallet does not block processing another wallet", async () => {
    const locked = await wallet();
    const independent = await wallet();
    let release: () => void = () => {};
    let acquired: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const holder = orm.em.fork().transactional(async (em) => {
      await em.execute("select id from wallets where id = ? for update", [locked.id]);
      acquired();
      await held;
    });
    let blocked: Promise<Response> | undefined;
    try {
      await deadline(ready, 5_000, "Test wallet lock was not acquired");
      blocked = submit(betInput(locked), 0);
      await (async () => {
        for (let attempt = 0; attempt < 500; attempt++) {
          const waiting = await rows("select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
          if (waiting.length > 0) return;
          await Bun.sleep(10);
        }
        throw new Error("The first application did not wait on its wallet lock");
      })();
      expect((await deadline(submit(betInput(independent), 1), 5_000, "Another wallet was blocked")).status).toBe(200);
    } finally {
      release();
      await holder;
    }
    expect((await blocked!).status).toBe(200);
    await assertReconciled(locked.id);
    await assertReconciled(independent.id);
  }, 20_000);

  test("an outbox insertion failure rolls back processed and rejected decisions, then permits retry", async () => {
    const target = await wallet();
    const inputs = [betInput(target), betInput(target, "200.00")];
    const before = await snapshot(target.id);
    await rows("create function test_reject_bet_outbox() returns trigger language plpgsql as $$ begin raise exception 'injected outbox failure'; end $$");
    await rows("create trigger test_bet_outbox_failure before insert on outbox_messages for each row execute function test_reject_bet_outbox()");
    try {
      for (const input of inputs) {
        expect((await submit(input)).status).toBe(503);
        expect(await snapshot(target.id)).toEqual(before);
      }
    } finally {
      await rows("drop trigger test_bet_outbox_failure on outbox_messages");
      await rows("drop function test_reject_bet_outbox()");
    }
    for (const [index, input] of inputs.entries()) {
      const retry = await submit(input, 2);
      expect(retry.status).toBe(index === 0 ? 200 : 422);
      expect(await retry.json()).toMatchObject({ idempotentReplay: false, balance: { amount: "75.00" } });
    }
    await assertReconciled(target.id);
  });

  test("an unconsumed response followed by SIGKILL replays the committed historical result after restart", async () => {
    const target = await wallet();
    const input = betInput(target);
    const response = await submit(input);
    expect(response.status).toBe(200);
    // Discard the response body: the caller has no transaction result to trust when it retries.
    await response.body?.cancel();
    const [committed] = await rows<{ id: string }>("select id from wager_transactions where provider_id = ? and external_transaction_id = ?", [input.providerId, input.externalTransactionId]);
    expect(committed).toBeDefined();
    const before = await snapshot(target.id);
    app().child.kill("SIGKILL");
    await deadline(app().child.exited, 5_000, "Application did not exit after SIGKILL");
    applications[0] = await startApplication(children);
    expect(await snapshot(target.id)).toEqual(before);
    expect((await submit(betInput(target, "5.00"), 1)).status).toBe(200);
    const retry = await submit(input);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ transactionId: committed!.id, status: "PROCESSED",
      balance: { amount: "75.00", currency: "BRL" }, idempotentReplay: true });
    expect((await readWallet(target.id)).balance.amount).toBe("70.00");
    expect(await rows("select id from outbox_messages where payload->'data'->>'transactionId' = ?", [committed!.id])).toHaveLength(2);
    await assertReconciled(target.id);
  });

  test("queries by internal and provider IDs return identical historical processed and rejected records", async () => {
    const target = await wallet();
    for (const amount of ["25.00", "200.00"]) {
      const input = betInput(target, amount);
      const result = await (await submit(input)).json() as BetResponse;
      const internal = await request(`/wagering/transactions/${result.transactionId}`);
      const external = await request(`/providers/${input.providerId}/wagering/transactions/${input.externalTransactionId}`, undefined, 1);
      expect(internal.status).toBe(200);
      expect(external.status).toBe(200);
      const record = await internal.json();
      expect(await external.json()).toEqual(record);
      expect(record).toMatchObject({ transactionId: result.transactionId, ...input, status: result.status,
        balance: result.balance, createdAt: expect.any(String),
        processedAt: result.status === "PROCESSED" ? expect.any(String) : null });
      if (result.failureCode) expect(record).toMatchObject({ failureCode: result.failureCode });
    }
    expect((await request(`/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await request(`/providers/missing/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await request("/wagering/transactions/not-a-uuid")).status).toBe(400);
    await assertReconciled(target.id);
  });

  test("HTTP rejects invalid business inputs, unsupported operations and transport keys without persistence", async () => {
    const target = await wallet();
    const input = betInput(target);
    const before = await snapshot(target.id);
    for (const body of [null, [], {}, { ...input, providerId: "" }, { ...input, walletId: "bad-id" },
      { ...input, kind: "OPENING" },
      ...["0.00", "-1.00", "1.001", "1e2", 25].map((amount) => ({ ...input, money: { amount, currency: "BRL" } })),
      { ...input, money: { amount: "25.00", currency: "USD" } }, { ...input, playerId: crypto.randomUUID() }]) {
      expect((await request("/wagering/transactions", body, 0, crypto.randomUUID())).status).toBe(400);
    }
    expect((await request("/wagering/transactions", input)).status).toBe(400);
    expect((await request("/wagering/transactions", input, 0, "opening:reserved")).status).toBe(400);
    expect((await submit({ ...input, walletId: crypto.randomUUID() })).status).toBe(404);
    expect(await snapshot(target.id)).toEqual(before);
    await assertReconciled(target.id);
  });

  test("the database protects terminal outcomes and prohibits ledger entries for rejected bets", async () => {
    const target = await wallet();
    const rejected = await (await submit(betInput(target, "200.00"))).json() as BetResponse;
    const processed = await (await submit(betInput(target))).json() as BetResponse;
    const before = await snapshot(target.id);
    for (const transactionId of [processed.transactionId, rejected.transactionId]) {
      await expect(rows("update wager_transactions set status = 'PROCESSED' where id = ?", [transactionId])).rejects.toThrow();
      await expect(rows("update wager_transactions set result_balance = '0.00' where id = ?", [transactionId])).rejects.toThrow();
      await expect(rows("delete from wager_transactions where id = ?", [transactionId])).rejects.toThrow();
    }
    await expect(rows("truncate wager_transactions cascade")).rejects.toThrow();
    await expect(rows(`insert into wallet_ledger
      (id, wallet_id, transaction_id, direction, currency, amount, balance_before, balance_after, created_at)
      select ?, wallet_id, id, 'DEBIT', currency, amount, '200.00', '0.00', now()
      from wager_transactions where id = ?`, [crypto.randomUUID(), rejected.transactionId])).rejects.toThrow();
    expect(await snapshot(target.id)).toEqual(before);
    await assertReconciled(target.id);
  });

  test("database uniqueness independently blocks duplicate provider IDs and idempotency keys", async () => {
    const target = await wallet();
    const original = await (await submit(betInput(target))).json() as BetResponse;
    for (const replaceKey of [false, true]) {
      await expect(rows(`insert into wager_transactions
        (id, wallet_id, player_id, currency, amount, idempotency_key, kind, status, created_at, processed_at,
          provider_id, external_transaction_id, round_id, game_id, payload_hash, result_balance, failure_code)
        select ?, wallet_id, player_id, currency, amount, ${replaceKey ? "?" : "idempotency_key"}, kind, status,
          created_at, processed_at, provider_id, ${replaceKey ? "external_transaction_id" : "?"}, round_id, game_id, payload_hash, result_balance, failure_code
        from wager_transactions where id = ?`, [crypto.randomUUID(), crypto.randomUUID(), original.transactionId]))
        .rejects.toThrow(replaceKey ? "wager_transactions_provider_external_unique" : "wager_transactions_idempotency_unique");
    }
    expect(await rows("select id from wager_transactions where wallet_id = ? and kind = 'BET'", [target.id])).toHaveLength(1);
    await assertReconciled(target.id);
  });

  test("stable ledger pagination handles timestamp ties and a later append without duplicates", async () => {
    // Force legal timestamp ties at insertion; immutable ledger entries are never edited for a fixture.
    await rows("create function test_tie_ledger_time() returns trigger language plpgsql as $$ begin new.created_at = '2026-01-01T00:00:00Z'; return new; end $$");
    await rows("create trigger test_ledger_time before insert on wallet_ledger for each row execute function test_tie_ledger_time()");
    // Apply the same fixture timestamp before the journal validates its ledger identity.
    await rows("create trigger aaa_test_accounting_time before insert on accounting_journal for each row execute function test_tie_ledger_time()");
    let target: WalletResponse;
    try {
      target = await wallet();
      for (let index = 0; index < 5; index++) expect((await submit(betInput(target, "1.00"), index % 3)).status).toBe(200);
    } finally {
      await rows("drop trigger test_ledger_time on wallet_ledger");
      await rows("drop trigger aaa_test_accounting_time on accounting_journal");
      await rows("drop function test_tie_ledger_time()");
    }
    const first = await (await request(`/wallets/${target!.id}/ledger?limit=2`)).json() as LedgerResponse;
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeString();
    expect((await submit(betInput(target!, "1.00"), 2)).status).toBe(200);
    const entries = [...first.items];
    let cursor = first.nextCursor;
    let pageCount = 1;
    while (cursor !== null) {
      expect(pageCount++).toBeLessThan(10);
      const page = await (await request(`/wallets/${target!.id}/ledger?limit=2&cursor=${cursor}`)).json() as LedgerResponse;
      entries.push(...page.items);
      cursor = page.nextCursor;
    }
    const expected = await rows<{ id: string }>("select id from wallet_ledger where wallet_id = ? order by created_at, id", [target!.id]);
    expect(entries.map((entry) => entry.id)).toEqual(expected.map((entry) => entry.id));
    expect(entries).toHaveLength(7);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(7);
    expect(new Set(entries.slice(0, 6).map((entry) => entry.createdAt)).size).toBe(1);
    await assertReconciled(target!.id);
  });

  test("migration rollback refuses to remove BET history and changes no records", async () => {
    const target = await wallet();
    expect((await submit(betInput(target))).status).toBe(200);
    const before = await snapshot(target.id);
    await expect(orm.getMigrator().down({ to: "Migration202610100002" })).rejects.toThrow();
    expect(await snapshot(target.id)).toEqual(before);
    expect(await orm.getMigrator().getPendingMigrations()).toHaveLength(0);
    await assertReconciled(target.id);
  });

  test("every final wallet balance equals the exact sum reconstructed from its ledger", async () => {
    expect(await rows(`
      select w.id from wallets w left join wallet_ledger l on l.wallet_id = w.id
      group by w.id
      having w.balance <> coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)
    `)).toEqual([]);
  });
});
