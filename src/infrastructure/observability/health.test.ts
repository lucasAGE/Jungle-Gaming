import { describe, expect, test } from "bun:test";
import { Health, withinDeadline } from "./health.js";

describe("bounded dependency readiness", () => {
  test("requires PostgreSQL and SQS to be available", async () => {
    const health = new Health({ postgres: async () => {}, queues: async () => {} });
    expect(await health.ready()).toEqual({ ready: true, dependencies: { postgres: "up", sqs: "up" } });
  });

  test.each(["postgres", "sqs"] as const)("reports %s unavailable without connection strings or error messages", async (dependency) => {
    const fail = async () => { throw new Error("postgres://user:password/private; financial-payload"); };
    const health = new Health({ postgres: dependency === "postgres" ? fail : async () => {}, queues: dependency === "sqs" ? fail : async () => {} });
    const result = await health.ready();
    expect(result.ready).toBe(false);
    expect(result.dependencies[dependency]).toBe("down");
    expect(JSON.stringify(result)).not.toMatch(/password|private|financial/);
  });

  test("a stalled dependency respects the deadline and aborts SQS requests", async () => {
    let signal: AbortSignal | undefined;
    const health = new Health({ postgres: async () => {}, queues: async (received) => {
      signal = received;
      await new Promise<void>(() => {});
    } }, 20);
    const started = performance.now();
    expect(await health.ready()).toEqual({ ready: false, dependencies: { postgres: "up", sqs: "down" } });
    expect(performance.now() - started).toBeLessThan(500);
    expect(signal?.aborted).toBe(true);
  });

  test("parallel probes share one dependency check and later probes recover", async () => {
    let postgresCalls = 0;
    let queueCalls = 0;
    let recovered = false;
    const health = new Health({
      postgres: async () => { postgresCalls += 1; if (!recovered) throw new Error("Unavailable"); },
      queues: async () => { queueCalls += 1; },
    });
    const probes = await Promise.all(Array.from({ length: 50 }, () => health.ready()));
    expect(probes.every((result) => !result.ready)).toBe(true);
    expect(postgresCalls).toBe(1);
    expect(queueCalls).toBe(1);
    recovered = true;
    expect((await health.ready()).ready).toBe(true);
    expect(postgresCalls).toBe(2);
  });

  test("deadline propagates a resolved value and does not swallow a dependency rejection", async () => {
    expect(await withinDeadline(Promise.resolve(42), 20)).toBe(42);
    await expect(withinDeadline(Promise.reject(new Error("offline")), 20)).rejects.toThrow("offline");
  });
});
