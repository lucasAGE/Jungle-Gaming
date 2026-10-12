import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { context, propagation, ROOT_CONTEXT, SpanKind, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { currentTraceCarrier, extractTraceContext, inSpan, tracedEnvelope, traceCarrier } from "./tracing.js";
import { OperationalTelemetry } from "./operational-telemetry.js";
import { StructuredLogger } from "./structured-logger.js";
import { wagerInput, wagerPayloadHash } from "../../application/wager-input.js";

const exporter = new InMemorySpanExporter();
let brokenAt: "start" | "end" | undefined;
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter), {
  onStart: () => { if (brokenAt === "start") throw new Error("broken span processor"); },
  onEnd: () => { if (brokenAt === "end") throw new Error("broken span processor"); },
  forceFlush: async () => {}, shutdown: async () => {},
}] });

beforeAll(() => { provider.register({ propagator: new W3CTraceContextPropagator() }); });
beforeEach(() => { exporter.reset(); brokenAt = undefined; });
afterAll(async () => { await provider.shutdown(); trace.disable(); context.disable(); propagation.disable(); });

describe("explicit OpenTelemetry instrumentation on Bun", () => {
  test("disabled tracing invokes work once without exporting or adding outbox metadata", async () => {
    const child = Bun.spawn([process.execPath, "-e", `
      import { SpanKind } from "@opentelemetry/api";
      import { initializeTracing, inSpan, tracedEnvelope } from "./src/infrastructure/observability/tracing.ts";
      initializeTracing();
      let calls = 0;
      const result = await inSpan("disabled", SpanKind.INTERNAL, async () => { calls += 1; return "original"; });
      console.log(JSON.stringify({ calls, result, envelope: tracedEnvelope({ eventId: "event-1" }) }));
    `], { env: { ...process.env, OTEL_ENABLED: "false" }, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).json()).toEqual({ calls: 1, result: "original", envelope: { eventId: "event-1" } });
  });
  test.each(["start", "end"] as const)("a broken span processor at %s preserves success and executes work once", async (phase) => {
    brokenAt = phase;
    let calls = 0;
    expect(await inSpan("committed", SpanKind.INTERNAL, async () => { calls += 1; return "original-result"; })).toBe("original-result");
    expect(calls).toBe(1);
  });

  test("a broken observer preserves the original failure without retrying the business callback", async () => {
    brokenAt = "end";
    let calls = 0;
    const original = new Error("business failure");
    await expect(inSpan("failed", SpanKind.INTERNAL, async () => { calls += 1; throw original; })).rejects.toBe(original);
    expect(calls).toBe(1);
  });

  test("a failed active context lookup cannot prevent financial work", async () => {
    const lookup = spyOn(context, "active").mockImplementation(() => { throw new Error("context lookup unavailable"); });
    let calls = 0;
    try {
      expect(await inSpan("committed", SpanKind.INTERNAL, async () => { calls++; return "original-result"; }))
        .toBe("original-result");
      expect(calls).toBe(1);
    } finally { lookup.mockRestore(); }
  });

  test.each(["success", "failure"] as const)("context failure after callback entry preserves its original %s", async (outcome) => {
    const originalWith = context.with;
    const observer = spyOn(context, "with").mockImplementation(((...args: unknown[]) => {
      Reflect.apply(originalWith, context, args);
      throw new Error("context manager failed after entry");
    }) as typeof context.with);
    const original = new Error("original business rejection");
    let calls = 0;
    try {
      const result = inSpan("financial-operation", SpanKind.INTERNAL, async () => {
        calls++;
        await Promise.resolve();
        if (outcome === "failure") throw original;
        return "committed-result";
      });
      if (outcome === "failure") await expect(result).rejects.toBe(original);
      else expect(await result).toBe("committed-result");
      expect(calls).toBe(1);
      expect(exporter.getFinishedSpans()).toHaveLength(1);
    } finally { observer.mockRestore(); }
  });
  test("keeps simultaneous async operations isolated and connects each child to its own parent", async () => {
    await Promise.all(["one", "two"].map((id) => inSpan(`request.${id}`, SpanKind.SERVER, async () => {
      await new Promise((resolve) => setTimeout(resolve, id === "one" ? 10 : 1));
      return inSpan(`work.${id}`, SpanKind.INTERNAL, async () => "done");
    }, {}, ROOT_CONTEXT)));
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(4);
    for (const id of ["one", "two"]) {
      const parent = spans.find((span) => span.name === `request.${id}`)!;
      const child = spans.find((span) => span.name === `work.${id}`)!;
      expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
      expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    }
    expect(spans[0]!.spanContext().traceId).not.toBe(spans[2]!.spanContext().traceId);
  });

  test("outbox metadata survives JSON persistence and continues tracing in another publisher context", async () => {
    let persisted: object = {};
    await inSpan("wager.process", SpanKind.INTERNAL, async () => {
      persisted = JSON.parse(JSON.stringify(tracedEnvelope({ eventId: "event-1", version: 1, data: { transactionId: "transaction-1" } })));
    }, {}, ROOT_CONTEXT);
    await inSpan("sqs.outbox.publish", SpanKind.PRODUCER, async () => {}, {}, extractTraceContext(persisted));
    const [original, publication] = exporter.getFinishedSpans();
    expect(publication!.spanContext().traceId).toBe(original!.spanContext().traceId);
    expect(publication!.parentSpanContext?.spanId).toBe(original!.spanContext().spanId);
    expect(persisted).toMatchObject({ eventId: "event-1", data: { transactionId: "transaction-1" } });
  });

  test("rejects malformed remote context and never carries baggage or financial fields", async () => {
    const carrier = traceCarrier({ traceparent: "invalid", baggage: "secret=value", money: "100.00", tracestate: "x".repeat(513) });
    expect(carrier).toEqual({ traceparent: "invalid" });
    await inSpan("new.root", SpanKind.SERVER, async () => {
      expect(currentTraceCarrier()).not.toHaveProperty("baggage");
    }, {}, extractTraceContext(carrier));
    expect(exporter.getFinishedSpans()[0]!.parentSpanContext).toBeUndefined();
  });

  test("records decisions and log trace IDs without logging payloads, stacks or driver messages", async () => {
    const lines: string[] = [];
    const telemetry = new OperationalTelemetry(new StructuredLogger((line) => lines.push(line)));
    const failure = Object.assign(new Error("secret SQL and balance 50000.00"), { code: "DATABASE_UNAVAILABLE" });
    await expect(telemetry.trace("wager.process", async () => {
      telemetry.wagerCompleted({ transactionId: "transaction-1" }, "PROCESSED", false, 1);
      throw failure;
    })).rejects.toBe(failure);
    const span = exporter.getFinishedSpans()[0]!;
    expect(span.attributes).toMatchObject({ "wagering.status": "PROCESSED", "wagering.idempotent_replay": false,
      "wagering.transaction_id": "transaction-1", "error.type": "DATABASE_UNAVAILABLE" });
    expect(span.events).toHaveLength(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ traceId: span.spanContext().traceId, spanId: span.spanContext().spanId });
    expect(JSON.stringify(span.attributes) + lines.join("")).not.toMatch(/secret|50000|stack|balance/);
  });

  test("transport context cannot change the canonical wager payload hash", () => {
    const body = { providerId: "provider-a", externalTransactionId: "external-1", playerId: crypto.randomUUID(),
      walletId: crypto.randomUUID(), roundId: "round-1", gameId: "fortune-chimp", kind: "BET",
      money: { amount: "1.00", currency: "BRL" } };
    // Context is outside the business payload on both HTTP headers and SQS message attributes.
    const requests = ["00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01", "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01"]
      .map((traceparent) => ({ headers: { traceparent }, body }));
    expect(wagerPayloadHash(wagerInput(requests[0]!.body))).toBe(wagerPayloadHash(wagerInput(requests[1]!.body)));
  });
});
