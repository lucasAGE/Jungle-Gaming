import { assertAccountingConsistent } from "./accounting-audit.js";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client.js";
import { resetTestDatabase, startApplication, stop, type Application, type Child, type Orm, type WalletResponse } from "./helpers.js";

const integration = process.env.RUN_DATABASE_INTEGRATION === "1" && process.env.RUN_SQS_INTEGRATION === "1" ? describe : describe.skip;
interface ExportedSpan { traceId: string; spanId: string; parentSpanId?: string; name: string; attributes?: Array<{ key: string; value: unknown }> }
interface ExportBatch { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: ExportedSpan[] }> }> }

integration("optional tracing with PostgreSQL, SQS and independent application processes", () => {
  let orm: Orm;
  let client: SQSClient;
  let api: Application;
  let receiver: ReturnType<typeof Bun.serve>;
  const spans: ExportedSpan[] = [];
  const children: Child[] = [];
  const queues: string[] = [];
  let queueUrl: string;
  let dlqUrl: string;
  let eventsUrl: string;
  let environment: Record<string, string>;
  const endpoint = process.env.TEST_SQS_ENDPOINT ?? "http://127.0.0.1:4567";

  const rows = <T = Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<T[]> => orm.em.getConnection().execute<T[]>(sql, parameters);
  async function eventually(work: () => Promise<boolean>): Promise<void> {
    const expires = Date.now() + 15_000;
    do { if (await work()) return; await Bun.sleep(25); } while (Date.now() < expires);
    throw new Error("Tracing integration condition did not complete");
  }
  async function createQueue(fifo = false): Promise<string> {
    const result = await client.send(new CreateQueueCommand({ QueueName: `tracing-${crypto.randomUUID()}${fifo ? ".fifo" : ""}`,
      ...(fifo ? { Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } } : {}) }));
    queues.push(result.QueueUrl!);
    return result.QueueUrl!;
  }
  async function wallet(application = api): Promise<WalletResponse> {
    const response = await fetch(`${application.url}/wallets`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } }) });
    expect(response.status).toBe(201);
    return response.json() as Promise<WalletResponse>;
  }
  function wager(target: WalletResponse) {
    return { providerId: "provider-a", externalTransactionId: crypto.randomUUID(), playerId: target.playerId, walletId: target.id,
      roundId: crypto.randomUUID(), gameId: "fortune-chimp", kind: "BET", money: { amount: "25.00", currency: "BRL" } };
  }

  beforeAll(async () => {
    receiver = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const batch = await request.json() as ExportBatch;
      for (const resource of batch.resourceSpans ?? []) for (const scope of resource.scopeSpans ?? []) spans.push(...scope.spans ?? []);
      return Response.json({});
    } });
    orm = await resetTestDatabase();
    client = createSqsClient(endpoint);
    queueUrl = await createQueue(true); dlqUrl = await createQueue(true); eventsUrl = await createQueue();
    environment = { AUTH_ENABLED: "false", OTEL_ENABLED: "true", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${receiver.url}v1/traces`,
      SQS_ENDPOINT: endpoint, SQS_WAGER_QUEUE_URL: queueUrl, SQS_WAGER_DLQ_URL: dlqUrl, SQS_EVENTS_QUEUE_URL: eventsUrl };
    api = await startApplication(children, environment);
  }, 60_000);

  afterEach(async () => {
    expect(await rows(`select w.id from wallets w left join wallet_ledger l on l.wallet_id = w.id
      group by w.id having w.balance <> coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)`)).toEqual([]);
  });
  afterAll(async () => {
    await Promise.all(children.map(stop));
    if (client) { for (const QueueUrl of queues) await client.send(new DeleteQueueCommand({ QueueUrl })).catch(() => {}); client.destroy(); }
    if (orm) { try { await assertAccountingConsistent(orm); } finally { await orm.close(true); } }
    receiver?.stop(true);
  });

  test("continues the committed HTTP trace after its process dies and another process publishes the outbox", async () => {
    const target = await wallet();
    const body = wager(target);
    const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const traceparent = `00-${traceId}-bbbbbbbbbbbbbbbb-01`;
    const submit = (parent: string) => fetch(`${api.url}/wagering/transactions`, { method: "POST", headers: {
      "content-type": "application/json", "Idempotency-Key": `provider-a:${body.externalTransactionId}`, traceparent: parent,
    }, body: JSON.stringify(body) });
    const response = await submit(traceparent);
    expect(response.status).toBe(200);
    const result = await response.json() as { transactionId: string };
    expect(await (await submit("00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01")).json())
      .toMatchObject({ transactionId: result.transactionId, balance: { amount: "75.00", currency: "BRL" }, idempotentReplay: true });
    const events = await rows<{ id: string; payload: { traceparent: string } }>(
      "select id, payload from outbox_messages where payload->'data'->>'transactionId' = ?", [result.transactionId]);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.payload.traceparent.startsWith(`00-${traceId}-`))).toBe(true);
    await eventually(async () => spans.some((span) => span.traceId === traceId && span.name === "wager.process"));
    const processing = spans.find((span) => span.traceId === traceId && span.name === "wager.process")!;
    const http = spans.find((span) => span.traceId === traceId && span.name === "POST /wagering/transactions")!;
    expect(processing.parentSpanId).toBe(http.spanId);
    expect(http.parentSpanId).toBe("bbbbbbbbbbbbbbbb");
    await stop(api.child);
    api = await startApplication(children, { ...environment, OUTBOX_PUBLISHER_ENABLED: "true" });
    await eventually(async () => (await rows<{ count: string }>("select count(*)::text as count from outbox_messages where published_at is null"))[0]!.count === "0");
    await eventually(async () => spans.filter((span) => span.traceId === traceId && span.name === "sqs.outbox.publish").length === 2);
    const publications = spans.filter((span) => span.traceId === traceId && span.name === "sqs.outbox.publish");
    expect(publications.every((span) => span.parentSpanId === processing.spanId)).toBe(true);
    const received = await client.send(new ReceiveMessageCommand({ QueueUrl: eventsUrl, MaxNumberOfMessages: 10, MessageAttributeNames: ["traceparent"] }));
    const matching = received.Messages!.filter((message) => events.some((event) => JSON.parse(message.Body!).eventId === event.id));
    expect(matching).toHaveLength(2);
    expect(matching.every((message) => message.MessageAttributes?.traceparent?.StringValue?.startsWith(`00-${traceId}-`))).toBe(true);
    expect(await rows("select id from wallet_ledger where transaction_id = ?", [result.transactionId])).toHaveLength(1);
  }, 30_000);

  test("propagates SQS context through the shared workflow and preserves committed idempotency when export is unavailable", async () => {
    const target = await wallet();
    const body = wager(target);
    const traceId = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const messageId = crypto.randomUUID();
    const envelope = { messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
      data: { ...body, idempotencyKey: `provider-a:${body.externalTransactionId}` } };
    await startApplication(children, { ...environment, SQS_CONSUMER_ENABLED: "true" });
    expect(new Set(children.map((child) => child.pid)).size).toBe(3);
    await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(envelope), MessageGroupId: target.id,
      MessageDeduplicationId: crypto.randomUUID(), MessageAttributes: { traceparent: { DataType: "String", StringValue: `00-${traceId}-ffffffffffffffff-01` } } }));
    await eventually(async () => spans.some((span) => span.traceId === traceId && span.name === "sqs.wager.process"));
    const consumer = spans.find((span) => span.traceId === traceId && span.name === "sqs.wager.process")!;
    const process = spans.find((span) => span.traceId === traceId && span.name === "wager.process")!;
    expect(consumer.parentSpanId).toBe("ffffffffffffffff");
    expect(process.parentSpanId).toBe(consumer.spanId);
    await eventually(async () => {
      const state = await client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }));
      return Object.values(state.Attributes ?? {}).every((value) => value === "0");
    });
    expect(await rows("select message_id from inbox_messages where message_id = ? and processed_at is not null", [messageId])).toHaveLength(1);
    expect(await rows("select id from wallet_ledger where wallet_id = ?", [target.id])).toHaveLength(2);
    receiver.stop(true);
    const replay = await fetch(`${api.url}/wagering/transactions`, { method: "POST", headers: {
      "content-type": "application/json", "Idempotency-Key": `provider-a:${body.externalTransactionId}`,
    }, body: JSON.stringify(body) });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ status: "PROCESSED", balance: { amount: "75.00", currency: "BRL" }, idempotentReplay: true });
    // Let the batch exporter attempt the closed endpoint before submitting fresh work.
    await Bun.sleep(700);
    const next = wager(target);
    const processed = await fetch(`${api.url}/wagering/transactions`, { method: "POST", headers: {
      "content-type": "application/json", "Idempotency-Key": `provider-a:${next.externalTransactionId}`,
    }, body: JSON.stringify(next) });
    expect(processed.status).toBe(200);
    expect(await processed.json()).toMatchObject({ status: "PROCESSED", balance: { amount: "50.00", currency: "BRL" }, idempotentReplay: false });
    expect(await rows("select id from wallet_ledger where wallet_id = ?", [target.id])).toHaveLength(3);
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toMatch(/25\.00|100\.00|75\.00|password|authorization/);
  }, 30_000);
});
