# Reproducible financial load experiment

The optional README experiment is available as:

```powershell
bun run test:load
```

It starts the existing isolated PostgreSQL and MiniStack services, builds the app,
resets only `wagering_test` on localhost port 55433, and starts three independent
application processes. Do not run it alongside integration tests, another load run,
or an authentication integration run: they share that disposable database.
Development wallets and queues are not reset. Every run creates its own SQS queues
and removes them after stopping its processes. Runs are repeatable.

Options are explicit and bounded:

```powershell
bun run test:load --requests 600 --concurrency 12
bun run test:load --requests 60 --concurrency 6
bun test tests/load/report.test.ts
```

`--requests` is per measured scenario (30–5000, default 600), and `--concurrency`
is the number of client workers (1–100, default 12). Arguments are validated before
starting containers or resetting the database. There is no RPS pass threshold.

## Methodology

After 30 warmup requests, two scenarios run sequentially:

1. **Hot wallet:** all distinct BETs debit the same wallet.
2. **Distributed wallets:** distinct BETs rotate across 20 wallets.

Every wager is exactly `"1.00" BRL`; every wallet opens with `"10000.00" BRL`,
enough for the maximum configured workload. HTTP requests rotate across the three
application processes. All three outbox publishers send events to real MiniStack SQS.
Input consumers and reference workers are disabled: this measures HTTP input with
SQS event output, not SQS input throughput. HTTP authentication and OpenTelemetry
are disabled only in these isolated benchmark processes to measure the financial
baseline; their overhead and Keycloak capacity are not included.

The workload is closed-loop: each client worker sends its next request after the
previous one completes. This does not model a fixed external arrival rate. Timings
use a monotonic clock and include complete HTTP responses, including errors and
the 15-second transport deadline. The client does not retry requests. Startup,
migrations, wallet creation, warmup, outbox drain and audit queries are outside the
request measurement window. p50/p95/p99 use the nearest-rank method, without dropping
slow requests or interpolating away a small sample's tail.

The report separates successful HTTP responses from committed database identities.
A transport failure does not imply the transaction rolled back. It records error
rate and codes, attempts/second, successful responses/second and committed
transactions/second. The financial audit checks every acknowledged identity, wallet
amount and version, ledger counts, exact reconstructed balances, and both published
events for every committed BET. Since the accounting increment, it also checks a
matching journal pair per ledger entry, wallet posting totals and balanced global
debits/credits per currency. Unexpected terminal failures, invariant violations,
absence of successful operations, or an outbox drain exceeding 60 seconds fail the run.

A transport timeout or response-body parsing failure also makes the run fail:
ending a client request does not cancel work already executing on the server.
The harness still records available metrics and database audit snapshots for
diagnosis, but cannot certify final financial consistency after an ambiguous
response. Such reports include `ambiguousResponses`, omit a positive
`financialInvariantsPassed`, and set committed transactions/second to `null`:
a late commit could occur outside the HTTP measurement window. HTTP errors whose
response bodies were received and parsed remain measured errors, not ambiguous
transport failures. There are no automatic client retries.

Lock-error counters are summed as deltas across processes. They cover deadlocks,
serialization failures and lock timeouts, not normal waiting for a wallet lock or
connection-pool timeouts. Zero lock errors does not mean zero contention.

The outbox is a shared database gauge, so it is sampled from one process rather than
summed across replicas. The sampler waits 500 ms between completed metric requests
and records sample failures and maximum **observed** backlog/age during load and drain.
It may miss shorter peaks. A separate SQL query measures each event's persisted
`published_at - occurred_at` after publication. Sampling adds some overhead.

## Reports and measured baseline

Each run writes `reports/load/<timestamp>-<run-id>.json` plus `reports/load/latest.json`,
including environment, parameters, distinct PIDs, results and cleanup errors.
Reports are local generated files, excluded from Git. A failed run retains a partial
diagnostic report when possible and exits nonzero; inspect `passed`, `error` and
`cleanupErrors` before interpreting performance values.

Initial baseline on 2026-10-11 local time (2026-10-12 02:23:57 UTC): Bun 1.4.3,
Windows 10 x64, AMD Ryzen 5 5500 with 12 logical CPUs and approximately 32 GiB host RAM.
Docker Engine 29.7.2 ran Linux containers with 12 CPUs and approximately 15.6 GiB RAM;
PostgreSQL 17.6 and MiniStack 1.5.24. Three process IDs were 23068, 19780 and 9176.
Default parameters: 600 requests per scenario, concurrency 12, 30 excluded warmup
requests. Other local activity was not controlled, so this is a local experiment,
not a production capacity claim.

