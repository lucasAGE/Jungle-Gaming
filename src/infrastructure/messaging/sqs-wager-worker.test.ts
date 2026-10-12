import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Logger, Module, type OnApplicationShutdown } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConsumeWager } from "../../application/consume-wager.js";
import { ProcessingError } from "../../application/processing-error.js";
import { ProcessWager, type WagerResult } from "../../application/process-wager.js";
import { WagerQueue, type QueueDelivery } from "../../application/wager-queue.js";
import { SqsWagerWorker } from "./sqs-wager-worker.js";

@Module({})
class TestWagerModule {}

const walletId = "0192f291-27dd-7d3f-8071-5f8685deef37";
const delivery: QueueDelivery = {
  brokerMessageId: "broker-message-1", receiptHandle: "receipt-1", receiveCount: 1, messageGroupId: walletId,
  body: JSON.stringify({
    messageId: "message-1", type: "WagerTransactionRequested", occurredAt: "2026-10-10T12:00:00.000Z",
    data: {
      providerId: "provider-a", externalTransactionId: "transaction-1", idempotencyKey: "provider-a:transaction-1",
      playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", walletId,
      roundId: "round-1", gameId: "game-1", kind: "BET", money: { amount: "25.00", currency: "BRL" },
    },
  }),
};
const result: WagerResult = {
  transactionId: "transaction-1", status: "PROCESSED", balance: { amount: "75.00", currency: "BRL" }, idempotentReplay: false,
};

function barrier() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function context(handle: ProcessWager["execute"], queue: WagerQueue, resources: OnApplicationShutdown) {
  const unused = async (): Promise<never> => { throw new Error("This lifecycle test replaces financial processing"); };
  const processing = new ProcessWager({ findById: unused, findByKey: unused, findByExternal: unused, transaction: unused });
  processing.execute = handle;
  return NestFactory.createApplicationContext({
    module: TestWagerModule,
    providers: [
      { provide: ConsumeWager, useValue: new ConsumeWager(processing, queue) },
      { provide: WagerQueue, useValue: queue },
      SqsWagerWorker,
      { provide: "resources", useValue: resources },
    ],
  });
}

function observeShutdown(worker: SqsWagerWorker) {
  const started = barrier();
  const original = worker.onModuleDestroy.bind(worker);
  const spy = spyOn(worker, "onModuleDestroy").mockImplementation(async () => {
    started.resolve();
    await original();
  });
  return { started: started.promise, restore: () => spy.mockRestore() };
}

