import { describe, expect, test } from "bun:test";
import {
  IntegrationEvent, type IntegrationEventProps, WalletBalanceChanged, WagerTransactionProcessed,
  WagerTransactionPendingReference, WagerTransactionRejected, WagerTransactionFailed,
} from "./integration-event.js";
import { Money } from "./money.js";
import { OpeningTransaction } from "./opening-transaction.js";
import { Wallet } from "./wallet.js";
import { WalletLedgerEntry } from "./wallet-ledger-entry.js";
import { maxReferenceAttempts, WagerTransaction, type WagerKind, type WagerReference } from "./wager-transaction.js";

const occurredAt = new Date("2026-10-10T12:00:00.000Z");

describe("WagerTransactionFailed event", () => {
  function records() {
    const wallet = Wallet.open({ id: "wallet", playerId: "player", initialBalance: Money.from({ amount: "100.00", currency: "BRL" }), createdAt: occurredAt });
    const transaction = WagerTransaction.create({ id: "wager", providerId: "provider", externalTransactionId: "external",
      idempotencyKey: "key", payloadHash: "hash", walletId: wallet.id, playerId: wallet.playerId,
      roundId: "round", gameId: "game", kind: "BET", money: Money.from({ amount: "25.00", currency: "BRL" }), createdAt: occurredAt });
    return { wallet, transaction, occurredAt, eventId: "event", correlationId: "correlation" };
  }
  test("serializes a failed operation with the unchanged exact balance and immutable context", () => {
    const context = records();
    context.transaction.fail("DATABASE_OPERATION_FAILED");
    const event = WagerTransactionFailed.wager(context);
    expect(event.toJSON()).toMatchObject({ eventType: "WagerTransactionFailed", version: 1, aggregateId: "wallet",
      correlationId: "correlation", causationId: "wager", data: { status: "FAILED", failureCode: "DATABASE_OPERATION_FAILED",
        money: { amount: "25.00", currency: "BRL" }, balance: { amount: "100.00", currency: "BRL" }, walletVersion: 1 } });
    expect(Reflect.set(event.data.balance, "amount", "0.00")).toBe(false);
    expect(context.wallet.balance.toString()).toBe("100.00");
  });
  test("rejects an active wager or unrelated wallet instead of inventing failure history", () => {
    const context = records();
    expect(() => WagerTransactionFailed.wager(context)).toThrow("Failed wager records must describe");
    context.transaction.fail("DATABASE_OPERATION_FAILED");
    const wallet = Wallet.open({ id: "other", playerId: "player", initialBalance: Money.zero("BRL"), createdAt: occurredAt });
    expect(() => WagerTransactionFailed.wager({ ...context, wallet })).toThrow("Failed wager records must describe");
  });
});

function openingRecords() {
  const wallet = Wallet.open({
    id: "wallet-1", playerId: "player-1", createdAt: occurredAt,
    initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
  });
  const transaction = OpeningTransaction.create({ id: "transaction-1", wallet, createdAt: occurredAt });
  const entry = WalletLedgerEntry.create({
    id: "entry-1", walletId: wallet.id, transactionId: transaction.id, direction: "CREDIT",
    money: transaction.money, balanceBefore: Money.zero("BRL"), balanceAfter: wallet.balance,
    createdAt: occurredAt,
  });
  return { eventId: "event-1", correlationId: "request-1", wallet, transaction, entry };
}

describe("Opening integration events", () => {
  test("serializes the processed event with trace context and exact decimal DTOs", () => {
    const event = WagerTransactionProcessed.opening(openingRecords());

    expect(event.toJSON()).toEqual({
      eventId: "event-1", eventType: "WagerTransactionProcessed", aggregateId: "wallet-1",
      correlationId: "request-1", causationId: "transaction-1", occurredAt: occurredAt.toISOString(),
      version: 1,
      data: {
        transactionId: "transaction-1", walletId: "wallet-1", playerId: "player-1",
        kind: "OPENING", status: "PROCESSED", money: { amount: "100.00", currency: "BRL" },
        balance: { amount: "100.00", currency: "BRL" }, walletVersion: 1,
      },
    });
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
    expect(event.data.money).not.toBeInstanceOf(Money);
  });

  test("serializes the balance change from its ledger entry", () => {
    const event = WalletBalanceChanged.opening(openingRecords());

    expect(event.eventType).toBe("WalletBalanceChanged");
    expect(event.version).toBe(1);
    expect(event.data).toEqual({
      walletId: "wallet-1", transactionId: "transaction-1", direction: "CREDIT",
      money: { amount: "100.00", currency: "BRL" },
      balanceBefore: { amount: "0.00", currency: "BRL" },
      balanceAfter: { amount: "100.00", currency: "BRL" }, walletVersion: 1,
    });
  });

  test.each([WagerTransactionProcessed, WalletBalanceChanged])(
    "%s refuses records from a different wallet",
    (EventType) => {
      const records = openingRecords();
      const wallet = Wallet.open({
        id: "other-wallet", playerId: "player-1", createdAt: occurredAt,
        initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      });

      expect(() => EventType.opening({ ...records, wallet }))
        .toThrow("Opening event records must describe the same balance change");
    },
  );

  test("protects nested data, envelope fields and time from mutation", () => {
    const event = WalletBalanceChanged.opening(openingRecords());
    event.occurredAt.setTime(0);
    const serialized = event.toJSON();

    expect(Reflect.set(event, "version", 9)).toBe(false);
    expect(Reflect.set(event.data, "walletVersion", 9)).toBe(false);
    expect(Reflect.set(event.data.money, "amount", "999.00")).toBe(false);
    Reflect.set(serialized.data.money, "amount", "999.00");
    expect(event.data.money.amount).toBe("100.00");
    expect(event.occurredAt).toEqual(occurredAt);
    expect(event.toJSON().data.money.amount).toBe("100.00");
  });

  test("the base event snapshots input and omits an absent causation ID", () => {
    class ExampleEvent extends IntegrationEvent<{ nested: { amount: string } }> {
      readonly eventType = "ExampleEvent";
      readonly version = 1;
      constructor(props: IntegrationEventProps<{ nested: { amount: string } }>) {
        super(props);
      }
    }
    const data = { nested: { amount: "0.01" } };
    const sourceDate = new Date(occurredAt);
    const event = new ExampleEvent({
      eventId: "event-1", aggregateId: "wallet-1", correlationId: "request-1",
      occurredAt: sourceDate, data,
    });
    data.nested.amount = "999.00";
    sourceDate.setTime(0);

    expect(event.data.nested.amount).toBe("0.01");
    expect(event.occurredAt).toEqual(occurredAt);
    expect(Object.hasOwn(event.toJSON(), "causationId")).toBe(false);
  });
});

