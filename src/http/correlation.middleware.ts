import { correlationId, requestContext } from "../infrastructure/observability/request-context.js";
import { StructuredLogger } from "../infrastructure/observability/structured-logger.js";
import { context, SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { extractTraceContext } from "../infrastructure/observability/tracing.js";

interface CorrelatedRequest { headers: Record<string, unknown>; method?: string; route?: { path?: unknown } }
interface CorrelatedResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  once(event: "finish" | "close", handler: () => void): unknown;
}

export function correlationMiddleware(request: CorrelatedRequest, response: CorrelatedResponse, next: () => void): void {
  const requestFields = { correlationId: correlationId(request.headers["x-correlation-id"]) };
  response.setHeader("x-correlation-id", requestFields.correlationId);
  const started = performance.now();
  const method = /^[A-Z]{1,12}$/.test(request.method ?? "") ? request.method! : "HTTP";
  const parent = extractTraceContext(request.headers);
  let span: Span | undefined;
  try {
    span = trace.getTracer("wagering-processor").startSpan(method, {
      kind: SpanKind.SERVER, attributes: { "http.request.method": method, "wagering.correlation_id": requestFields.correlationId },
    }, parent);
  } catch { /* HTTP handling continues when its optional observer cannot start. */ }
  let active = parent;
  try { if (span) active = trace.setSpan(parent, span); } catch { /* Context setup cannot block the request. */ }
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    // Express route templates avoid recording player identifiers, URLs and query strings.
    const route = typeof request.route?.path === "string" ? request.route.path : "unmatched";
    try {
      span?.updateName(`${method} ${route}`);
      span?.setAttributes({ "http.route": route, "http.response.status_code": response.statusCode });
      if (response.statusCode >= 500) span?.setStatus({ code: SpanStatusCode.ERROR });
    } catch { /* Observer failure cannot change a completed HTTP response. */ }
    let logged = false;
    const log = () => {
      logged = true;
      new StructuredLogger().log({
        event: "http_completed", ...requestFields, statusCode: response.statusCode, elapsedMs: performance.now() - started,
      });
    };
    try { context.with(active, log); }
    catch { if (!logged) log(); }
    finally { try { span?.end(); } catch { /* A failed exporter cannot terminate the application. */ } }
  };
  response.once("finish", end);
  response.once("close", end);
  let entered = false;
  let failed = false;
  let downstreamError: unknown;
  const proceed = () => {
    entered = true;
    try { requestContext.run(requestFields, next); }
    catch (error) { failed = true; downstreamError = error; throw error; }
  };
  try { context.with(active, proceed); }
  catch {
    if (failed) throw downstreamError;
    if (!entered) proceed();
  }
}