describe("SqsWagerWorker lifecycle", () => {
  let previousEnabled: string | undefined;
  let previousVisibility: string | undefined;
  let log: ReturnType<typeof spyOn>;
  let warn: ReturnType<typeof spyOn>;
  let error: ReturnType<typeof spyOn>;

  beforeEach(() => {
    previousEnabled = process.env.SQS_CONSUMER_ENABLED;
    previousVisibility = process.env.SQS_VISIBILITY_TIMEOUT_SECONDS;
    process.env.SQS_CONSUMER_ENABLED = "true";
    process.env.SQS_VISIBILITY_TIMEOUT_SECONDS = "2";
    log = spyOn(Logger.prototype, "log").mockImplementation(() => {});
    warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    error = spyOn(Logger.prototype, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (previousEnabled === undefined) delete process.env.SQS_CONSUMER_ENABLED;
    else process.env.SQS_CONSUMER_ENABLED = previousEnabled;
    if (previousVisibility === undefined) delete process.env.SQS_VISIBILITY_TIMEOUT_SECONDS;
    else process.env.SQS_VISIBILITY_TIMEOUT_SECONDS = previousVisibility;
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  test("Nest shutdown drains the financial commit and acknowledgment before closing resources", async () => {
    const processingStarted = barrier();
    const allowCommit = barrier();
    const ackStarted = barrier();
    const allowAck = barrier();
    const actions: string[] = [];
    let polls = 0;
    const queue: WagerQueue = {
      async receive() { return ++polls === 1 ? delivery : null; },
      async acknowledge() {
        actions.push("ack_started");
        ackStarted.resolve();
        await allowAck.promise;
        actions.push("ack_completed");
      },
      async retry() { actions.push("visibility_extended"); },
      async deadLetter() { actions.push("dead_lettered"); },
    };
    const app = await context(async () => {
      actions.push("processing_started");
      processingStarted.resolve();
      await allowCommit.promise;
      actions.push("committed");
      return result;
    }, queue, { onApplicationShutdown() { actions.push("resources_closed"); } });
    const shutdown = observeShutdown(app.get(SqsWagerWorker));
    let closing: Promise<void> | undefined;
    try {
      await processingStarted.promise;
      closing = app.close();
      await shutdown.started;
      expect(actions).toEqual(["processing_started"]);

      allowCommit.resolve();
      await ackStarted.promise;
      expect(actions).toEqual(["processing_started", "committed", "ack_started"]);
      allowAck.resolve();
      await closing;
      expect(actions).toEqual(["processing_started", "committed", "ack_started", "ack_completed", "resources_closed"]);
      expect(polls).toBe(1);
    } finally {
      allowCommit.resolve();
      allowAck.resolve();
      await (closing ?? app.close());
      shutdown.restore();
    }
  });

  test("returns visibility without processing a delivery received after shutdown starts", async () => {
    const receiveStarted = barrier();
    const allowReceive = barrier();
    const actions: string[] = [];
    let processingCalls = 0;
    const queue: WagerQueue = {
      async receive() { receiveStarted.resolve(); await allowReceive.promise; return delivery; },
      async acknowledge() { actions.push("acknowledged"); },
      async retry(message, delay) { expect(message).toBe(delivery); actions.push(`visibility:${delay}`); },
      async deadLetter() { actions.push("dead_lettered"); },
    };
    const app = await context(async () => { processingCalls += 1; return result; }, queue, {
      onApplicationShutdown() { actions.push("resources_closed"); },
    });
    const shutdown = observeShutdown(app.get(SqsWagerWorker));
    let closing: Promise<void> | undefined;
    try {
      await receiveStarted.promise;
      closing = app.close();
      await shutdown.started;
      expect(actions).toEqual([]);
      allowReceive.resolve();
      await closing;
      expect(processingCalls).toBe(0);
      expect(actions).toEqual(["visibility:0", "resources_closed"]);
    } finally {
      allowReceive.resolve();
      await (closing ?? app.close());
      shutdown.restore();
    }
  });

  test.each(["ack", "retry", "dlq"] as const)("drains an in-flight heartbeat before %s settlement", async (outcome) => {
    const allowProcessing = barrier();
    const processingCompleted = barrier();
    const heartbeatStarted = barrier();
    const allowHeartbeat = barrier();
    const actions: string[] = [];
    let polls = 0;
    const queue: WagerQueue = {
      async receive() { return ++polls === 1 ? delivery : null; },
      async acknowledge() { actions.push("ack"); },
      async retry(_message, delay) {
        if (delay === 2) {
          actions.push("heartbeat_started");
          heartbeatStarted.resolve();
          await allowHeartbeat.promise;
          actions.push("heartbeat_completed");
        } else actions.push(`retry:${delay}`);
      },
      async deadLetter() { actions.push("dlq"); },
    };
    const app = await context(async () => {
      await allowProcessing.promise;
      actions.push("processing_completed");
      processingCompleted.resolve();
      if (outcome !== "ack") throw new ProcessingError(outcome === "retry", new Error("Database failure"));
      return result;
    }, queue, { onApplicationShutdown() { actions.push("resources_closed"); } });
    const shutdown = observeShutdown(app.get(SqsWagerWorker));
    let closing: Promise<void> | undefined;
    try {
      await heartbeatStarted.promise;
      closing = app.close();
      await shutdown.started;
      allowProcessing.resolve();
      await processingCompleted.promise;
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(actions).toEqual(["heartbeat_started", "processing_completed"]);

      allowHeartbeat.resolve();
      await closing;
      expect(actions).toEqual([
        "heartbeat_started", "processing_completed", "heartbeat_completed",
        outcome === "retry" ? "retry:1" : outcome, "resources_closed",
      ]);
      expect(polls).toBe(1);
    } finally {
      allowProcessing.resolve();
      allowHeartbeat.resolve();
      await (closing ?? app.close());
      shutdown.restore();
    }
  });
});
