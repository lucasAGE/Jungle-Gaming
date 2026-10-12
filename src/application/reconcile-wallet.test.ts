import { describe, expect, mock, test } from "bun:test";
import { ReconcileWallet } from "./reconcile-wallet.js";
import type { ReconciliationReader, ReconciliationResult } from "./reconciliation-reader.js";
import { Telemetry } from "./telemetry.js";

const walletId = "0192f291-27dd-7d3f-8071-5f8685deef37";

function result(overrides: Partial<ReconciliationResult> = {}): ReconciliationResult {
  return {
    walletId, storedBalance: { amount: "100.00", currency: "BRL" },
    calculatedBalance: { amount: "100.00", currency: "BRL" },
    difference: { amount: "0.00", currency: "BRL" }, consistent: true, checkedEntries: 1,
    ...overrides,
  };
}

describe("wallet reconciliation", () => {
  test("normalizes the wallet identity before reading one committed snapshot", async () => {
    const snapshot = result();
    const read = mock(async () => snapshot);
    const reader: ReconciliationReader = { read };
    expect(await new ReconcileWallet(reader).execute(walletId.toUpperCase())).toEqual(snapshot);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(walletId);
  });

  test.each([undefined, null, "", 123, "invalid", `${walletId}\n`])(
    "rejects invalid wallet identity %j without reaching persistence", async (id) => {
      const read = mock(async () => result());
      await expect(new ReconcileWallet({ read }).execute(id)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(read).not.toHaveBeenCalled();
    },
  );

  test("reports a missing wallet distinctly", async () => {
    await expect(new ReconcileWallet({ read: async () => null }).execute(walletId))
      .rejects.toMatchObject({ code: "WALLET_NOT_FOUND" });
  });

  test.each([
    ["100.00", "0.00"], ["100.01", "-0.01"], ["99.99", "0.01"],
    ["2000000000000000099.98", "-1999999999999999999.98"],
  ])(
    "preserves calculated balance %s and signed difference %s without changing stored state", async (calculated, amount) => {
      const snapshot = Object.freeze(result({ calculatedBalance: { amount: calculated!, currency: "BRL" },
        difference: { amount: amount!, currency: "BRL" }, consistent: amount === "0.00" }));
      const completed = mock(() => {});
      const telemetry = Object.create(Telemetry.noop) as Telemetry;
      telemetry.reconciliationCompleted = completed;
      const read = mock(async () => snapshot);
      expect(await new ReconcileWallet({ read }, telemetry).execute(walletId)).toBe(snapshot);
      expect(completed).toHaveBeenCalledTimes(1);
      expect(completed).toHaveBeenCalledWith({ walletId, consistent: snapshot.consistent, checkedEntries: 1 });
    },
  );

  test("does not report a completed check when persistence fails", async () => {
    const failure = new Error("Connection failed");
    const completed = mock(() => {});
    const telemetry = Object.create(Telemetry.noop) as Telemetry;
    telemetry.reconciliationCompleted = completed;
    await expect(new ReconcileWallet({ read: async () => { throw failure; } }, telemetry).execute(walletId))
      .rejects.toBe(failure);
    expect(completed).not.toHaveBeenCalled();
  });
});
