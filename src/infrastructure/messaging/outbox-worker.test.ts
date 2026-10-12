import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Logger, Module, type OnApplicationShutdown } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { EventPublisher } from "../../application/event-publisher.js";
import type { OutboxStore } from "../../application/outbox-store.js";
import { PublishOutbox } from "../../application/publish-outbox.js";
import { OutboxMessage } from "../../domain/outbox-message.js";
import { OutboxWorker } from "./outbox-worker.js";

@Module({})
class TestOutboxModule {}

function barrier() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function message(): OutboxMessage {
  const occurredAt = new Date("2026-10-10T12:00:00.000Z");
  return OutboxMessage.rehydrate({
    id: "event-1", aggregateId: "wallet-1", eventType: "WalletBalanceChanged", occurredAt, attempts: 0,
    payload: {
      eventId: "event-1", aggregateId: "wallet-1", eventType: "WalletBalanceChanged",
      correlationId: "request-1", occurredAt: occurredAt.toISOString(), version: 1,
      data: { transactionId: "transaction-1" },
    },
  });
}

function context(workflow: PublishOutbox, resources: OnApplicationShutdown) {
  return NestFactory.createApplicationContext({
    module: TestOutboxModule,
    providers: [
      { provide: PublishOutbox, useValue: workflow },
      OutboxWorker,
      { provide: "resources", useValue: resources },
    ],
  });
}

describe("OutboxWorker lifecycle", () => {
  let previousEnabled: string | undefined;
  let log: ReturnType<typeof spyOn>;
  let warn: ReturnType<typeof spyOn>;
  let error: ReturnType<typeof spyOn>;

  beforeEach(() => {
    previousEnabled = process.env.OUTBOX_PUBLISHER_ENABLED;
    process.env.OUTBOX_PUBLISHER_ENABLED = "true";
    log = spyOn(Logger.prototype, "log").mockImplementation(() => {});
    warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    error = spyOn(Logger.prototype, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (previousEnabled === undefined) delete process.env.OUTBOX_PUBLISHER_ENABLED;
    else process.env.OUTBOX_PUBLISHER_ENABLED = previousEnabled;
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  test("Nest shutdown drains publication and its commit before closing shared resources", async () => {
    const pending = message();
    const sendStarted = barrier();
    const allowSend = barrier();
    const commitStarted = barrier();
    const allowCommit = barrier();
    const destroyStarted = barrier();
    const actions: string[] = [];
    let polls = 0;
    let resourcesClosed = false;
    const store: OutboxStore = {
      async withNextDue(work) {
        polls += 1;
        if (polls > 1) return null;
        await work(pending);
        commitStarted.resolve();
        await allowCommit.promise;
        actions.push("delivery_committed");
        return pending;
      },
    };
    const publisher: EventPublisher = {
      async publish() {
        actions.push("send_started");
        sendStarted.resolve();
        await allowSend.promise;
        actions.push("send_completed");
      },
    };
    const app = await context(new PublishOutbox(store, publisher), {
      onApplicationShutdown() {
        resourcesClosed = true;
        actions.push("resources_closed");
      },
    });
    const worker = app.get(OutboxWorker);
    const originalDestroy = worker.onModuleDestroy.bind(worker);
    const destroy = spyOn(worker, "onModuleDestroy").mockImplementation(async () => {
      destroyStarted.resolve();
      await originalDestroy();
    });
    let closing: Promise<void> | undefined;
    try {
      await sendStarted.promise;
      closing = app.close();
      await destroyStarted.promise;
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(resourcesClosed).toBe(false);
      expect(pending.isPending()).toBe(true);

      allowSend.resolve();
      await commitStarted.promise;
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(resourcesClosed).toBe(false);
      expect(pending.isPending()).toBe(false);

      allowCommit.resolve();
      await closing;
      expect(actions).toEqual(["send_started", "send_completed", "delivery_committed", "resources_closed"]);
      expect(polls).toBe(1);
    } finally {
      allowSend.resolve();
      allowCommit.resolve();
      await (closing ?? app.close());
      destroy.mockRestore();
    }
  });

  test("a failed database poll does not stop later publication", async () => {
    const pending = message();
    const committed = barrier();
    let polls = 0;
    let sends = 0;
    let resourcesClosed = false;
    const store: OutboxStore = {
      async withNextDue(work) {
        polls += 1;
        if (polls === 1) throw new Error("Database temporarily unavailable");
        if (!pending.isPending()) return null;
        await work(pending);
        committed.resolve();
        return pending;
      },
    };
    const publisher: EventPublisher = { async publish() { sends += 1; } };
    const app = await context(new PublishOutbox(store, publisher), {
      onApplicationShutdown() { resourcesClosed = true; },
    });
    try {
      await committed.promise;
      expect(polls).toBeGreaterThanOrEqual(2);
      expect(sends).toBe(1);
      expect(pending.isPending()).toBe(false);
      expect(error).toHaveBeenCalledWith({ event: "outbox_poll_failed", errorType: "Error" });
    } finally {
      await app.close();
    }
    expect(resourcesClosed).toBe(true);
  });
});
