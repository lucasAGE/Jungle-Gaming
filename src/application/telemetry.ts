export interface TelemetryContext {
  readonly correlationId?: string | null;
  readonly messageId?: string | null;
  readonly transactionId?: string | null;
  readonly walletId?: string | null;
  readonly providerId?: string | null;
}

export type ObservedWagerStatus = "PROCESSED" | "REJECTED" | "PENDING_REFERENCE" | "FAILED";

// Monitoring is an observer of committed decisions, never part of financial correctness.
export abstract class Telemetry {
  static readonly noop: Telemetry = new (class extends Telemetry {})();

  context(): TelemetryContext { return {}; }
  trace<T>(_name: string, work: () => Promise<T>): Promise<T> { return work(); }
  wagerCompleted(_context: TelemetryContext, _status: ObservedWagerStatus, _replay: boolean, _elapsedMs: number): void {}
  lockConflict(_context: TelemetryContext): void {}
  reconciliationCompleted(_result: { walletId: string; consistent: boolean; checkedEntries: number }): void {}
  retry(_source: "sqs" | "outbox" | "reference"): void {}
  deadLetter(): void {}
}