const processedAt = new Date("2026-10-10T12:00:01.000Z");

function wagerRecords(amount = "25.00", kind: WagerKind = "BET", initialBalance = "100.00", referenceExternalTransactionId?: string) {
  const wallet = Wallet.open({
    id: "wallet-1", playerId: "player-1", createdAt: occurredAt,
    initialBalance: Money.from({ amount: initialBalance, currency: "BRL" }),
  });
  const transaction = WagerTransaction.create({
    id: `${kind.toLowerCase()}-1`, providerId: "provider-a", externalTransactionId: "external-1",
    idempotencyKey: "provider-a:external-1", payloadHash: "payload-hash",
    walletId: wallet.id, playerId: wallet.playerId, roundId: "round-1", gameId: "game-1",
    kind, money: Money.from({ amount, currency: "BRL" }), createdAt: occurredAt,
    ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }),
  });
  return { eventId: "event-1", correlationId: "request-1", wallet, transaction };
}

function processedBetRecords() {
  const records = wagerRecords();
  const { wallet, entry } = records.wallet.debit({
    money: records.transaction.money, transactionId: records.transaction.id,
    entryId: "entry-1", at: processedAt,
  });
  records.transaction.markProcessed(processedAt);
  return { ...records, wallet, entry };
}

describe("BET integration events", () => {
  test("processed event records the provider identity, observed balance and processing time", () => {
    const event = WagerTransactionProcessed.wager(processedBetRecords());

    expect(event.toJSON()).toEqual({
      eventId: "event-1", eventType: "WagerTransactionProcessed", aggregateId: "wallet-1",
      correlationId: "request-1", causationId: "bet-1", occurredAt: processedAt.toISOString(),
      version: 1,
      data: {
        transactionId: "bet-1", walletId: "wallet-1", playerId: "player-1",
        providerId: "provider-a", externalTransactionId: "external-1", roundId: "round-1", gameId: "game-1",
        kind: "BET", status: "PROCESSED", money: { amount: "25.00", currency: "BRL" },
        balance: { amount: "75.00", currency: "BRL" }, walletVersion: 2,
      },
    });
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });

  test("balance event describes exactly the persisted debit", () => {
    const event = WalletBalanceChanged.wager(processedBetRecords());

    expect(event.eventType).toBe("WalletBalanceChanged");
    expect(event.occurredAt).toEqual(processedAt);
    expect(event.data).toEqual({
      walletId: "wallet-1", transactionId: "bet-1", direction: "DEBIT",
      money: { amount: "25.00", currency: "BRL" },
      balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "75.00", currency: "BRL" }, walletVersion: 2,
    });
  });

  test.each([WagerTransactionProcessed, WalletBalanceChanged])(
    "%s refuses a pending transaction and the wallet before debit", (EventType) => {
      const records = wagerRecords();
      const debited = records.wallet.debit({
        money: records.transaction.money, transactionId: records.transaction.id,
        entryId: "entry-1", at: processedAt,
      });

      expect(() => EventType.wager({ ...records, ...debited }))
        .toThrow("Wager event records must describe the same processed operation");
      records.transaction.markProcessed(processedAt);
      expect(() => EventType.wager({ ...records, entry: debited.entry }))
        .toThrow("Wager event records must describe the same processed operation");
    },
  );

  test.each([WagerTransactionProcessed, WalletBalanceChanged])(
    "%s refuses a ledger entry from a different transaction", (EventType) => {
      const records = processedBetRecords();
      const entry = WalletLedgerEntry.create({
        id: "entry-2", walletId: records.wallet.id, transactionId: "different-bet", direction: "DEBIT",
        money: records.entry.money, balanceBefore: records.entry.balanceBefore,
        balanceAfter: records.entry.balanceAfter, createdAt: processedAt,
      });

      expect(() => EventType.wager({ ...records, entry }))
        .toThrow("Wager event records must describe the same processed operation");
    },
  );

  test("rejected event keeps the unchanged balance and stable failure code", () => {
    const records = wagerRecords("101.00");
    records.transaction.reject("INSUFFICIENT_FUNDS");
    const event = WagerTransactionRejected.wager(records);

    expect(event.toJSON()).toEqual({
      eventId: "event-1", eventType: "WagerTransactionRejected", aggregateId: "wallet-1",
      correlationId: "request-1", causationId: "bet-1", occurredAt: occurredAt.toISOString(), version: 1,
      data: {
        transactionId: "bet-1", walletId: "wallet-1", playerId: "player-1",
        providerId: "provider-a", externalTransactionId: "external-1", roundId: "round-1", gameId: "game-1",
        kind: "BET", status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS",
        money: { amount: "101.00", currency: "BRL" },
        balance: { amount: "100.00", currency: "BRL" }, walletVersion: 1,
      },
    });
    expect(records.wallet.balance.toString()).toBe("100.00");
    expect(records.wallet.version).toBe(1);
  });

  test("refuses a rejected event for a pending transaction or a sufficient balance", () => {
    const pending = wagerRecords("101.00");
    expect(() => WagerTransactionRejected.wager(pending))
      .toThrow("Rejected wager records must describe the same balance rule violation");
    const sufficient = wagerRecords("100.00");
    sufficient.transaction.reject("INSUFFICIENT_FUNDS");
    expect(() => WagerTransactionRejected.wager(sufficient))
      .toThrow("Rejected wager records must describe the same balance rule violation");
  });

  test("refuses rejection records belonging to another wallet", () => {
    const records = wagerRecords("101.00");
    records.transaction.reject("INSUFFICIENT_FUNDS");
    const wallet = Wallet.open({
      id: "other-wallet", playerId: "player-1", initialBalance: Money.zero("BRL"), createdAt: occurredAt,
    });

    expect(() => WagerTransactionRejected.wager({ ...records, wallet }))
      .toThrow("Rejected wager records must describe the same balance rule violation");
  });

  test("BET event snapshots and envelopes resist mutation", () => {
    const rejected = wagerRecords("101.00");
    rejected.transaction.reject("INSUFFICIENT_FUNDS");
    const events = [
      WagerTransactionProcessed.wager(processedBetRecords()),
      WalletBalanceChanged.wager(processedBetRecords()),
      WagerTransactionRejected.wager(rejected),
    ];
    for (const event of events) {
      const original = event.toJSON();
      event.occurredAt.setTime(0);
      expect(Reflect.set(event, "version", 2)).toBe(false);
      expect(Reflect.set(event.data.money, "amount", "0.00")).toBe(false);
      expect(Reflect.set(event.data, "walletVersion", 99)).toBe(false);
      const serialized = event.toJSON();
      Reflect.set(serialized.data.money, "amount", "999.00");
      expect(event.toJSON()).toEqual(original);
    }
  });
});

