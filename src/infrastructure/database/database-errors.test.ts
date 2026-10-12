import { describe, expect, test } from "bun:test";
import { DriverException } from "@mikro-orm/core";
import { isDatabaseError, isTransientDatabaseError } from "./database-errors.js";

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error("Database operation failed"), { code });
}

describe("database failure classification", () => {
  test.each(["40001", "40P01", "08006", "53300", "57P01", "55P03", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"])(
    "retries unwrapped transaction, resource and connection failure %s", (code) => {
      const error = failure(code);
      expect(isDatabaseError(error)).toBe(true);
      expect(isTransientDatabaseError(error)).toBe(true);
    },
  );

  test.each(["23514", "23503", "42P01", "P0001"])("recognizes permanent SQLSTATE %s without retrying", (code) => {
    const error = failure(code);
    expect(isDatabaseError(error)).toBe(true);
    expect(isTransientDatabaseError(error)).toBe(false);
  });

  test("retains the classification after MikroORM wraps the driver error", () => {
    const transient = new DriverException(failure("40001"));
    const permanent = new DriverException(failure("23514"));
    expect(isDatabaseError(transient)).toBe(true);
    expect(isTransientDatabaseError(transient)).toBe(true);
    expect(isDatabaseError(permanent)).toBe(true);
    expect(isTransientDatabaseError(permanent)).toBe(false);
  });

  test("retries a pool acquisition timeout before the driver has a SQLSTATE", () => {
    const error = new Error("Pool acquisition timed out");
    error.name = "KnexTimeoutError";
    expect(isDatabaseError(error)).toBe(true);
    expect(isTransientDatabaseError(error)).toBe(true);
  });

  test.each([new DriverException(new Error("Connection terminated during commit")), failure("XX000"), failure("08007")])(
    "keeps unknown or ambiguous database outcomes retryable: %s", (error) => {
      expect(isDatabaseError(error)).toBe(true);
      expect(isTransientDatabaseError(error)).toBe(true);
    },
  );

  test.each([new Error("Application failure"), { code: "40001" }, null, "ECONNREFUSED"])(
    "does not identify an unrelated value as a database error: %s", (error) => {
      expect(isDatabaseError(error)).toBe(false);
      expect(isTransientDatabaseError(error)).toBe(false);
    },
  );
});
