import { randomUUID } from "node:crypto";
import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type Context, type Span } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

let provider: NodeTracerProvider | undefined;
export type TraceCarrier = Record<string, string>;

export function initializeTracing(): void {
  const enabled = process.env.OTEL_ENABLED ?? "false";
  if (!["true", "false"].includes(enabled)) throw new Error("OTEL_ENABLED must be true or false");
  if (enabled === "false" || provider) return;
  const endpoint = new URL(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? "http://127.0.0.1:4318/v1/traces");
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must be an HTTP(S) URL without credentials, query or fragment");
  }
  const ratio = Number(process.env.OTEL_TRACES_SAMPLE_RATIO ?? "1");
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new Error("OTEL_TRACES_SAMPLE_RATIO must be between zero and one");
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": process.env.OTEL_SERVICE_NAME ?? "wagering-processor",
      "service.version": "0.1.0", "service.instance.id": randomUUID(), "process.runtime.name": "bun", "process.runtime.version": Bun.version }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint.href, timeoutMillis: 1_000 }), {
      maxQueueSize: 2_048, maxExportBatchSize: 128, scheduledDelayMillis: 500, exportTimeoutMillis: 1_500,
    })],
  });
  // Only W3C trace context crosses boundaries; arbitrary baggage is not forwarded.
  provider.register({ propagator: new W3CTraceContextPropagator() });
}

export async function shutdownTracing(): Promise<void> {
  const current = provider;
  provider = undefined;
  try { await current?.shutdown(); } catch { /* Diagnostics cannot prevent application shutdown. */ }
}

export function traceCarrier(input: unknown): TraceCarrier {
  if (!input || typeof input !== "object") return {};
  const values = input as Record<string, unknown>;
  const carrier: TraceCarrier = {};
  if (typeof values.traceparent === "string" && values.traceparent.length <= 256) carrier.traceparent = values.traceparent;
  if (typeof values.tracestate === "string" && values.tracestate.length <= 512) carrier.tracestate = values.tracestate;
  return carrier;
}

export function extractTraceContext(input: unknown): Context {
  try { return propagation.extract(ROOT_CONTEXT, traceCarrier(input)); } catch { return ROOT_CONTEXT; }
}

export function currentTraceCarrier(): TraceCarrier {
  const carrier: TraceCarrier = {};
  try { propagation.inject(context.active(), carrier); } catch { return {}; }
  return traceCarrier(carrier);
}

export function tracedEnvelope<T extends object>(envelope: T): T & TraceCarrier {
  // This optional transport metadata is saved atomically with the immutable outbox payload.
  return { ...envelope, ...currentTraceCarrier() };
}

export function activeTraceIds(): { traceId?: string; spanId?: string } {
  try {
    const value = trace.getSpan(context.active())?.spanContext();
    return value && /^[0-9a-f]{32}$/.test(value.traceId) && !/^0+$/.test(value.traceId)
      ? { traceId: value.traceId, spanId: value.spanId } : {};
  } catch { return {}; }
}

export async function inSpan<T>(name: string, kind: SpanKind, work: () => Promise<T>,
  attributes: Attributes = {}, parent?: Context): Promise<T> {
  let activeParent = parent ?? ROOT_CONTEXT;
  if (parent === undefined) {
    try { activeParent = context.active(); } catch { /* Observer failure starts a root span instead. */ }
  }
  let span: Span;
  try { span = trace.getTracer("wagering-processor").startSpan(name, { kind, attributes }, activeParent); }
  catch { return work(); }
  let pending: Promise<T> | undefined;
  const execute = (): Promise<T> => pending ??= (async () => {
    try { return await work(); }
    catch (error) {
      // Driver messages, stacks and full financial payloads are intentionally excluded.
      const code = error instanceof Error && "code" in error && typeof error.code === "string"
        && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : "OPERATION_FAILED";
      try { span.setAttribute("error.type", code); span.setStatus({ code: SpanStatusCode.ERROR }); } catch { /* Observer failure. */ }
      throw error;
    } finally { try { span.end(); } catch { /* A finished commit must retain its original result. */ } }
  })();
  try {
    return await context.with(trace.setSpan(activeParent, span), execute);
  } catch {
    // A context manager may fail after starting work. Preserve that exact promise, never rerun it.
    if (pending) return pending;
    try { span.end(); } catch { /* Observer failure. */ }
    return work();
  }
}

export function recordWagerSpan(status: string, replay: boolean, transactionId: string | null | undefined): void {
  try {
    trace.getSpan(context.active())?.setAttributes({ "wagering.status": status, "wagering.idempotent_replay": replay,
      ...(transactionId ? { "wagering.transaction_id": transactionId } : {}) });
  } catch { /* Recording a decision cannot invalidate its committed result. */ }
}
