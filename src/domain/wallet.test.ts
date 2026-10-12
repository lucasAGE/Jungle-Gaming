import { describe, expect, test } from "bun:test";
import { DomainError } from "./domain-error.js";
import { Money, MoneyError } from "./money.js";
import { Wallet } from "./wallet.js";

const openedAt = new Date("2026-10-10T12:00:00.000Z");

describe("Wallet opening", () => {
  test.each(["0.00", "0.01", "9007199254740993.01"])(
    "opens with %s and version one",
    (amount) => {
      const wallet = Wallet.open({
        id: "wallet-1", playerId: "player-1",
        initialBalance: Money.from({ amount, currency: "BRL" }), createdAt: openedAt,
      });

      expect(wallet.id).toBe("wallet-1");
      expect(wallet.playerId).toBe("player-1");
      expect(wallet.balance.toJSON()).toEqual({ amount, currency: "BRL" });
      expect(wallet.currency).toBe("BRL");
      expect(wallet.version).toBe(1);
      expect(wallet.createdAt).toEqual(openedAt);
      expect(wallet.updatedAt).toEqual(openedAt);
    },
  );

  test("rejects a negative internal Money result", () => {
    expect(() => Wallet.open({
      id: "wallet-1", playerId: "player-1", createdAt: openedAt,
      initialBalance: Money.from({ amount: "0.01", currency: "BRL" }).negate(),
    })).toThrow(new DomainError("WALLET_NEGATIVE_BALANCE", "A wallet cannot open with a negative balance"));
  });

  test("derives currency from balance without losing currency-aware modeling", () => {
    const wallet = Wallet.open({
      id: "wallet-1", playerId: "player-1", createdAt: openedAt,
      initialBalance: Money.zero("USD"),
    });

    expect(wallet.currency).toBe("USD");
  });

  test("retains persisted version and timestamps without replaying opening", () => {
    const updatedAt = new Date("2026-10-10T13:00:00.000Z");
    const wallet = Wallet.rehydrate({
      id: "wallet-1", playerId: "player-1",
      balance: Money.from({ amount: "25.13", currency: "BRL" }),
      version: 7, createdAt: openedAt, updatedAt,
    });

    expect(wallet.balance.toString()).toBe("25.13");
    expect(wallet.version).toBe(7);
    expect(wallet.createdAt).toEqual(openedAt);
    expect(wallet.updatedAt).toEqual(updatedAt);
  });

  test("protects state from mutable input dates and returned dates", () => {
    const createdAt = new Date(openedAt);
    const wallet = Wallet.open({
      id: "wallet-1", playerId: "player-1", createdAt,
      initialBalance: Money.zero("BRL"),
    });
    createdAt.setTime(0);
    wallet.createdAt.setTime(0);
    wallet.updatedAt.setTime(0);

    expect(wallet.createdAt).toEqual(openedAt);
    expect(wallet.updatedAt).toEqual(openedAt);
    expect(Reflect.set(wallet, "version", 99)).toBe(false);
    expect(Reflect.set(wallet, "balance", Money.zero("USD"))).toBe(false);
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe("BRL");
  });
});

