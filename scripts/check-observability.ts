import { SpanKind } from "@opentelemetry/api";
import { activeTraceIds, initializeTracing, inSpan, shutdownTracing } from "../src/infrastructure/observability/tracing.js";

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

const health = await json<{ database: string }>("http://127.0.0.1:3001/api/health");
if (health.database !== "ok") throw new Error("Grafana is not ready");
const dashboard = await json<{ dashboard?: { panels?: unknown[] } }>("http://127.0.0.1:3001/api/dashboards/uid/wagering-overview");
if (dashboard.dashboard?.panels?.length !== 10) throw new Error("The wagering dashboard was not provisioned");
const metric = await json<{ data?: { result?: unknown[] } }>("http://127.0.0.1:9090/api/v1/query?query=wagering_outbox_pending");
if (!metric.data?.result?.length) throw new Error("No wagering metrics are available; start the application on port 3000");

// A diagnostic trace exercises the real exporter and storage without creating financial records.
process.env.OTEL_ENABLED = "true";
process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://127.0.0.1:4318/v1/traces";
process.env.OTEL_SERVICE_NAME = "wagering-observability-check";
process.env.OTEL_TRACES_SAMPLE_RATIO = "1";
initializeTracing();
let traceId: string | undefined;
try { await inSpan("observability.check", SpanKind.INTERNAL, async () => { traceId = activeTraceIds().traceId; }); }
finally { await shutdownTracing(); }
if (!traceId) throw new Error("OpenTelemetry did not create a trace");
const expires = Date.now() + 15_000;
let stored = false;
do {
  const response = await fetch(`http://127.0.0.1:3001/api/datasources/proxy/uid/wagering-tempo/api/traces/${traceId}`, {
    headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000),
  });
  if (response.ok && (await response.text()).includes("observability.check")) { stored = true; break; }
  await Bun.sleep(250);
} while (Date.now() < expires);
if (!stored) throw new Error(`Grafana could not query the exported trace ${traceId}`);
console.log(JSON.stringify({ grafana: "ready", dashboard: "provisioned", metrics: "available", trace: "stored", traceId,
  dashboardUrl: "http://127.0.0.1:3001/d/wagering-overview/wagering-processor" }));
