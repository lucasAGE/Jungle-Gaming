import { mkdir } from "node:fs/promises";
import { cpus, release, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { CreateQueueCommand, DeleteQueueCommand } from "@aws-sdk/client-sqs";
import { Money } from "../../src/domain/money.js";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client.js";
import { isolatedDatabaseUrl, resetTestDatabase, startApplication, stop,
  type Application, type Child, type Orm, type WalletResponse } from "../integration/helpers.js";
import { parseLoadOptions, summarizeLatencies } from "./report.js";

const options = parseLoadOptions(process.argv.slice(2));
isolatedDatabaseUrl();
if (process.env.RUN_SQS_INTEGRATION !== "1" || process.env.TEST_SQS_ENDPOINT !== "http://127.0.0.1:4567") {
  throw new Error("Load tests require the isolated MiniStack endpoint; use bun run test:load");
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const runId = crypto.randomUUID();
const startedAt = new Date().toISOString();
const client = createSqsClient(process.env.TEST_SQS_ENDPOINT);
const queues: string[] = [];
const children: Child[] = [];
const applications: Application[] = [];
let orm: Orm | undefined;
const report = {
  schemaVersion: 1, runId, startedAt, completedAt: "", passed: false,
  environment: { bun: Bun.version, platform: process.platform, release: release(), architecture: process.arch,
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(),
    docker: {} as Record<string, unknown>, images: [] as string[], applicationPids: [] as number[] },
  methodology: { ...options, instances: 3, warmupRequests: 30, amount: "1.00 BRL", initialBalance: "10000.00 BRL",
    workload: "Closed-loop HTTP BETs, round-robin across three processes, with three real SQS outbox publishers",
    authentication: "Disabled only in isolated financial benchmark processes; Keycloak is tested separately",
    tracing: "Disabled for this controlled financial baseline",
    percentiles: "Nearest rank over all completed attempts, including HTTP and transport failures",
    requestTimeoutMs: 15_000, clientRetries: 0, outboxSampleDelayMs: 500, outboxDrainTimeoutMs: 60_000,
    excludedFromRequestTiming: "Build, migrations, startup, wallet creation, warmup, outbox drain and correctness queries",
    limitations: ["Short local experiment; no production capacity or arrival-rate guarantee",
      "HTTP input and SQS event output only; SQS input throughput is not measured",
      "Normal wallet lock waits are reflected in latency, not in the lock-error counter",
      "Outbox gauges are shared database values, sampled once, not summed across replicas",
      "Periodic metric sampling and local Docker resource contention affect the results"] },
  scenarios: [] as Record<string, unknown>[], error: null as string | null, cleanupErrors: [] as string[],
};

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function rows<T = Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<T[]> {
  ensure(orm, "The test database is not initialized");
  return orm.em.getConnection().execute<T[]>(sql, parameters);
}

async function commandOutput(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "inherit" });
  const output = await new Response(child.stdout).text();
  ensure(await child.exited === 0, `Environment command failed: ${args.join(" ")}`);
  return output.trim();
}

async function queue(fifo = false): Promise<string> {
  const result = await client.send(new CreateQueueCommand({ QueueName: `load-${crypto.randomUUID()}${fifo ? ".fifo" : ""}`,
    ...(fifo ? { Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } } : {}) }));
  ensure(result.QueueUrl, "SQS did not return a queue URL");
  queues.push(result.QueueUrl);
  return result.QueueUrl;
}

