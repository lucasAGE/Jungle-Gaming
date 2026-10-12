import { describe, expect, test } from "bun:test";
import { Money } from "./money.js";
import { OpeningTransaction } from "./opening-transaction.js";
import { Wallet } from "./wallet.js";

const openedAt = new Date("2026-10-10T12:00:00.000Z");

function wallet(amount: string): Wallet {
  return Wallet.open({
    id: "wallet-1", playerId: "player-1", createdAt: openedAt,
    initialBalance: Money.from({ amount, currency: "BRL" }),
  });
}

describe("Internal opening transaction", () => {
  test("is processed with the exact initial balance and a stable wallet-specific key", () => {
    const transaction = OpeningTransaction.create({
      id: "transaction-1", wallet: wallet("9007199254740993.01"), createdAt: openedAt,
    });

    expect(transaction.id).toBe("transaction-1");
    expect(transaction.walletId).toBe("wallet-1");
    expect(transaction.playerId).toBe("player-1");
    expect(transaction.kind).toBe("OPENING");
    expect(transaction.status).toBe("PROCESSED");
    expect(transaction.idempotencyKey).toBe("opening:wallet-1");
    expect(transaction.money.toJSON()).toEqual({ amount: "9007199254740993.01", currency: "BRL" });
    expect(transaction.createdAt).toEqual(openedAt);
    expect(transaction.processedAt).toEqual(openedAt);
  });

  test("does not create a financial transaction for a zero opening", () => {
    expect(() => OpeningTransaction.create({
      id: "transaction-1", wallet: wallet("0.00"), createdAt: openedAt,
    })).toThrow("An opening credit requires a positive balance");
  });

  test("restores persisted identifiers and timestamps without generating new values", () => {
    const processedAt = new Date("2026-10-10T12:00:01.000Z");
    const transaction = OpeningTransaction.rehydrate({
      id: "persisted-transaction", walletId: "persisted-wallet", playerId: "persisted-player",
      money: Money.from({ amount: "0.01", currency: "BRL" }),
      createdAt: openedAt, processedAt,
    });

    expect(transaction.id).toBe("persisted-transaction");
    expect(transaction.walletId).toBe("persisted-wallet");
    expect(transaction.playerId).toBe("persisted-player");
    expect(transaction.idempotencyKey).toBe("opening:persisted-wallet");
    expect(transaction.createdAt).toEqual(openedAt);
    expect(transaction.processedAt).toEqual(processedAt);
  });

  test("protects immutable transaction fields and timestamps", () => {
    const createdAt = new Date(openedAt);
    const transaction = OpeningTransaction.create({
      id: "transaction-1", wallet: wallet("100.00"), createdAt,
    });
    createdAt.setTime(0);
    transaction.createdAt.setTime(0);
    transaction.processedAt.setTime(0);

    expect(transaction.createdAt).toEqual(openedAt);
    expect(transaction.processedAt).toEqual(openedAt);
    expect(Reflect.set(transaction, "status", "REJECTED")).toBe(false);
    expect(Reflect.set(transaction, "money", Money.zero("BRL"))).toBe(false);
    expect(transaction.status).toBe("PROCESSED");
    expect(transaction.money.toString()).toBe("100.00");
  });
});