function processedWinRecords(referenceExternalTransactionId?: string) {
  const records = wagerRecords("25.00", "WIN", "100.00", referenceExternalTransactionId);
  const credited = records.wallet.credit({
    money: records.transaction.money, transactionId: records.transaction.id,
    entryId: "entry-1", at: processedAt,
  });
  records.transaction.markProcessed(processedAt, referenceExternalTransactionId === undefined ? undefined : "referenced-bet");
  return { ...records, ...credited };
}

describe("WIN integration events", () => {
  test("processed and balance events describe the same exact credit", () => {
    const records = processedWinRecords();
    const processed = WagerTransactionProcessed.wager(records);
    const changed = WalletBalanceChanged.wager(records);

    expect(processed.toJSON()).toEqual({
      eventId: "event-1", eventType: "WagerTransactionProcessed", aggregateId: "wallet-1",
      correlationId: "request-1", causationId: "win-1", occurredAt: processedAt.toISOString(),
      version: 1,
      data: {
        transactionId: "win-1", walletId: "wallet-1", playerId: "player-1",
        providerId: "provider-a", externalTransactionId: "external-1", roundId: "round-1", gameId: "game-1",
        kind: "WIN", status: "PROCESSED", money: { amount: "25.00", currency: "BRL" },
        balance: { amount: "125.00", currency: "BRL" }, walletVersion: 2,
      },
    });
    expect(changed.data).toEqual({
      walletId: "wallet-1", transactionId: "win-1", direction: "CREDIT",
      money: { amount: "25.00", currency: "BRL" },
      balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "125.00", currency: "BRL" }, walletVersion: 2,
    });
    expect(changed.occurredAt).toEqual(processedAt);
  });

  test.each([WagerTransactionProcessed, WalletBalanceChanged])("%s rejects a debit presented as a WIN", (EventType) => {
    const records = wagerRecords("25.00", "WIN");
    const debited = records.wallet.debit({
      money: records.transaction.money, transactionId: records.transaction.id,
      entryId: "entry-1", at: processedAt,
    });
    records.transaction.markProcessed(processedAt);

    expect(() => EventType.wager({ ...records, ...debited }))
      .toThrow("Wager event records must describe the same processed operation");
  });

  test("requires a ledger entry for processed WIN and BET events", () => {
    for (const records of [processedWinRecords(), processedBetRecords()]) {
      expect(() => WagerTransactionProcessed.wager({ ...records, entry: null }))
        .toThrow("Wager event records must describe the same processed operation");
    }
  });

  test("rejects a WIN event with the balance before the credit", () => {
    const records = processedWinRecords();
    const original = wagerRecords("25.00", "WIN");

    expect(() => WagerTransactionProcessed.wager({ ...records, wallet: original.wallet }))
      .toThrow("Wager event records must describe the same processed operation");
  });

  test("a rejected WIN snapshots the real balance-limit violation", () => {
    const records = wagerRecords("0.01", "WIN", "999999999999999999.99");
    records.transaction.reject("BALANCE_LIMIT_EXCEEDED");
    const event = WagerTransactionRejected.wager(records);

    expect(event.data.kind).toBe("WIN");
    expect(event.data.status).toBe("REJECTED");
    expect(event.data.failureCode).toBe("BALANCE_LIMIT_EXCEEDED");
    expect(event.data.money).toEqual({ amount: "0.01", currency: "BRL" });
    expect(event.data.balance).toEqual({ amount: "999999999999999999.99", currency: "BRL" });
    expect(event.data.walletVersion).toBe(1);
    expect(event.occurredAt).toEqual(occurredAt);
    expect(records.wallet.balance.toString()).toBe("999999999999999999.99");
    expect(records.wallet.updatedAt).toEqual(occurredAt);
  });

  test("refuses a balance-limit rejection when the credit fits exactly", () => {
    const records = wagerRecords("0.01", "WIN", "999999999999999999.98");
    records.transaction.reject("BALANCE_LIMIT_EXCEEDED");

    expect(() => WagerTransactionRejected.wager(records))
      .toThrow("Rejected wager records must describe the same balance rule violation");
  });

  test("refuses a rejected WIN event for a different currency", () => {
    const records = wagerRecords("0.01", "WIN", "999999999999999999.99");
    records.transaction.reject("BALANCE_LIMIT_EXCEEDED");
    const wallet = Wallet.open({
      id: records.wallet.id, playerId: records.wallet.playerId, createdAt: occurredAt,
      initialBalance: Money.from({ amount: "999999999999999999.99", currency: "USD" }),
    });

    expect(() => WagerTransactionRejected.wager({ ...records, wallet }))
      .toThrow("Rejected wager records must describe the same balance rule violation");
  });

  test("WIN envelopes and their nested snapshots remain immutable", () => {
    const rejected = wagerRecords("0.01", "WIN", "999999999999999999.99");
    rejected.transaction.reject("BALANCE_LIMIT_EXCEEDED");
    const events = [
      WagerTransactionProcessed.wager(processedWinRecords()),
      WalletBalanceChanged.wager(processedWinRecords()),
      WagerTransactionRejected.wager(rejected),
    ];
    for (const event of events) {
      const snapshot = event.toJSON();
      event.occurredAt.setTime(0);
      expect(Reflect.set(event, "version", 2)).toBe(false);
      expect(Reflect.set(event.data.money, "amount", "0.00")).toBe(false);
      expect(Reflect.set(event.data, "walletVersion", 999)).toBe(false);
      const serialized = event.toJSON();
      Reflect.set(serialized.data.money, "amount", "99.00");
      expect(event.toJSON()).toEqual(snapshot);
    }
  });
});