describe("Wallet debit", () => {
  const debitedAt = new Date("2026-10-10T13:00:00.000Z");

  function open(amount = "100.00") {
    return Wallet.open({
      id: "wallet-1", playerId: "player-1", createdAt: openedAt,
      initialBalance: Money.from({ amount, currency: "BRL" }),
    });
  }

  test.each([
    ["100.00", "80.00", "20.00"],
    ["100.00", "100.00", "0.00"],
    ["999999999999999999.99", "0.01", "999999999999999999.98"],
  ])("debits %s by %s and returns exact balance %s with a balanced ledger entry", (before, amount, after) => {
    const original = open(before);
    const money = Money.from({ amount, currency: "BRL" });
    const { wallet, entry } = original.debit({ money, transactionId: "bet-1", entryId: "entry-1", at: debitedAt });

    expect(wallet).not.toBe(original);
    expect(wallet.balance.toString()).toBe(after);
    expect(wallet.version).toBe(2);
    expect(wallet.createdAt).toEqual(openedAt);
    expect(wallet.updatedAt).toEqual(debitedAt);
    expect(entry.id).toBe("entry-1");
    expect(entry.walletId).toBe(wallet.id);
    expect(entry.transactionId).toBe("bet-1");
    expect(entry.direction).toBe("DEBIT");
    expect(entry.money.equals(money)).toBe(true);
    expect(entry.balanceBefore.toString()).toBe(before);
    expect(entry.balanceAfter.toString()).toBe(after);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.createdAt).toEqual(debitedAt);
    expect(original.balance.toString()).toBe(before);
    expect(original.version).toBe(1);
    expect(original.updatedAt).toEqual(openedAt);
  });

  test("increments the persisted version once for each debit", () => {
    const original = Wallet.rehydrate({
      id: "wallet-1", playerId: "player-1", balance: Money.from({ amount: "100.00", currency: "BRL" }),
      version: 7, createdAt: openedAt, updatedAt: openedAt,
    });
    const money = Money.from({ amount: "25.00", currency: "BRL" });
    const first = original.debit({ money, transactionId: "bet-1", entryId: "entry-1", at: debitedAt });
    const second = first.wallet.debit({ money, transactionId: "bet-2", entryId: "entry-2", at: debitedAt });

    expect(first.wallet.version).toBe(8);
    expect(second.wallet.version).toBe(9);
    expect(second.wallet.balance.toString()).toBe("50.00");
    expect(second.entry.balanceBefore.equals(first.entry.balanceAfter)).toBe(true);
  });

  test("insufficient funds leaves balance, version and timestamps unchanged", () => {
    const wallet = open("20.00");

    expect(() => wallet.debit({
      money: Money.from({ amount: "80.00", currency: "BRL" }),
      transactionId: "bet-1", entryId: "entry-1", at: debitedAt,
    })).toThrow(new DomainError("INSUFFICIENT_FUNDS", "The wallet has insufficient funds for this bet"));
    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(openedAt);
  });

  test.each([Money.zero("BRL"), Money.from({ amount: "0.01", currency: "BRL" }).negate()])(
    "rejects a non-positive debit %s", (money) => {
      const wallet = open();
      expect(() => wallet.debit({ money, transactionId: "bet-1", entryId: "entry-1", at: debitedAt }))
        .toThrow(new DomainError("BET_REQUIRES_POSITIVE_AMOUNT", "A bet requires a positive amount"));
      expect(wallet.balance.toString()).toBe("100.00");
      expect(wallet.version).toBe(1);
    },
  );

  test("rejects mismatched currencies without changing balance", () => {
    const wallet = open();
    expect(() => wallet.debit({
      money: Money.from({ amount: "1.00", currency: "USD" }),
      transactionId: "bet-1", entryId: "entry-1", at: debitedAt,
    })).toThrow(new MoneyError("MONEY_CURRENCY_MISMATCH", "Money currencies must match"));
    expect(wallet.balance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
    expect(wallet.version).toBe(1);
  });

  test("protects the debited wallet and entry from timestamp mutation", () => {
    const at = new Date(debitedAt);
    const { wallet, entry } = open().debit({
      money: Money.from({ amount: "1.00", currency: "BRL" }),
      transactionId: "bet-1", entryId: "entry-1", at,
    });
    at.setTime(0);
    wallet.updatedAt.setTime(0);
    entry.createdAt.setTime(0);

    expect(wallet.updatedAt).toEqual(debitedAt);
    expect(entry.createdAt).toEqual(debitedAt);
    expect(Reflect.set(wallet, "balance", Money.zero("BRL"))).toBe(false);
    expect(Reflect.set(entry, "direction", "CREDIT")).toBe(false);
  });
});

