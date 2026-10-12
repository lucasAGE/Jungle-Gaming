import "reflect-metadata";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { DemoRuntime } from "../../scripts/demo/runtime.js";
import { createDemoServer } from "../../scripts/demo/server.js";
import { demoDatabaseUrl, demoSqsEndpoint } from "../../scripts/demo/resources.js";
import { createSqsClient, getQueueUrl, wagerQueueName } from "../../src/infrastructure/messaging/sqs-client.js";
import { presenterTokens } from "../auth/keycloak-login.js";

const integration = process.env.RUN_DEMO_INTEGRATION === "1" ? describe : describe.skip;
integration("isolated presentation runtime with PostgreSQL, SQS and three authenticated processes", () => {
  const runtime = new DemoRuntime();
  let supervisor: ReturnType<typeof createDemoServer> | undefined;
  let client: SQSClient;
  let accessToken: string;
  let wallet: { id: string; playerId: string };

  async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string, timeout = 20_000): Promise<T> {
    const deadline = Date.now() + timeout;
    let value: T;
    do {
      value = await read();
      if (ready(value)) return value;
      await Bun.sleep(100);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
  }

  async function request(path: string, body?: unknown, key?: string, id: 1 | 2 | 3 = 1, authenticated = true) {
    const target = runtime.target(id);
    if (!target) {
      const state = await runtime.state();
      throw new Error(`Process ${id} is not available: ${JSON.stringify({ processes: state.processes,
        recentLogs: state.logs.filter((line) => !line.includes("framework_log")).slice(-12) })}`);
    }
    return fetch(`${target}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(key === undefined ? {} : { "Idempotency-Key": key }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12_000),
    });
  }

  function input(amount = "1.00") {
    const externalTransactionId = crypto.randomUUID();
    return { providerId: "provider-a", externalTransactionId, playerId: wallet.playerId, walletId: wallet.id,
      roundId: `demo-test-${externalTransactionId}`, gameId: "fortune-chimp", kind: "BET", money: { amount, currency: "BRL" } };
  }
  const keyFor = (body: ReturnType<typeof input>) => `provider-a:${body.externalTransactionId}`;
  async function queueCounts() {
    const QueueUrl = await getQueueUrl(client, wagerQueueName);
    const result = await client.send(new GetQueueAttributesCommand({ QueueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }));
    return { visible: Number(result.Attributes?.ApproximateNumberOfMessages ?? 0),
      inFlight: Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0) };
  }
  async function freshWallet() {
    const response = await request("/wallets", { playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } });
    expect(response.status).toBe(201);
    wallet = await response.json() as typeof wallet;
  }
  async function snapshotWallet() {
    const result = await runtime.audit();
    const found = result.wallets.find((candidate) => candidate.walletId === wallet.id);
    expect(found).toBeDefined();
    return found!;
  }

  beforeAll(async () => {
    if (demoDatabaseUrl !== "postgresql://wagering:wagering_demo@127.0.0.1:55434/wagering_demo"
      || demoSqsEndpoint !== "http://127.0.0.1:4568") throw new Error("The demo suite requires its fixed disposable resources");
    if (process.env.AUTH_ISSUER !== "http://127.0.0.1:58081/realms/wagering") {
      throw new Error("Use bun run test:demo to select the isolated identity provider");
    }
    // Claim the same local listener as the real demo before touching its resources.
    // A running presentation therefore blocks this reset suite instead of losing data.
    supervisor = createDemoServer({ runtime, port: 3100 });
    accessToken = (await presenterTokens(process.env.AUTH_ISSUER)).access_token;
    client = createSqsClient(demoSqsEndpoint);
    await supervisor.start();
  }, 90_000);

  afterEach(async () => {
    expect((await runtime.audit()).consistent).toBe(true);
  });
  afterAll(async () => {
    await supervisor?.close();
    client?.destroy();
  }, 30_000);

  test("reset removes visible and in-flight messages and financial history, then seeds one balanced wallet and three fresh processes", async () => {
    const initial = await runtime.reset();
    const initialPids = initial.processes.map((process) => process.pid);
    expect(new Set(initialPids).size).toBe(3);
    expect(initial.seedWallet).not.toBeNull();
    wallet = initial.seedWallet!;
    const oldBet = input("25.00");
    expect((await request("/wagering/transactions", oldBet, keyFor(oldBet))).status).toBe(200);
    for (const id of [1, 2, 3] as const) await runtime.process(id, "stop");
    const QueueUrl = await getQueueUrl(client, wagerQueueName);
    for (const group of ["visible-reset", "invisible-reset"]) await client.send(new SendMessageCommand({
      QueueUrl, MessageBody: "old-demo-message", MessageGroupId: group, MessageDeduplicationId: crypto.randomUUID(),
    }));
    const received = await client.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 1, VisibilityTimeout: 120 }));
    expect(received.Messages).toHaveLength(1);
    expect(await queueCounts()).toEqual({ visible: 1, inFlight: 1 });
    const reset = await runtime.reset();
    expect(reset.seedWallet?.id).not.toBe(initial.seedWallet!.id);
    expect(reset.processes.every((process) => process.running && process.pid !== null && !initialPids.includes(process.pid))).toBe(true);
    expect(new Set(reset.processes.map((process) => process.pid)).size).toBe(3);
    console.log(JSON.stringify({ event: "demo_test_processes", beforeReset: initialPids,
      afterReset: reset.processes.map((process) => process.pid) }));
    expect(await queueCounts()).toEqual({ visible: 0, inFlight: 0 });
    const audit = await runtime.audit();
    expect(audit.counts).toMatchObject({ wallets: 1, transactions: 1, ledger: 1, journal: 1, postings: 2, inbox: 0, outbox: 2 });
    expect(audit.wallets).toHaveLength(1);
    expect(audit.wallets[0]).toMatchObject({ balance: "100.00", ledger: "100.00", accounting: "100.00", consistent: true });
    expect((await request("/wallets", {}, undefined, 1, false)).status).toBe(401);
    expect((await request("/health/ready", undefined, undefined, 1, false)).status).toBe(200);
  }, 90_000);

  test("fifty SQS copies and a killed HTTP process retain one debit, one journal pair and the original replay result", async () => {
    await freshWallet();
    const body = input("25.00");
    const before = await runtime.audit();
    await runtime.send({ data: { ...body, idempotencyKey: keyFor(body) }, copies: 50 });
    await eventually(queueCounts, (counts) => counts.visible === 0 && counts.inFlight === 0, "duplicate deliveries to settle", 30_000);
    expect(await snapshotWallet()).toMatchObject({ balance: "75.00", ledger: "75.00", accounting: "75.00" });
    const originalResponse = await request("/wagering/transactions", body, keyFor(body));
    expect(originalResponse.status).toBe(200);
    const original = await originalResponse.json() as { transactionId: string; balance: { amount: string }; idempotentReplay: boolean };
    expect(original.idempotentReplay).toBe(true);
    await runtime.process(1, "crash");
    await runtime.process(1, "start");
    const replay = await request("/wagering/transactions", body, keyFor(body));
    expect(await replay.json()).toEqual(original);
    const after = await runtime.audit();
    expect(after.counts!.transactions).toBe(before.counts!.transactions! + 1);
    expect(after.counts!.ledger).toBe(before.counts!.ledger! + 1);
    expect(after.counts!.journal).toBe(before.counts!.journal! + 1);
    expect(after.counts!.postings).toBe(before.counts!.postings! + 2);
    expect(after.counts!.inbox).toBe(before.counts!.inbox! + 1);
  }, 60_000);

  test("the before-ack barrier exposes a committed inbox and crash redelivery never applies the debit twice", async () => {
    await freshWallet();
    for (const id of [2, 3] as const) await runtime.process(id, "stop");
    await runtime.process(1, "restart", { pauseBeforeAck: true });
    const body = input("10.00");
    const before = await runtime.audit();
    await runtime.send({ data: { ...body, idempotencyKey: keyFor(body) } });
    await eventually(() => runtime.state(), (state) => state.processes[0]?.ackPaused === true, "the post-commit acknowledgment barrier");
    const paused = await runtime.audit();
    expect(paused.counts!.inbox).toBe(before.counts!.inbox! + 1);
    expect(await snapshotWallet()).toMatchObject({ balance: "90.00", accounting: "90.00" });
    await runtime.process(1, "crash");
    await runtime.process(1, "start", { pauseBeforeAck: false });
    await eventually(queueCounts, (counts) => counts.visible === 0 && counts.inFlight === 0, "redelivery acknowledgment");
    const replay = await request("/wagering/transactions", body, keyFor(body));
    expect(await replay.json()).toMatchObject({ idempotentReplay: true, balance: { amount: "90.00" } });
    const after = await runtime.audit();
    expect(after.counts!.ledger).toBe(paused.counts!.ledger);
    expect(after.counts!.journal).toBe(paused.counts!.journal);
    expect(after.counts!.inbox).toBe(paused.counts!.inbox);
    for (const id of [2, 3] as const) await runtime.process(id, "start");
  }, 60_000);

  test("DLQ inspection preserves a poison message and redrive preserves its body without a financial effect", async () => {
    const before = await runtime.audit();
    await runtime.sendInvalid();
    const inspection = await eventually(() => runtime.inspect("dlq"), (result) => result.messages.length > 0, "the invalid-message DLQ");
    const message = inspection.messages[0]!;
    expect(message.body).toBe("{");
    expect((await runtime.inspect("dlq")).messages.some((item) => item.messageId === message.messageId)).toBe(true);
    expect(message.messageId).toBeDefined();
    await runtime.redrive(message.messageId!);
    const redelivered = await eventually(() => runtime.inspect("dlq"),
      (result) => result.messages.some((item) => item.messageId !== message.messageId), "redriven poison message to return to DLQ");
    expect(redelivered.messages[0]!.body).toBe("{");
    const after = await runtime.audit();
    for (const count of ["wallets", "transactions", "ledger", "journal", "postings", "inbox", "outbox"]) {
      expect(after.counts![count]).toBe(before.counts![count]);
    }
  }, 60_000);

  test("fault gates isolate managed processes while committed outbox events survive SQS downtime and recover", async () => {
    await freshWallet();
    await eventually(() => runtime.audit(), (result) => result.counts!.pendingOutbox === 0, "initial outbox drain");
    await runtime.connectivity("sqs", false);
    try {
      const body = input("5.00");
      const response = await request("/wagering/transactions", body, keyFor(body));
      expect(response.status).toBe(200);
      expect(await snapshotWallet()).toMatchObject({ balance: "95.00", accounting: "95.00" });
      await eventually(() => runtime.audit(), (result) => result.counts!.pendingOutbox! >= 2
        && result.outbox.some((event) => Number(event.attempts) > 0), "durable outbox retry after an SQS connection failure");
      expect((await request("/health/ready", undefined, undefined, 1, false)).status).toBe(503);
      expect((await request("/health/live", undefined, undefined, 1, false)).status).toBe(200);
    } finally { await runtime.connectivity("sqs", true); }
    await eventually(() => runtime.audit(), (result) => result.counts!.pendingOutbox === 0, "outbox recovery");
    await runtime.connectivity("postgres", false);
    try {
      expect((await request("/health/ready", undefined, undefined, 1, false)).status).toBe(503);
      expect((await runtime.audit()).consistent).toBe(true);
    } finally { await runtime.connectivity("postgres", true); }
    await eventually(() => request("/health/ready", undefined, undefined, 1, false), (response) => response.status === 200,
      "PostgreSQL connectivity recovery");
  }, 60_000);
});