describe("WIN reference integration events", () => {
  function pendingRecords() {
    const records = wagerRecords("25.00", "WIN", "100.00", "external-bet");
    records.transaction.markPendingReference(occurredAt);
    return records;
  }

  test("snapshots the initial deferred win with its retry schedule and unchanged balance", () => {
    const records = pendingRecords();
    const event = WagerTransactionPendingReference.wager(records);
    expect(event.toJSON()).toEqual({
      eventId: "event-1", eventType: "WagerTransactionPendingReference", aggregateId: "wallet-1",
      correlationId: "request-1", causationId: "win-1", occurredAt: occurredAt.toISOString(), version: 1,
      data: {
        transactionId: "win-1", walletId: "wallet-1", playerId: "player-1",
        providerId: "provider-a", externalTransactionId: "external-1", referenceExternalTransactionId: "external-bet",
        roundId: "round-1", gameId: "game-1", kind: "WIN", status: "PENDING_REFERENCE",
        money: { amount: "25.00", currency: "BRL" }, balance: { amount: "100.00", currency: "BRL" },
        walletVersion: 1, referenceAttempts: 0, nextReferenceAttemptAt: processedAt.toISOString(),
      },
    });
    records.transaction.retryMissingReference(processedAt);
    expect(event.data.referenceAttempts).toBe(0);
    expect(event.data.nextReferenceAttemptAt).toBe(processedAt.toISOString());
    expect(records.wallet.balance.toString()).toBe("100.00");
    expect(records.wallet.version).toBe(1);
  });

  test("protects the pending envelope, schedule and nested money snapshots", () => {
    const event = WagerTransactionPendingReference.wager(pendingRecords());
    const original = event.toJSON();
    event.occurredAt.setTime(0);
    expect(Reflect.set(event, "version", 99)).toBe(false);
    expect(Reflect.set(event.data, "nextReferenceAttemptAt", "invalid")).toBe(false);
    expect(Reflect.set(event.data.money, "amount", "99.00")).toBe(false);
    Reflect.set(event.toJSON().data.balance, "amount", "0.00");
    expect(event.toJSON()).toEqual(original);
  });

  test("only the initial deferral creates the pending-reference event", () => {
    const pending = pendingRecords();
    pending.transaction.retryMissingReference(processedAt);
    expect(() => WagerTransactionPendingReference.wager(pending))
      .toThrow("Pending reference records must describe the initial deferred transaction");
    const initial = wagerRecords("25.00", "WIN", "100.00", "external-bet");
    expect(() => WagerTransactionPendingReference.wager(initial))
      .toThrow("Pending reference records must describe the initial deferred transaction");
    expect(() => WagerTransactionPendingReference.wager(processedWinRecords("external-bet")))
      .toThrow("Pending reference records must describe the initial deferred transaction");
  });

  test.each(["identity", "player", "currency"])("rejects a pending event from another wallet %s", (field) => {
    const records = pendingRecords();
    const wallet = Wallet.open({
      id: field === "identity" ? "other-wallet" : records.wallet.id,
      playerId: field === "player" ? "other-player" : records.wallet.playerId,
      initialBalance: Money.from({ amount: "100.00", currency: field === "currency" ? "USD" : "BRL" }),
      createdAt: occurredAt,
    });
    expect(() => WagerTransactionPendingReference.wager({ ...records, wallet }))
      .toThrow("Pending reference records must describe the initial deferred transaction");
  });

  test("processed WIN includes both external and resolved reference identities", () => {
    const event = WagerTransactionProcessed.wager(processedWinRecords("external-bet"));
    expect(event.data.referenceExternalTransactionId).toBe("external-bet");
    expect(event.data.referenceTransactionId).toBe("referenced-bet");
    expect(event.data.balance.amount).toBe("125.00");
    expect(event.occurredAt).toEqual(processedAt);
  });

  test.each([undefined, "", "win-1"])("rejects a processed WIN with an invalid resolved reference %s", (referenceTransactionId) => {
    const records = processedWinRecords("external-bet");
    const transaction = WagerTransaction.rehydrate({
      ...records.transaction, createdAt: occurredAt, status: "PROCESSED", processedAt,
      ...(referenceTransactionId === undefined ? {} : { referenceTransactionId }),
    });
    expect(() => WagerTransactionProcessed.wager({ ...records, transaction }))
      .toThrow("Wager event records must describe the same processed operation");
  });

  test.each([
    "REFERENCE_MISMATCH", "REFERENCE_KIND_MISMATCH", "REFERENCE_NOT_PROCESSED", "REFERENCE_NOT_FOUND",
  ] as const)("a terminal %s event records the worker decision time and reference", (code) => {
    const records = pendingRecords();
    if (code === "REFERENCE_NOT_FOUND") {
      for (let attempt = 0; attempt < maxReferenceAttempts; attempt += 1) {
        records.transaction.retryMissingReference(records.transaction.nextReferenceAttemptAt!);
      }
    } else records.transaction.reject(code);
    const at = new Date("2026-10-10T12:05:03.000Z");
    const event = WagerTransactionRejected.wager({ ...records, occurredAt: at });
    at.setTime(0);
    expect(event.data.failureCode).toBe(code);
    expect(event.data.referenceExternalTransactionId).toBe("external-bet");
    expect(event.data.referenceTransactionId).toBeUndefined();
    expect(event.data.balance.amount).toBe("100.00");
    expect(event.occurredAt.toISOString()).toBe("2026-10-10T12:05:03.000Z");
  });

  test("rejects a reference failure event without an external reference", () => {
    const records = wagerRecords("25.00", "WIN");
    const transaction = WagerTransaction.rehydrate({
      ...records.transaction, createdAt: occurredAt, status: "REJECTED", failureCode: "REFERENCE_NOT_FOUND",
    });
    expect(() => WagerTransactionRejected.wager({ ...records, transaction }))
      .toThrow("Rejected wager records must describe the same balance rule violation");
  });
});

