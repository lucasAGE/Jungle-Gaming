export class ProcessingError extends Error {
  constructor(public readonly retryable: boolean, cause: unknown, public readonly auditUnavailable = false) {
    super("The database operation could not be completed", { cause });
    this.name = "ProcessingError";
  }

  get code(): "DATABASE_UNAVAILABLE" | "DATABASE_OPERATION_FAILED" | "FAILURE_AUDIT_UNAVAILABLE" {
    if (this.auditUnavailable) return "FAILURE_AUDIT_UNAVAILABLE";
    return this.retryable ? "DATABASE_UNAVAILABLE" : "DATABASE_OPERATION_FAILED";
  }
}
