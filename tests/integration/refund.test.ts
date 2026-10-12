import { assertAccountingConsistent } from "./accounting-audit.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, SendMessageCommand, SQSClient,
} from "@aws-sdk/client-sqs";
import { ProcessWager } from "../../src/application/process-wager.js";
import { PostgresWageringStore } from "../../src/infrastructure/database/postgres-wagering-store.js";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client.js";
import {
  deadline, resetTestDatabase, startApplication, stop,
  type Application, type Child, type Orm, type WalletResponse,
} from "./helpers.js";

const integration = process.env.RUN_DATABASE_INTEGRATION === "1" && process.env.RUN_SQS_INTEGRATION === "1"
  ? describe : describe.skip;
const endpoint = process.env.TEST_SQS_ENDPOINT ?? "http://127.0.0.1:4567";
interface Input {
  providerId: string; externalTransactionId: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: "BET" | "WIN" | "LOSS" | "REFUND"; money: WalletResponse["balance"];
  referenceExternalTransactionId?: string;
}
interface Result {
  transactionId: string; status: "PENDING_REFERENCE" | "PROCESSED" | "REJECTED";
  balance: WalletResponse["balance"]; idempotentReplay: boolean; failureCode?: string;
}

integration("REFUND with PostgreSQL, SQS and independent application processes", () => {
  let orm: Orm;
  let processWager: ProcessWager;
  let client: SQSClient;
  let queueUrl: string;
  let dlqUrl: string;
  let applications: Application[];
  let children: Child[];

  function rows<T = Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    return orm.em.getConnection().execute<T[]>(sql, parameters);
  }

  function environment(): Record<string, string> {
    return { SQS_CONSUMER_ENABLED: "true", SQS_ENDPOINT: endpoint,
      SQS_WAGER_QUEUE_URL: queueUrl, SQS_WAGER_DLQ_URL: dlqUrl, SQS_VISIBILITY_TIMEOUT_SECONDS: "2" };
  }

  function request(path: string, body?: unknown, instance = 0, key?: string): Promise<Response> {
    return fetch(`${applications[instance]!.url}${path}`, {
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

  function input(target: WalletResponse, kind: Input["kind"], amount = kind === "LOSS" ? "0.00" : "25.00"): Input {
    return { providerId: "provider-a", externalTransactionId: crypto.randomUUID(), playerId: target.playerId,
      walletId: target.id, roundId: crypto.randomUUID(), gameId: "fortune-chimp", kind, money: { amount, currency: "BRL" } };
  }

  function refund(target: WalletResponse, bet: Input): Input {
    return { ...input(target, "REFUND", bet.money.amount), roundId: bet.roundId,
      referenceExternalTransactionId: bet.externalTransactionId };
  }

  function key(body: Input): string { return `${body.providerId}:${body.externalTransactionId}`; }

  function submit(body: Input, instance = 0): Promise<Response> {
    return request("/wagering/transactions", body, instance, key(body));
  }

  function envelope(body: Input) {
    return { messageId: crypto.randomUUID(), type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
      data: { ...body, idempotencyKey: key(body) } };
  }

  function send(message: ReturnType<typeof envelope>): Promise<unknown> {
    return client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message),
      MessageGroupId: message.data.walletId, MessageDeduplicationId: crypto.randomUUID() }));
  }

  async function eventually<T>(read: () => Promise<T>, ready: (result: T) => boolean): Promise<T> {
    const expires = Date.now() + 15_000;
    let result: T;
    do {
      result = await read();
      if (ready(result)) return result;
      await Bun.sleep(25);
    } while (Date.now() < expires);
    throw new Error(`Expected refund processing to finish: ${JSON.stringify(result)}`);
  }

  async function drained(): Promise<void> {
    await eventually(async () => {
      const response = await client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }));
      return Number(response.Attributes?.ApproximateNumberOfMessages ?? "0")
        + Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? "0");
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

  async function due(transactionId: string): Promise<Date> {
    const records = await rows<{ next_reference_attempt_at: string }>(
      "select next_reference_attempt_at from wager_transactions where id = ?", [transactionId]);
    expect(records).toHaveLength(1);
    return new Date(records[0]!.next_reference_attempt_at);
  }

  async function eventTypes(transactionId: string): Promise<string[]> {
    return (await rows<{ event_type: string }>(
      "select event_type from outbox_messages where payload->'data'->>'transactionId' = ? order by event_type",
      [transactionId])).map((row) => row.event_type);
  }

  beforeEach(async () => {
    children = [];
    applications = [];
    const url = new URL(endpoint);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)
      || url.port !== "4567" || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Refund tests require isolated local MiniStack on port 4567");
    }
    orm = await resetTestDatabase();
    processWager = new ProcessWager(new PostgresWageringStore(orm));
    client = createSqsClient(endpoint);
    const suffix = crypto.randomUUID();
    const dlq = await client.send(new CreateQueueCommand({ QueueName: `refund-dlq-${suffix}.fifo`,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } }));
    if (!dlq.QueueUrl) throw new Error("MiniStack did not return the DLQ URL");
    dlqUrl = dlq.QueueUrl;
    const attributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }));
    const created = await client.send(new CreateQueueCommand({ QueueName: `refund-${suffix}.fifo`,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false", VisibilityTimeout: "2",
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: attributes.Attributes?.QueueArn, maxReceiveCount: "5" }) } }));
    if (!created.QueueUrl) throw new Error("MiniStack did not return the input queue URL");
    queueUrl = created.QueueUrl;
    for (let index = 0; index < 3; index++) applications.push(await startApplication(children, environment()));
  }, 60_000);

  afterEach(async () => {
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

  test("50 concurrent copies credit once and preserve their historical result across transports", async () => {
    expect(new Set(applications.map(({ child }) => child.pid)).size).toBe(3);
    const target = await wallet();
    const bet = input(target, "BET");
    const betResult = await (await submit(bet)).json() as Result;
    const body = { ...refund(target, bet), gameId: "different-game" };
    const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => submit(body, index % 3)));
    expect(responses.map((response) => response.status)).toEqual(Array(50).fill(200));
    const results = await Promise.all(responses.map((response) => response.json() as Promise<Result>));
    const original = results.find((result) => !result.idempotentReplay)!;
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(original).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00", currency: "BRL" } });
    expect(await rows("select balance, version from wallets where id = ?", [target.id])).toEqual([{ balance: "100.00", version: 3 }]);
    expect(await rows("select direction, amount from wallet_ledger where transaction_id = ?", [original.transactionId]))
      .toEqual([{ direction: "CREDIT", amount: "25.00" }]);
    expect(await eventTypes(original.transactionId)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    expect(await (await request(`/wagering/transactions/${original.transactionId}`)).json())
      .toMatchObject({ kind: "REFUND", referenceTransactionId: betResult.transactionId,
        referenceExternalTransactionId: bet.externalTransactionId });
    expect((await submit(input(target, "WIN", "1.00"))).status).toBe(200);
    expect(await (await submit(body, 2)).json()).toEqual({ ...original, idempotentReplay: true });
    const message = envelope(body);
    await Promise.all(Array.from({ length: 5 }, () => send(message)));
    await drained();
    expect((await snapshot(target.id)).inbox).toHaveLength(1);
    expect(await rows("select id from wallet_ledger where transaction_id = ?", [original.transactionId])).toHaveLength(1);
    const beforeConflict = await snapshot(target.id);
    expect((await submit({ ...body, money: { amount: "24.00", currency: "BRL" } })).status).toBe(409);
    expect((await request("/wagering/transactions", body, 1, crypto.randomUUID())).status).toBe(409);
    expect(await snapshot(target.id)).toEqual(beforeConflict);
  }, 30_000);

  test("distinct refund identities racing for one BET produce one credit and terminal rejections", async () => {
    const target = await wallet();
    const bet = input(target, "BET");
    expect((await submit(bet)).status).toBe(200);
    const bodies = Array.from({ length: 12 }, () => refund(target, bet));
    const responses = await Promise.all(bodies.map((body, index) => submit(body, index % 3)));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 422)).toHaveLength(11);
    const results = await Promise.all(responses.map((response) => response.json() as Promise<Result>));
    for (const result of results) {
      expect(result.balance.amount).toBe("100.00");
      if (result.status === "REJECTED") {
        expect(result.failureCode).toBe("REFERENCE_ALREADY_REFUNDED");
        expect(await eventTypes(result.transactionId)).toEqual(["WagerTransactionRejected"]);
        expect(await rows("select id from wallet_ledger where transaction_id = ?", [result.transactionId])).toEqual([]);
      }
    }
    expect(await rows("select balance, version from wallets where id = ?", [target.id])).toEqual([{ balance: "100.00", version: 3 }]);
    expect(await rows("select id from wallet_ledger where wallet_id = ?", [target.id])).toHaveLength(3);
    for (let index = 0; index < bodies.length; index++) {
      expect(await (await submit(bodies[index]!, index % 3)).json()).toEqual({ ...results[index], idempotentReplay: true });
    }
  });

  test("reference and amount failures are durable, while corrected new refunds remain possible", async () => {
    const target = await wallet();
    const other = await wallet();
    const bet = input(target, "BET");
    const otherBet = input(other, "BET");
    const rejectedBet = { ...input(target, "BET", "1000.00"), roundId: bet.roundId };
    const loss = { ...input(target, "LOSS"), roundId: bet.roundId };
    const win = { ...input(target, "WIN", "1.00"), roundId: bet.roundId };
    for (const body of [bet, otherBet, rejectedBet, loss, win]) await submit(body);
    const cases: Array<[Input, string]> = [
      [{ ...refund(target, bet), money: { amount: "24.99", currency: "BRL" } }, "REFERENCE_AMOUNT_MISMATCH"],
      [{ ...refund(target, bet), roundId: "another-round" }, "REFERENCE_MISMATCH"],
      [refund(target, otherBet), "REFERENCE_MISMATCH"],
      [{ ...refund(target, loss), money: { amount: "1.00", currency: "BRL" } }, "REFERENCE_KIND_MISMATCH"],
      [refund(target, win), "REFERENCE_KIND_MISMATCH"],
      [refund(target, rejectedBet), "REFERENCE_NOT_PROCESSED"],
    ];
    for (const [body, failureCode] of cases) {
      const response = await submit(body);
      expect(response.status).toBe(422);
      const result = await response.json() as Result;
      expect(result).toMatchObject({ status: "REJECTED", failureCode, balance: { amount: "76.00" } });
      expect(await (await submit(body, 1)).json()).toEqual({ ...result, idempotentReplay: true });
      expect(await eventTypes(result.transactionId)).toEqual(["WagerTransactionRejected"]);
      expect(await rows("select id from wallet_ledger where transaction_id = ?", [result.transactionId])).toEqual([]);
    }
    const valid = await submit(refund(target, bet));
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ status: "PROCESSED", balance: { amount: "101.00" } });

    const missingReference = input(target, "REFUND");
    const body = refund(target, bet);
    const before = await snapshot(target.id);
    for (const invalid of [missingReference,
      { ...body, referenceExternalTransactionId: "" }, { ...body, referenceExternalTransactionId: null },
      { ...body, referenceExternalTransactionId: "invalid reference" },
      { ...body, referenceExternalTransactionId: body.externalTransactionId },
      ...["0.00", "-0.01", "1.001", 25].map((amount) => ({ ...body, money: { amount, currency: "BRL" } })),
      { ...body, money: { amount: "25.00", currency: "USD" } },
    ]) expect((await request("/wagering/transactions", invalid, 0, crypto.randomUUID())).status).toBe(400);
    expect(await snapshot(target.id)).toEqual(before);
  });

  test("an overflowing refund stays rejected and does not consume the BET reversal", async () => {
    const target = await wallet("999999999999999999.99");
    const bet = input(target, "BET", "0.01");
    expect((await submit(bet)).status).toBe(200);
    expect((await submit(input(target, "WIN", "0.01"))).status).toBe(200);
    const body = refund(target, bet);
    const response = await submit(body);
    expect(response.status).toBe(422);
    const rejected = await response.json() as Result;
    expect(rejected).toMatchObject({ status: "REJECTED", failureCode: "BALANCE_LIMIT_EXCEEDED",
      balance: { amount: "999999999999999999.99" } });
    expect(await eventTypes(rejected.transactionId)).toEqual(["WagerTransactionRejected"]);
    expect(await rows("select id from wallet_ledger where transaction_id = ?", [rejected.transactionId])).toEqual([]);
    expect((await submit(input(target, "BET", "0.01"))).status).toBe(200);
    expect(await (await submit(body, 1)).json()).toEqual({ ...rejected, idempotentReplay: true });
    const corrected = await submit(refund(target, bet), 2);
    expect(corrected.status).toBe(200);
    expect(await corrected.json()).toMatchObject({ balance: { amount: "999999999999999999.99" } });
  });

  test("provider-scoped missing refunds expire after ten scheduled checks without financial effects", async () => {
    const target = await wallet();
    const otherProviderBet = { ...input(target, "BET"), providerId: "provider-b" };
    expect((await submit(otherProviderBet)).status).toBe(200);
    const body = refund(target, otherProviderBet);
    const response = await submit(body);
    expect(response.status).toBe(202);
    const accepted = await response.json() as Result;
    const beforeWallet = await rows("select * from wallets where id = ?", [target.id]);
    for (let attempt = 1; attempt <= 10; attempt++) {
      const next = await due(accepted.transactionId);
      expect(await processWager.reprocessNext(new Date(next.getTime() - 1))).toBeNull();
      await processWager.reprocessNext(next);
      const record = (await rows<{ status: string; reference_attempts: number; next_reference_attempt_at: string | null }>(
        "select status, reference_attempts, next_reference_attempt_at from wager_transactions where id = ?", [accepted.transactionId]))[0]!;
      expect(record.reference_attempts).toBe(attempt);
      expect(record.status).toBe(attempt === 10 ? "REJECTED" : "PENDING_REFERENCE");
      if (attempt < 10) expect(new Date(record.next_reference_attempt_at!).getTime() - next.getTime()).toBe(Math.min(60, 2 ** attempt) * 1_000);
    }
    expect(await rows("select * from wallets where id = ?", [target.id])).toEqual(beforeWallet);
    expect(await rows("select id from wallet_ledger where transaction_id = ?", [accepted.transactionId])).toEqual([]);
    expect(await eventTypes(accepted.transactionId)).toEqual(["WagerTransactionPendingReference", "WagerTransactionRejected"]);
    const expired = await submit(body);
    expect(expired.status).toBe(422);
    expect(await expired.json()).toMatchObject({ failureCode: "REFERENCE_NOT_FOUND", balance: { amount: "75.00" }, idempotentReplay: true });
  });

  test("SQS refunds before their BET are acknowledged and three restarted workers settle competing reversals once", async () => {
    const cases: Array<{ target: WalletResponse; messages: Array<ReturnType<typeof envelope>> }> = [];
    for (let index = 0; index < 3; index++) {
      const target = await wallet();
      const bet = input(target, "BET");
      const messages = [envelope(refund(target, bet)), envelope(refund(target, bet))];
      for (const message of messages) await send(message);
      await send(messages[0]!);
      await send(envelope(bet));
      cases.push({ target, messages });
    }
    await drained();
    for (const { target } of cases) {
      const before = await snapshot(target.id);
      expect(before.inbox).toHaveLength(3);
      expect(before.inbox.every((record) => record.processed_at !== null)).toBe(true);
      expect(before.transactions.filter((record) => record.status === "PENDING_REFERENCE")).toHaveLength(2);
      expect(before.wallet).toEqual([expect.objectContaining({ balance: "75.00", version: 2 })]);
      expect(before.ledger).toHaveLength(2);
    }
    for (const application of applications) application.child.kill("SIGKILL");
    await Promise.all(applications.map(({ child }) => deadline(child.exited, 5_000, "Application did not stop")));
    applications = [];
    // Holding the wallets makes all three workers start before any can claim recovery work.
    let release: () => void = () => {};
    let acquired: () => void = () => {};
    const lockAcquired = new Promise<void>((resolve) => { acquired = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const holder = orm.em.fork().transactional(async (em) => {
      await em.execute("select id from wallets order by id for update");
      acquired();
      await hold;
    });
    try {
      await deadline(lockAcquired, 5_000, "Test did not acquire wallet locks");
      for (let index = 0; index < 3; index++) {
        applications.push(await startApplication(children, { ...environment(), REFERENCE_WORKER_ENABLED: "true" }));
      }
      expect(new Set(applications.map(({ child }) => child.pid)).size).toBe(3);
      expect(await rows("select id from wager_transactions where status = 'PENDING_REFERENCE'")).toHaveLength(6);
    } finally { release(); await holder; }
    await eventually(() => rows("select id from wager_transactions where status = 'PENDING_REFERENCE'"), (records) => records.length === 0);
    for (const { target, messages } of cases) {
      const after = await snapshot(target.id);
      expect(after.wallet).toEqual([expect.objectContaining({ balance: "100.00", version: 3 })]);
      expect(after.ledger).toHaveLength(3);
      const refunds = after.transactions.filter((record) => record.kind === "REFUND");
      expect(refunds.filter((record) => record.status === "PROCESSED")).toHaveLength(1);
      expect(refunds.filter((record) => record.failure_code === "REFERENCE_ALREADY_REFUNDED")).toHaveLength(1);
      for (const transaction of refunds) {
        expect(await eventTypes(transaction.id as string)).toEqual(transaction.status === "PROCESSED"
          ? ["WagerTransactionPendingReference", "WagerTransactionProcessed", "WalletBalanceChanged"]
          : ["WagerTransactionPendingReference", "WagerTransactionRejected"]);
      }
      for (const message of messages) await send(message);
      await drained();
      expect(await snapshot(target.id)).toEqual(after);
    }
  }, 45_000);

  test("outbox failures roll back inbox acceptance and refund finalization without reserving the BET", async () => {
    const target = await wallet();
    const bet = input(target, "BET");
    const body = refund(target, bet);
    const delivery = { messageId: crypto.randomUUID(), consumerName: "wager-transactions", receivedAt: new Date(), correlationId: crypto.randomUUID() };
    async function failOutbox(): Promise<void> {
      await rows(`create function test_refund_outbox_failure() returns trigger language plpgsql as $$
        begin raise exception 'injected serialization failure' using errcode = '40001'; end $$`);
      await rows("create trigger test_refund_outbox_failure before insert on outbox_messages for each row execute function test_refund_outbox_failure()");
    }
    async function restoreOutbox(): Promise<void> {
      await rows("drop trigger test_refund_outbox_failure on outbox_messages");
      await rows("drop function test_refund_outbox_failure()");
    }
    const before = await snapshot(target.id);
    await failOutbox();
    try {
      await expect(processWager.execute(body, key(body), delivery)).rejects.toMatchObject({ retryable: true });
      expect(await snapshot(target.id)).toEqual(before);
      expect(await rows("select * from inbox_messages where message_id = ?", [delivery.messageId])).toEqual([]);
    } finally { await restoreOutbox(); }
    const accepted = await processWager.execute(body, key(body), delivery);
    expect(accepted.status).toBe("PENDING_REFERENCE");
    expect((await submit(bet)).status).toBe(200);
    const committed = await snapshot(target.id);
    const next = await due(accepted.transactionId);
    await failOutbox();
    try {
      await expect(processWager.reprocessNext(next)).rejects.toMatchObject({ retryable: true });
      expect(await snapshot(target.id)).toEqual(committed);
    } finally { await restoreOutbox(); }
    await processWager.reprocessNext(next);
    const finalized = await snapshot(target.id);
    expect(finalized.inbox).toEqual(committed.inbox);
    expect(finalized.wallet).toEqual([expect.objectContaining({ balance: "100.00", version: 3 })]);
    expect(finalized.ledger).toHaveLength(3);
    expect(await processWager.execute(body, key(body), delivery)).toMatchObject({ status: "PROCESSED", idempotentReplay: true });
    expect(await snapshot(target.id)).toEqual(finalized);
  });

  test("migration 006 roundtrips referenced WIN history and refuses to discard pending refunds", async () => {
    const target = await wallet();
    const bet = input(target, "BET");
    await send(envelope(bet));
    await drained();
    await send(envelope({ ...input(target, "WIN", "1.00"), roundId: bet.roundId,
      referenceExternalTransactionId: bet.externalTransactionId }));
    await drained();
    const pendingWin = { ...input(target, "WIN", "1.00"), referenceExternalTransactionId: crypto.randomUUID() };
    expect((await submit(pendingWin)).status).toBe(202);
    const before = await snapshot(target.id);
    await orm.getMigrator().down({ to: "Migration202610100006" });
    expect((await orm.getMigrator().getPendingMigrations()).map(({ name }) => name)).toEqual(["Migration202610100006", "Migration202610100007", "Migration202610100008", "Migration202610120001"]);
    expect(await snapshot(target.id)).toEqual(before);
    await orm.getMigrator().up();
    expect(await snapshot(target.id)).toEqual(before);
    expect((await submit(refund(target, input(target, "BET")))).status).toBe(202);
    const withRefund = await snapshot(target.id);
    await expect(orm.getMigrator().down({ to: "Migration202610100006" })).rejects.toThrow();
    expect(await snapshot(target.id)).toEqual(withRefund);
    expect(await orm.getMigrator().getPendingMigrations()).toHaveLength(0);
  });

  test("database guards require references, exact amounts, unique successful refunds and credit ledger direction", async () => {
    const target = await wallet();
    const bet = input(target, "BET");
    const betResult = await (await submit(bet)).json() as Result;
    const pending = await (await submit(refund(target, input(target, "BET")))).json() as Result;
    const before = await snapshot(target.id);
    const columns = `id, wallet_id, player_id, currency, amount, idempotency_key, kind, status, created_at, processed_at,
      provider_id, external_transaction_id, round_id, game_id, payload_hash, result_balance, failure_code,
      reference_external_transaction_id, reference_transaction_id, reference_attempts, next_reference_attempt_at, processing_correlation_id`;
    for (const [amount, reference, status, next] of [
      ["amount", "null", "'PROCESSED'", "null"],
      ["'0.00'", "reference_external_transaction_id", "status", "next_reference_attempt_at"],
    ]) {
      await expect(rows(`insert into wager_transactions (${columns})
        select ?, wallet_id, player_id, currency, ${amount}, ?, kind, ${status}, created_at,
          ${status === "status" ? "processed_at" : "now()"}, provider_id, ?, round_id, game_id, payload_hash, result_balance,
          failure_code, ${reference}, reference_transaction_id, reference_attempts, ${next}, processing_correlation_id
        from wager_transactions where id = ?`,
      [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), pending.transactionId])).rejects.toMatchObject({ code: "23514" });
    }

    async function insertRefund(em: Orm["em"], id: string, amount: string): Promise<void> {
      await em.execute(`insert into wager_transactions (${columns})
        select ?, wallet_id, player_id, currency, ?, ?, 'REFUND', 'PROCESSED', now(), now(), provider_id, ?,
          round_id, game_id, payload_hash, '100.00', null, external_transaction_id, id, 0, null, ?
        from wager_transactions where id = ?`,
      [id, amount, crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), betResult.transactionId]);
    }
    await expect(orm.em.fork().transactional((em) => insertRefund(em, crypto.randomUUID(), "24.99")))
      .rejects.toMatchObject({ code: "23514", message: expect.stringContaining("Reversal amount must equal the referenced transaction amount") });
    const wrongDirectionId = crypto.randomUUID();
    await expect(orm.em.fork().transactional(async (em) => {
      await insertRefund(em, wrongDirectionId, "25.00");
      await em.execute(`insert into wallet_ledger
        (id, wallet_id, transaction_id, direction, currency, amount, balance_before, balance_after, created_at)
        select ?, wallet_id, id, 'DEBIT', currency, amount, '75.00', '50.00', now()
        from wager_transactions where id = ?`, [crypto.randomUUID(), wrongDirectionId]);
    })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("Ledger direction does not match the transaction and reference kinds") });
    expect(await snapshot(target.id)).toEqual(before);
    const processed = await (await submit(refund(target, bet))).json() as Result;
    expect(processed.status).toBe("PROCESSED");
    await expect(orm.em.fork().transactional((em) => insertRefund(em, crypto.randomUUID(), "25.00")))
      .rejects.toMatchObject({ code: "23505", message: expect.stringContaining("wager_transactions_refund_reference_unique") });
    const finalized = await snapshot(target.id);
    for (const assignment of ["amount = '24.99'", "reference_transaction_id = null", "status = 'PENDING_REFERENCE'"]) {
      await expect(rows(`update wager_transactions set ${assignment} where id = ?`, [processed.transactionId])).rejects.toThrow();
    }
    await expect(rows("delete from wager_transactions where id = ?", [processed.transactionId])).rejects.toThrow();
    await expect(orm.getMigrator().down({ to: "Migration202610100006" })).rejects.toThrow();
    expect(await snapshot(target.id)).toEqual(finalized);
  });
});
