import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client.js";
import { assertAccountingConsistent } from "./accounting-audit.js";
import { deadline, resetTestDatabase, startApplication, stop, type Application, type Child, type Orm, type WalletResponse } from "./helpers.js";

const integration = process.env.RUN_DATABASE_INTEGRATION === "1" && process.env.RUN_SQS_INTEGRATION === "1" ? describe : describe.skip;
const endpoint = process.env.TEST_SQS_ENDPOINT ?? "http://127.0.0.1:4567";
interface Input {
  providerId: string; externalTransactionId: string; walletId: string; playerId: string; roundId: string; gameId: string;
  kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK"; money: WalletResponse["balance"]; referenceExternalTransactionId?: string;
}
interface Result { transactionId: string; status: string; balance: WalletResponse["balance"]; idempotentReplay: boolean }
interface JournalPage {
  items: Array<{ ledgerEntryId: string; transactionId: string; money: WalletResponse["balance"];
    debitAccountId: string; creditAccountId: string; createdAt: string }>;
  nextCursor: string | null;
}

integration("balanced accounting with PostgreSQL, SQS and three application processes", () => {
  let orm: Orm;
  let client: SQSClient;
  let queueUrl: string;
  let dlqUrl: string;
  const applications: Application[] = [];
  const children: Child[] = [];
  const rows = <T = Record<string, unknown>>(sql: string, parameters: unknown[] = []) => orm.em.getConnection().execute<T[]>(sql, parameters);
  const key = (body: Input) => `${body.providerId}:${body.externalTransactionId}`;
  function request(path: string, body?: unknown, instance = 0, identity?: string) {
    return fetch(`${applications[instance]!.url}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(identity ? { "Idempotency-Key": identity } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  }
  const submit = (body: Input, instance = 0) => request("/wagering/transactions", body, instance, key(body));
  async function wallet(amount = "100.00"): Promise<WalletResponse> {
    const response = await request("/wallets", { playerId: crypto.randomUUID(), initialBalance: { amount, currency: "BRL" } });
    expect(response.status, response.ok ? undefined : await response.clone().text()).toBe(201);
    return response.json() as Promise<WalletResponse>;
  }
  function input(target: WalletResponse, kind: Input["kind"] = "BET", amount = "25.00"): Input {
    return { providerId: "provider-a", externalTransactionId: crypto.randomUUID(), walletId: target.id, playerId: target.playerId,
      roundId: "accounting-round", gameId: "fortune-chimp", kind, money: { amount, currency: "BRL" } };
  }
  async function accepted(body: Input, instance = 0): Promise<Result> {
    const response = await submit(body, instance);
    expect(response.status, response.ok ? undefined : await response.clone().text()).toBe(200);
    return response.json() as Promise<Result>;
  }
  function envelope(body: Input) {
    return { messageId: crypto.randomUUID(), type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
      data: { ...body, idempotencyKey: key(body) } };
  }
  function send(message: ReturnType<typeof envelope>) {
    return client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message),
      MessageGroupId: message.data.walletId, MessageDeduplicationId: crypto.randomUUID() }));
  }
  async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
    const expires = Date.now() + 15_000;
    let value: T;
    do { value = await read(); if (ready(value)) return value; await Bun.sleep(25); } while (Date.now() < expires);
    throw new Error(`Accounting scenario did not finish: ${JSON.stringify(value)}`);
  }
  async function drained(): Promise<void> {
    await eventually(async () => (await client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }))).Attributes,
    (attributes) => attributes?.ApproximateNumberOfMessages === "0" && attributes.ApproximateNumberOfMessagesNotVisible === "0");
  }
  async function history() {
    return { wallets: await rows("select * from wallets order by id"), transactions: await rows("select * from wager_transactions order by id"),
      ledger: await rows("select * from wallet_ledger order by id"), outbox: await rows("select * from outbox_messages order by id"),
      inbox: await rows("select * from inbox_messages order by consumer_name, message_id") };
  }
  async function accounting() {
    return { accounts: await rows("select * from accounting_accounts order by id"),
      journal: await rows("select * from accounting_journal order by ledger_entry_id"),
      postings: await rows("select * from accounting_postings order by ledger_entry_id, direction") };
  }
  async function postings(transactionId: string) {
    return rows("select account_id, direction, amount::text, currency from accounting_postings where transaction_id = ? order by direction", [transactionId]);
  }
  beforeAll(async () => {
    if (endpoint !== "http://127.0.0.1:4567" && endpoint !== "http://localhost:4567") throw new Error("Accounting tests require isolated MiniStack on port 4567");
    orm = await resetTestDatabase();
    client = createSqsClient(endpoint);
    const suffix = crypto.randomUUID();
    dlqUrl = (await client.send(new CreateQueueCommand({ QueueName: `accounting-dlq-${suffix}.fifo`, Attributes: { FifoQueue: "true" } }))).QueueUrl!;
    const attributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }));
    queueUrl = (await client.send(new CreateQueueCommand({ QueueName: `accounting-${suffix}.fifo`, Attributes: { FifoQueue: "true", VisibilityTimeout: "2",
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: attributes.Attributes?.QueueArn, maxReceiveCount: "5" }) } }))).QueueUrl!;
    for (let index = 0; index < 3; index++) applications.push(await startApplication(children, {
      SQS_CONSUMER_ENABLED: "true", SQS_ENDPOINT: endpoint, SQS_WAGER_QUEUE_URL: queueUrl, SQS_WAGER_DLQ_URL: dlqUrl, SQS_VISIBILITY_TIMEOUT_SECONDS: "2",
    }));
    expect(new Set(applications.map(({ child }) => child.pid)).size).toBe(3);
  }, 60_000);
  afterEach(async () => { if (orm) await assertAccountingConsistent(orm); });
  afterAll(async () => {
    await Promise.all(children.map(stop));
    try { if (queueUrl) await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      if (dlqUrl) await client.send(new DeleteQueueCommand({ QueueUrl: dlqUrl })); }
    finally { client?.destroy(); if (orm) await orm.close(true); }
  });

  test("migration 202610120001 backfills existing history and reverses without changing any financial record", async () => {
    const target = await wallet();
    await wallet("0.00");
    await accepted(input(target));
    await accepted(input(target, "WIN", "10.00"));
    const original = await history();
    const journal = await accounting();
    await orm.getMigrator().down({ to: "Migration202610120001" });
    expect((await orm.getMigrator().getPendingMigrations()).map(({ name }) => name)).toEqual(["Migration202610120001"]);
    expect(await rows("select to_regclass('public.accounting_journal')::text as journal, to_regclass('public.accounting_accounts')::text as accounts"))
      .toEqual([{ journal: null, accounts: null }]);
    expect(await history()).toEqual(original);
    await orm.getMigrator().up();
    expect(await accounting()).toEqual(journal);
    expect(await history()).toEqual(original);
  });

  test("zero opening creates an account without postings, while exact amounts and stable journal pagination remain readable", async () => {
    const empty = await wallet("0.00");
    expect(await rows("select id, kind, currency from accounting_accounts where wallet_id = ?", [empty.id]))
      .toEqual([{ id: `wallet:${empty.id}`, kind: "WALLET_LIABILITY", currency: "BRL" }]);
    expect(await (await request(`/wallets/${empty.id}/journal`)).json()).toEqual({ items: [], nextCursor: null });
    const target = await wallet("999999999999999999.99");
    const [opening] = await rows<{ id: string }>("select id from wager_transactions where wallet_id = ?", [target.id]);
    expect(await postings(opening!.id)).toEqual([
      { account_id: `wallet:${target.id}`, direction: "CREDIT", amount: "999999999999999999.99", currency: "BRL" },
      { account_id: "opening-clearing:BRL", direction: "DEBIT", amount: "999999999999999999.99", currency: "BRL" },
    ]);
    const bet = await accepted(input(target, "BET", "0.01"));
    const response = await request(`/wallets/${target.id}/journal?limit=1`);
    expect(response.status).toBe(200);
    const page = await response.json() as JournalPage;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ transactionId: opening!.id, money: { amount: "999999999999999999.99", currency: "BRL" },
      debitAccountId: "opening-clearing:BRL", creditAccountId: `wallet:${target.id}` });
    expect(page.nextCursor).toBeString();
    const next = await (await request(`/wallets/${target.id}/journal?limit=1&cursor=${page.nextCursor}`)).json() as JournalPage;
    expect(next.items).toHaveLength(1);
    expect(next.items[0]).toMatchObject({ transactionId: bet.transactionId, money: { amount: "0.01", currency: "BRL" },
      debitAccountId: `wallet:${target.id}`, creditAccountId: "house:BRL" });
    expect(next.nextCursor).toBeNull();
    expect((await request(`/wallets/${empty.id}/journal?cursor=${page.nextCursor}`)).status).toBe(400);
    expect((await request(`/wallets/${target.id}/journal?limit=0`)).status).toBe(400);
    expect((await request(`/wallets/${crypto.randomUUID()}/journal`)).status).toBe(404);
  });

  test("all financial kinds post matching counterparts and non-financial outcomes add none", async () => {
    const target = await wallet();
    const bet = input(target);
    const win = input(target, "WIN", "10.00");
    const refund = { ...input(target, "REFUND"), referenceExternalTransactionId: bet.externalTransactionId };
    const rollbackWin = { ...input(target, "ROLLBACK", "10.00"), referenceExternalTransactionId: win.externalTransactionId };
    const rollbackRefund = { ...input(target, "ROLLBACK"), referenceExternalTransactionId: refund.externalTransactionId };
    for (const [body, walletDirection] of [[bet, "DEBIT"], [win, "CREDIT"], [refund, "CREDIT"], [rollbackWin, "DEBIT"], [rollbackRefund, "DEBIT"]] as const) {
      const result = await accepted(body);
      const pair = await postings(result.transactionId);
      expect(pair).toHaveLength(2);
      expect(pair).toContainEqual({ account_id: `wallet:${target.id}`, direction: walletDirection, amount: body.money.amount, currency: "BRL" });
      expect(pair).toContainEqual({ account_id: "house:BRL", direction: walletDirection === "CREDIT" ? "DEBIT" : "CREDIT", amount: body.money.amount, currency: "BRL" });
    }
    for (const [body, status] of [[input(target, "LOSS", "0.00"), 200], [input(target, "BET", "1000.00"), 422],
      [{ ...input(target, "REFUND"), referenceExternalTransactionId: crypto.randomUUID() }, 202]] as const) {
      const response = await submit(body);
      expect(response.status).toBe(status);
      const result = await response.json() as Result;
      expect(await postings(result.transactionId)).toEqual([]);
    }
    expect((await (await request(`/wallets/${target.id}`)).json() as WalletResponse).balance.amount).toBe("75.00");
  });

  test("50 concurrent HTTP and SQS copies commit one journal and redelivery replays its historical result", async () => {
    const target = await wallet();
    const body = input(target);
    const message = envelope(body);
    // Every send has a fresh broker deduplication ID; PostgreSQL must deduplicate the business identity.
    const [results] = await Promise.all([
      Promise.all(Array.from({ length: 25 }, (_, index) => accepted(body, index % 3))),
      Promise.all(Array.from({ length: 25 }, () => send(message))),
    ]);
    await eventually(() => rows("select transaction_id from inbox_messages where message_id = ? and processed_at is not null", [message.messageId]), (receipts) => receipts.length === 1);
    await drained();
    expect(new Set(results.map(({ transactionId }) => transactionId)).size).toBe(1);
    const original = results[0]!;
    expect(await postings(original.transactionId)).toHaveLength(2);
    expect(await rows("select ledger_entry_id from accounting_journal where transaction_id = ?", [original.transactionId])).toHaveLength(1);
    await accepted(input(target, "WIN", "10.00"));
    const before = await accounting();
    expect(await accepted(body, 2)).toMatchObject({ transactionId: original.transactionId, idempotentReplay: true, balance: { amount: "75.00", currency: "BRL" } });
    await send(message);
    await drained();
    expect(await accounting()).toEqual(before);
    expect((await (await request(`/wallets/${target.id}`)).json() as WalletResponse).balance.amount).toBe("85.00");
  }, 30_000);

  test("competing bets book exactly one house credit and unrelated wallets do not share a write lock", async () => {
    const target = await wallet();
    const responses = await Promise.all([submit(input(target, "BET", "80.00"), 0), submit(input(target, "BET", "80.00"), 1)]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 422]);
    expect(await rows(`select p.amount::text from accounting_postings p join wager_transactions t on t.id = p.transaction_id
      where t.wallet_id = ? and p.account_id = 'house:BRL' and p.direction = 'CREDIT'`, [target.id])).toEqual([{ amount: "80.00" }]);
    expect((await (await request(`/wallets/${target.id}`)).json() as WalletResponse).balance.amount).toBe("20.00");

    const other = await wallet();
    let unlock: () => void = () => {};
    let announce: () => void = () => {};
    const held = new Promise<void>((resolve) => { announce = resolve; });
    const released = new Promise<void>((resolve) => { unlock = resolve; });
    const holder = orm.em.fork().transactional(async (em) => {
      await em.execute("select id from wallets where id = ? for update", [target.id]);
      // Ordinary financial inserts only need compatible FK key-share locks on this immutable account.
      await em.execute("select id from accounting_accounts where id = 'house:BRL' for no key update");
      announce(); await released;
    });
    try {
      await deadline(held, 5_000, "The test account lock was not acquired");
      expect(await deadline(accepted(input(other), 2), 5_000, "An unrelated wallet waited for a shared house write lock"))
        .toMatchObject({ status: "PROCESSED", balance: { amount: "75.00", currency: "BRL" } });
    } finally { unlock(); await holder; }
  });

  test.each(["accounting_journal", "outbox_messages"] as const)("a transient %s failure rolls back SQS inbox and every financial record before retry", async (table) => {
    const target = await wallet();
    const body = input(target);
    const message = envelope(body);
    const before = { history: await history(), accounting: await accounting() };
    await rows("create sequence test_accounting_failure_attempts");
    await rows(`create function test_accounting_failure() returns trigger language plpgsql as $$
      begin perform nextval('test_accounting_failure_attempts'); raise exception 'injected serialization failure' using errcode = '40001'; end $$`);
    await rows(`create trigger test_accounting_failure before insert on ${table} for each row execute function test_accounting_failure()`);
    try {
      await send(message);
      // A new PostgreSQL sequence already reports last_value=1 before nextval is called.
      await eventually(() => rows<{ is_called: boolean }>("select is_called from test_accounting_failure_attempts"), (attempts) => attempts[0]?.is_called === true);
      expect({ history: await history(), accounting: await accounting() }).toEqual(before);
      expect(await rows("select message_id from inbox_messages where message_id = ?", [message.messageId])).toEqual([]);
    } finally {
      await rows(`drop trigger test_accounting_failure on ${table}`);
      await rows("drop function test_accounting_failure()");
      await rows("drop sequence test_accounting_failure_attempts");
    }
    await eventually(() => rows<{ transaction_id: string }>("select transaction_id from inbox_messages where message_id = ? and processed_at is not null", [message.messageId]), (receipts) => receipts.length === 1);
    await drained();
    const result = await accepted(body, 1);
    expect(result).toMatchObject({ idempotentReplay: true, balance: { amount: "75.00", currency: "BRL" } });
    expect(await postings(result.transactionId)).toHaveLength(2);
    expect(await rows("select event_type from outbox_messages where payload->'data'->>'transactionId' = ? order by event_type", [result.transactionId]))
      .toEqual([{ event_type: "WagerTransactionProcessed" }, { event_type: "WalletBalanceChanged" }]);
  }, 30_000);

  test("an opening journal failure rolls back the new wallet, account, ledger and outbox before a clean retry", async () => {
    const body = { playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } };
    const before = { history: await history(), accounting: await accounting() };
    await rows(`create function test_opening_accounting_failure() returns trigger language plpgsql as $$
      begin raise exception 'injected opening journal failure' using errcode = '40001'; end $$`);
    await rows("create trigger test_opening_accounting_failure before insert on accounting_journal for each row execute function test_opening_accounting_failure()");
    try {
      const response = await request("/wallets", body);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "DATABASE_UNAVAILABLE" });
      expect({ history: await history(), accounting: await accounting() }).toEqual(before);
    } finally {
      await rows("drop trigger test_opening_accounting_failure on accounting_journal");
      await rows("drop function test_opening_accounting_failure()");
    }
    expect((await request("/wallets", body, 2)).status).toBe(201);
  });

  test("database constraints forbid missing accounts, missing or malformed pairs, duplicates and accounting mutation", async () => {
    const target = await wallet();
    const bet = await accepted(input(target));
    const other = await wallet();
    const before = await accounting();
    await expect(rows(`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
      values (?, ?, 'BRL', 0, 1, now(), now())`, [crypto.randomUUID(), crypto.randomUUID()])).rejects.toThrow("wallets_accounting_account_fk");

    async function invalidPair(override?: { amount?: string; currency?: string; debit?: string; credit?: string; transaction?: string; time?: string }) {
      return orm.em.fork().transactional(async (em) => {
        const transactionId = crypto.randomUUID();
        const ledgerId = crypto.randomUUID();
        await em.execute(`insert into wager_transactions
          (id, wallet_id, player_id, currency, amount, idempotency_key, kind, status, provider_id, external_transaction_id, round_id, game_id, payload_hash, result_balance, created_at, processed_at)
          select ?, wallet_id, player_id, currency, amount, ?, kind, status, provider_id, ?, round_id, game_id, payload_hash, result_balance, created_at, processed_at
          from wager_transactions where id = ?`, [transactionId, crypto.randomUUID(), crypto.randomUUID(), bet.transactionId]);
        await em.execute(`insert into wallet_ledger (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, created_at)
          select ?, wallet_id, ?, currency, direction, amount, balance_before, balance_after, created_at from wallet_ledger where transaction_id = ?`, [ledgerId, transactionId, bet.transactionId]);
        if (override) await em.execute(`insert into accounting_journal
          (ledger_entry_id, transaction_id, currency, amount, debit_account_id, credit_account_id, created_at)
          select id, coalesce(?::uuid, transaction_id), coalesce(?::text, currency), coalesce(?::numeric, amount), ?, ?, coalesce(?::timestamptz, created_at)
          from wallet_ledger where id = ?`, [override.transaction ?? null, override.currency ?? null, override.amount ?? null,
          override.debit ?? `wallet:${target.id}`, override.credit ?? "house:BRL", override.time ?? null, ledgerId]);
      });
    }
    await expect(invalidPair()).rejects.toThrow("wallet_ledger_accounting_journal_fk");
    for (const invalid of [{ amount: "24.99" }, { amount: "NaN" }, { currency: "USD" }, { transaction: crypto.randomUUID() },
      { time: "2000-01-01T00:00:00.000Z" }, { debit: `wallet:${other.id}` }, { debit: "house:BRL", credit: `wallet:${target.id}` },
      { credit: "opening-clearing:BRL" }, { credit: `wallet:${target.id}` }]) await expect(invalidPair(invalid)).rejects.toThrow();
    await expect(rows("insert into accounting_journal select * from accounting_journal where transaction_id = ?", [bet.transactionId])).rejects.toThrow();
    for (const table of ["accounting_accounts", "accounting_journal", "accounting_postings"]) {
      const column = table === "accounting_accounts" ? "kind" : "amount";
      for (const sql of [`update ${table} set ${column} = ${column}`, `delete from ${table}`, `truncate ${table}`]) await expect(rows(sql)).rejects.toThrow();
    }
    expect(await accounting()).toEqual(before);
  });
});
