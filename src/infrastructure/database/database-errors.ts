import { DriverException } from "@mikro-orm/core";

const connectionErrorCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH",
  "57P01", "57P02", "57P03", "53300",
]);

export function isDatabaseError(error: unknown): boolean {
  if (error instanceof DriverException) return true;
  if (!(error instanceof Error)) return false;
  // Pool acquisition and transaction startup can fail before MikroORM wraps the driver error.
  if (error.name === "KnexTimeoutError") return true;
  return "code" in error && typeof error.code === "string" &&
    (connectionErrorCodes.has(error.code) || /^[0-9A-Z]{5}$/.test(error.code));
}

export function isTransientDatabaseError(error: unknown): boolean {
  if (!isDatabaseError(error)) return false;
  // Only definite server rejections can become terminal FAILED after rollback.
  // An unclassified driver/commit failure may have committed, so replay must decide.
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") return true;
  return !/^(0A|22|23|42)[A-Z0-9]{3}$/.test(error.code) && error.code !== "P0001";
}
