# Optional local observability

Start the application normally on port 3000, then start the optional services:

```powershell
docker compose -f compose.yaml -f compose.observability.yaml --profile observability up -d prometheus tempo grafana
bun scripts/check-observability.ts
```

The check reads real metrics and exports a diagnostic trace, without creating financial records. It verifies that Grafana can query the trace from Tempo. Run it repeatedly after startup.

Open [the dashboard](http://127.0.0.1:3001/d/wagering-overview/wagering-processor). Anonymous access has the Viewer role and all published ports bind to localhost. Prometheus scrapes the application's existing `/metrics` endpoint every five seconds through Docker Desktop's `host.docker.internal` address. This path was verified on Windows without changing the application's localhost bind. Native Linux host networking may require a different scrape target.

To trace application requests, set these variables before starting or restarting that application process:

```powershell
$env:OTEL_ENABLED = 'true'
$env:OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://127.0.0.1:4318/v1/traces'
bun run start
```

Use Grafana's Explore page and the **Wagering traces** datasource. Tracing is disabled by default; the dashboard still works with the existing metrics. `OTEL_TRACES_SAMPLE_RATIO` accepts a value from zero to one and defaults to one. `OTEL_SERVICE_NAME` defaults to `wagering-processor`.

HTTP and SQS processing share the `wager.process` span. W3C trace context is transported through HTTP headers and SQS message attributes. The outbox JSON stores optional `traceparent` and `tracestate` fields with the committed event, allowing another process to continue its trace. These fields are outside the canonical wager hash and domain event data. Old events without them remain publishable. Pending-reference retries retain the existing correlation ID; their background processing is not attached to the original trace in this increment.

Tracing exports span names, timing, identifiers and status. It does not export financial amounts, request bodies, authorization headers, database statements or exception stacks. Exporter failures cannot reverse a commit or run financial processing twice. Diagnostics use bounded memory and best-effort export: a crashed process can lose buffered spans, while its committed financial records and outbox events remain durable.

The dashboard sums counters across configured instances but uses the maximum for outbox gauges because they describe the same shared database. Percentiles use histogram buckets and are estimates. Counters reset when a process restarts. Add any additional application scrape targets to `prometheus.yaml` to monitor more processes.

These containers are a development/demo setup with local storage, short metric retention and no production availability guarantees. They add neither a financial database migration nor an application dependency on Grafana being online. To stop only these services:

```powershell
docker compose -f compose.yaml -f compose.observability.yaml --profile observability stop prometheus tempo grafana
```
