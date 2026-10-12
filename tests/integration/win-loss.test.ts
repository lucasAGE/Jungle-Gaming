import { assertAccountingConsistent } from "./accounting-audit.js";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, SendMessageCommand, SQSClient,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client.js";
import {
  deadline, resetTestDatabase, startApplication, stop,
  type Application, type Child, type Orm, type WalletResponse,
} from "./helpers.js";

const integration = process.env.RUN_DATABASE_INTEGRATION === "1" && process.env.RUN_SQS_INTEGRATION === "1"
  ? describe : describe.skip;
const endpoint = process.env.TEST_SQS_ENDPOINT ?? "http://127.0.0.1:4567";
interface WagerInput {
  providerId: string; externalTransactionId: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: "BET" | "WIN" | "LOSS"; money: WalletResponse["balance"];
}
interface WagerResult {
  transactionId: string; status: "PROCESSED" | "REJECTED"; balance: WalletResponse["balance"];
  idempotentReplay: boolean; failureCode?: string;
}

integration("WIN and LOSS over HTTP and SQS with three independent application processes", () => {
  let orm: Orm;
  let client: SQSClient;
  let queueUrl: string;
  let dlqUrl: string;
  const children: Child[] = [];
  const applications: Application[] = [];

  function app(index = 0): Application {
    const application = applications[index];
    if (!application) throw new Error(`Application ${index} is unavailable`);
    return application;
  }

  function rows<T = Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    return orm.em.getConnection().execute<T[]>(sql, parameters);
  }

  async function eventually<T>(read: () => Promise<T>, ready: (result: T) => boolean): Promise<T> {
    const expires = Date.now() + 15_000;
    let result: T;
    do {
      result = await read();
      if (ready(result)) return result;
      await Bun.sleep(25);
    } while (Date.now() < expires);
    throw new Error(`Expected asynchronous wager processing to finish: ${JSON.stringify(result)}`);
  }

  function environment(): Record<string, string> {
    return { SQS_CONSUMER_ENABLED: "true", SQS_ENDPOINT: endpoint,
      SQS_WAGER_QUEUE_URL: queueUrl, SQS_WAGER_DLQ_URL: dlqUrl, SQS_VISIBILITY_TIMEOUT_SECONDS: "2" };
  }

  function request(path: string, body?: unknown, instance = 0, key?: string): Promise<Response> {
    return fetch(`${app(instance).url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(key === undefined ? {} : { "Idempotency-Key": key }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
  }

  async function wallet(amount = "100.00"): Promise<WalletResponse> {
    const response = await request("/wallets", {
      playerId: crypto.randomUUID(), initialBalance: { amount, currency: "BRL" },
    });
    expect(response.status).toBe(201);
    return response.json() as Promise<WalletResponse>;
  }

  function input(target: WalletResponse, kind: WagerInput["kind"], amount = kind === "LOSS" ? "0.00" : "25.00"): WagerInput {
    return { providerId: "provider-a", externalTransactionId: crypto.randomUUID(),
      playerId: target.playerId, walletId: target.id, roundId: crypto.randomUUID(), gameId: "fortune-chimp",
      kind, money: { amount, currency: "BRL" } };
  }

  function key(body: WagerInput): string { return `${body.providerId}:${body.externalTransactionId}`; }

  function submit(body: WagerInput, instance = 0): Promise<Response> {
    return request("/wagering/transactions", body, instance, key(body));
  }

  function envelope(body: WagerInput) {
    return { messageId: crypto.randomUUID(), type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
      data: { ...body, idempotencyKey: key(body) } };
  }

  function send(message: ReturnType<typeof envelope>): Promise<unknown> {
    return client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message),
      MessageGroupId: message.data.walletId,
      // A fresh broker ID makes these genuine duplicate deliveries to the database inbox.
      MessageDeduplicationId: crypto.randomUUID() }));
  }

  async function drained(): Promise<void> {
    await eventually(async () => {
      const result = await client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }));
      return Number(result.Attributes?.ApproximateNumberOfMessages ?? "0")
        + Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? "0");
    }, (count) => count === 0);
  }

  async function snapshot(walletId: string) {
    return { wallet: await rows("select * from wallets where id = ?", [walletId]),
      transactions: await rows("select * from wager_transactions where wallet_id = ? order by id", [walletId]),
      ledger: await rows("select * from wallet_ledger where wallet_id = ? order by id", [walletId]),
      outbox: await rows("select * from outbox_messages where aggregate_id = ? order by id", [walletId]),
      inbox: await rows(`select i.* from inbox_messages i join wager_transactions t on t.id = i.transaction_id
        where t.wallet_id = ? order by i.consumer_name, i.message_id`, [walletId]) };
  }

  async function balance(walletId: string): Promise<WalletResponse> {
    const response = await request(`/wallets/${walletId}`);
    expect(response.status).toBe(200);
    return response.json() as Promise<WalletResponse>;
  }

  beforeAll(async () => {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)
      || url.port !== "4567" || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("WIN and LOSS tests require the isolated local MiniStack endpoint on port 4567");
    }
    orm = await resetTestDatabase();
    client = createSqsClient(endpoint);
    const suffix = crypto.randomUUID();
    const dlq = await client.send(new CreateQueueCommand({ QueueName: `win-loss-dlq-${suffix}.fifo`,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } }));
    if (!dlq.QueueUrl) throw new Error("MiniStack did not return the DLQ URL");
    dlqUrl = dlq.QueueUrl;
    const attributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }));
    const created = await client.send(new CreateQueueCommand({ QueueName: `win-loss-${suffix}.fifo`,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false", VisibilityTimeout: "2",
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: attributes.Attributes?.QueueArn, maxReceiveCount: "5" }) } }));
    if (!created.QueueUrl) throw new Error("MiniStack did not return the input queue URL");
    queueUrl = created.QueueUrl;
    for (let index = 0; index < 3; index++) applications.push(await startApplication(children, environment()));
  }, 60_000);

  afterAll(async () => {
    await Promise.all(children.map(stop));
    try {
      if (orm) expect(await rows(`select w.id from wallets w left join wallet_ledger l on l.wallet_id = w.id
        group by w.id having w.balance <> coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)`)).toEqual([]);
    } finally {
      if (orm) { try { await assertAccountingConsistent(orm); } finally { await orm.close(true); } }
      if (queueUrl) await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      if (dlqUrl) await client.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
      client?.destroy();
    }
  });

  test("migration 004 round trip preserves opening, BET, ledger, outbox and completed inbox history", async () => {
    expect(new Set(applications.map(({ child }) => child.pid)).size).toBe(3);
    const target = await wallet();
    const message = envelope(input(target, "BET"));
    await send(message);
    await drained();
    const before = await snapshot(target.id);
    expect(before.inbox).toHaveLength(1);
    expect(before.wallet).toEqual([expect.objectContaining({ balance: "75.00", version: 2 })]);
    await orm.getMigrator().down({ to: "Migration202610100004" });
    expect((await orm.getMigrator().getPendingMigrations()).map((migration) => migration.name)).toEqual([
      "Migration202610100004", "Migration202610100005", "Migration202610100006", "Migration202610100007", "Migration202610100008", "Migration202610120001",
    ]);
    const downgraded = await snapshot(target.id);
    expect(downgraded).toMatchObject({ wallet: before.wallet, ledger: before.ledger, outbox: before.outbox, inbox: before.inbox });
    expect(downgraded.transactions).toHaveLength(before.transactions.length);
    await orm.getMigrator().up();
    expect(await snapshot(target.id)).toEqual(before);
  }, 30_000);

  test("50 concurrent HTTP copies across three processes commit exactly one WIN credit and two events", async () => {
    const target = await wallet();
    const body = input(target, "WIN");
    const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => submit(body, index % 3)));
    const results = await Promise.all(responses.map((response) => response.json() as Promise<WagerResult>));
    expect(responses.map((response) => response.status)).toEqual(Array(50).fill(200));
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    for (const result of results) expect(result).toMatchObject({ status: "PROCESSED", balance: { amount: "125.00", currency: "BRL" } });
    expect(await balance(target.id)).toMatchObject({ balance: { amount: "125.00" }, version: 2 });
    const transactionId = results[0]!.transactionId;
    expect(await rows("select kind, status, amount from wager_transactions where id = ?", [transactionId])).toEqual([
      { kind: "WIN", status: "PROCESSED", amount: "25.00" },
    ]);
    expect(await rows("select direction, amount, balance_before, balance_after from wallet_ledger where transaction_id = ?", [transactionId])).toEqual([
      { direction: "CREDIT", amount: "25.00", balance_before: "100.00", balance_after: "125.00" },
    ]);
    expect(await rows("select event_type, published_at from outbox_messages where payload->'data'->>'transactionId' = ? order by event_type", [transactionId])).toEqual([
      { event_type: "WagerTransactionProcessed", published_at: null }, { event_type: "WalletBalanceChanged", published_at: null },
    ]);
  }, 30_000);

  test("concurrent LOSS copies emit one result without changing the wallet, and replay the historical balance", async () => {
    const target = await wallet();
    const beforeWallet = await rows("select * from wallets where id = ?", [target.id]);
    const body = input(target, "LOSS");
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => submit(body, index % 3)));
    expect(responses.map((response) => response.status)).toEqual(Array(20).fill(200));
    const results = await Promise.all(responses.map((response) => response.json() as Promise<WagerResult>));
    const original = results.find((result) => !result.idempotentReplay)!;
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(original).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00", currency: "BRL" } });
    expect(await rows("select * from wallets where id = ?", [target.id])).toEqual(beforeWallet);
    expect(await rows("select id from wallet_ledger where transaction_id = ?", [original.transactionId])).toEqual([]);
    expect(await rows("select event_type from outbox_messages where payload->'data'->>'transactionId' = ?", [original.transactionId])).toEqual([
      { event_type: "WagerTransactionProcessed" },
    ]);
    expect((await submit(input(target, "WIN", "1.00"), 1)).status).toBe(200);
    const replay = await submit(body, 2);
    expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
    expect(await balance(target.id)).toMatchObject({ balance: { amount: "101.00" }, version: 2 });
    const record = await (await request(`/wagering/transactions/${original.transactionId}`)).json();
    expect(record).toMatchObject({ ...body, status: "PROCESSED", balance: original.balance, processedAt: expect.any(String) });
  });

  test("distinct concurrent credits and losses have no lost updates or extra ledger entries", async () => {
    const target = await wallet("0.00");
    const bodies = Array.from({ length: 12 }, () => [input(target, "WIN", "0.01"), input(target, "LOSS")]).flat();
    const responses = await Promise.all(bodies.map((body, index) => submit(body, index % 3)));
    expect(responses.map((response) => response.status)).toEqual(Array(24).fill(200));
    expect(await balance(target.id)).toMatchObject({ balance: { amount: "0.12" }, version: 13 });
    expect(await rows("select id from wager_transactions where wallet_id = ?", [target.id])).toHaveLength(24);
    expect(await rows("select id from wallet_ledger where wallet_id = ?", [target.id])).toHaveLength(12);
    expect(await rows("select id from outbox_messages where aggregate_id = ?", [target.id])).toHaveLength(36);
  });

  test("a cent at the numeric limit is exact and an overflowing WIN stays rejected after the balance later falls", async () => {
    const target = await wallet("999999999999999999.98");
    const accepted = input(target, "WIN", "0.01");
    const processed = await (await submit(accepted)).json() as WagerResult;
    expect(processed).toMatchObject({ status: "PROCESSED", balance: { amount: "999999999999999999.99" } });
    const rejected = input(target, "WIN", "0.01");
    const response = await submit(rejected, 1);
    expect(response.status).toBe(422);
    const original = await response.json() as WagerResult;
    expect(original).toMatchObject({ status: "REJECTED", failureCode: "BALANCE_LIMIT_EXCEEDED",
      balance: { amount: "999999999999999999.99" }, idempotentReplay: false });
    expect(await balance(target.id)).toMatchObject({ balance: original.balance, version: 2 });
    expect(await rows("select id from wallet_ledger where transaction_id = ?", [original.transactionId])).toEqual([]);
    expect(await rows("select event_type from outbox_messages where payload->'data'->>'transactionId' = ?", [original.transactionId])).toEqual([
      { event_type: "WagerTransactionRejected" },
    ]);
    expect((await submit(input(target, "BET", "1.00"), 2)).status).toBe(200);
    const beforeReplay = await snapshot(target.id);
    const replay = await submit(rejected);
    expect(replay.status).toBe(422);
    expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
    expect(await (await submit(accepted, 2)).json()).toEqual({ ...processed, idempotentReplay: true });
    expect(await snapshot(target.id)).toEqual(beforeReplay);
    const record = await (await request(`/providers/${rejected.providerId}/wagering/transactions/${rejected.externalTransactionId}`)).json();
    expect(record).toMatchObject({ kind: "WIN", status: "REJECTED", failureCode: "BALANCE_LIMIT_EXCEEDED", balance: original.balance });
  });

  test("an outbox insertion failure atomically rolls back WIN and LOSS before a clean retry", async () => {
    const target = await wallet();
    const bodies = [input(target, "WIN"), input(target, "LOSS")];
    const before = await snapshot(target.id);
    await rows("create function test_win_loss_outbox_failure() returns trigger language plpgsql as $$ begin raise exception 'injected outbox failure'; end $$");
    await rows("create trigger test_win_loss_outbox_failure before insert on outbox_messages for each row execute function test_win_loss_outbox_failure()");
    try {
      for (const body of bodies) {
        expect((await submit(body)).status).toBe(503);
        expect(await snapshot(target.id)).toEqual(before);
      }
    } finally {
      await rows("drop trigger test_win_loss_outbox_failure on outbox_messages");
      await rows("drop function test_win_loss_outbox_failure()");
    }
    for (const body of bodies) {
      const response = await submit(body, 2);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "PROCESSED", idempotentReplay: false, balance: { amount: "125.00" } });
    }
    expect(await balance(target.id)).toMatchObject({ balance: { amount: "125.00" }, version: 2 });
  });

  test("SQS duplicate WIN and LOSS messages share historical idempotency with HTTP", async () => {
    const target = await wallet();
    const win = envelope(input(target, "WIN"));
    const loss = envelope(input(target, "LOSS"));
    for (const message of [win, loss]) {
      await Promise.all(Array.from({ length: 5 }, () => send(message)));
      await drained();
    }
    const before = await snapshot(target.id);
    expect(before.inbox).toHaveLength(2);
    expect(before.transactions).toHaveLength(3);
    expect(before.ledger).toHaveLength(2);
    expect(before.outbox).toHaveLength(5);
    expect(await balance(target.id)).toMatchObject({ balance: { amount: "125.00" }, version: 2 });
    expect((await submit(input(target, "WIN", "5.00"))).status).toBe(200);
    for (const message of [win, loss]) {
      const { idempotencyKey: _, ...body } = message.data;
      const replay = await submit(body, 1);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ status: "PROCESSED", idempotentReplay: true, balance: { amount: "125.00" } });
      await send(message);
      await send({ ...message, messageId: crypto.randomUUID() });
    }
    await drained();
    const after = await snapshot(target.id);
    expect(after.inbox).toHaveLength(4);
    expect(after.transactions).toHaveLength(4);
    expect(after.ledger).toHaveLength(3);
    expect(after.outbox).toHaveLength(7);
    expect(await balance(target.id)).toMatchObject({ balance: { amount: "130.00" }, version: 3 });
  }, 30_000);

  test("a transient SQS WIN failure rolls back its inbox and financial records, then commits and acknowledges once", async () => {
    const target = await wallet();
    const message = envelope(input(target, "WIN"));
    const before = await snapshot(target.id);
    await rows("create sequence test_win_sqs_attempts");
    await rows(`create function test_win_sqs_outbox_failure() returns trigger language plpgsql as $$
      begin perform nextval('test_win_sqs_attempts'); raise exception 'injected serialization failure' using errcode = '40001'; end $$`);
    await rows("create trigger test_win_sqs_outbox_failure before insert on outbox_messages for each row execute function test_win_sqs_outbox_failure()");
    try {
      await send(message);
      await eventually(() => rows<{ last_value: string }>("select last_value::text from test_win_sqs_attempts"),
        (records) => Number(records[0]?.last_value) >= 2);
      expect(await snapshot(target.id)).toEqual(before);
      expect(await rows("select * from inbox_messages where message_id = ?", [message.messageId])).toEqual([]);
    } finally {
      await rows("drop trigger test_win_sqs_outbox_failure on outbox_messages");
      await rows("drop function test_win_sqs_outbox_failure()");
    }
    await drained();
    const after = await snapshot(target.id);
    expect(after.inbox).toHaveLength(1);
    expect(after.transactions).toHaveLength(2);
    expect(after.ledger).toHaveLength(2);
    expect(after.outbox).toHaveLength(4);
    expect(await balance(target.id)).toMatchObject({ balance: { amount: "125.00" }, version: 2 });
  }, 30_000);

  test("a committed WIN survives application death and replays its original balance after restart", async () => {
    const target = await wallet();
    const body = input(target, "WIN");
    const response = await submit(body);
    expect(response.status).toBe(200);
    await response.body?.cancel();
    const before = await snapshot(target.id);
    app().child.kill("SIGKILL");
    await deadline(app().child.exited, 5_000, "Application did not exit after SIGKILL");
    applications[0] = await startApplication(children, environment());
    expect(await snapshot(target.id)).toEqual(before);
    expect((await submit(input(target, "WIN", "1.00"), 1)).status).toBe(200);
    const replay = await submit(body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ status: "PROCESSED", idempotentReplay: true, balance: { amount: "125.00" } });
    expect(await balance(target.id)).toMatchObject({ balance: { amount: "126.00" }, version: 3 });
  });

  test("invalid WIN and LOSS amounts, currencies and references do not persist financial records", async () => {
    const target = await wallet();
    const win = input(target, "WIN");
    const loss = input(target, "LOSS");
    const before = await snapshot(target.id);
    const invalid = [
      ...["0.00", "-0.01", "1.001", "1e2", 25].map((amount) => ({ ...win, money: { amount, currency: "BRL" } })),
      ...["0.01", "-0.01", "0", 0].map((amount) => ({ ...loss, money: { amount, currency: "BRL" } })),
      ...[win, loss].map((body) => ({ ...body, money: { ...body.money, currency: "USD" } })),
      { ...loss, referenceExternalTransactionId: "unresolved-bet" },
    ];
    for (const body of invalid) {
      expect((await request("/wagering/transactions", body, 0, crypto.randomUUID())).status).toBe(400);
    }
    expect(await snapshot(target.id)).toEqual(before);
  });

  test("database guards forbid LOSS ledger entries, invalid operation amounts and terminal mutations", async () => {
    const target = await wallet();
    const win = await (await submit(input(target, "WIN"))).json() as WagerResult;
    const loss = await (await submit(input(target, "LOSS"))).json() as WagerResult;
    const before = await snapshot(target.id);
    for (const result of [win, loss]) {
      await expect(rows("update wager_transactions set result_balance = '0.00' where id = ?", [result.transactionId])).rejects.toThrow();
      await expect(rows("delete from wager_transactions where id = ?", [result.transactionId])).rejects.toThrow();
    }
    await expect(rows(`insert into wallet_ledger
      (id, wallet_id, transaction_id, direction, currency, amount, balance_before, balance_after, created_at)
      select ?, wallet_id, id, 'CREDIT', currency, '1.00', '125.00', '126.00', now()
      from wager_transactions where id = ?`, [crypto.randomUUID(), loss.transactionId])).rejects.toThrow();
    const wrongDirectionId = crypto.randomUUID();
    // A fresh identity avoids a duplicate-ledger failure masking the direction guard.
    // The rejected insert rolls back the fixture transaction with its temporary WIN.
    await expect(orm.em.fork().transactional(async (em) => {
      await em.execute(`insert into wager_transactions
        (id, wallet_id, player_id, currency, amount, idempotency_key, kind, status, created_at, processed_at,
          provider_id, external_transaction_id, round_id, game_id, payload_hash, result_balance, failure_code)
        select ?, wallet_id, player_id, currency, amount, ?, kind, status, created_at, processed_at,
          provider_id, ?, round_id, game_id, payload_hash, result_balance, failure_code
        from wager_transactions where id = ?`, [wrongDirectionId, crypto.randomUUID(), crypto.randomUUID(), win.transactionId]);
      await em.execute(`insert into wallet_ledger
        (id, wallet_id, transaction_id, direction, currency, amount, balance_before, balance_after, created_at)
        select ?, wallet_id, id, 'DEBIT', currency, amount, '125.00', '100.00', now()
        from wager_transactions where id = ?`, [crypto.randomUUID(), wrongDirectionId]);
    })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("Ledger direction does not match the transaction and reference kinds") });
    for (const [kind, amount] of [["WIN", "0.00"], ["LOSS", "1.00"]]) {
      await expect(rows(`insert into wager_transactions
        (id, wallet_id, player_id, currency, amount, idempotency_key, kind, status, created_at, processed_at,
          provider_id, external_transaction_id, round_id, game_id, payload_hash, result_balance, failure_code)
        select ?, wallet_id, player_id, currency, ?, ?, ?, status, created_at, processed_at,
          provider_id, ?, round_id, game_id, payload_hash, result_balance, failure_code
        from wager_transactions where id = ?`, [crypto.randomUUID(), amount, crypto.randomUUID(), kind, crypto.randomUUID(), win.transactionId])).rejects.toThrow();
    }
    for (const [kind, amount, failureCode] of [
      ["WIN", "25.00", null], ["WIN", "25.00", "INSUFFICIENT_FUNDS"], ["LOSS", "0.00", "BALANCE_LIMIT_EXCEEDED"],
    ]) {
      await expect(rows(`insert into wager_transactions
        (id, wallet_id, player_id, currency, amount, idempotency_key, kind, status, created_at, processed_at,
          provider_id, external_transaction_id, round_id, game_id, payload_hash, result_balance, failure_code)
        select ?, wallet_id, player_id, currency, ?, ?, ?, 'REJECTED', created_at, null,
          provider_id, ?, round_id, game_id, payload_hash, result_balance, ?
        from wager_transactions where id = ?`, [crypto.randomUUID(), amount, crypto.randomUUID(), kind,
        crypto.randomUUID(), failureCode, win.transactionId])).rejects.toThrow();
    }
    expect(await snapshot(target.id)).toEqual(before);
  });

  test("idempotency and provider identity constraints span WIN and LOSS kinds", async () => {
    const target = await wallet();
    const body = input(target, "WIN");
    const result = await (await submit(body)).json() as WagerResult;
    const before = await snapshot(target.id);
    const conflictingLoss = { ...body, kind: "LOSS", money: { amount: "0.00", currency: "BRL" } };
    const conflict = await request("/wagering/transactions", conflictingLoss, 1, key(body));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const externalConflict = await request("/wagering/transactions", conflictingLoss, 2, crypto.randomUUID());
    expect(externalConflict.status).toBe(409);
    expect(await externalConflict.json()).toMatchObject({ code: "EXTERNAL_TRANSACTION_CONFLICT" });
    for (const replaceKey of [false, true]) {
      await expect(rows(`insert into wager_transactions
        (id, wallet_id, player_id, currency, amount, idempotency_key, kind, status, created_at, processed_at,
          provider_id, external_transaction_id, round_id, game_id, payload_hash, result_balance, failure_code)
        select ?, wallet_id, player_id, currency, '0.00', ${replaceKey ? "?" : "idempotency_key"}, 'LOSS', status,
          created_at, processed_at, provider_id, ${replaceKey ? "external_transaction_id" : "?"},
          round_id, game_id, payload_hash, result_balance, failure_code
        from wager_transactions where id = ?`, [crypto.randomUUID(), crypto.randomUUID(), result.transactionId]))
        .rejects.toThrow(replaceKey ? "wager_transactions_provider_external_unique" : "wager_transactions_idempotency_unique");
    }
    expect(await snapshot(target.id)).toEqual(before);
  });

  test("migration 004 refuses to remove WIN or LOSS history without changing any accepted records", async () => {
    const target = await wallet();
    expect((await submit(input(target, "WIN"))).status).toBe(200);
    expect((await submit(input(target, "LOSS"))).status).toBe(200);
    const before = await snapshot(target.id);
    await expect(orm.getMigrator().down({ to: "Migration202610100004" })).rejects.toThrow();
    expect(await snapshot(target.id)).toEqual(before);
    expect(await orm.getMigrator().getPendingMigrations()).toHaveLength(0);
  });
});