| Measure | Hot wallet | 20 wallets |
| --- | ---: | ---: |
| Requests / committed BETs | 600 / 600 | 600 / 600 |
| Measurement duration | 20.46 s | 8.80 s |
| Requests per second | 29.33 | 68.15 |
| p50 / p95 / p99 | 366.15 / 761.98 / 920.50 ms | 147.21 / 355.86 / 750.65 ms |
| HTTP error rate | 0% | 0% |
| Lock errors / outbox retries | 0 / 0 | 0 / 0 |
| Maximum observed pending events | 18 | 815 |
| Maximum observed oldest pending age | 0.29 s | 7.60 s |
| Event publication p50 / p95 / p99 | 108 / 268 / 301 ms | 5965 / 7569 / 7602 ms |
| Drain after HTTP requests | 0.11 s | 7.62 s |
| Financial invariants | Passed | Passed |

The distributed workload completed HTTP requests faster but outran the three
publishers, accumulating an observable backlog that subsequently drained. The hot
wallet serialized financial changes. These observations support discussing the
trade-off between request throughput and eventual publication; a larger controlled
experiment would be needed to identify hardware or service capacity limits.

This baseline preceded the authentication/tracing implementation. Future runs keep
those features explicitly disabled in the benchmark and record their methodology
in each report. It must not be presented as an authenticated API benchmark.

## Repeatability check after the optional features

`bun run test:load --requests 60 --concurrency 6` passed at 2026-10-12
02:47:45–02:48:04 UTC on the same host, using independent PIDs 40788, 33556 and 38348.
All 120 measured requests and the 30 excluded warmup requests returned HTTP 200.
Both financial audits passed, with no ambiguous responses, metric-sampling failures,
lock errors, outbox retries or cleanup errors.

| Measure | Hot wallet | 20 wallets |
| --- | ---: | ---: |
| Requests / committed BETs | 60 / 60 | 60 / 60 |
| Requests per second | 24.59 | 35.90 |
| p50 / p95 / p99 | 234.04 / 349.12 / 392.36 ms | 155.95 / 236.77 / 275.27 ms |
| Maximum observed pending events | 19 | 57 |
| Maximum observed oldest pending age | 0.27 s | 0.88 s |
| Event publication p50 / p95 / p99 | 176 / 288 / 320 ms | 719 / 861 / 885 ms |
| Drain after HTTP requests | 0.37 s | 0.64 s |

This shorter run validates repeatability and the updated harness. Its different
request count, concurrency and uncontrolled local activity preclude a direct
performance comparison with the original baseline. Authentication and tracing
remained explicitly disabled in the isolated load processes.

## Repeatability check with double-entry accounting

`bun run test:load --requests 60 --concurrency 6` passed at 2026-10-12
03:26:52–03:27:09 UTC using independent PIDs 41328, 41316 and 35008.
All 120 measured requests and 30 warmup requests returned HTTP 200. The audit now
also verified exact journal coverage, wallet accounting totals and balanced global
postings. No ambiguous responses, lock errors, outbox retries, metric-sampling
failures or cleanup errors occurred.

| Measure | Hot wallet | 20 wallets |
| --- | ---: | ---: |
| Requests / committed BETs | 60 / 60 | 60 / 60 |
| Requests per second | 18.31 | 55.77 |
| p50 / p95 / p99 | 287.66 / 580.17 / 712.82 ms | 106.80 / 141.23 / 160.15 ms |
| Maximum observed pending events | 12 | 59 |
| Maximum observed oldest pending age | 0.27 s | 0.63 s |
| Event publication p50 / p95 / p99 | 167 / 281 / 303 ms | 613 / 676 / 760 ms |
| Drain after HTTP requests | 0.11 s | 0.78 s |

This short run verifies the final accounting implementation under concurrent load.
The host also ran local presentation/monitoring services; these measurements do not
isolate the cost of accounting from other activity. Auth/tracing stayed disabled in
the three isolated load processes. The machine-readable report is saved under
`reports/load/` (ignored by Git); the full run ID is `5c74e7ea-085b-494c-8523-8d64fa6d50b5`.