describe("LOSS integration events", () => {
  function processedLossRecords() {
    const records = wagerRecords("0.00", "LOSS");
    records.transaction.markProcessed(processedAt);
    return { ...records, entry: null };
  }

  test("records the result without a ledger entry, balance change or new wallet version", () => {
    const records = processedLossRecords();
    const event = WagerTransactionProcessed.wager(records);

    expect(event.toJSON()).toEqual({
      eventId: "event-1", eventType: "WagerTransactionProcessed", aggregateId: "wallet-1",
      correlationId: "request-1", causationId: "loss-1", occurredAt: processedAt.toISOString(),
      version: 1,
      data: {
        transactionId: "loss-1", walletId: "wallet-1", playerId: "player-1",
        providerId: "provider-a", externalTransactionId: "external-1", roundId: "round-1", gameId: "game-1",
        kind: "LOSS", status: "PROCESSED", money: { amount: "0.00", currency: "BRL" },
        balance: { amount: "100.00", currency: "BRL" }, walletVersion: 1,
      },
    });
    expect(records.wallet.updatedAt).toEqual(occurredAt);
    expect(Reflect.set(event.data.money, "amount", "1.00")).toBe(false);
    expect(Reflect.set(event.data.balance, "amount", "0.00")).toBe(false);
    const serialized = event.toJSON();
    Reflect.set(serialized.data.balance, "amount", "0.00");
    expect(event.data.balance.amount).toBe("100.00");
  });

  test.each([WagerTransactionProcessed, WalletBalanceChanged])("%s refuses a LOSS accompanied by a ledger entry", (EventType) => {
    const records = processedLossRecords();
    const entry = processedWinRecords().entry;

    expect(() => EventType.wager({ ...records, entry }))
      .toThrow("Wager event records must describe the same processed operation");
  });

  test("refuses a pending LOSS event", () => {
    const records = wagerRecords("0.00", "LOSS");

    expect(() => WagerTransactionProcessed.wager({ ...records, entry: null }))
      .toThrow("Wager event records must describe the same processed operation");
  });

  test("refuses a nonzero rehydrated LOSS even without a ledger entry", () => {
    const records = processedLossRecords();
    const transaction = WagerTransaction.rehydrate({
      ...records.transaction, createdAt: occurredAt, status: "PROCESSED", processedAt,
      money: Money.from({ amount: "0.01", currency: "BRL" }),
    });

    expect(() => WagerTransactionProcessed.wager({ ...records, transaction }))
      .toThrow("Wager event records must describe the same processed operation");
  });

  test.each(["identity", "player", "currency"])("refuses a LOSS event with a different wallet %s", (field) => {
    const records = processedLossRecords();
    const wallet = Wallet.open({
      id: field === "identity" ? "other-wallet" : records.wallet.id,
      playerId: field === "player" ? "other-player" : records.wallet.playerId,
      initialBalance: Money.from({ amount: "100.00", currency: field === "currency" ? "USD" : "BRL" }),
      createdAt: occurredAt,
    });

    expect(() => WagerTransactionProcessed.wager({ ...records, wallet }))
      .toThrow("Wager event records must describe the same processed operation");
  });
});

