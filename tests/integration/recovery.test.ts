import { assertAccountingConsistent } from "./accounting-audit.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createConnection, createServer, type Socket } from "node:net";
import {
  CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client.js";
import {
  isolatedDatabaseUrl, resetTestDatabase, startApplication, stop, type Application, type Child, type Orm, type WalletResponse,
} from "./helpers.js";

const integration = process.env.RUN_DATABASE_INTEGRATION === "1" && process.env.RUN_SQS_INTEGRATION === "1"
  ? describe : describe.skip;

// Forward actual protocol traffic to the test containers. Disconnecting only these
// sockets exercises network recovery without stopping another developer's services.
class NetworkLink {
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer((incoming) => {
    const outgoing = createConnection({ host: "127.0.0.1", port: this.targetPort });
    for (const socket of [incoming, outgoing]) {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => { incoming.destroy(); outgoing.destroy(); });
    }
    incoming.pipe(outgoing).pipe(incoming);
  });
  port = 0;

  constructor(private readonly targetPort: 55433 | 4567) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.port, "127.0.0.1", () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a local TCP address");
    this.port = address.port;
  }

  async disconnect(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }
}

integration("recovery from actual PostgreSQL and SQS network outages", () => {
  let orm: Orm;
  let client: SQSClient;
  let database: NetworkLink;
  let broker: NetworkLink;
  let queueUrl: string;
  let dlqUrl: string;
  let eventsUrl: string;
  let applications: Application[];
  let children: Child[];

  function rows<T = Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    return orm.em.getConnection().execute<T[]>(sql, parameters);
  }

  async function eventually<T>(read: () => Promise<T>, ready: (result: T) => boolean): Promise<T> {
    const expires = Date.now() + 20_000;
    let result: T;
    do {
      result = await read();
      if (ready(result)) return result;
      await Bun.sleep(50);
    } while (Date.now() < expires);
    throw new Error(`Recovery did not complete: ${JSON.stringify(result)}`);
  }

  function request(instance: number, path: string, body?: unknown, key?: string): Promise<Response> {
    return fetch(`${applications[instance]!.url}${path}`, {
      method: body === undefined ? "GET" : "POST", headers: {
        "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
  }

  async function wallet(): Promise<WalletResponse> {
    const response = await request(0, "/wallets", {
      playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" },
    });
    expect(response.status).toBe(201);
    return response.json() as Promise<WalletResponse>;
  }

  function bet(target: WalletResponse) {
    const externalTransactionId = crypto.randomUUID();
    return { providerId: "provider-a", externalTransactionId, walletId: target.id, playerId: target.playerId,
      kind: "BET", roundId: crypto.randomUUID(), gameId: "fortune-chimp", money: { amount: "25.00", currency: "BRL" } };
  }

  async function assertConsistent(target: WalletResponse, balance: string): Promise<void> {
    for (let instance = 0; instance < 3; instance++) {
      const response = await request(instance, `/wallets/${target.id}/reconciliation`, {});
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ consistent: true, storedBalance: { amount: balance },
        calculatedBalance: { amount: balance }, difference: { amount: "0.00" } });
    }
  }

  async function ready(status: number): Promise<void> {
    const responses = await Promise.all(applications.map((_, index) => request(index, "/health/ready")));
    expect(responses.map((response) => response.status)).toEqual([status, status, status]);
    for (let index = 0; index < 3; index++) expect((await request(index, "/health/live")).status).toBe(200);
  }

  beforeEach(async () => {
    children = [];
    applications = [];
    orm = await resetTestDatabase();
    database = new NetworkLink(55433);
    broker = new NetworkLink(4567);
    await database.connect();
    await broker.connect();
    client = createSqsClient("http://127.0.0.1:4567");
    const suffix = crypto.randomUUID();
    dlqUrl = (await client.send(new CreateQueueCommand({ QueueName: `recovery-dlq-${suffix}.fifo`,
      Attributes: { FifoQueue: "true" } }))).QueueUrl!;
    const dlqAttributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }));
    queueUrl = (await client.send(new CreateQueueCommand({ QueueName: `recovery-${suffix}.fifo`, Attributes: {
      FifoQueue: "true", VisibilityTimeout: "2", RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: dlqAttributes.Attributes?.QueueArn, maxReceiveCount: "5",
      }),
    } }))).QueueUrl!;
    eventsUrl = (await client.send(new CreateQueueCommand({ QueueName: `recovery-events-${suffix}` }))).QueueUrl!;
    const url = new URL(isolatedDatabaseUrl());
    url.port = String(database.port);
    for (let index = 0; index < 3; index++) applications.push(await startApplication(children, {
      DATABASE_URL: url.href, SQS_ENDPOINT: `http://127.0.0.1:${broker.port}`,
      SQS_WAGER_QUEUE_URL: queueUrl, SQS_WAGER_DLQ_URL: dlqUrl, SQS_EVENTS_QUEUE_URL: eventsUrl,
      SQS_CONSUMER_ENABLED: "true", OUTBOX_PUBLISHER_ENABLED: "true", REFERENCE_WORKER_ENABLED: "true",
      SQS_VISIBILITY_TIMEOUT_SECONDS: "2",
    }));
    expect(new Set(applications.map(({ child }) => child.pid)).size).toBe(3);
    await ready(200);
  }, 60_000);

  afterEach(async () => {
    await Promise.all(children.map(stop));
    await database?.disconnect();
    await broker?.disconnect();
    try {
      if (orm) expect(await rows(`select w.id from wallets w left join wallet_ledger l on l.wallet_id = w.id
        group by w.id having w.balance <> coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)`)).toEqual([]);
    } finally {
      if (orm) { try { await assertAccountingConsistent(orm); } finally { await orm.close(true); } }
      for (const url of [queueUrl, dlqUrl, eventsUrl]) if (url) await client.send(new DeleteQueueCommand({ QueueUrl: url }));
      client?.destroy();
    }
  });

  test("three running processes retain committed events during SQS loss and drain once connectivity returns", async () => {
    const target = await wallet();
    await eventually(() => rows("select id from outbox_messages where published_at is null"), (records) => records.length === 0);
    await broker.disconnect();
    await ready(503);
    const body = bet(target);
    const key = `${body.providerId}:${body.externalTransactionId}`;
    const response = await request(1, "/wagering/transactions", body, key);
    expect(response.status).toBe(200);
    const decision = await response.json() as { transactionId: string };
    await eventually(() => rows<{ attempts: number }>("select attempts from outbox_messages where published_at is null"),
      (records) => records.length === 2 && records.some((record) => record.attempts > 0));
    await assertConsistent(target, "75.00");
    const message = { messageId: crypto.randomUUID(), type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
      data: { ...body, idempotencyKey: key } };
    for (let index = 0; index < 3; index++) await client.send(new SendMessageCommand({ QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message), MessageGroupId: target.id, MessageDeduplicationId: crypto.randomUUID() }));
    await broker.connect();
    await eventually(() => rows("select id from outbox_messages where published_at is null"), (records) => records.length === 0);
    await eventually(() => rows("select * from inbox_messages"), (records) => records.length === 1);
    expect(await rows("select transaction_id from wallet_ledger where transaction_id = ?", [decision.transactionId])).toHaveLength(1);
    await ready(200);
    await assertConsistent(target, "75.00");
    const published = new Set<string>();
    await eventually(async () => {
      const result = await client.send(new ReceiveMessageCommand({ QueueUrl: eventsUrl, MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1, VisibilityTimeout: 30 }));
      for (const event of result.Messages ?? []) published.add((JSON.parse(event.Body!) as { eventId: string }).eventId);
      return published.size;
    }, (count) => count === 4);
    const expected = await rows<{ id: string }>("select id from outbox_messages");
    expect(published).toEqual(new Set(expected.map(({ id }) => id)));
  }, 60_000);

  test("a live PostgreSQL disconnect creates no false terminal decision and the same identity succeeds after recovery", async () => {
    const target = await wallet();
    const body = bet(target);
    const key = `${body.providerId}:${body.externalTransactionId}`;
    await database.disconnect();
    await ready(503);
    const responses = await Promise.all(applications.map((_, index) => request(index, "/wagering/transactions", body, key)));
    expect(responses.map((response) => response.status)).toEqual([503, 503, 503]);
    for (const response of responses) expect(await response.json()).toMatchObject({ code: "DATABASE_UNAVAILABLE" });
    expect(await rows("select id from wager_transactions where external_transaction_id = ?", [body.externalTransactionId])).toEqual([]);
    await database.connect();
    await eventually(async () => (await request(0, "/health/ready")).status, (status) => status === 200);
    const recovered = await Promise.all(applications.map((_, index) => request(index, "/wagering/transactions", body, key)));
    expect(recovered.map((response) => response.status)).toEqual([200, 200, 200]);
    const decisions = await Promise.all(recovered.map((response) => response.json() as Promise<{ transactionId: string; idempotentReplay: boolean }>));
    expect(new Set(decisions.map(({ transactionId }) => transactionId)).size).toBe(1);
    expect(decisions.filter(({ idempotentReplay }) => !idempotentReplay)).toHaveLength(1);
    expect(await rows("select id from wager_transactions where status = 'FAILED'")).toEqual([]);
    await ready(200);
    await assertConsistent(target, "75.00");
    await eventually(() => rows("select id from outbox_messages where published_at is null"), (records) => records.length === 0);
  }, 60_000);
});