async function post(path: string, body: unknown, index: number, key?: string): Promise<Response> {
  return fetch(`${applications[index % 3]!.url}${path}`, { method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
}

async function metrics(index: number): Promise<Map<string, number>> {
  const response = await fetch(`${applications[index]!.url}/metrics`, { signal: AbortSignal.timeout(5_000) });
  ensure(response.ok, `Metrics returned HTTP ${response.status}`);
  const values = new Map<string, number>();
  for (const line of (await response.text()).split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const split = line.lastIndexOf(" ");
    values.set(line.slice(0, split), Number(line.slice(split + 1)));
  }
  return values;
}

function metric(values: Map<string, number>, name: string): number {
  const value = values.get(name);
  ensure(value !== undefined && Number.isFinite(value), `Missing or invalid metric: ${name}`);
  return value;
}

async function counters(): Promise<{ locks: number; retries: number }> {
  const samples = await Promise.all(applications.map((_, index) => metrics(index)));
  return { locks: samples.reduce((sum, value) => sum + metric(value, "wagering_lock_conflicts_total"), 0),
    retries: samples.reduce((sum, value) => sum + metric(value, 'wagering_retries_total{source="outbox"}'), 0) };
}

async function drain(): Promise<void> {
  const expires = performance.now() + 60_000;
  do {
    const [result] = await rows<{ pending: number }>("select count(*)::int as pending from outbox_messages where published_at is null");
    if (result!.pending === 0) return;
    await Bun.sleep(100);
  } while (performance.now() < expires);
  throw new Error("The outbox did not drain within 60 seconds");
}

async function scenario(name: string, walletCount: number, requestCount: number, measured: boolean): Promise<void> {
  const wallets: WalletResponse[] = [];
  for (let index = 0; index < walletCount; index++) {
    const response = await post("/wallets", { playerId: crypto.randomUUID(),
      initialBalance: { amount: "10000.00", currency: "BRL" } }, index);
    ensure(response.status === 201, `Opening returned HTTP ${response.status}`);
    wallets.push(await response.json() as WalletResponse);
  }
  const providerId = `load-${runId}-${name}`;
  const requests = Array.from({ length: requestCount }, (_, index) => {
    const wallet = wallets[index % wallets.length]!;
    return { providerId, externalTransactionId: crypto.randomUUID(), walletId: wallet.id, playerId: wallet.playerId,
      roundId: `round-${index}`, gameId: "load-test", kind: "BET", money: { amount: "1.00", currency: "BRL" } };
  });
  await drain();
  const before = await counters();
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  const errorCodes: Record<string, number> = {};
  const accepted = new Map<string, string>();
  let ambiguousResponses = 0;
  const sampling = { samples: 0, failures: 0, maximumPending: 0, maximumLagSeconds: 0 };
  let samplingStopped = false;
  const sampler = (async () => {
    while (!samplingStopped) {
      try {
        const values = await metrics(0);
        const pending = metric(values, "wagering_outbox_pending");
        const lagSeconds = metric(values, "wagering_outbox_lag_seconds");
        sampling.samples++;
        sampling.maximumPending = Math.max(sampling.maximumPending, pending);
        sampling.maximumLagSeconds = Math.max(sampling.maximumLagSeconds, lagSeconds);
      } catch { sampling.failures++; }
      if (!samplingStopped) await Bun.sleep(500);
    }
  })();
  const result: Record<string, unknown> = { name, walletCount, requested: requestCount, statuses, errorCodes, outboxSampling: sampling };
  if (measured) report.scenarios.push(result);
  let next = 0;
  const start = performance.now();
  try {
    await Promise.all(Array.from({ length: Math.min(options.concurrency, requestCount) }, async () => {
      while (next < requests.length) {
        const index = next++;
        const body = requests[index]!;
        const sent = performance.now();
        try {
          const response = await post("/wagering/transactions", body, index, `${providerId}:${body.externalTransactionId}`);
          const status = String(response.status);
          statuses[status] = (statuses[status] ?? 0) + 1;
          const payload = await response.json() as { status?: string; transactionId?: string; code?: string };
          if (response.status === 200 && payload.status === "PROCESSED" && typeof payload.transactionId === "string") {
            accepted.set(body.externalTransactionId, payload.transactionId);
          } else {
            const code = payload.code ?? "UNEXPECTED_RESPONSE";
            errorCodes[code] = (errorCodes[code] ?? 0) + 1;
          }
        } catch (error) {
          ambiguousResponses++;
          const code = error instanceof Error ? error.name : "TransportError";
          errorCodes[code] = (errorCodes[code] ?? 0) + 1;
        } finally { latencies.push(performance.now() - sent); }
      }
    }));
    const elapsedMs = performance.now() - start;
    Object.assign(result, { elapsedMs, completedAttempts: latencies.length, successfulResponses: accepted.size, ambiguousResponses,
      errorRate: (requestCount - accepted.size) / requestCount, requestsPerSecond: requestCount / (elapsedMs / 1_000),
      successfulResponsesPerSecond: accepted.size / (elapsedMs / 1_000), latency: summarizeLatencies(latencies) });
    const drainStart = performance.now();
    await drain();
    result.outboxDrainAfterRequestsMs = performance.now() - drainStart;
    samplingStopped = true;
    await sampler;
    const after = await counters();
    result.lockErrors = after.locks - before.locks;
    result.outboxRetries = after.retries - before.retries;

    // Count committed identities independently: a missing HTTP response does not prove rollback.
    const persisted = await rows<{ id: string; external_transaction_id: string; wallet_id: string; status: string }>(
      "select id, external_transaction_id, wallet_id, status from wager_transactions where provider_id = ?", [providerId]);
    const submitted = new Set<string>(requests.map((request) => request.externalTransactionId));
    ensure(persisted.length <= requestCount && persisted.every((row) => row.status === "PROCESSED" && submitted.has(row.external_transaction_id)),
      "Unexpected or terminally failed transaction in the load workload");
    ensure(new Set(persisted.map((row) => row.external_transaction_id)).size === persisted.length, "Duplicate financial identity");
    for (const [identity, id] of accepted) ensure(persisted.some((row) => row.id === id && row.external_transaction_id === identity), "Acknowledged wager was not persisted");
    result.committedTransactions = persisted.length;
    result.committedTransactionsPerSecond = ambiguousResponses === 0 ? persisted.length / (elapsedMs / 1_000) : null;
    result.committedWithoutSuccessfulResponse = persisted.length - accepted.size;
    for (const wallet of wallets) {
      const count = persisted.filter((row) => row.wallet_id === wallet.id).length;
      const expected = Money.from(wallet.balance).subtract(Money.from({ amount: `${count}.00`, currency: "BRL" }));
      const [stored] = await rows<{ balance: string; version: number; entries: number }>(
        `select balance::text, version, (select count(*)::int from wallet_ledger where wallet_id = wallets.id) as entries
         from wallets where id = ?`, [wallet.id]);
      ensure(stored?.balance === expected.toString() && stored.version === count + 1 && stored.entries === count + 1,
        "Wallet amount, version or ledger count disagrees with committed BETs");
    }
    const events = await rows<{ transaction_id: string; event_type: string; published_at: Date | null; delay_ms: number }>(
      `select t.id as transaction_id, o.event_type, o.published_at,
        (extract(epoch from (o.published_at - o.occurred_at)) * 1000)::double precision as delay_ms
       from outbox_messages o join wager_transactions t on o.payload->'data'->>'transactionId' = t.id::text
       where t.provider_id = ?`, [providerId]);
    ensure(events.length === persisted.length * 2, "Committed BETs must have exactly two outbox events");
    for (const row of persisted) {
      const types = events.filter((event) => event.transaction_id === row.id).map((event) => event.event_type).sort();
      ensure(types.join(",") === "WagerTransactionProcessed,WalletBalanceChanged", "A committed BET is missing its event pair");
    }
    ensure(events.every((event) => event.published_at !== null), "Committed events remain unpublished");
    result.eventPublicationLatency = summarizeLatencies(events.map((event) => event.delay_ms));
    ensure((await rows(`select w.id from wallets w left join wallet_ledger l on l.wallet_id = w.id group by w.id
      having w.balance < 0 or w.balance <> coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)`)).length === 0,
    "A wallet balance differs from its immutable ledger");
    ensure((await rows(`select l.id from wallet_ledger l
      left join accounting_journal j on j.ledger_entry_id = l.id
      where j.ledger_entry_id is null or j.amount <> l.amount or j.currency <> l.currency
        or j.transaction_id <> l.transaction_id`)).length === 0,
    "A ledger movement is missing its exact accounting pair");
    ensure((await rows(`select w.id from wallets w
      left join accounting_postings p on p.account_id = 'wallet:' || w.id::text
      group by w.id having w.balance <> coalesce(sum(case when p.direction = 'CREDIT' then p.amount else -p.amount end), 0)`)).length === 0,
    "A wallet balance differs from its accounting postings");
    ensure((await rows(`select currency from accounting_postings group by currency
      having sum(case when direction = 'DEBIT' then amount else -amount end) <> 0`)).length === 0,
    "Accounting debits and credits do not balance per currency");
    ensure(sampling.samples > 0, "No outbox metric samples were collected");
    ensure(accepted.size > 0, "The workload did not receive any successful financial response");
    // A client deadline does not cancel server work; these database snapshots cannot certify its final state.
    ensure(ambiguousResponses === 0, "Final financial state cannot be certified after transport or response-body failures; server work may still be in flight");
    result.financialInvariantsPassed = true;
    console.log(JSON.stringify({ event: "load_scenario_completed", ...result }));
  } finally { samplingStopped = true; await sampler; }
}

try {
  const info = JSON.parse(await commandOutput(["docker", "info", "--format", "{{json .}}"])) as Record<string, unknown>;
  report.environment.docker = { serverVersion: info.ServerVersion, os: info.OSType, architecture: info.Architecture,
    cpus: info.NCPU, memoryBytes: info.MemTotal };
  report.environment.images = (await commandOutput(["docker", "compose", "--profile", "test", "config", "--images"])).split("\n");
  orm = await resetTestDatabase();
  const inputUrl = await queue(true); const dlqUrl = await queue(true); const eventsUrl = await queue();
  for (let index = 0; index < 3; index++) applications.push(await startApplication(children, {
    AUTH_ENABLED: "false", OTEL_ENABLED: "false",
    OUTBOX_PUBLISHER_ENABLED: "true", SQS_EVENTS_QUEUE_URL: eventsUrl, SQS_WAGER_QUEUE_URL: inputUrl, SQS_WAGER_DLQ_URL: dlqUrl,
  }));
  report.environment.applicationPids = applications.map(({ child }) => child.pid);
  ensure(new Set(report.environment.applicationPids).size === 3, "Load testing requires three independent processes");
  await scenario("warmup", 3, 30, false);
  await scenario("hot-wallet", 1, options.requests, true);
  await scenario("distributed-wallets", 20, options.requests, true);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  const cleanup = await Promise.allSettled(children.map(stop));
  for (const outcome of cleanup) if (outcome.status === "rejected") report.cleanupErrors.push(String(outcome.reason));
  for (const QueueUrl of queues) {
    try { await client.send(new DeleteQueueCommand({ QueueUrl })); }
    catch (error) { report.cleanupErrors.push(String(error)); }
  }
  client.destroy();
  if (orm) {
    try { await orm.close(true); } catch (error) { report.cleanupErrors.push(String(error)); }
  }
  report.completedAt = new Date().toISOString();
  report.passed = report.passed && report.cleanupErrors.length === 0;
  const directory = `${root}reports/load`;
  await mkdir(directory, { recursive: true });
  const path = `${directory}/${startedAt.replaceAll(":", "-")}-${runId}.json`;
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await Bun.write(path, serialized);
  await Bun.write(`${directory}/latest.json`, serialized);
  console.log(`Load report: ${path}`);
}
if (!report.passed) throw new Error(report.error ?? `Load cleanup failed: ${report.cleanupErrors.join("; ")}`);
