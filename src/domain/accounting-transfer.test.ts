import { describe, expect, test } from "bun:test";
import { AccountingTransfer, type AccountingTransferState } from "./accounting-transfer.js";
import { DomainError } from "./domain-error.js";
import { Money, MoneyError } from "./money.js";
import type { WagerKind } from "./wager-transaction.js";
import { WalletLedgerEntry, type LedgerDirection, type LedgerEntryState } from "./wallet-ledger-entry.js";

const recordedAt = new Date("2026-10-12T12:00:00.123Z");
const money = (amount: string, currency = "BRL"): Money => Money.from({ amount, currency });

function entryState(direction: LedgerDirection, overrides: Partial<LedgerEntryState> = {}): LedgerEntryState {
  return {
    id: "entry-1", walletId: "wallet-1", transactionId: "transaction-1", direction,
    money: money("25.00"), balanceBefore: money("100.00"),
    balanceAfter: money(direction === "CREDIT" ? "125.00" : "75.00"),
    createdAt: recordedAt, ...overrides,
  };
}

describe("Immutable accounting transfer", () => {
  const mappings: Array<["OPENING" | WagerKind, LedgerDirection, string, string]> = [
    ["OPENING", "CREDIT", "opening-clearing:BRL", "wallet:wallet-1"],
    ["BET", "DEBIT", "wallet:wallet-1", "house:BRL"],
    ["WIN", "CREDIT", "house:BRL", "wallet:wallet-1"],
    ["REFUND", "CREDIT", "house:BRL", "wallet:wallet-1"],
    ["ROLLBACK", "CREDIT", "house:BRL", "wallet:wallet-1"],
    ["ROLLBACK", "DEBIT", "wallet:wallet-1", "house:BRL"],
  ];

  test.each(mappings)("%s with %s balances %s against %s", (kind, direction, debitAccountId, creditAccountId) => {
    const entry = WalletLedgerEntry.create(entryState(direction));
    const transfer = AccountingTransfer.fromLedger(entry, kind);

    expect(transfer.ledgerEntryId).toBe(entry.id);
    expect(transfer.transactionId).toBe(entry.transactionId);
    expect(transfer.walletId).toBe(entry.walletId);
    expect(transfer.money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(transfer.debitAccountId).toBe(debitAccountId);
    expect(transfer.creditAccountId).toBe(creditAccountId);
    expect(transfer.createdAt).toEqual(recordedAt);
  });

  test("a reversal swaps the original debit and credit without changing the exact amount", () => {
    const amount = money("9007199254740993.01");
    const win = WalletLedgerEntry.create(entryState("CREDIT", {
      money: amount, balanceBefore: money("0.00"), balanceAfter: amount,
    }));
    const rollback = WalletLedgerEntry.create(entryState("DEBIT", {
      id: "reversal-entry", transactionId: "reversal-transaction",
      money: amount, balanceBefore: amount, balanceAfter: money("0.00"),
    }));
    const credited = AccountingTransfer.fromLedger(win, "WIN");
    const reversed = AccountingTransfer.fromLedger(rollback, "ROLLBACK");

    expect(reversed.debitAccountId).toBe(credited.creditAccountId);
    expect(reversed.creditAccountId).toBe(credited.debitAccountId);
    expect(reversed.money.toString()).toBe("9007199254740993.01");
    expect(reversed.money.equals(credited.money)).toBe(true);
  });

  test("account identities remain currency-aware without converting the amount", () => {
    const entry = WalletLedgerEntry.create(entryState("CREDIT", {
      money: money("999999999999999999.99", "USD"),
      balanceBefore: money("0.00", "USD"), balanceAfter: money("999999999999999999.99", "USD"),
    }));
    const transfer = AccountingTransfer.fromLedger(entry, "OPENING");

    expect(transfer.debitAccountId).toBe("opening-clearing:USD");
    expect(transfer.money.toJSON()).toEqual({ amount: "999999999999999999.99", currency: "USD" });
    expect(AccountingTransfer.fromLedger(entry, "WIN").debitAccountId).toBe("house:USD");
  });

  test.each(["OPENING", "BET", "WIN", "REFUND"] as const)("rejects a valid ledger with the wrong direction for %s", (kind) => {
    const entry = WalletLedgerEntry.create(entryState(kind === "BET" ? "CREDIT" : "DEBIT"));
    expect(() => AccountingTransfer.fromLedger(entry, kind)).toThrow(new DomainError(
      "ACCOUNTING_DIRECTION_MISMATCH", "The ledger direction does not match the transaction kind",
    ));
  });

  test("LOSS cannot manufacture accounting movement from a wallet entry", () => {
    const entry = WalletLedgerEntry.create(entryState("DEBIT"));
    expect(() => AccountingTransfer.fromLedger(entry, "LOSS"))
      .toThrow("A loss has no accounting transfer");
  });

  test("a rollback cannot interpret an unknown persisted ledger direction as a debit", () => {
    const entry = WalletLedgerEntry.rehydrate(entryState("DEBIT", { direction: "UNKNOWN" as LedgerDirection }));
    expect(() => AccountingTransfer.fromLedger(entry, "ROLLBACK"))
      .toThrow("The ledger direction does not match the transaction kind");
  });

  test.each([money("0.00"), money("0.01").negate()])("rejects non-positive amounts in rehydrated evidence", (amount) => {
    const entry = WalletLedgerEntry.rehydrate(entryState("CREDIT", { money: amount }));
    expect(() => AccountingTransfer.fromLedger(entry, "WIN"))
      .toThrow("An accounting transfer requires a positive amount");
  });

  test.each(["CREDIT", "DEBIT"] as const)("rejects unbalanced %s wallet evidence", (direction) => {
    const entry = WalletLedgerEntry.rehydrate(entryState(direction, { balanceAfter: money("100.01") }));
    expect(() => AccountingTransfer.fromLedger(entry, "ROLLBACK"))
      .toThrow("An accounting transfer requires a balanced non-negative wallet entry");
  });

  test("rejects balanced evidence with a negative wallet balance", () => {
    const entry = WalletLedgerEntry.rehydrate(entryState("DEBIT", {
      money: money("25.00"), balanceBefore: money("20.00"), balanceAfter: money("5.00").negate(),
    }));
    expect(entry.isBalanced()).toBe(true);
    expect(() => AccountingTransfer.fromLedger(entry, "BET"))
      .toThrow("An accounting transfer requires a balanced non-negative wallet entry");
  });

  test("refuses evidence mixing currencies before choosing accounting accounts", () => {
    const entry = WalletLedgerEntry.rehydrate(entryState("CREDIT", { balanceAfter: money("125.00", "USD") }));
    expect(() => AccountingTransfer.fromLedger(entry, "WIN")).toThrow(MoneyError);
  });

  test("protects the shared amount, account identities and audit timestamp from mutation", () => {
    const entry = WalletLedgerEntry.create(entryState("CREDIT"));
    const transfer = AccountingTransfer.fromLedger(entry, "WIN");
    transfer.createdAt.setTime(0);
    entry.createdAt.setTime(0);

    expect(Object.isFrozen(transfer)).toBe(true);
    expect(Reflect.set(transfer, "money", money("999.00"))).toBe(false);
    expect(Reflect.set(transfer, "debitAccountId", "wallet:other-wallet")).toBe(false);
    expect(Reflect.set(transfer, "creditAccountId", "house:BRL")).toBe(false);
    expect(transfer.money.toString()).toBe("25.00");
    expect(transfer.createdAt).toEqual(recordedAt);
  });

  test("rehydration preserves persisted evidence without reapplying creation rules", () => {
    const createdAt = new Date(recordedAt);
    const state: AccountingTransferState = {
      ledgerEntryId: "old-entry", transactionId: "old-transaction", walletId: "old-wallet",
      money: money("0.00"), debitAccountId: "recorded-debit", creditAccountId: "recorded-credit", createdAt,
    };
    const transfer = AccountingTransfer.rehydrate(state);
    createdAt.setTime(0);

    expect(transfer.ledgerEntryId).toBe(state.ledgerEntryId);
    expect(transfer.transactionId).toBe(state.transactionId);
    expect(transfer.walletId).toBe(state.walletId);
    expect(transfer.money.isZero()).toBe(true);
    expect(transfer.debitAccountId).toBe(state.debitAccountId);
    expect(transfer.creditAccountId).toBe(state.creditAccountId);
    expect(transfer.createdAt).toEqual(recordedAt);
    expect(Object.isFrozen(transfer)).toBe(true);
  });
});
