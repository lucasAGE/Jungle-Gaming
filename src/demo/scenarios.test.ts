import { describe, expect, test } from "bun:test";
import { canReference, conflictRequest, decimalAmount, powerShellCommand, referenceFields, requireUuid, wagerRequest, type DemoWager } from "./scenarios.js";
import { wagerInput } from "../application/wager-input.js";

const body: DemoWager = {
  providerId: "provider-a", externalTransactionId: "external-1",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-1", gameId: "fortune-chimp", kind: "BET", money: { amount: "25.00", currency: "BRL" },
};

describe("presentation requests", () => {
  test("keeps money exact at the database limit and never coerces input", () => {
    expect(decimalAmount("999999999999999999.99")).toBe("999999999999999999.99");
    for (const value of ["1", "1.001", "1e2", "-1.00", "01.00", "NaN", "1000000000000000000.00"]) {
      expect(() => decimalAmount(value)).toThrow();
    }
    expect(decimalAmount("0.00")).toBe("0.00");
    expect(() => decimalAmount("0.00", false)).toThrow();
  });

  test("preserves the original identity and payload independently of later form edits", () => {
    const editable = structuredClone(body) as { money: { amount: string; currency: "BRL" } } & DemoWager;
    const original = wagerRequest(editable);
    editable.money.amount = "80.00";
    expect(original.body).toEqual(body);
    const conflict = conflictRequest(original, "50.00");
    expect(conflict.idempotencyKey).toBe("provider-a:external-1");
    expect((conflict.body as DemoWager).externalTransactionId).toBe(body.externalTransactionId);
    expect((conflict.body as DemoWager).money.amount).toBe("50.00");
    expect((original.body as DemoWager).money.amount).toBe("25.00");
    expect(() => conflictRequest(original, "25.00")).toThrow("identical amount");
    expect(() => conflictRequest(wagerRequest({ ...body, kind: "LOSS", money: { amount: "0.00", currency: "BRL" } }), "1.00")).toThrow("LOSS");
  });

  test("formats a real POST and read request without leaking a token or interpolating user input", () => {
    const request = wagerRequest({ ...body, gameId: "a'$(Get-Secret)`b" });
    const command = powerShellCommand("http://127.0.0.1:3000", request);
    expect(command).toContain('Authorization = "Bearer $accessToken"');
    expect(command).toContain("a''$(Get-Secret)`b");
    expect(command).toContain("'Idempotency-Key' = 'provider-a:external-1'");
    expect(command).toContain("-Method POST");
    expect(command).toContain("-Body $body");
    const get = powerShellCommand("http://127.0.0.1:3000", { method: "GET", path: `/wallets/${body.walletId}/ledger?limit=50` });
    expect(get).toContain("-Method GET");
    expect(get).not.toContain("-Body");
    expect(get).not.toContain("Idempotency-Key");
  });

  test("filters reference kinds and validates identifiers before constructing paths", () => {
    expect(canReference("REFUND", "BET")).toBe(true);
    expect(canReference("REFUND", "WIN")).toBe(false);
    expect(canReference("ROLLBACK", "REFUND")).toBe(true);
    expect(canReference("ROLLBACK", "ROLLBACK")).toBe(false);
    expect(requireUuid(body.walletId)).toBe(body.walletId);
    expect(() => requireUuid("../../metrics")).toThrow();
  });

  test("switching to LOSS drops a previously selected reference and still satisfies the API contract", () => {
    const loss = { ...body, kind: "LOSS" as const, money: { amount: "0.00", currency: "BRL" as const },
      ...referenceFields("LOSS", "previously-selected-bet") };
    expect(wagerInput(wagerRequest(loss).body).kind).toBe("LOSS");
    expect(loss).not.toHaveProperty("referenceExternalTransactionId");
    expect(canReference("LOSS", "BET")).toBe(false);
    expect(referenceFields("BET", "previously-selected-bet")).toEqual({});
    expect(referenceFields("WIN", "bet-1")).toEqual({ referenceExternalTransactionId: "bet-1" });
    expect(() => referenceFields("REFUND", "")).toThrow("requires a reference");
  });
});