describe("REFUND integration events", () => {
  function refundRecords(amount = "25.00", balance = "100.00") {
    return wagerRecords(amount, "REFUND", balance, "external-bet");
  }

  function processedRefundRecords() {
    const records = refundRecords();
    const effect = records.wallet.credit({
      money: records.transaction.money, transactionId: records.transaction.id,
      entryId: "entry-1", at: processedAt,
    });
    records.transaction.markProcessed(processedAt, "referenced-bet");
    return { ...records, ...effect };
  }

  test("processed refund and balance events describe the same credit and resolved BET", () => {
    const records = processedRefundRecords();
    const processed = WagerTransactionProcessed.wager(records);
    const changed = WalletBalanceChanged.wager(records);
    expect(processed.toJSON()).toEqual({
      eventId: "event-1", eventType: "WagerTransactionProcessed", aggregateId: "wallet-1",
      correlationId: "request-1", causationId: "refund-1", occurredAt: processedAt.toISOString(), version: 1,
      data: {
        transactionId: "refund-1", walletId: "wallet-1", playerId: "player-1", providerId: "provider-a",
        externalTransactionId: "external-1", roundId: "round-1", gameId: "game-1",
        referenceExternalTransactionId: "external-bet", referenceTransactionId: "referenced-bet",
        kind: "REFUND", status: "PROCESSED", money: { amount: "25.00", currency: "BRL" },
        balance: { amount: "125.00", currency: "BRL" }, walletVersion: 2,
      },
    });
    expect(changed.data).toEqual({
      walletId: "wallet-1", transactionId: "refund-1", direction: "CREDIT",
      money: { amount: "25.00", currency: "BRL" }, balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "125.00", currency: "BRL" }, walletVersion: 2,
    });
    expect(changed.occurredAt).toEqual(processedAt);
    expect(changed.causationId).toBe(processed.causationId);
    expect(Reflect.set(processed.data.money, "amount", "0.00")).toBe(false);
    expect(Reflect.set(changed.data.balanceAfter, "amount", "0.00")).toBe(false);
  });

  test.each([WagerTransactionProcessed, WalletBalanceChanged])("%s refuses a refund debit", (EventType) => {
    const records = refundRecords();
    const effect = records.wallet.debit({
      money: records.transaction.money, transactionId: records.transaction.id,
      entryId: "entry-1", at: processedAt,
    });
    records.transaction.markProcessed(processedAt, "referenced-bet");
    expect(() => EventType.wager({ ...records, ...effect }))
      .toThrow("Wager event records must describe the same processed operation");
  });

  test("refuses a processed refund without its ledger entry", () => {
    const records = processedRefundRecords();
    expect(() => WagerTransactionProcessed.wager({ ...records, entry: null }))
      .toThrow("Wager event records must describe the same processed operation");
  });

  test.each([undefined, "", "refund-1"])("refuses an invalid resolved refund reference %s", (referenceTransactionId) => {
    const records = processedRefundRecords();
    const transaction = WagerTransaction.rehydrate({
      ...records.transaction, createdAt: occurredAt, status: "PROCESSED", processedAt,
      ...(referenceTransactionId === undefined ? {} : { referenceTransactionId }),
    });
    expect(() => WagerTransactionProcessed.wager({ ...records, transaction }))
      .toThrow("Wager event records must describe the same processed operation");
  });

  test("refuses a processed refund without the required external reference", () => {
    const records = processedRefundRecords();
    const { referenceExternalTransactionId: _reference, ...source } = records.transaction;
    const transaction = WagerTransaction.rehydrate({ ...source, createdAt: occurredAt, status: "PROCESSED", processedAt });
    expect(() => WagerTransactionProcessed.wager({ ...records, transaction }))
      .toThrow("Wager event records must describe the same processed operation");
  });

  test("pending refund snapshots durable acceptance without a balance or version change", () => {
    const records = refundRecords();
    records.transaction.markPendingReference(occurredAt);
    const event = WagerTransactionPendingReference.wager(records);
    expect(event.data).toEqual({
      transactionId: "refund-1", walletId: "wallet-1", playerId: "player-1", providerId: "provider-a",
      externalTransactionId: "external-1", referenceExternalTransactionId: "external-bet",
      roundId: "round-1", gameId: "game-1", kind: "REFUND", status: "PENDING_REFERENCE",
      money: { amount: "25.00", currency: "BRL" }, balance: { amount: "100.00", currency: "BRL" },
      walletVersion: 1, referenceAttempts: 0, nextReferenceAttemptAt: processedAt.toISOString(),
    });
    records.transaction.retryMissingReference(processedAt);
    expect(event.data.referenceAttempts).toBe(0);
    expect(event.data.nextReferenceAttemptAt).toBe(processedAt.toISOString());
    expect(Reflect.set(event.data.balance, "amount", "0.00")).toBe(false);
    expect(records.wallet.version).toBe(1);
    expect(records.wallet.updatedAt).toEqual(occurredAt);
    expect(records.wallet.balance.toString()).toBe("100.00");
    expect(() => WagerTransactionPendingReference.wager(records))
      .toThrow("Pending reference records must describe the initial deferred transaction");
    expect(() => WagerTransactionProcessed.wager({ ...records, entry: null }))
      .toThrow("Wager event records must describe the same processed operation");
  });

  test.each([
    "REFERENCE_MISMATCH", "REFERENCE_KIND_MISMATCH", "REFERENCE_NOT_PROCESSED",
    "REFERENCE_AMOUNT_MISMATCH", "REFERENCE_ALREADY_REFUNDED", "REFERENCE_NOT_FOUND",
  ] as const)("rejected refund emits %s with its unchanged balance and reference", (code) => {
    const records = refundRecords();
    records.transaction.markPendingReference(occurredAt);
    if (code === "REFERENCE_NOT_FOUND") {
      for (let attempt = 0; attempt < maxReferenceAttempts; attempt += 1) {
        records.transaction.retryMissingReference(records.transaction.nextReferenceAttemptAt!);
      }
    } else records.transaction.reject(code);
    const decisionAt = new Date("2026-10-10T12:05:03.000Z");
    const event = WagerTransactionRejected.wager({ ...records, occurredAt: decisionAt });
    expect(event.data.kind).toBe("REFUND");
    expect(event.data.status).toBe("REJECTED");
    expect(event.data.failureCode).toBe(code);
    expect(event.data.referenceExternalTransactionId).toBe("external-bet");
    expect(event.data.referenceTransactionId).toBeUndefined();
    expect(event.data.balance.amount).toBe("100.00");
    expect(event.data.walletVersion).toBe(1);
    expect(event.occurredAt).toEqual(decisionAt);
    expect(() => WagerTransactionProcessed.wager({ ...records, entry: null }))
      .toThrow("Wager event records must describe the same processed operation");
  });

  test("supports a refund rejection when intervening credits leave no room for the refund", () => {
    const records = refundRecords("0.01", "999999999999999999.99");
    records.transaction.reject("BALANCE_LIMIT_EXCEEDED");
    const event = WagerTransactionRejected.wager(records);
    expect(event.data.failureCode).toBe("BALANCE_LIMIT_EXCEEDED");
    expect(event.data.balance.amount).toBe("999999999999999999.99");
    expect(event.data.walletVersion).toBe(1);
    expect(event.data.referenceExternalTransactionId).toBe("external-bet");
    const sufficient = refundRecords();
    sufficient.transaction.reject("BALANCE_LIMIT_EXCEEDED");
    expect(() => WagerTransactionRejected.wager(sufficient))
      .toThrow("Rejected wager records must describe the same balance rule violation");
  });

  test("does not emit refund-specific failures for a WIN", () => {
    const records = wagerRecords("25.00", "WIN", "100.00", "external-bet");
    const transaction = WagerTransaction.rehydrate({
      ...records.transaction, createdAt: occurredAt, status: "REJECTED", failureCode: "REFERENCE_ALREADY_REFUNDED",
    });
    expect(() => WagerTransactionRejected.wager({ ...records, transaction }))
      .toThrow("Rejected wager records must describe the same balance rule violation");
  });
});

