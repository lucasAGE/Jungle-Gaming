import { describe, expect, test } from "bun:test";
import { OperationalTelemetry } from "./operational-telemetry.js";
import { correlationId, requestContext, sanitizedContext } from "./request-context.js";
import { StructuredLogger } from "./structured-logger.js";

describe("safe structured diagnostics", () => {
  test("every log contains the five context fields and drops financial bodies and error details", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger((line) => lines.push(line));
    requestContext.run({ correlationId: "http-request-1" }, () => logger.error({
      event: "request_failed", walletId: "wallet-1", providerId: "provider-a", code: "DATABASE_UNAVAILABLE",
      message: "select secret financial SQL", stack: "private-stack", errorType: "private-password",
      body: { money: { amount: "50000.00", currency: "BRL" } }, payload: "private-payload",
    }));
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "error", event: "request_failed", correlationId: "http-request-1", messageId: null,
      transactionId: null, walletId: "wallet-1", providerId: "provider-a", code: "DATABASE_UNAVAILABLE",
    });
    expect(lines[0]).not.toMatch(/private|secret|50000|BRL|select/);
  });

  test("rejects control characters, nested objects, arrays and unbounded identifiers", () => {
    expect(sanitizedContext({ correlationId: "valid:one", providerId: "unsafe\nprovider", walletId: "x".repeat(256) }))
      .toEqual({ correlationId: "valid:one", providerId: null, walletId: null, transactionId: null, messageId: null });
    for (const invalid of [null, undefined, ["request"], { toString: () => "request" }, "\r\n", "", "x".repeat(129)]) {
      expect(correlationId(invalid)).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(correlationId("valid-request_1:2.3")).toBe("valid-request_1:2.3");
  });

  test("preserves valid business and SQS identities without broadening HTTP header or event validation", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger((line) => lines.push(line));
    const longId = "m".repeat(255);
    const transactionId = 'transaction:"quoted"\\path';
    logger.log({ event: "valid_event", providerId: "provider@example", messageId: longId,
      correlationId: longId, transactionId, walletId: "wallet-1" });
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "valid_event", providerId: "provider@example",
      messageId: longId, correlationId: longId, transactionId, walletId: "wallet-1" });
    expect(lines).toHaveLength(1);
    expect(correlationId(longId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(correlationId("provider@example")).toMatch(/^[0-9a-f-]{36}$/);
    logger.log({ event: "event@example", code: "code@example" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ event: "framework_log", code: null });
  });

  test.each(["x".repeat(256), "has space", "line\nbreak", "tab\tvalue", "nul\0value", "delete\x7f", "non-ascii-é"])(
    "rejects oversized, whitespace, control and non-ASCII context identities %#", (invalid) => {
      expect(sanitizedContext({ correlationId: invalid, messageId: invalid, transactionId: invalid,
        walletId: invalid, providerId: invalid })).toEqual({ correlationId: null, messageId: null,
        transactionId: null, walletId: null, providerId: null });
    },
  );

  test("asynchronous requests retain their own correlation context", async () => {
    const telemetry = new OperationalTelemetry(new StructuredLogger(() => {}));
    const found = await Promise.all(["one", "two", "three"].map((id) => requestContext.run({ correlationId: id }, async () => {
      await Promise.resolve();
      return telemetry.context().correlationId;
    })));
    expect(found).toEqual(["one", "two", "three"]);
    expect(telemetry.context()).toEqual({});
  });

  test("a failing log sink cannot fail a committed operation", () => {
    const logger = new StructuredLogger(() => { throw new Error("sink closed"); });
    expect(() => logger.log({ event: "wager_completed" })).not.toThrow();
  });
});

describe("bounded operational metrics", () => {
  test("counts committed decisions once, duplicates separately, and observes processing latency", () => {
    const telemetry = new OperationalTelemetry(new StructuredLogger(() => {}));
    telemetry.wagerCompleted({ providerId: "provider-a", walletId: "wallet-a" }, "PROCESSED", false, 100);
    telemetry.wagerCompleted({ providerId: "provider-b", walletId: "wallet-b" }, "PROCESSED", true, 20);
    telemetry.wagerCompleted({}, "PENDING_REFERENCE", false, 10);
    telemetry.wagerCompleted({}, "REJECTED", false, 250);
    telemetry.wagerCompleted({}, "FAILED", false, 500);
    const metrics = telemetry.render({ pending: 7, lagSeconds: 42.5 });
    expect(metrics).toContain('wagering_transactions_total{status="PROCESSED"} 1');
    expect(metrics).toContain('wagering_transactions_total{status="PENDING_REFERENCE"} 1');
    expect(metrics).toContain('wagering_transactions_total{status="REJECTED"} 1');
    expect(metrics).toContain('wagering_transactions_total{status="FAILED"} 1');
    expect(metrics).toContain("wagering_duplicates_total 1");
    expect(metrics).toContain('wagering_processing_seconds_bucket{le="0.1"} 3');
    expect(metrics).toContain('wagering_processing_seconds_bucket{le="+Inf"} 5');
    expect(metrics).toContain("wagering_processing_seconds_count 5");
    expect(metrics).toContain("wagering_outbox_pending 7");
    expect(metrics).toContain("wagering_outbox_lag_seconds 42.5");
    expect(metrics).not.toMatch(/provider-a|provider-b|wallet-a|wallet-b/);
  });

  test("records retry sources, DLQ, lock conflicts and reconciliation divergence without money", () => {
    const lines: string[] = [];
    const telemetry = new OperationalTelemetry(new StructuredLogger((line) => lines.push(line)));
    telemetry.retry("sqs"); telemetry.retry("sqs"); telemetry.retry("outbox"); telemetry.retry("reference");
    telemetry.deadLetter(); telemetry.lockConflict({ walletId: "wallet-1" });
    telemetry.reconciliationCompleted({ walletId: "wallet-1", consistent: true, checkedEntries: 3 });
    telemetry.reconciliationCompleted({ walletId: "wallet-2", consistent: false, checkedEntries: 5 });
    const metrics = telemetry.render({ pending: 0, lagSeconds: 0 });
    expect(metrics).toContain('wagering_retries_total{source="sqs"} 2');
    expect(metrics).toContain('wagering_retries_total{source="outbox"} 1');
    expect(metrics).toContain('wagering_retries_total{source="reference"} 1');
    expect(metrics).toContain("wagering_dlq_total 1");
    expect(metrics).toContain("wagering_lock_conflicts_total 1");
    expect(metrics).toContain("wagering_reconciliations_total 2");
    expect(metrics).toContain("wagering_reconciliation_divergences_total 1");
    expect(JSON.parse(lines[2]!)).toMatchObject({ level: "warn", consistent: false, walletId: "wallet-2", checkedEntries: 5 });
    expect(lines.join("\n")).not.toMatch(/amount|balance|money/);
  });

  test("latency ignores invalid elapsed times and counters reset in a fresh process instance", () => {
    const telemetry = new OperationalTelemetry(new StructuredLogger(() => {}));
    telemetry.wagerCompleted({}, "PROCESSED", false, Number.NaN);
    telemetry.wagerCompleted({}, "REJECTED", false, -1);
    expect(telemetry.render({ pending: 0, lagSeconds: 0 })).toContain("wagering_processing_seconds_count 0");
    expect(new OperationalTelemetry().render({ pending: 0, lagSeconds: 0 })).toContain('wagering_transactions_total{status="PROCESSED"} 0');
  });
});
