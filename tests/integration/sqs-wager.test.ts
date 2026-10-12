import { assertAccountingConsistent } from "./accounting-audit.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, GetQueueAttributesCommand,
  ReceiveMessageCommand, SendMessageCommand, SQSClient, type Message,
} from "@aws-sdk/client-sqs";
import { fileURLToPath } from "node:url";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client.js";
import {
  deadline, isolatedDatabaseUrl, resetTestDatabase, startApplication, stop,
  type Application, type Child, type Orm, type WalletResponse,
} from "./helpers.js";

const integration = process.env.RUN_DATABASE_INTEGRATION === "1" && process.env.RUN_SQS_INTEGRATION === "1"
  ? describe : describe.skip;
const root = fileURLToPath(new URL("../../", import.meta.url));
const endpoint = process.env.TEST_SQS_ENDPOINT ?? "http://127.0.0.1:4567";
interface WagerBody {
  providerId: string; externalTransactionId: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: "BET"; money: { amount: string; currency: string };
}
interface RequestEnvelope {
  messageId: string; type: "WagerTransactionRequested"; occurredAt: string;
  data: WagerBody & { idempotencyKey: string };
}

integration("SQS wagers with a persistent inbox and independent application processes", () => {
  let orm: Orm;
  let client: SQSClient;
  let application: Application;
  let queueUrl: string;
  let dlqUrl: string;
  const children: Child[] = [];

  function rows<T = Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    return orm.em.getConnection().execute<T[]>(sql, parameters);
  }

  async function eventually<T>(read: () => Promise<T>, ready: (result: T) => boolean, timeout = 15_000): Promise<T> {
    const expires = Date.now() + timeout;
    let result: T;
    do {
      result = await read();
      if (ready(result)) return result;
      await Bun.sleep(25);
    } while (Date.now() < expires);
    throw new Error(`Expected asynchronous wager processing to finish: ${JSON.stringify(result)}`);
  }

  function consumerEnvironment(deadLetterQueue = dlqUrl): Record<string, string> {
    return { SQS_CONSUMER_ENABLED: "true", SQS_ENDPOINT: endpoint,
      SQS_WAGER_QUEUE_URL: queueUrl, SQS_WAGER_DLQ_URL: deadLetterQueue, SQS_VISIBILITY_TIMEOUT_SECONDS: "2" };
  }

  async function wallet(amount = "100.00"): Promise<WalletResponse> {
    const response = await fetch(`${application.url}/wallets`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId: crypto.randomUUID(), initialBalance: { amount, currency: "BRL" } }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(response.status).toBe(201);
    return response.json() as Promise<WalletResponse>;
  }

  function envelope(target: WalletResponse, amount = "25.00"): RequestEnvelope {
    const externalTransactionId = crypto.randomUUID();
    return { messageId: crypto.randomUUID(), type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
      data: { providerId: "provider-a", externalTransactionId, idempotencyKey: `provider-a:${externalTransactionId}`,
        playerId: target.playerId, walletId: target.id, roundId: crypto.randomUUID(), gameId: "fortune-chimp",
        kind: "BET", money: { amount, currency: "BRL" } } };
  }

  function send(body: RequestEnvelope | string, groupId?: string): Promise<unknown> {
    return client.send(new SendMessageCommand({ QueueUrl: queueUrl,
      MessageBody: typeof body === "string" ? body : JSON.stringify(body),
      MessageGroupId: groupId ?? (typeof body === "string" ? crypto.randomUUID() : body.data.walletId),
      // Deliberately bypass FIFO deduplication: correctness must come from PostgreSQL.
      MessageDeduplicationId: crypto.randomUUID(),
    }));
  }

  async function submitHttp(message: RequestEnvelope): Promise<Response> {
    const { idempotencyKey, ...body } = message.data;
    return fetch(`${application.url}/wagering/transactions`, {
      method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
  }

  async function pending(): Promise<number> {
    const response = await client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }));
    return Number(response.Attributes?.ApproximateNumberOfMessages ?? "0")
      + Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? "0");
  }

  async function drained(): Promise<void> {
    await eventually(pending, (count) => count === 0);
  }

  async function inbox(count: number): Promise<Record<string, unknown>[]> {
    return eventually(() => rows("select * from inbox_messages order by message_id"), (records) => records.length === count);
  }

  async function receiveDeadLetters(count: number): Promise<Message[]> {
    const messages: Message[] = [];
    await eventually(async () => {
      const result = await client.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl,
        MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ["All"] }));
      for (const message of result.Messages ?? []) {
        if (!message.ReceiptHandle) throw new Error("SQS returned a message without a receipt handle");
        messages.push(message);
        await client.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: message.ReceiptHandle }));
      }
      return messages;
    }, (received) => received.length >= count, 20_000);
    expect(messages).toHaveLength(count);
    return messages;
  }

  async function snapshot(walletId: string) {
    return { wallet: await rows("select * from wallets where id = ?", [walletId]),
      transactions: await rows("select * from wager_transactions where wallet_id = ? order by id", [walletId]),
      ledger: await rows("select * from wallet_ledger where wallet_id = ? order by id", [walletId]),
      outbox: await rows("select * from outbox_messages where aggregate_id = ? order by id", [walletId]) };
  }

  beforeAll(() => {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)
      || url.port !== "4567" || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("SQS wager tests require the isolated local MiniStack endpoint on port 4567");
    }
    client = createSqsClient(endpoint);
  });

  beforeEach(async () => {
    orm = await resetTestDatabase();
    const suffix = crypto.randomUUID();
    const dlq = await client.send(new CreateQueueCommand({ QueueName: `wager-test-dlq-${suffix}.fifo`,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } }));
    if (!dlq.QueueUrl) throw new Error("MiniStack did not return the DLQ URL");
    dlqUrl = dlq.QueueUrl;
    const attributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }));
    const created = await client.send(new CreateQueueCommand({ QueueName: `wager-test-${suffix}.fifo`,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false", VisibilityTimeout: "2",
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: attributes.Attributes?.QueueArn, maxReceiveCount: "5" }) } }));
    if (!created.QueueUrl) throw new Error("MiniStack did not return the input queue URL");
    queueUrl = created.QueueUrl;
    application = await startApplication(children);
  });

  afterEach(async () => {
    await Promise.all(children.splice(0).map(stop));
    if (orm) {
      expect(await rows(`select w.id from wallets w left join wallet_ledger l on l.wallet_id = w.id
        group by w.id having w.balance <> coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)`)).toEqual([]);
      try { await assertAccountingConsistent(orm); } finally { await orm.close(true); }
    }
    if (queueUrl) await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    if (dlqUrl) await client.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
  });

  afterAll(() => { client?.destroy(); });

  test("three consumers deduplicate 50 broker deliveries, share HTTP idempotency and process independent wallet groups", async () => {
    const consumers = await Promise.all(Array.from({ length: 3 }, () => startApplication(children, consumerEnvironment())));
    expect(new Set(consumers.map(({ child }) => child.pid)).size).toBe(3);
    const target = await wallet();
    const message = envelope(target);
    await Promise.all(Array.from({ length: 50 }, () => send(message)));
    await drained();
    const [receipt] = await inbox(1);
    expect(receipt).toMatchObject({ message_id: message.messageId, consumer_name: "wager-transactions",
      processed_at: expect.anything(), transaction_id: expect.any(String) });
    expect(await rows("select balance, version from wallets where id = ?", [target.id])).toEqual([{ balance: "75.00", version: 2 }]);
    expect(await rows("select id from wallet_ledger where wallet_id = ? and direction = 'DEBIT'", [target.id])).toHaveLength(1);
    expect(await rows("select id from outbox_messages where aggregate_id = ?", [target.id])).toHaveLength(4);
    const replay = await submitHttp(message);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ transactionId: receipt!.transaction_id, idempotentReplay: true,
      balance: { amount: "75.00", currency: "BRL" } });

    await Promise.all(Array.from({ length: 3 }, () => send({ ...message, messageId: crypto.randomUUID() })));
    await drained();
    expect(await inbox(4)).toHaveLength(4);
    const independent = await Promise.all(Array.from({ length: 3 }, () => wallet("12.34")));
    await Promise.all(independent.map((item) => send(envelope(item, "2.34"))));
    await drained();
    for (const item of independent) {
      expect(await rows("select balance, version from wallets where id = ?", [item.id])).toEqual([{ balance: "10.00", version: 2 }]);
    }
    const httpFirst = envelope(await wallet());
    expect((await submitHttp(httpFirst)).status).toBe(200);
    await send(httpFirst);
    await drained();
    expect(await inbox(8)).toHaveLength(8);
    expect(await rows("select id from wallet_ledger where wallet_id = ? and direction = 'DEBIT'", [httpFirst.data.walletId])).toHaveLength(1);
  }, 45_000);

  test("two queued bets of 80 against 100 persist one rejection, acknowledge both and preserve original replay balances", async () => {
    await Promise.all(Array.from({ length: 3 }, () => startApplication(children, consumerEnvironment())));
    const target = await wallet();
    const messages = [envelope(target, "80.00"), envelope(target, "80.00")];
    await Promise.all(messages.map((message) => send(message)));
    await drained();
    expect(await inbox(2)).toHaveLength(2);
    expect(await rows("select status, failure_code from wager_transactions where wallet_id = ? and kind = 'BET' order by status", [target.id])).toEqual([
      { status: "PROCESSED", failure_code: null }, { status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" },
    ]);
    expect(await rows("select balance, version from wallets where id = ?", [target.id])).toEqual([{ balance: "20.00", version: 2 }]);
    expect(await rows("select id from wallet_ledger where wallet_id = ? and direction = 'DEBIT'", [target.id])).toHaveLength(1);
    expect(await rows("select id from outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionRejected'", [target.id])).toHaveLength(1);
    expect((await submitHttp(envelope(target, "5.00"))).status).toBe(200);
    const before = await snapshot(target.id);
    for (const message of messages) {
      const replay = await submitHttp(message);
      expect([200, 422]).toContain(replay.status);
      expect(await replay.json()).toMatchObject({ idempotentReplay: true, balance: { amount: "20.00", currency: "BRL" } });
      await send(message);
    }
    await drained();
    expect(await snapshot(target.id)).toEqual(before);
    expect(await inbox(2)).toHaveLength(2);
  }, 30_000);

  test("HTTP and SQS racing for the same wager commit one debit and a completed inbox", async () => {
    await startApplication(children, consumerEnvironment());
    const target = await wallet();
    const message = envelope(target);
    let release: () => void = () => {};
    let acquired: () => void = () => {};
    const locked = new Promise<void>((resolve) => { acquired = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = orm.em.fork().transactional(async (em) => {
      await em.execute("select id from wallets where id = ? for update", [target.id]);
      acquired();
      await held;
    });
    let http: Promise<Response> | undefined;
    try {
      await deadline(locked, 5_000, "The test wallet lock was not acquired");
      await send(message);
      http = submitHttp(message);
      await eventually(() => rows("select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'"),
        (records) => records.length >= 2);
    } finally {
      release();
      await holder;
    }
    const response = await http!;
    expect(response.status).toBe(200);
    const result = await response.json() as { transactionId: string };
    await drained();
    expect(await inbox(1)).toEqual([expect.objectContaining({ transaction_id: result.transactionId, processed_at: expect.anything() })]);
    expect(await rows("select balance, version from wallets where id = ?", [target.id])).toEqual([{ balance: "75.00", version: 2 }]);
    expect(await rows("select id from wallet_ledger where wallet_id = ? and direction = 'DEBIT'", [target.id])).toHaveLength(1);
    expect(await rows("select id from outbox_messages where aggregate_id = ?", [target.id])).toHaveLength(4);
    expect(await (await submitHttp(message)).json()).toMatchObject({ transactionId: result.transactionId,
      idempotentReplay: true, balance: { amount: "75.00", currency: "BRL" } });
  }, 30_000);

  test("malformed messages, shared validation failures and conflicting inbox identities reach the DLQ without financial changes", async () => {
    await startApplication(children, consumerEnvironment());
    const target = await wallet();
    const accepted = envelope(target);
    await send(accepted);
    await drained();
    const before = await snapshot(target.id);
    const invalid = ["not JSON", JSON.stringify({ ...envelope(target), data: { ...accepted.data, money: { amount: 25, currency: "BRL" } } }),
      JSON.stringify({ ...envelope(target), data: { ...accepted.data, providerId: "" } }),
      JSON.stringify({ ...accepted, data: { ...accepted.data, money: { amount: "26.00", currency: "BRL" } } })];
    await Promise.all(invalid.map((body) => send(body, target.id)));
    const wrongGroup = envelope(target);
    await send(wrongGroup, crypto.randomUUID());
    const otherWallet = await wallet();
    const conflictingKey = envelope(otherWallet);
    conflictingKey.data.idempotencyKey = accepted.data.idempotencyKey;
    await send(conflictingKey);
    const deadLetters = await receiveDeadLetters(6);
    expect(deadLetters.map((item) => item.Body).sort()).toEqual([...invalid, JSON.stringify(wrongGroup), JSON.stringify(conflictingKey)].sort());
    for (const item of deadLetters) expect(item.MessageAttributes?.FailureCode?.StringValue).toBeString();
    await drained();
    expect(await snapshot(target.id)).toEqual(before);
    expect(await rows("select balance, version from wallets where id = ?", [otherWallet.id])).toEqual([{ balance: "100.00", version: 1 }]);
    expect(await inbox(1)).toHaveLength(1);
  }, 30_000);

  test("a transient outbox failure rolls back inbox and finances, backs off, and recovers after the database failure ends", async () => {
    const target = await wallet();
    const message = envelope(target);
    const before = await snapshot(target.id);
    await rows("create sequence test_sqs_outbox_attempts");
    await rows(`create function test_sqs_outbox_failure() returns trigger language plpgsql as $$
      begin perform nextval('test_sqs_outbox_attempts'); raise exception 'injected serialization failure' using errcode = '40001'; end $$`);
    await rows("create trigger test_sqs_outbox_failure before insert on outbox_messages for each row execute function test_sqs_outbox_failure()");
    try {
      await startApplication(children, consumerEnvironment());
      const started = Date.now();
      await send(message);
      await eventually(() => rows<{ last_value: string }>("select last_value::text from test_sqs_outbox_attempts"),
        (records) => Number(records[0]?.last_value) >= 2);
      expect(Date.now() - started).toBeGreaterThanOrEqual(800);
      expect(await snapshot(target.id)).toEqual(before);
      expect(await rows("select * from inbox_messages")).toEqual([]);
      expect(await pending()).toBe(1);
    } finally {
      await rows("drop trigger test_sqs_outbox_failure on outbox_messages");
      await rows("drop function test_sqs_outbox_failure()");
    }
    await drained();
    expect(await inbox(1)).toHaveLength(1);
    expect(await rows("select balance, version from wallets where id = ?", [target.id])).toEqual([{ balance: "75.00", version: 2 }]);
    expect(await rows("select id from wallet_ledger where wallet_id = ? and direction = 'DEBIT'", [target.id])).toHaveLength(1);
  }, 30_000);

  test("repeated transient failures exhaust the bounded retry budget and preserve the original message in the DLQ", async () => {
    const target = await wallet();
    const message = envelope(target);
    const before = await snapshot(target.id);
    await rows("create sequence test_sqs_retry_attempts");
    await rows(`create function test_sqs_retry_failure() returns trigger language plpgsql as $$
      begin perform nextval('test_sqs_retry_attempts'); raise exception 'injected serialization failure' using errcode = '40001'; end $$`);
    await rows("create trigger test_sqs_retry_failure before insert on outbox_messages for each row execute function test_sqs_retry_failure()");
    try {
      await startApplication(children, consumerEnvironment());
      await send(message);
      const [deadLetter] = await receiveDeadLetters(1);
      expect(deadLetter!.Body).toBe(JSON.stringify(message));
      expect(await rows("select last_value::text from test_sqs_retry_attempts")).toEqual([{ last_value: "5" }]);
      expect(await snapshot(target.id)).toEqual(before);
      expect(await rows("select * from inbox_messages")).toEqual([]);
      await drained();
    } finally {
      await rows("drop trigger test_sqs_retry_failure on outbox_messages");
      await rows("drop function test_sqs_retry_failure()");
    }
  }, 30_000);

  test("a consumer killed after commit and before acknowledgment redelivers without a second debit", async () => {
    const target = await wallet();
    const message = envelope(target);
    await send(message);
    const child = Bun.spawn([process.execPath, "tests/fixtures/pause-before-sqs-ack.ts"], {
      cwd: root, env: { ...process.env, DATABASE_URL: isolatedDatabaseUrl(), ...consumerEnvironment() },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    children.push(child);
    let output = "";
    let announce: () => void = () => {};
    const committed = new Promise<void>((resolve) => { announce = resolve; });
    const reader = child.stdout.getReader();
    void (async () => {
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return;
        output += decoder.decode(chunk.value, { stream: true });
        if (output.includes('"event":"sqs_ack_paused"')) announce();
      }
    })();
    void new Response(child.stderr).text().then((text) => { output += text; });
    await deadline(Promise.race([committed,
      child.exited.then((code) => { throw new Error(`SQS crash fixture exited with ${code}: ${output}`); }),
    ]), 15_000, "The consumer did not reach the acknowledgment barrier");
    expect(await inbox(1)).toHaveLength(1);
    const before = await snapshot(target.id);
    expect(before.wallet).toEqual([expect.objectContaining({ balance: "75.00", version: 2 })]);
    child.kill("SIGKILL");
    await deadline(child.exited, 5_000, "The consumer did not exit after SIGKILL");
    await startApplication(children, consumerEnvironment());
    await drained();
    expect(await snapshot(target.id)).toEqual(before);
    expect(await inbox(1)).toHaveLength(1);
  }, 30_000);

  test("a failed DLQ send keeps the source delivery until a healthy consumer can transfer it", async () => {
    const missingUrl = queueUrl.replace(/\/[^/]+$/, `/missing-${crypto.randomUUID()}.fifo`);
    const consumer = await startApplication(children, consumerEnvironment(missingUrl));
    await send("not JSON");
    await Bun.sleep(1_500);
    expect(await pending()).toBe(1);
    expect(await rows("select * from inbox_messages")).toEqual([]);
    await stop(consumer.child);
    await startApplication(children, consumerEnvironment());
    const [deadLetter] = await receiveDeadLetters(1);
    expect(deadLetter!.Body).toBe("not JSON");
    await drained();
  }, 30_000);

  // Windows TerminateProcess does not dispatch SIGTERM to Bun's JavaScript signal handlers.
  test.skipIf(process.platform === "win32")("SIGTERM finishes an in-flight wager before closing PostgreSQL and acknowledging the message", async () => {
    const target = await wallet();
    const consumer = await startApplication(children, consumerEnvironment());
    let release: () => void = () => {};
    let acquired: () => void = () => {};
    const locked = new Promise<void>((resolve) => { acquired = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = orm.em.fork().transactional(async (em) => {
      await em.execute("select id from wallets where id = ? for update", [target.id]);
      acquired();
      await held;
    });
    try {
      await deadline(locked, 5_000, "The test wallet lock was not acquired");
      await send(envelope(target));
      await eventually(() => rows("select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'"),
        (records) => records.length > 0);
      consumer.child.kill("SIGTERM");
      // Give the signal handler a chance to start while financial processing is still in flight.
      await Bun.sleep(100);
      expect(consumer.child.exitCode).toBeNull();
    } finally {
      release();
      await holder;
    }
    await deadline(consumer.child.exited, 10_000, "The consumer did not finish graceful shutdown");
    expect(await inbox(1)).toHaveLength(1);
    expect(await pending()).toBe(0);
    expect(await rows("select balance, version from wallets where id = ?", [target.id])).toEqual([{ balance: "75.00", version: 2 }]);
  }, 30_000);

  test("migration 003 reverses an empty inbox but refuses to erase committed delivery history", async () => {
    const target = await wallet();
    const before = await snapshot(target.id);
    await orm.getMigrator().down({ to: "Migration202610100003" });
    expect(await rows("select to_regclass('public.inbox_messages')::text as relation")).toEqual([{ relation: null }]);
    await orm.getMigrator().up();
    expect(await snapshot(target.id)).toEqual(before);
    await startApplication(children, consumerEnvironment());
    await send(envelope(target));
    await drained();
    const receipts = await inbox(1);
    const committed = await snapshot(target.id);
    await expect(rows("insert into inbox_messages select * from inbox_messages")).rejects.toThrow("inbox_messages_pkey");
    await expect(rows("update inbox_messages set payload_hash = repeat('a', 64)")).rejects.toThrow("Processed inbox messages are immutable");
    await expect(rows("delete from inbox_messages")).rejects.toThrow("Processed inbox messages are immutable");
    await expect(rows("truncate inbox_messages")).rejects.toThrow("Inbox messages cannot be truncated");
    await expect(orm.getMigrator().down({ to: "Migration202610100003" })).rejects.toThrow();
    expect(await rows("select * from inbox_messages order by message_id")).toEqual(receipts);
    expect(await snapshot(target.id)).toEqual(committed);
    expect(await orm.getMigrator().getPendingMigrations()).toHaveLength(0);
  }, 30_000);
});
