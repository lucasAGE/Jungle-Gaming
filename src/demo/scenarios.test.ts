import { describe, expect, test } from "bun:test";
import { canReference, conflictRequest, decimalAmount, parallelPowerShellCommand, parallelWagerRequests, powerShellCommand, referenceFields, requireUuid, sqsSubmission, targetRequest, wagerRequest, type DemoWager } from "./scenarios.js";
import { wagerInput } from "../application/wager-input.js";
import { sqsWagerInput } from "../application/sqs-wager-input.js";

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

  test("SQS preserves the HTTP business identity and captures an independent payload for envelope retries", () => {
    const editable = structuredClone(body) as { money: { amount: string; currency: "BRL" } } & DemoWager;
    const messageId = "0192f291-27dd-7d3f-8071-5f8685deef37";
    const original = sqsSubmission(editable, messageId, 50);
    editable.money.amount = "80.00";
    expect(original.messageId).toBe(messageId);
    expect(original.copies).toBe(50);
    expect(original.data.money.amount).toBe("25.00");
    expect(original.data.idempotencyKey).toBe(wagerRequest(body).idempotencyKey!);
    const anotherEnvelope = sqsSubmission(body, crypto.randomUUID(), 1);
    expect(anotherEnvelope.messageId).not.toBe(original.messageId);
    expect(anotherEnvelope.data).toEqual(original.data);
    const received = sqsWagerInput(JSON.stringify({ messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
      data: original.data }), body.walletId);
    expect(wagerInput(received.body).externalTransactionId).toBe(body.externalTransactionId);
    for (const copies of [0, 51, 1.5, NaN, Infinity]) expect(() => sqsSubmission(body, messageId, copies)).toThrow("between 1 and 50");
    expect(() => sqsSubmission(body, "not-a-uuid", 1)).toThrow();
  });

  test("PowerShell can target an independent process and supplies the supervisor origin for control writes", () => {
    const financial = powerShellCommand("http://127.0.0.1:3100", { ...wagerRequest(body), processId: 3 });
    expect(financial).toContain("'X-Demo-Process' = '3'");
    expect(financial).not.toContain("  Origin =");
    const control = powerShellCommand("http://127.0.0.1:3100", {
      method: "POST", path: "/demo/control/reset", body: { confirmation: "RESET DEMO" },
    });
    expect(control).toContain("Origin = 'http://127.0.0.1:3100'");
    expect(control).not.toContain("X-Demo-Process");
    expect(control).toContain('"confirmation": "RESET DEMO"');
    const read = powerShellCommand("http://127.0.0.1:3100", { method: "GET", path: "/demo/control/state" });
    expect(read).not.toContain("  Origin =");
  });

  test("parallel dispatch snapshots copies with shared or distinct persistent identities", () => {
    const same = parallelWagerRequests(body, 50, false);
    expect(same).toHaveLength(50);
    expect(new Set(same.map((request) => request.idempotencyKey)).size).toBe(1);
    expect(same[0]!.body).not.toBe(same[1]!.body);
    const distinct = parallelWagerRequests(body, 2, true);
    expect(new Set(distinct.map((request) => request.idempotencyKey)).size).toBe(2);
    for (const request of distinct) {
      const parsed = wagerInput(request.body);
      expect(parsed.externalTransactionId).not.toBe(body.externalTransactionId);
      expect(parsed.walletId).toBe(body.walletId);
      expect(parsed.money.toString()).toBe("25.00");
    }
    for (const count of [1, 51, 1.5, NaN]) expect(() => parallelWagerRequests(body, count, false)).toThrow("between 2 and 50");
  });

  test("parallel PowerShell jobs retain payloads and safely quote shell metacharacters", () => {
    const requests = parallelWagerRequests({ ...body, gameId: "game'$(Get-Secret)`value" }, 2, true);
    const command = parallelPowerShellCommand("http://127.0.0.1:3100", requests);
    expect(command).toContain("game''$(Get-Secret)`value");
    expect(command).toContain("Start-Job -ArgumentList $baseUrl, $accessToken");
    expect(command).toContain("Wait-Job | Receive-Job");
    expect(command).toContain("$headers['X-Demo-Process']");
    for (const request of requests) expect(command).toContain(request.idempotencyKey!);
  });

  test("a replay can leave a crashed process without changing its persistent identity or payload", () => {
    const original = { ...wagerRequest(body), processId: 1 as const };
    const automatic = targetRequest(original);
    const anotherProcess = targetRequest(original, 3);
    expect(automatic).not.toHaveProperty("processId");
    expect(anotherProcess.processId).toBe(3);
    expect(automatic.idempotencyKey).toBe(original.idempotencyKey!);
    expect(automatic.body).toEqual(original.body);
    expect(anotherProcess.body).toEqual(original.body);
    expect(original.processId).toBe(1);
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
