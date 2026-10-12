import { Telemetry, type ObservedWagerStatus, type TelemetryContext } from "../../application/telemetry.js";
import { requestContext } from "./request-context.js";
import { StructuredLogger } from "./structured-logger.js";
import { SpanKind } from "@opentelemetry/api";
import { inSpan, recordWagerSpan } from "./tracing.js";

const statuses = ["PROCESSED", "REJECTED", "PENDING_REFERENCE", "FAILED"] as const;
const sources = ["sqs", "outbox", "reference"] as const;
const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

export class OperationalTelemetry extends Telemetry {
  private readonly decisions = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<ObservedWagerStatus, number>;
  private readonly retries = { sqs: 0, outbox: 0, reference: 0 };
  private duplicates = 0;
  private dlq = 0;
  private locks = 0;
  private reconciliations = 0;
  private divergences = 0;
  private readonly latencyBuckets = buckets.map(() => 0);
  private latencyCount = 0;
  private latencySum = 0;

  constructor(private readonly logger = new StructuredLogger()) { super(); }

  override context(): TelemetryContext { return requestContext.getStore() ?? {}; }
  override trace<T>(name: string, work: () => Promise<T>): Promise<T> { return inSpan(name, SpanKind.INTERNAL, work); }

  override wagerCompleted(context: TelemetryContext, status: ObservedWagerStatus, replay: boolean, elapsedMs: number): void {
    if (!statuses.includes(status)) return;
    recordWagerSpan(status, replay, context.transactionId);
    if (replay) this.duplicates += 1;
    else this.decisions[status] += 1;
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0) {
      const seconds = elapsedMs / 1_000;
      this.latencyCount += 1;
      this.latencySum += seconds;
      buckets.forEach((boundary, index) => { if (seconds <= boundary) this.latencyBuckets[index]! += 1; });
    }
    this.logger.log({ event: "wager_completed", ...this.context(), ...context, status, idempotentReplay: replay, elapsedMs });
  }

  override lockConflict(context: TelemetryContext): void {
    this.locks += 1;
    this.logger.warn({ event: "database_lock_conflict", ...this.context(), ...context });
  }

  override retry(source: "sqs" | "outbox" | "reference"): void {
    if (sources.includes(source)) this.retries[source] += 1;
  }

  override deadLetter(): void { this.dlq += 1; }

  override reconciliationCompleted(result: { walletId: string; consistent: boolean; checkedEntries: number }): void {
    this.reconciliations += 1;
    if (!result.consistent) this.divergences += 1;
    const entry = { event: "wallet_reconciled", ...this.context(), ...result };
    if (result.consistent) this.logger.log(entry);
    else this.logger.warn(entry);
  }

  render(outbox: { pending: number; lagSeconds: number }): string {
    const lines = ["# TYPE wagering_transactions_total counter"];
    for (const status of statuses) lines.push(`wagering_transactions_total{status="${status}"} ${this.decisions[status]}`);
    lines.push("# TYPE wagering_duplicates_total counter", `wagering_duplicates_total ${this.duplicates}`,
      "# TYPE wagering_retries_total counter");
    for (const source of sources) lines.push(`wagering_retries_total{source="${source}"} ${this.retries[source]}`);
    lines.push("# TYPE wagering_dlq_total counter", `wagering_dlq_total ${this.dlq}`,
      "# TYPE wagering_lock_conflicts_total counter", `wagering_lock_conflicts_total ${this.locks}`,
      "# TYPE wagering_reconciliations_total counter", `wagering_reconciliations_total ${this.reconciliations}`,
      "# TYPE wagering_reconciliation_divergences_total counter", `wagering_reconciliation_divergences_total ${this.divergences}`,
      "# TYPE wagering_processing_seconds histogram");
    buckets.forEach((boundary, index) => lines.push(`wagering_processing_seconds_bucket{le="${boundary}"} ${this.latencyBuckets[index]}`));
    lines.push(`wagering_processing_seconds_bucket{le="+Inf"} ${this.latencyCount}`,
      `wagering_processing_seconds_sum ${this.latencySum}`, `wagering_processing_seconds_count ${this.latencyCount}`,
      "# TYPE wagering_outbox_pending gauge", `wagering_outbox_pending ${outbox.pending}`,
      "# TYPE wagering_outbox_lag_seconds gauge", `wagering_outbox_lag_seconds ${outbox.lagSeconds}`);
    return `${lines.join("\n")}\n`;
  }
}
