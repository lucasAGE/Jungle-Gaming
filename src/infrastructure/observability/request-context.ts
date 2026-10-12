import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { TelemetryContext } from "../../application/telemetry.js";

export const requestContext = new AsyncLocalStorage<TelemetryContext>();

export function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/.test(value) ? value : null;
}

export function correlationId(value: unknown): string {
  return safeIdentifier(value) ?? randomUUID();
}

function safeContextIdentifier(value: unknown): string | null {
  // SQS and business identities allow more punctuation and length than an HTTP correlation header.
  // JSON encoding escapes valid printable identifiers; whitespace and controls are never admitted.
  return typeof value === "string" && /^[!-~]{1,255}$/.test(value) ? value : null;
}

export function sanitizedContext(context: TelemetryContext = {}) {
  return {
    correlationId: safeContextIdentifier(context.correlationId), messageId: safeContextIdentifier(context.messageId),
    transactionId: safeContextIdentifier(context.transactionId), walletId: safeContextIdentifier(context.walletId),
    providerId: safeContextIdentifier(context.providerId),
  };
}
