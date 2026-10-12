import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Logger, Module, type OnApplicationShutdown } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ProcessWager, type ReferenceProcessingResult } from "../application/process-wager.js";
import { ReferenceWorker } from "./reference-worker.js";

@Module({})
class TestReferenceModule {}

const result: ReferenceProcessingResult = {
  transactionId: "win-1", status: "PROCESSED", walletId: "wallet-1", providerId: "provider-a",
  correlationId: "request-1", referenceAttempts: 2,
};

function barrier() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function context(handle: ProcessWager["reprocessNext"], resources: OnApplicationShutdown) {
  const unused = async (): Promise<never> => { throw new Error("This lifecycle test controls the commit boundary"); };
  const processing = new ProcessWager({ findById: unused, findByKey: unused, findByExternal: unused, transaction: unused });
  processing.reprocessNext = handle;
  return NestFactory.createApplicationContext({
    module: TestReferenceModule,
    providers: [
      { provide: ProcessWager, useValue: processing },
      ReferenceWorker,
      { provide: "resources", useValue: resources },
    ],
  });
}

describe("ReferenceWorker lifecycle", () => {
  let previousEnabled: string | undefined;
  let log: ReturnType<typeof spyOn>;
  let warn: ReturnType<typeof spyOn>;
  let error: ReturnType<typeof spyOn>;

  beforeEach(() => {
    previousEnabled = process.env.REFERENCE_WORKER_ENABLED;
    process.env.REFERENCE_WORKER_ENABLED = "true";
    log = spyOn(Logger.prototype, "log").mockImplementation(() => {});
    warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    error = spyOn(Logger.prototype, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (previousEnabled === undefined) delete process.env.REFERENCE_WORKER_ENABLED;
    else process.env.REFERENCE_WORKER_ENABLED = previousEnabled;
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  test("Nest shutdown drains the reference decision and commit before closing database resources", async () => {
    const processingStarted = barrier();
    const allowDecision = barrier();
    const commitStarted = barrier();
    const allowCommit = barrier();
    const destroyStarted = barrier();
    const actions: string[] = [];
    let polls = 0;
    log.mockImplementation((entry: unknown) => {
      if (typeof entry === "object" && entry !== null && "event" in entry && entry.event === "reference_checked") {
        actions.push("outcome_logged");
      }
    });
    const app = await context(async () => {
      polls += 1;
      actions.push("processing_started");
      processingStarted.resolve();
      await allowDecision.promise;
      actions.push("decision_ready");
      commitStarted.resolve();
      await allowCommit.promise;
      actions.push("decision_committed");
      return result;
    }, { onApplicationShutdown() { actions.push("resources_closed"); } });
    const worker = app.get(ReferenceWorker);
    const originalDestroy = worker.onModuleDestroy.bind(worker);
    const destroy = spyOn(worker, "onModuleDestroy").mockImplementation(async () => {
      destroyStarted.resolve();
      await originalDestroy();
    });
    let closing: Promise<void> | undefined;
    try {
      await processingStarted.promise;
      closing = app.close();
      await destroyStarted.promise;
      expect(actions).toEqual(["processing_started"]);

      allowDecision.resolve();
      await commitStarted.promise;
      expect(actions).toEqual(["processing_started", "decision_ready"]);
      expect(error).not.toHaveBeenCalled();

      allowCommit.resolve();
      await closing;
      expect(actions).toEqual([
        "processing_started", "decision_ready", "decision_committed", "outcome_logged", "resources_closed",
      ]);
      expect(polls).toBe(1);
    } finally {
      allowDecision.resolve();
      allowCommit.resolve();
      await (closing ?? app.close());
      destroy.mockRestore();
    }
  });

  test("a failed poll resumes processing without logging database secrets or leaking a shutdown poll", async () => {
    const idle = barrier();
    const nextReferenceAttemptAt = new Date("2026-10-10T12:00:30.000Z");
    let polls = 0;
    let resourcesClosed = false;
    const app = await context(async () => {
      polls += 1;
      if (polls === 1) throw new Error("postgres://user:secret-password@localhost/database; private-payload");
      if (polls === 2) return { ...result, status: "PENDING_REFERENCE", nextReferenceAttemptAt };
      idle.resolve();
      return null;
    }, { onApplicationShutdown() { resourcesClosed = true; } });
    try {
      await idle.promise;
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith({ event: "reference_processing_failed", errorType: "Error" });
      expect(log).toHaveBeenCalledWith({
        event: "reference_checked", ...result, status: "PENDING_REFERENCE",
        nextReferenceAttemptAt: nextReferenceAttemptAt.toISOString(),
      });
      const diagnostics = JSON.stringify([...error.mock.calls, ...log.mock.calls]);
      expect(diagnostics).not.toContain("secret-password");
      expect(diagnostics).not.toContain("private-payload");
    } finally {
      await app.close();
    }
    expect(resourcesClosed).toBe(true);
    expect(polls).toBe(3);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(polls).toBe(3);
  });

  test("disabled workers never claim a reference and still close resources", async () => {
    process.env.REFERENCE_WORKER_ENABLED = "false";
    let polls = 0;
    let resourcesClosed = false;
    const app = await context(async () => { polls += 1; return null; }, {
      onApplicationShutdown() { resourcesClosed = true; },
    });
    await app.close();
    expect(polls).toBe(0);
    expect(resourcesClosed).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });
});
