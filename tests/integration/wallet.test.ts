import { assertAccountingConsistent } from "./accounting-audit.js";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encodeLedgerCursor } from "../../src/application/ledger-cursor.js";
import { WalletSchema } from "../../src/infrastructure/database/entities.js";
import { deadline, resetTestDatabase, startApplication, stop, type Application, type Child, type LedgerResponse, type Orm, type WalletResponse } from "./helpers.js";

const integration = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;

integration("wallet opening with real PostgreSQL and three application processes", () => {
  let orm: Orm;
  const applications: Application[] = [];
  const children: Child[] = [];
  let migrationRoundTripVerified = false;

  async function rows<T = Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    return orm.em.getConnection().execute<T[]>(sql, parameters);
  }

  function app(index = 0): Application {
    const application = applications[index];
    if (!application) throw new Error(`Application ${index} is unavailable`);
    return application;
  }

  async function request(path: string, body?: unknown, instance = 0): Promise<Response> {
    return fetch(`${app(instance).url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  function opening(amount = "100.00", playerId = crypto.randomUUID()) {
    return { playerId, initialBalance: { amount, currency: "BRL" } };
  }

  async function create(amount = "100.00", instance = 0): Promise<WalletResponse> {
    const response = await request("/wallets", opening(amount), instance);
    expect(response.status).toBe(201);
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

  beforeAll(async () => {
    orm = await resetTestDatabase();
    expect((await rows("select id from wallets"))).toHaveLength(0);
    await orm.getMigrator().down({ to: 0 });
    const [absent] = await rows<{ relation: string | null }>("select to_regclass('public.wallets')::text as relation");
    expect(absent!.relation).toBeNull();
    await orm.getMigrator().up();
    migrationRoundTripVerified = true;
    // Sequential startup still produces three independent, simultaneously running OS processes.
    for (let index = 0; index < 3; index++) applications.push(await startApplication(children));
  }, 60_000);

  afterAll(async () => {
    await Promise.all(children.map(stop));
    if (orm) { try { await assertAccountingConsistent(orm); } finally { await orm.close(true); } }
  });

  test("versioned migrations go up, down and up again", () => {
    expect(migrationRoundTripVerified).toBe(true);
    expect(new Set(applications.map(({ child }) => child.pid)).size).toBe(3);
  });

  test.each(["0.01", "100.00", "999999999999999999.99"])(
    "persists exact opening %s, one credit and two complete unpublished events", async (amount) => {
      const wallet = await create(amount);
      expect(wallet.balance).toEqual({ amount, currency: "BRL" });
      expect(wallet.version).toBe(1);
      const read = await request(`/wallets/${wallet.id}`, undefined, 1);
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual(wallet);
      const ledger = await (await request(`/wallets/${wallet.id}/ledger`)).json() as LedgerResponse;
      expect(ledger.items).toHaveLength(1);
      expect(ledger.nextCursor).toBeNull();
      const entry = ledger.items[0]!;
      expect(entry).toMatchObject({ walletId: wallet.id, direction: "CREDIT", money: wallet.balance,
        balanceBefore: { amount: "0.00", currency: "BRL" }, balanceAfter: wallet.balance });
      expect(new Date(entry.createdAt).toISOString()).toBe(entry.createdAt);
      const transactions = await rows("select * from wager_transactions where wallet_id = ?", [wallet.id]);
      expect(transactions).toHaveLength(1);
      expect(transactions[0]).toMatchObject({ id: entry.transactionId, kind: "OPENING", status: "PROCESSED" });
      const events = await rows<{ id: string; event_type: string; payload: Record<string, unknown>; published_at: null }>(
        "select * from outbox_messages where aggregate_id = ? order by event_type", [wallet.id]);
      expect(events.map((event) => event.event_type).sort()).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
      for (const event of events) {
        expect(event.published_at).toBeNull();
        expect(event.payload).toMatchObject({ eventId: event.id, eventType: event.event_type,
          aggregateId: wallet.id, version: 1 });
        expect(typeof event.payload.correlationId).toBe("string");
        expect(typeof event.payload.occurredAt).toBe("string");
        expect(event.payload.data).toMatchObject({ walletId: wallet.id, transactionId: entry.transactionId });
      }
      const changed = events.find((event) => event.event_type === "WalletBalanceChanged")!;
      expect(changed.payload.data).toMatchObject({ direction: "CREDIT", money: wallet.balance,
        balanceBefore: { amount: "0.00", currency: "BRL" }, balanceAfter: wallet.balance, walletVersion: 1 });
      const processed = events.find((event) => event.event_type === "WagerTransactionProcessed")!;
      expect(processed.payload.data).toEqual({ walletId: wallet.id, transactionId: entry.transactionId,
        playerId: wallet.playerId, kind: "OPENING", status: "PROCESSED", money: wallet.balance,
        balance: wallet.balance, walletVersion: 1 });
      await assertReconciled(wallet.id);
    },
  );

  test("zero opening has version one and no financial records or events", async () => {
    const wallet = await create("0.00");
    expect(wallet.balance.amount).toBe("0.00");
    expect(wallet.version).toBe(1);
    expect(await rows("select id from wager_transactions where wallet_id = ?", [wallet.id])).toHaveLength(0);
    expect(await rows("select id from wallet_ledger where wallet_id = ?", [wallet.id])).toHaveLength(0);
    expect(await rows("select id from outbox_messages where aggregate_id = ?", [wallet.id])).toHaveLength(0);
    expect(await (await request(`/wallets/${wallet.id}/ledger`)).json()).toEqual({ items: [], nextCursor: null });
    await assertReconciled(wallet.id);
  });

  test("ORM hydration and dirty checking preserve a cent above JavaScript numeric precision", async () => {
    const wallet = await create("999999999999999999.99");
    const em = orm.em.fork();
    await em.begin();
    try {
      const record = await em.findOneOrFail(WalletSchema, { id: wallet.id });
      expect(record.balance).toBe("999999999999999999.99");
      record.balance = "999999999999999999.98";
      await em.flush();
      em.clear();
      const persisted = await em.findOneOrFail(WalletSchema, { id: wallet.id });
      expect(persisted.balance).toBe("999999999999999999.98");
    } finally {
      // Exercise the mapping without committing a balance edit outside the financial use case.
      await em.rollback();
    }
    await assertReconciled(wallet.id);
  });

  test("duplicate creation conflicts even when the balance changes", async () => {
    const body = opening();
    const first = await request("/wallets", body);
    expect(first.status).toBe(201);
    const wallet = await first.json() as WalletResponse;
    for (const amount of ["100.00", "200.00"]) {
      const duplicate = await request("/wallets", opening(amount, body.playerId), 1);
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ code: "WALLET_ALREADY_EXISTS" });
    }
    expect((await (await request(`/wallets/${wallet.id}`)).json() as WalletResponse).balance.amount).toBe("100.00");
    await assertReconciled(wallet.id);
  });

  test("50 simultaneous duplicate creations across three processes commit exactly one opening", async () => {
    const body = opening("100.00");
    const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => request("/wallets", body, index % 3)));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(49);
    const wallet = await responses.find((response) => response.status === 201)!.json() as WalletResponse;
    expect(await rows("select id from wallets where player_id = ?", [body.playerId])).toHaveLength(1);
    expect(await rows("select id from wager_transactions where wallet_id = ?", [wallet.id])).toHaveLength(1);
    expect(await rows("select id from wallet_ledger where wallet_id = ?", [wallet.id])).toHaveLength(1);
    expect(await rows("select id from outbox_messages where aggregate_id = ?", [wallet.id])).toHaveLength(2);
    await assertReconciled(wallet.id);
  }, 30_000);

  test("independent wallets open concurrently across all processes", async () => {
    const wallets = await Promise.all(Array.from({ length: 12 }, (_, index) => create("12.34", index % 3)));
    expect(new Set(wallets.map((wallet) => wallet.id)).size).toBe(12);
    await Promise.all(wallets.map((wallet) => assertReconciled(wallet.id)));
  });

  test("an outbox insert failure rolls back wallet, transaction, ledger and events", async () => {
    const body = opening();
    const counts = () => rows("select (select count(*) from wallets)::text as wallets, (select count(*) from wager_transactions)::text as transactions, (select count(*) from wallet_ledger)::text as ledger, (select count(*) from outbox_messages)::text as outbox");
    const before = await counts();
    await rows("create function test_reject_outbox() returns trigger language plpgsql as $$ begin raise exception 'injected outbox failure'; end $$");
    await rows("create trigger test_outbox_failure before insert on outbox_messages for each row execute function test_reject_outbox()");
    try {
      expect((await request("/wallets", body)).status).toBe(500);
      expect(await counts()).toEqual(before);
      expect(await rows("select id from wallets where player_id = ?", [body.playerId])).toHaveLength(0);
    } finally {
      await rows("drop trigger test_outbox_failure on outbox_messages");
      await rows("drop function test_reject_outbox()");
    }
    const retry = await request("/wallets", body, 2);
    expect(retry.status).toBe(201);
    await assertReconciled((await retry.json() as WalletResponse).id);
  });

  test("HTTP rejects malformed input and distinguishes missing wallets", async () => {
    const valid = opening();
    for (const body of [null, [], {}, { ...valid, playerId: "bad-id" },
      { ...valid, initialBalance: { amount: "-1.00", currency: "BRL" } },
      { ...valid, initialBalance: { amount: 100, currency: "BRL" } },
      { ...valid, initialBalance: { amount: "1.001", currency: "BRL" } },
      { ...valid, initialBalance: { amount: "1e2", currency: "BRL" } },
      { ...valid, initialBalance: { amount: "1.00", currency: "USD" } }]) {
      const response = await request("/wallets", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: expect.any(String), message: expect.any(String) });
    }
    const malformed = await fetch(`${app().url}/wallets`, { method: "POST", headers: { "content-type": "application/json" }, body: "{", signal: AbortSignal.timeout(5_000) });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: expect.any(String), message: expect.any(String) });
    expect((await request("/wallets/not-a-uuid")).status).toBe(400);
    expect((await request(`/wallets/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await request(`/wallets/${crypto.randomUUID()}/ledger`)).status).toBe(404);
  });

  test("ledger query validates limits, opaque cursors and wallet ownership", async () => {
    const wallet = await create();
    const path = `/wallets/${wallet.id}/ledger`;
    for (const query of ["limit=0", "limit=-1", "limit=101", "limit=1.5", "limit=abc", "cursor=bad-cursor"]) {
      expect((await request(`${path}?${query}`)).status).toBe(400);
    }
    const first = await (await request(`${path}?limit=1`)).json() as LedgerResponse;
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeNull();
    const entry = first.items[0]!;
    const cursor = encodeLedgerCursor(wallet.id, { id: entry.id, createdAt: new Date(entry.createdAt) });
    const following = await request(`${path}?cursor=${cursor}&limit=1`);
    expect(following.status).toBe(200);
    expect(await following.json()).toEqual({ items: [], nextCursor: null });
    const other = await create();
    expect((await request(`/wallets/${other.id}/ledger?cursor=${cursor}`)).status).toBe(400);
  });

  test("database constraints reject negative balances, NaN, currency mismatch and duplicate ledger", async () => {
    const wallet = await create();
    for (const amount of ["-0.01", "NaN"]) {
      await expect(rows("update wallets set balance = ? where id = ?", [amount, wallet.id])).rejects.toThrow();
    }
    await expect(rows("update wallets set currency = 'USD' where id = ?", [wallet.id])).rejects.toThrow();
    await expect(rows("insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) select ?, player_id, currency, balance, version, created_at, updated_at from wallets where id = ?", [crypto.randomUUID(), wallet.id])).rejects.toThrow();
    await expect(rows("insert into wallet_ledger (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at) select ?, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at from wallet_ledger where wallet_id = ?", [crypto.randomUUID(), wallet.id])).rejects.toThrow();
    await assertReconciled(wallet.id);
  });

  test("database rejects invalid ledger arithmetic and cross-record currencies atomically", async () => {
    for (const [currency, after, constraint] of [
      ["BRL", "99.00", "wallet_ledger_arithmetic_check"],
      ["USD", "100.00", "wallet_ledger_transaction_fk"],
    ]) {
      const walletId = crypto.randomUUID();
      // A single SQL statement rolls back its fresh fixture too when the ledger check fails.
      await expect(rows(`
        with wallet as (
          insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
          values (?, ?, 'BRL', '100.00', 1, now(), now()) returning *
        ), opening as (
          insert into wager_transactions (id, wallet_id, player_id, currency, amount, idempotency_key, kind, status, created_at, processed_at)
          select ?, id, player_id, currency, '100.00', ?, 'OPENING', 'PROCESSED', now(), now() from wallet returning *
        )
        insert into wallet_ledger (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, created_at)
        select ?, wallet_id, id, ?, 'CREDIT', amount, '0.00', ?, now() from opening
      `, [walletId, crypto.randomUUID(), crypto.randomUUID(), `test:${walletId}`, crypto.randomUUID(), currency, after])).rejects.toThrow(constraint);
      expect(await rows("select id from wallets where id = ?", [walletId])).toHaveLength(0);
    }
  });

  test("the persisted opening idempotency key cannot be reused by a different wallet", async () => {
    const wallet = await create();
    const [existing] = await rows<{ idempotency_key: string }>("select idempotency_key from wager_transactions where wallet_id = ?", [wallet.id]);
    const duplicateWalletId = crypto.randomUUID();
    await expect(rows(`
      with wallet as (
        insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
        values (?, ?, 'BRL', '100.00', 1, now(), now()) returning *
      )
      insert into wager_transactions (id, wallet_id, player_id, currency, amount, idempotency_key, kind, status, created_at, processed_at)
      select ?, id, player_id, currency, '100.00', ?, 'OPENING', 'PROCESSED', now(), now() from wallet
    `, [duplicateWalletId, crypto.randomUUID(), crypto.randomUUID(), existing!.idempotency_key])).rejects.toThrow("wager_transactions_idempotency_unique");
    expect(await rows("select id from wallets where id = ?", [duplicateWalletId])).toHaveLength(0);
    await assertReconciled(wallet.id);
  });

  test("the database refuses ledger UPDATE, DELETE and TRUNCATE", async () => {
    const wallet = await create();
    await expect(rows("update wallet_ledger set amount = '99.00' where wallet_id = ?", [wallet.id])).rejects.toThrow();
    await expect(rows("delete from wallet_ledger where wallet_id = ?", [wallet.id])).rejects.toThrow();
    await expect(rows("truncate wallet_ledger")).rejects.toThrow();
    expect(await rows("select id from wallet_ledger where wallet_id = ?", [wallet.id])).toHaveLength(1);
    await assertReconciled(wallet.id);
  });

  test("abrupt process death after commit preserves wallet, ledger, events and duplicate protection", async () => {
    const body = opening("123.45");
    const response = await request("/wallets", body);
    expect(response.status).toBe(201);
    const wallet = await response.json() as WalletResponse;
    const events = await rows("select id, payload from outbox_messages where aggregate_id = ? order by id", [wallet.id]);
    app().child.kill("SIGKILL");
    await deadline(app().child.exited, 5_000, "Application did not exit after SIGKILL");
    applications[0] = await startApplication(children);
    expect(await (await request(`/wallets/${wallet.id}`)).json()).toEqual(wallet);
    expect((await request("/wallets", body)).status).toBe(409);
    expect(await rows("select id, payload from outbox_messages where aggregate_id = ? order by id", [wallet.id])).toEqual(events);
    expect(await rows("select id from wallet_ledger where wallet_id = ?", [wallet.id])).toHaveLength(1);
    await assertReconciled(wallet.id);
  });

  test("every final wallet balance equals the exact sum reconstructed from its ledger", async () => {
    const inconsistent = await rows(`
      select w.id from wallets w left join wallet_ledger l on l.wallet_id = w.id
      group by w.id
      having w.balance <> coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)
    `);
    expect(inconsistent).toEqual([]);
  });
});
