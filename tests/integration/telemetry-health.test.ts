import { assertAccountingConsistent } from "./accounting-audit.js";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { CreateQueueCommand, DeleteQueueCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client.js";
import { resetTestDatabase, startApplication, stop, type Application, type Child, type Orm, type WalletResponse } from "./helpers.js";

const integration = process.env.RUN_DATABASE_INTEGRATION === "1" && process.env.RUN_SQS_INTEGRATION === "1"
  ? describe : describe.skip;

integration("operational telemetry and dependency health with real PostgreSQL and SQS", () => {
  let orm: Orm;
  let client: SQSClient;
  let app: Application;
  const children: Child[] = [];
  const queues: string[] = [];
  const endpoint = process.env.TEST_SQS_ENDPOINT ?? "http://127.0.0.1:4567";
  let inputUrl: string;
  let dlqUrl: string;
  let eventsUrl: string;

  async function createQueue(fifo = false): Promise<string> {
    const result = await client.send(new CreateQueueCommand({ QueueName: `observability-${crypto.randomUUID()}${fifo ? ".fifo" : ""}`,
      ...(fifo ? { Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } } : {}) }));
    queues.push(result.QueueUrl!);
    return result.QueueUrl!;
  }

  function rows<T = Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    return orm.em.getConnection().execute<T[]>(sql, parameters);
  }

  function post(path: string, body: unknown, headers: Record<string, string> = {}, application = app): Promise<Response> {
    return fetch(`${application.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  }

  async function wallet(correlation = "opening-request-1"): Promise<WalletResponse> {
    const response = await post("/wallets", { playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } },
      { "x-correlation-id": correlation });
    expect(response.status).toBe(201);
    return response.json() as Promise<WalletResponse>;
  }

  function wager(target: WalletResponse, amount = "25.00") {
    return { providerId: "provider-a", externalTransactionId: crypto.randomUUID(), walletId: target.id, playerId: target.playerId,
      roundId: "round-telemetry", gameId: "fortune-chimp", kind: "BET", money: { amount, currency: "BRL" } };
  }

  async function metrics(application = app): Promise<string> {
    const response = await fetch(`${application.url}/metrics`, { signal: AbortSignal.timeout(5_000) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    return response.text();
  }

  function metric(text: string, name: string): number {
    const line = text.split("\n").find((value) => value.startsWith(`${name} `));
    if (!line) throw new Error(`Expected metric ${name}`);
    return Number(line.slice(name.length + 1));
  }

  async function eventually(read: () => Promise<boolean>): Promise<void> {
    const expires = Date.now() + 12_000;
    do {
      if (await read()) return;
      await Bun.sleep(25);
    } while (Date.now() < expires);
    throw new Error("Operational condition was not reached");
  }

  beforeAll(async () => {
    orm = await resetTestDatabase();
    client = createSqsClient(endpoint);
    inputUrl = await createQueue(true); dlqUrl = await createQueue(true); eventsUrl = await createQueue();
    app = await startApplication(children, { SQS_ENDPOINT: endpoint, SQS_WAGER_QUEUE_URL: inputUrl,
      SQS_WAGER_DLQ_URL: dlqUrl, SQS_EVENTS_QUEUE_URL: eventsUrl });
  }, 60_000);

  afterEach(async () => {
    expect(await rows(`select w.id from wallets w left join wallet_ledger l on l.wallet_id = w.id
      group by w.id having w.balance <> coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)`)).toEqual([]);
  });

  afterAll(async () => {
    await Promise.all(children.map(stop));
    if (client) {
      for (const QueueUrl of queues) await client.send(new DeleteQueueCommand({ QueueUrl })).catch(() => {});
      client.destroy();
    }
    if (orm) { try { await assertAccountingConsistent(orm); } finally { await orm.close(true); } }
  });

  test("health routes are open and readiness checks actual queue attributes", async () => {
    const live = await fetch(`${app.url}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ live: true });
    const ready = await fetch(`${app.url}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ready: true, dependencies: { postgres: "up", sqs: "up" } });
    expect(ready.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("HTTP correlation reaches immutable opening and wager outbox events; replays only increment duplicate metrics", async () => {
    const before = await metrics();
    const target = await wallet();
    expect(await rows<{ correlation_id: string }>("select payload->>'correlationId' as correlation_id from outbox_messages where aggregate_id = ?", [target.id]))
      .toEqual([{ correlation_id: "opening-request-1" }, { correlation_id: "opening-request-1" }]);
    const body = wager(target);
    const headers = { "Idempotency-Key": `${body.providerId}:${body.externalTransactionId}`, "x-correlation-id": "wager-request-1" };
    const first = await post("/wagering/transactions", body, headers);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-correlation-id")).toBe("wager-request-1");
    const result = await first.json() as { transactionId: string; idempotentReplay: boolean };
    const duplicate = await post("/wagering/transactions", body, { ...headers, "x-correlation-id": "replay-request-1" });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ transactionId: result.transactionId, idempotentReplay: true });
    expect(await rows<{ correlation_id: string }>("select payload->>'correlationId' as correlation_id from outbox_messages where payload->'data'->>'transactionId' = ?", [result.transactionId]))
      .toEqual([{ correlation_id: "wager-request-1" }, { correlation_id: "wager-request-1" }]);
    const after = await metrics();
    expect(metric(after, 'wagering_transactions_total{status="PROCESSED"}') - metric(before, 'wagering_transactions_total{status="PROCESSED"}')).toBe(2);
    expect(metric(after, "wagering_duplicates_total") - metric(before, "wagering_duplicates_total")).toBe(1);
    expect(metric(after, "wagering_processing_seconds_count") - metric(before, "wagering_processing_seconds_count")).toBe(3);
    expect(metric(after, "wagering_outbox_pending") - metric(before, "wagering_outbox_pending")).toBe(4);
    expect(metric(after, "wagering_outbox_lag_seconds")).toBeGreaterThanOrEqual(0);
    expect(after).not.toContain(target.id);
    expect(after).not.toContain(body.providerId);
  });

  test("replaces malformed correlation headers and records rejection and reconciliation divergence", async () => {
    const target = await wallet();
    const before = await metrics();
    const body = wager(target, "101.00");
    const response = await post("/wagering/transactions", body, {
      "Idempotency-Key": `${body.providerId}:${body.externalTransactionId}`, "x-correlation-id": JSON.stringify({ private: "amount" }),
    });
    expect(response.status).toBe(422);
    const id = response.headers.get("x-correlation-id")!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const rejection = await response.json() as { transactionId: string };
    expect(await rows<{ correlation_id: string }>("select payload->>'correlationId' as correlation_id from outbox_messages where payload->'data'->>'transactionId' = ?", [rejection.transactionId]))
      .toEqual([{ correlation_id: id }]);
    try {
      await rows("update wallets set balance = 100.01 where id = ?", [target.id]);
      const reconciliation = await post(`/wallets/${target.id}/reconciliation`, {});
      expect(reconciliation.status).toBe(200);
      expect(await reconciliation.json()).toMatchObject({ consistent: false, difference: { amount: "0.01", currency: "BRL" } });
    } finally { await rows("update wallets set balance = 100.00 where id = ?", [target.id]); }
    const after = await metrics();
    expect(metric(after, 'wagering_transactions_total{status="REJECTED"}') - metric(before, 'wagering_transactions_total{status="REJECTED"}')).toBe(1);
    expect(metric(after, "wagering_reconciliation_divergences_total") - metric(before, "wagering_reconciliation_divergences_total")).toBe(1);
  });

  test("counts SQS DLQ settlement only after the broker operation succeeds", async () => {
    const consumer = await startApplication(children, { SQS_ENDPOINT: endpoint, SQS_CONSUMER_ENABLED: "true",
      SQS_WAGER_QUEUE_URL: inputUrl, SQS_WAGER_DLQ_URL: dlqUrl, SQS_EVENTS_QUEUE_URL: eventsUrl });
    await client.send(new SendMessageCommand({ QueueUrl: inputUrl, MessageBody: "invalid-json",
      MessageGroupId: crypto.randomUUID(), MessageDeduplicationId: crypto.randomUUID() }));
    await eventually(async () => metric(await metrics(consumer), "wagering_dlq_total") === 1);
    expect(metric(await metrics(consumer), "wagering_duplicates_total")).toBe(0);
    await stop(consumer.child);
  }, 30_000);

  test("counts a real PostgreSQL lock conflict and permits a safe retry after the lock is released", async () => {
    const target = await wallet();
    const body = wager(target);
    const headers = { "Idempotency-Key": `${body.providerId}:${body.externalTransactionId}` };
    let lockedApp: Application | undefined;
    let release: () => void = () => {};
    let locked: () => void = () => {};
    const acquired = new Promise<void>((resolve) => { locked = resolve; });
    const unlock = new Promise<void>((resolve) => { release = resolve; });
    let holder: Promise<void> | undefined;
    // This setting affects only fresh connections to the guarded disposable test database.
    await rows("alter database wagering_test set lock_timeout to '200ms'");
    try {
      lockedApp = await startApplication(children, { SQS_ENDPOINT: endpoint, SQS_WAGER_QUEUE_URL: inputUrl,
        SQS_WAGER_DLQ_URL: dlqUrl, SQS_EVENTS_QUEUE_URL: eventsUrl });
      holder = orm.em.fork().transactional(async (em) => {
        await em.getConnection().execute("select id from wallets where id = ? for update", [target.id], "all", em.getTransactionContext());
        locked();
        await unlock;
      });
      await acquired;
      const blocked = await post("/wagering/transactions", body, headers, lockedApp);
      expect(blocked.status).toBe(503);
      expect(await blocked.json()).toMatchObject({ code: "DATABASE_UNAVAILABLE" });
      expect(await rows("select id from wager_transactions where external_transaction_id = ?", [body.externalTransactionId])).toEqual([]);
      expect(metric(await metrics(lockedApp), "wagering_lock_conflicts_total")).toBe(1);
      release();
      await holder;
      const retry = await post("/wagering/transactions", body, headers, lockedApp);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ status: "PROCESSED", idempotentReplay: false, balance: { amount: "75.00", currency: "BRL" } });
      const counters = await metrics(lockedApp);
      expect(metric(counters, "wagering_lock_conflicts_total")).toBe(1);
      expect(metric(counters, 'wagering_transactions_total{status="FAILED"}')).toBe(0);
      expect(metric(counters, 'wagering_transactions_total{status="PROCESSED"}')).toBe(1);
    } finally {
      release();
      await holder;
      if (lockedApp) await stop(lockedApp.child);
      await rows("alter database wagering_test reset lock_timeout");
    }
  }, 30_000);

  test("readiness detects a deleted configured queue while liveness remains available", async () => {
    await client.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    const ready = await fetch(`${app.url}/health/ready`, { signal: AbortSignal.timeout(5_000) });
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ ready: false, dependencies: { postgres: "up", sqs: "down" } });
    expect((await fetch(`${app.url}/health/live`)).status).toBe(200);
  });
});
