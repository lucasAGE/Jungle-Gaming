import { describe, expect, test } from "bun:test";
import { ApplicationError } from "./application-error.js";
import { moneyInput, openWalletInput } from "./input-validation.js";
import { decodeLedgerCursor, encodeLedgerCursor } from "./ledger-cursor.js";

const playerId = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";
const walletId = "0192f291-27dd-7d3f-8071-5f8685deef37";

describe("shared wallet input validation", () => {
  test("normalizes UUID case without converting the monetary string", () => {
    const input = openWalletInput({
      playerId: playerId.toUpperCase(), initialBalance: { amount: "9007199254740993.01", currency: "BRL" },
    });
    expect(input.playerId).toBe(playerId);
    expect(input.initialBalance.toString()).toBe("9007199254740993.01");
  });

  test.each([
    { playerId, initialBalance: { amount: "1.00", currency: "BRL" }, kind: "OPENING" },
    { playerId, initialBalance: { amount: "1.00", currency: "BRL", extra: true } },
    { playerId, initialBalance: { amount: "1.00" } },
    { playerId: `${playerId}\n`, initialBalance: { amount: "1.00", currency: "BRL" } },
  ])("rejects ambiguous or incomplete payload %j", (input) => {
    expect(() => openWalletInput(input)).toThrow(ApplicationError);
  });

  test("enforces enabled currency separately from currency-aware Money", () => {
    expect(() => moneyInput({ amount: "1.00", currency: "USD" })).toThrow(
      new ApplicationError("UNSUPPORTED_CURRENCY", "Only BRL is enabled"),
    );
  });
});

describe("ledger cursor contract", () => {
  const position = { id: playerId, createdAt: new Date("2026-10-10T12:00:00.123Z") };

  test("preserves the complete tie-breaking position for one wallet", () => {
    expect(decodeLedgerCursor(encodeLedgerCursor(walletId, position), walletId)).toEqual(position);
  });

  test("rejects a cursor reused for a different wallet", () => {
    expect(() => decodeLedgerCursor(encodeLedgerCursor(walletId, position), playerId)).toThrow(ApplicationError);
  });

  test.each([
    { version: 2, walletId, id: playerId, createdAt: position.createdAt.toISOString() },
    { version: 1, walletId, id: playerId, createdAt: "not-a-date" },
    { version: 1, walletId, id: playerId, createdAt: "2026-10-10" },
    { version: 1, walletId, id: "invalid", createdAt: position.createdAt.toISOString() },
  ])("rejects invalid cursor contents %j", (payload) => {
    const cursor = Buffer.from(JSON.stringify(payload)).toString("base64url");
    expect(() => decodeLedgerCursor(cursor, walletId)).toThrow(ApplicationError);
  });
});