describe("ROLLBACK integration events", () => {
  function rollbackRecords(kind = "WIN", amount = "25.00", balance = "100.00") {
    const records = wagerRecords(amount, "ROLLBACK", balance, "external-original");
    const reference: WagerReference = {
      id: "referenced-original", providerId: records.transaction.providerId,
      playerId: records.wallet.playerId, walletId: records.wallet.id, currency: records.wallet.currency,
      money: records.transaction.money, roundId: records.transaction.roundId, kind, status: "PROCESSED",
    };
    return { ...records, reference };
  }

  function processedRollbackRecords(kind = "WIN", amount = "25.00", balance = "100.00") {
    const records = rollbackRecords(kind, amount, balance);
    const movement = {
      money: records.transaction.money, transactionId: records.transaction.id, entryId: "entry-1", at: processedAt,
    };
    const effect = kind === "BET" ? records.wallet.credit(movement) : records.wallet.debit(movement);
    records.transaction.markProcessed(processedAt, records.reference.id);
    return { ...records, ...effect };
  }

  test.each(["BET", "WIN", "REFUND"])("processed events invert the %s and preserve both reference identities", (kind) => {
    const records = processedRollbackRecords(kind);
    const processed = WagerTransactionProcessed.wager(records);
    const changed = WalletBalanceChanged.wager(records);
    const balance = kind === "BET" ? "125.00" : "75.00";
    expect(processed.toJSON()).toEqual({
      eventId: "event-1", eventType: "WagerTransactionProcessed", aggregateId: "wallet-1",
      correlationId: "request-1", causationId: "rollback-1", occurredAt: processedAt.toISOString(), version: 1,
      data: {
        transactionId: "rollback-1", walletId: "wallet-1", playerId: "player-1", providerId: "provider-a",
        externalTransactionId: "external-1", roundId: "round-1", gameId: "game-1",
        referenceExternalTransactionId: "external-original", referenceTransactionId: "referenced-original",
        kind: "ROLLBACK", status: "PROCESSED", money: { amount: "25.00", currency: "BRL" },
        balance: { amount: balance, currency: "BRL" }, walletVersion: 2,
      },
    });
    expect(changed.data).toEqual({
      walletId: "wallet-1", transactionId: "rollback-1", direction: kind === "BET" ? "CREDIT" : "DEBIT",
      money: { amount: "25.00", currency: "BRL" }, balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: balance, currency: "BRL" }, walletVersion: 2,
    });
    expect(changed.occurredAt).toEqual(processedAt);
    expect(records.reference.status).toBe("PROCESSED");
    expect(records.reference.money.toString()).toBe("25.00");
    expect(Reflect.set(processed.data.money, "amount", "0.00")).toBe(false);
    expect(Reflect.set(changed.data.balanceAfter, "amount", "0.00")).toBe(false);
  });

  test.each(["BET", "WIN", "REFUND"])("refuses an event that repeats the original %s direction", (kind) => {
    const records = rollbackRecords(kind);
    const movement = {
      money: records.transaction.money, transactionId: records.transaction.id, entryId: "entry-1", at: processedAt,
    };
    const effect = kind === "BET" ? records.wallet.debit(movement) : records.wallet.credit(movement);
    records.transaction.markProcessed(processedAt, records.reference.id);
    for (const EventType of [WagerTransactionProcessed, WalletBalanceChanged]) {
      expect(() => EventType.wager({ ...records, ...effect }))
        .toThrow("Wager event records must describe the same processed operation");
    }
  });

  test.each([WagerTransactionProcessed, WalletBalanceChanged])("%s requires the resolved original operation", (EventType) => {
    const { reference: _reference, ...records } = processedRollbackRecords();
    expect(() => EventType.wager(records)).toThrow("Wager event records must describe the same processed operation");
  });

  test.each(["id", "providerId", "playerId", "walletId", "currency", "roundId"] as const)(
    "rejects a processed event with a different reference %s", (field) => {
      const records = processedRollbackRecords();
      expect(() => WagerTransactionProcessed.wager({ ...records, reference: { ...records.reference, [field]: "another" } }))
        .toThrow("Wager event records must describe the same processed operation");
    },
  );

  test("refuses processed rollback events with ineligible or mismatched reference state", () => {
    const records = processedRollbackRecords();
    for (const changes of [
      { kind: "ROLLBACK" }, { kind: "LOSS" }, { status: "PENDING_REFERENCE" },
      { money: Money.from({ amount: "24.99", currency: "BRL" }) },
      { money: Money.from({ amount: "25.00", currency: "USD" }) },
    ]) {
      expect(() => WagerTransactionProcessed.wager({ ...records, reference: { ...records.reference, ...changes } }))
        .toThrow("Wager event records must describe the same processed operation");
    }
    expect(() => WagerTransactionProcessed.wager({ ...records, entry: null }))
      .toThrow("Wager event records must describe the same processed operation");
  });

  test("emits exact cents when reversing a large WIN", () => {
    const records = processedRollbackRecords("WIN", "9007199254740992.01", "9007199254740992.02");
    const processed = WagerTransactionProcessed.wager(records);
    const changed = WalletBalanceChanged.wager(records);
    expect(processed.data.money.amount).toBe("9007199254740992.01");
    expect(processed.data.balance.amount).toBe("0.01");
    expect(changed.data.balanceBefore.amount).toBe("9007199254740992.02");
    expect(changed.data.balanceAfter.amount).toBe("0.01");
  });

  test("pending rollback records only durable acceptance and the initial retry schedule", () => {
    const { reference: _reference, ...records } = rollbackRecords();
    records.transaction.markPendingReference(occurredAt);
    const event = WagerTransactionPendingReference.wager(records);
    expect(event.data).toEqual({
      transactionId: "rollback-1", walletId: "wallet-1", playerId: "player-1", providerId: "provider-a",
      externalTransactionId: "external-1", referenceExternalTransactionId: "external-original",
      roundId: "round-1", gameId: "game-1", kind: "ROLLBACK", status: "PENDING_REFERENCE",
      money: { amount: "25.00", currency: "BRL" }, balance: { amount: "100.00", currency: "BRL" },
      walletVersion: 1, referenceAttempts: 0, nextReferenceAttemptAt: processedAt.toISOString(),
    });
    records.transaction.retryMissingReference(processedAt);
    expect(event.data.referenceAttempts).toBe(0);
    expect(event.data.nextReferenceAttemptAt).toBe(processedAt.toISOString());
    expect(records.wallet.updatedAt).toEqual(occurredAt);
    expect(records.wallet.version).toBe(1);
    expect(Reflect.set(event.data.balance, "amount", "0.00")).toBe(false);
    expect(() => WagerTransactionPendingReference.wager(records)).toThrow("initial deferred transaction");
  });

  test.each([
    "REFERENCE_MISMATCH", "REFERENCE_KIND_MISMATCH", "REFERENCE_NOT_PROCESSED",
    "REFERENCE_AMOUNT_MISMATCH", "REFERENCE_ALREADY_ROLLED_BACK", "REFERENCE_NOT_FOUND",
  ] as const)("emits the terminal %s decision without a balance change", (code) => {
    const { reference: _reference, ...records } = rollbackRecords();
    records.transaction.markPendingReference(occurredAt);
    if (code === "REFERENCE_NOT_FOUND") {
      for (let attempt = 0; attempt < maxReferenceAttempts; attempt += 1) {
        records.transaction.retryMissingReference(records.transaction.nextReferenceAttemptAt!);
      }
    } else records.transaction.reject(code);
    const decisionAt = new Date("2026-10-10T12:05:03.000Z");
    const event = WagerTransactionRejected.wager({ ...records, occurredAt: decisionAt });
    expect(event.data.kind).toBe("ROLLBACK");
    expect(event.data.failureCode).toBe(code);
    expect(event.data.referenceExternalTransactionId).toBe("external-original");
    expect(event.data.referenceTransactionId).toBeUndefined();
    expect(event.data.balance.amount).toBe("100.00");
    expect(event.data.walletVersion).toBe(1);
    expect(event.occurredAt).toEqual(decisionAt);
  });

  test.each(["WIN", "REFUND"])("distinguishes insufficient reversal funds for %s from a BET rejection", (kind) => {
    const records = rollbackRecords(kind, "25.00", "24.99");
    records.transaction.reject("REVERSAL_INSUFFICIENT_FUNDS");
    const event = WagerTransactionRejected.wager(records);
    expect(event.data.failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
    expect(event.data.balance.amount).toBe("24.99");
    expect(event.data.walletVersion).toBe(1);
    expect(event.data.referenceTransactionId).toBeUndefined();
    expect(records.wallet.updatedAt).toEqual(occurredAt);
  });

  test("does not claim reversal insufficiency without a matching debit reference and insufficient balance", () => {
    const records = rollbackRecords("WIN", "25.00", "24.99");
    records.transaction.reject("REVERSAL_INSUFFICIENT_FUNDS");
    const { reference: _reference, ...withoutReference } = records;
    expect(() => WagerTransactionRejected.wager(withoutReference)).toThrow("same balance rule violation");
    for (const changes of [{ kind: "BET" }, { status: "PENDING_REFERENCE" }, { roundId: "other" },
      { money: Money.from({ amount: "24.99", currency: "BRL" }) }]) {
      expect(() => WagerTransactionRejected.wager({ ...records, reference: { ...records.reference, ...changes } }))
        .toThrow("same balance rule violation");
    }
    const sufficient = rollbackRecords("WIN", "25.00", "25.00");
    sufficient.transaction.reject("REVERSAL_INSUFFICIENT_FUNDS");
    expect(() => WagerTransactionRejected.wager(sufficient)).toThrow("same balance rule violation");
  });

  test("overflow rejection applies only when reversing a matching BET credit", () => {
    const records = rollbackRecords("BET", "0.01", "999999999999999999.99");
    records.transaction.reject("BALANCE_LIMIT_EXCEEDED");
    const event = WagerTransactionRejected.wager(records);
    expect(event.data.failureCode).toBe("BALANCE_LIMIT_EXCEEDED");
    expect(event.data.balance.amount).toBe("999999999999999999.99");
    const { reference: _reference, ...withoutReference } = records;
    expect(() => WagerTransactionRejected.wager(withoutReference)).toThrow("same balance rule violation");
    for (const changes of [{ kind: "WIN" }, { kind: "REFUND" }, { status: "REJECTED" }, { walletId: "another" }]) {
      expect(() => WagerTransactionRejected.wager({ ...records, reference: { ...records.reference, ...changes } }))
        .toThrow("same balance rule violation");
    }
    const room = rollbackRecords("BET");
    room.transaction.reject("BALANCE_LIMIT_EXCEEDED");
    expect(() => WagerTransactionRejected.wager(room)).toThrow("same balance rule violation");
  });

  test("rejects malformed persisted rollback states before emitting success or failure", () => {
    const records = processedRollbackRecords();
    const { referenceExternalTransactionId: _externalReference, ...source } = records.transaction;
    const processed = WagerTransaction.rehydrate({
      ...source, createdAt: occurredAt, status: "PROCESSED", processedAt, referenceTransactionId: records.reference.id,
    });
    expect(() => WagerTransactionProcessed.wager({ ...records, transaction: processed })).toThrow("same processed operation");
    for (const failureCode of ["REFERENCE_ALREADY_REFUNDED", "INSUFFICIENT_FUNDS"] as const) {
      const transaction = WagerTransaction.rehydrate({ ...records.transaction, createdAt: occurredAt, status: "REJECTED", failureCode });
      expect(() => WagerTransactionRejected.wager({ ...records, transaction })).toThrow("same balance rule violation");
    }
    const missingReference = WagerTransaction.rehydrate({
      ...source, createdAt: occurredAt, status: "REJECTED", failureCode: "REFERENCE_ALREADY_ROLLED_BACK",
    });
    expect(() => WagerTransactionRejected.wager({ ...records, transaction: missingReference })).toThrow("same balance rule violation");
  });
});