describe("Wallet credit", () => {
  const creditedAt = new Date("2026-10-10T13:00:00.000Z");
  const money = (amount: string) => Money.from({ amount, currency: "BRL" });

  function open(amount: string) {
    return Wallet.open({
      id: "wallet-1", playerId: "player-1", initialBalance: money(amount), createdAt: openedAt,
    });
  }

  test.each([
    ["0.00", "25.00", "25.00"],
    ["100.00", "0.01", "100.01"],
    ["999999999999999999.98", "0.01", "999999999999999999.99"],
  ])("credits %s by %s with exact result %s and an immutable ledger entry", (before, amount, after) => {
    const original = open(before);
    const at = new Date(creditedAt);
    const result = original.credit({ money: money(amount), transactionId: "win-1", entryId: "entry-1", at });
    at.setTime(0);
    result.wallet.updatedAt.setTime(0);
    result.entry.createdAt.setTime(0);

    expect(result.wallet).not.toBe(original);
    expect(result.wallet.balance.toString()).toBe(after);
    expect(result.wallet.version).toBe(2);
    expect(result.wallet.createdAt).toEqual(openedAt);
    expect(result.wallet.updatedAt).toEqual(creditedAt);
    expect(result.entry.id).toBe("entry-1");
    expect(result.entry.walletId).toBe("wallet-1");
    expect(result.entry.transactionId).toBe("win-1");
    expect(result.entry.direction).toBe("CREDIT");
    expect(result.entry.money.toString()).toBe(amount);
    expect(result.entry.balanceBefore.toString()).toBe(before);
    expect(result.entry.balanceAfter.toString()).toBe(after);
    expect(result.entry.createdAt).toEqual(creditedAt);
    expect(result.entry.isBalanced()).toBe(true);
    expect(Reflect.set(result.wallet, "balance", Money.zero("BRL"))).toBe(false);
    expect(Reflect.set(result.entry, "direction", "DEBIT")).toBe(false);
    expect(original.balance.toString()).toBe(before);
    expect(original.version).toBe(1);
    expect(original.updatedAt).toEqual(openedAt);
  });

  test("continues the persisted version for successive credits", () => {
    const original = Wallet.rehydrate({
      id: "wallet-1", playerId: "player-1", balance: money("100.00"),
      version: 7, createdAt: openedAt, updatedAt: openedAt,
    });
    const first = original.credit({ money: money("25.00"), transactionId: "win-1", entryId: "entry-1", at: creditedAt });
    const second = first.wallet.credit({ money: money("25.00"), transactionId: "win-2", entryId: "entry-2", at: creditedAt });

    expect(first.wallet.version).toBe(8);
    expect(second.wallet.version).toBe(9);
    expect(second.wallet.balance.toString()).toBe("150.00");
    expect(second.entry.balanceBefore.equals(first.entry.balanceAfter)).toBe(true);
  });

  test.each(["0.01", "999999999999999999.99"])("rejects an overflowing %s credit without altering the original", (amount) => {
    const wallet = open("999999999999999999.99");

    expect(() => wallet.credit({ money: money(amount), transactionId: "win-1", entryId: "entry-1", at: creditedAt }))
      .toThrow(new DomainError("BALANCE_LIMIT_EXCEEDED", "The credit would exceed the supported wallet balance"));
    expect(wallet.balance.toString()).toBe("999999999999999999.99");
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(openedAt);
  });

  test.each([Money.zero("BRL"), money("0.01").negate()])("rejects a non-positive credit %s", (amount) => {
    const wallet = open("100.00");

    expect(() => wallet.credit({ money: amount, transactionId: "win-1", entryId: "entry-1", at: creditedAt }))
      .toThrow(new DomainError("WIN_REQUIRES_POSITIVE_AMOUNT", "A win requires a positive amount"));
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("preserves currency errors instead of misclassifying them as overflow", () => {
    const wallet = open("999999999999999999.99");

    expect(() => wallet.credit({
      money: Money.from({ amount: "0.01", currency: "USD" }),
      transactionId: "win-1", entryId: "entry-1", at: creditedAt,
    })).toThrow(new MoneyError("MONEY_CURRENCY_MISMATCH", "Money currencies must match"));
    expect(wallet.balance.toJSON()).toEqual({ amount: "999999999999999999.99", currency: "BRL" });
    expect(wallet.version).toBe(1);
  });
});
