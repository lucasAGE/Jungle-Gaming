import { assertAccountingConsistent } from "./accounting-audit.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, ReceiveMessageCommand, SQSClient,
} from "@aws-sdk/client-sqs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client.js";
import {
  deadline, isolatedDatabaseUrl, resetTestDatabase, startApplication, stop,
  type Application, type Child, type Orm, type WalletResponse,
} from "./helpers.js";

const integration = process.env.RUN_DATABASE_INTEGRATION === "1" && process.env.RUN_SQS_INTEGRATION === "1"
  ? describe : describe.skip;
const root = fileURLToPath(new URL("../../", import.meta.url));
const sqsEndpoint = process.env.TEST_SQS_ENDPOINT ?? "http://127.0.0.1:4567";
interface Envelope {
  eventId: string; eventType: string; aggregateId: string; correlationId: string;
  occurredAt: string; version: number; data: Record<string, unknown>;
}
interface OutboxRow {
  id: string; payload: Envelope; attempts: number; published_at: string | null; next_attempt_at: string | null;
}

integration("transactional outbox with real PostgreSQL, MiniStack SQS and independent publishers", () => {
  let orm: Orm;
  let application: Application;
  let client: SQSClient;
  let queueUrl: string;
  const children: Child[] = [];
  const publishers: Child[] = [];

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
    throw new Error(`Expected the asynchronous operation to finish: ${JSON.stringify(result)}`);
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

  function outbox(walletId: string): Promise<OutboxRow[]> {
    return rows<OutboxRow>("select * from outbox_messages where aggregate_id = ? order by id", [walletId]);
  }

  async function published(walletId: string, count: number): Promise<OutboxRow[]> {
    return eventually(() => outbox(walletId), (records) =>
      records.length === count && records.every((record) => record.published_at !== null));
  }

  function publisherEnvironment(endpoint = sqsEndpoint): Record<string, string> {
    return { OUTBOX_PUBLISHER_ENABLED: "true", SQS_ENDPOINT: endpoint, SQS_EVENTS_QUEUE_URL: queueUrl };
  }

  async function startPublisher(endpoint = sqsEndpoint): Promise<Application> {
    return startApplication(publishers, publisherEnvironment(endpoint));
  }

  async function receive(): Promise<Envelope[]> {
    const result = await client.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 10,
    }));
    const envelopes: Envelope[] = [];
    for (const message of result.Messages ?? []) {
      if (!message.Body || !message.ReceiptHandle) throw new Error("SQS returned an incomplete event");
      envelopes.push(JSON.parse(message.Body) as Envelope);
      await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
    return envelopes;
  }

  async function receiveCount(count: number): Promise<Envelope[]> {
    const envelopes: Envelope[] = [];
    await eventually(async () => { envelopes.push(...await receive()); return envelopes; },
      (received) => received.length >= count);
    expect(envelopes).toHaveLength(count);
    return envelopes;
  }

  async function assertReconciled(): Promise<void> {
    const records = await rows<{ id: string; balance: string; calculated: string }>(`
      select w.id, w.balance::text as balance,
        coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as calculated
      from wallets w left join wallet_ledger l on l.wallet_id = w.id group by w.id
    `);
    for (const record of records) expect(record.balance).toBe(record.calculated);
  }

  beforeAll(async () => {
    const endpoint = new URL(sqsEndpoint);
    if (endpoint.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(endpoint.hostname)
      || endpoint.port !== "4567" || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
      throw new Error("Outbox integration tests require the isolated local MiniStack endpoint on port 4567");
    }
    client = createSqsClient(sqsEndpoint);
  }, 30_000);

  beforeEach(async () => {
    orm = await resetTestDatabase();
    application = await startApplication(children);
    const created = await client.send(new CreateQueueCommand({ QueueName: `outbox-test-${crypto.randomUUID()}` }));
    if (!created.QueueUrl) throw new Error("MiniStack did not return the test queue URL");
    queueUrl = created.QueueUrl;
  });

  afterEach(async () => {
    await Promise.all([...publishers.splice(0), ...children.splice(0)].map(stop));
    if (orm) {
      await assertReconciled();
      try { await assertAccountingConsistent(orm); } finally { await orm.close(true); }
    }
    if (queueUrl) await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  });

  afterAll(async () => {
    await Promise.all([...children, ...publishers].map(stop));
    client?.destroy();
  });

  test("the publisher cannot see opening events before the financial transaction commits", async () => {
    await startPublisher();
    const lockKey = 7821401;
    await rows(`
      create function pause_opening_event() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(${lockKey}); return NEW; end $$
    `);
    await rows("create trigger pause_opening_event after insert on outbox_messages for each row execute function pause_opening_event()");
    let release: () => void = () => {};
    let locked: () => void = () => {};
    const lockHeld = new Promise<void>((resolve) => { locked = resolve; });
    const releaseLock = new Promise<void>((resolve) => { release = resolve; });
    const holder = orm.em.fork().transactional(async (em) => {
      await em.getConnection().execute("select pg_advisory_xact_lock(?)", [lockKey], "all", em.getTransactionContext());
      locked();
      await releaseLock;
    });
    let opening: Promise<WalletResponse> | undefined;
    try {
      await deadline(lockHeld, 5_000, "The financial commit barrier was not acquired");
      opening = wallet();
      await eventually(() => rows<{ waiting: boolean }>(
        "select exists(select 1 from pg_locks where locktype = 'advisory' and objid = ? and not granted) as waiting", [lockKey]),
      (result) => result[0]?.waiting === true);
      expect(await rows("select id from wallets")).toHaveLength(0);
      expect(await rows("select id from outbox_messages")).toHaveLength(0);
      expect(await receive()).toEqual([]);
      release();
      await holder;
      const target = await opening;
      const records = await published(target.id, 2);
      const received = await receiveCount(2);
      expect(received.map((event) => event.eventId).sort()).toEqual(records.map((record) => record.id).sort());
    } finally {
      release();
      await holder;
      await opening?.catch(() => {});
      await rows("drop trigger pause_opening_event on outbox_messages");
      await rows("drop function pause_opening_event()");
    }
  }, 30_000);

  test("two independent publishers drain a shared outbox while three application processes are running", async () => {
    const targets = await Promise.all(Array.from({ length: 8 }, () => wallet()));
    const [first, second] = await Promise.all([startPublisher(), startPublisher()]);
    expect(new Set([application.child.pid, first.child.pid, second.child.pid]).size).toBe(3);
    const records = (await Promise.all(targets.map((target) => published(target.id, 2)))).flat();
    const received = await receiveCount(records.length);
    expect(new Set(received.map((event) => event.eventId)).size).toBe(records.length);
    expect(received.sort((a, b) => a.eventId.localeCompare(b.eventId))).toEqual(
      records.map((record) => record.payload).sort((a, b) => a.eventId.localeCompare(b.eventId)),
    );
    expect(await receive()).toEqual([]);
    expect(records.every((record) => record.attempts === 0)).toBe(true);
  }, 30_000);

  test("a refused SQS connection persists retry backoff and a restarted publisher recovers every event", async () => {
    const target = await wallet();
    const original = await outbox(target.id);
    const reservation = createServer();
    await new Promise<void>((resolve) => { reservation.listen(0, "127.0.0.1", resolve); });
    const address = reservation.address();
    await new Promise<void>((resolve, reject) => { reservation.close((error) => error ? reject(error) : resolve()); });
    if (!address || typeof address === "string") throw new Error("Expected an unused TCP port");
    const unavailable = await startPublisher(`http://127.0.0.1:${address.port}`);
    const retried = await eventually(() => outbox(target.id), (records) => records.some((record) => record.attempts >= 1));
    const failed = retried.find((record) => record.attempts >= 1)!;
    expect(failed.published_at).toBeNull();
    expect(failed.next_attempt_at).not.toBeNull();
    expect(new Date(failed.next_attempt_at!).getTime()).toBeGreaterThan(Date.now());
    expect(await receive()).toEqual([]);
    await stop(unavailable.child);
    await startPublisher();
    const recovered = await published(target.id, 2);
    const received = await receiveCount(2);
    expect(received.map((event) => event.eventId).sort()).toEqual(original.map((record) => record.id).sort());
    expect(recovered.find((record) => record.id === failed.id)!.attempts).toBeGreaterThanOrEqual(1);
    expect(recovered.map((record) => record.payload)).toEqual(original.map((record) => record.payload));
  }, 30_000);

  test("a crash after SQS send can redeliver the same event ID without losing events or locking the wallet", async () => {
    const target = await wallet();
    const child = Bun.spawn([process.execPath, "tests/fixtures/pause-after-sqs-send.ts"], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: isolatedDatabaseUrl(), ...publisherEnvironment() },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    publishers.push(child);
    let output = "";
    let announce: (id: string) => void = () => {};
    const sent = new Promise<string>((resolve) => { announce = resolve; });
    async function capture(stream: ReadableStream<Uint8Array>): Promise<void> {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const text = decoder.decode(chunk.value, { stream: true });
        output = (output + text).slice(-8_000);
        pending += text;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const log = JSON.parse(line) as { event?: string; eventId?: string };
            if (log.event === "outbox_send_paused" && log.eventId) announce(log.eventId);
          } catch { /* Other runtime output is retained for startup diagnostics. */ }
        }
      }
    }
    void capture(child.stdout);
    void capture(child.stderr);
    const sentId = await deadline(Promise.race([
      sent, child.exited.then((code) => { throw new Error(`Crash fixture exited with ${code}: ${output}`); }),
    ]), 15_000, "The publisher did not reach the real SQS send barrier");
    expect((await outbox(target.id)).every((record) => record.published_at === null)).toBe(true);
    const firstDelivery = await receiveCount(1);
    expect(firstDelivery[0]!.eventId).toBe(sentId);
    const otherPublisher = await startPublisher();
    expect(new Set([application.child.pid, child.pid, otherPublisher.child.pid]).size).toBe(3);

    const externalTransactionId = crypto.randomUUID();
    const betResponse = await fetch(`${application.url}/wagering/transactions`, {
      method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": `provider-a:${externalTransactionId}` },
      body: JSON.stringify({ providerId: "provider-a", externalTransactionId, playerId: target.playerId,
        walletId: target.id, roundId: crypto.randomUUID(), gameId: "fortune-chimp", kind: "BET",
        money: { amount: "25.00", currency: "BRL" } }),
      signal: AbortSignal.timeout(5_000),
    });
    expect(betResponse.status).toBe(200);
    expect(await betResponse.json()).toMatchObject({ balance: { amount: "75.00", currency: "BRL" } });

    const whileLocked = await eventually(() => outbox(target.id), (records) =>
      records.length === 4 && records.filter((record) => record.published_at !== null).length === 3);
    expect(whileLocked.find((record) => record.id === sentId)!.published_at).toBeNull();
    const otherDeliveries = await receiveCount(3);
    expect(otherDeliveries.map((event) => event.eventId).sort()).toEqual(
      whileLocked.filter((record) => record.id !== sentId).map((record) => record.id).sort(),
    );

    child.kill("SIGKILL");
    await child.exited;
    await published(target.id, 4);
    const redelivery = await receiveCount(1);
    expect(redelivery[0]).toEqual(firstDelivery[0]);
    expect(await receive()).toEqual([]);
  }, 30_000);
});
