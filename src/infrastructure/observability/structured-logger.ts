import type { LoggerService } from "@nestjs/common";
import { requestContext, safeIdentifier, sanitizedContext } from "./request-context.js";
import { activeTraceIds } from "./tracing.js";

// Only operational fields are admitted. Driver errors and request/event bodies cannot leak through this boundary.
export class StructuredLogger implements LoggerService {
  constructor(private readonly write: (line: string) => void = (line) => console.log(line)) {}

  log(message: unknown): void { this.emit("info", message); }
  warn(message: unknown): void { this.emit("warn", message); }
  error(message: unknown): void { this.emit("error", message); }
  debug(message: unknown): void { this.emit("debug", message); }
  verbose(message: unknown): void { this.emit("debug", message); }
  fatal(message: unknown): void { this.emit("error", message); }

  private emit(level: string, message: unknown): void {
    const fields = message !== null && typeof message === "object" ? message as Record<string, unknown> : {};
    const context = { ...requestContext.getStore(), ...fields };
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(), level,
      event: safeIdentifier(fields.event) ?? "framework_log", ...sanitizedContext(context), ...activeTraceIds(),
    };
    for (const key of ["status", "transactionStatus", "code", "reasonCode", "eventType", "source"] as const) {
      if (fields[key] !== undefined) entry[key] = safeIdentifier(fields[key]);
    }
    for (const key of ["port", "attempts", "referenceAttempts", "receiveCount", "checkedEntries", "elapsedMs", "statusCode"] as const) {
      if (typeof fields[key] === "number" && Number.isFinite(fields[key]) && fields[key] >= 0) entry[key] = fields[key];
    }
    for (const key of ["idempotentReplay", "consistent"] as const) {
      if (typeof fields[key] === "boolean") entry[key] = fields[key];
    }
    // Logging failures must not turn an already committed financial operation into an apparent failure.
    try { this.write(JSON.stringify(entry)); } catch { /* A broken diagnostic sink cannot undo a commit. */ }
  }
}
