import { describe, expect, test } from "bun:test";
import { Money, MoneyError } from "./money.js";
import { WalletLedgerEntry, type LedgerEntryState } from "./wallet-ledger-entry.js";

const recordedAt = new Date("2026-10-10T12:00:00.000Z");
const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });

function state(overrides: Partial<LedgerEntryState> = {}): LedgerEntryState {
  return {
    id: "entry-1", walletId: "wallet-1", transactionId: "transaction-1",
    direction: "CREDIT", money: brl("0.20"),
    balanceBefore: brl("0.10"), balanceAfter: brl("0.30"), createdAt: recordedAt,
    ...overrides,
  };
}

describe("Immutable wallet ledger entry", () => {
  test("checks exact credit arithmetic and keeps the complete audit record", () => {
    const entry = WalletLedgerEntry.create(state());

    expect(entry.id).toBe("entry-1");
    expect(entry.walletId).toBe("wallet-1");
    expect(entry.transactionId).toBe("transaction-1");
    expect(entry.direction).toBe("CREDIT");
    expect(entry.money.toString()).toBe("0.20");
    expect(entry.balanceBefore.toString()).toBe("0.10");
    expect(entry.balanceAfter.toString()).toBe("0.30");
    expect(entry.createdAt).toEqual(recordedAt);
    expect(entry.isBalanced()).toBe(true);
  });

  test("checks exact debit arithmetic including draining a balance to zero", () => {
    const entry = WalletLedgerEntry.create(state({
      direction: "DEBIT", money: brl("9007199254740993.01"),
      balanceBefore: brl("9007199254740993.01"), balanceAfter: brl("0.00"),
    }));

    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.isZero()).toBe(true);
  });

  test.each(["CREDIT", "DEBIT"] as const)("rejects unbalanced %s records", (direction) => {
    expect(() => WalletLedgerEntry.create(state({ direction, balanceAfter: brl("0.31") })))
      .toThrow("The ledger amount must match the balance change");
  });

  test.each([Money.zero("BRL"), brl("0.01").negate()])("rejects non-positive movement %s", (money) => {
    expect(() => WalletLedgerEntry.create(state({ money })))
      .toThrow("A ledger entry requires a positive amount");
  });

  test.each(["balanceBefore", "balanceAfter"] as const)("rejects a negative %s", (field) => {
    expect(() => WalletLedgerEntry.create(state({ [field]: brl("0.01").negate() })))
      .toThrow("Ledger balances must not be negative");
  });

  test.each(["money", "balanceBefore", "balanceAfter"] as const)("rejects currency mismatch in %s", (field) => {
    expect(() => WalletLedgerEntry.create(state({
      [field]: Money.from({ amount: "0.20", currency: "USD" }),
    }))).toThrow(MoneyError);
  });

  test("rehydration reconstructs audit evidence without replaying create validation", () => {
    const entry = WalletLedgerEntry.rehydrate(state({ balanceAfter: brl("0.31") }));

    expect(entry.balanceAfter.toString()).toBe("0.31");
    expect(entry.isBalanced()).toBe(false);
  });

  test("cannot be changed through a public field or a shared Date", () => {
    const createdAt = new Date(recordedAt);
    const entry = WalletLedgerEntry.create(state({ createdAt }));
    createdAt.setTime(0);
    entry.createdAt.setTime(0);

    expect(Reflect.set(entry, "balanceAfter", brl("999.00"))).toBe(false);
    expect(Reflect.set(entry, "direction", "DEBIT")).toBe(false);
    expect(entry.createdAt).toEqual(recordedAt);
    expect(entry.isBalanced()).toBe(true);
  });
});
