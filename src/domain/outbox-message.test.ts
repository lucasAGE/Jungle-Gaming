import { describe, expect, test } from "bun:test";
import { DomainError } from "./domain-error.js";
import { WalletBalanceChanged } from "./integration-event.js";
import { Money } from "./money.js";
import { OpeningTransaction } from "./opening-transaction.js";
import { OutboxMessage, type OutboxMessageState } from "./outbox-message.js";
import { Wallet } from "./wallet.js";
import { WalletLedgerEntry } from "./wallet-ledger-entry.js";

const occurredAt = new Date("2026-10-10T12:00:00.000Z");

function event() {
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
  return WalletBalanceChanged.opening({
    eventId: "event-1", correlationId: "request-1", transaction, wallet, entry,
  });
}

function persistedState(): OutboxMessageState {
  const source = event();
  return {
    id: source.eventId, aggregateId: source.aggregateId, eventType: source.eventType,
    payload: { ...source.toJSON() }, occurredAt: source.occurredAt, attempts: 0,
  };
}

describe("OutboxMessage", () => {
  test("enqueues the complete original envelope, immediately eligible for publication", () => {
    const source = event();
    const message = OutboxMessage.enqueue(source);

    expect(message.id).toBe(source.eventId);
    expect(message.aggregateId).toBe(source.aggregateId);
    expect(message.eventType).toBe(source.eventType);
    expect(message.occurredAt).toEqual(source.occurredAt);
    expect(message.payload).toEqual({ ...source.toJSON() });
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toBeUndefined();
    expect(message.publishedAt).toBeUndefined();
    expect(message.isPending()).toBe(true);
    expect(message.isDue(occurredAt)).toBe(true);
  });

  test("retries indefinitely with exponential backoff capped at sixty seconds", () => {
    const message = OutboxMessage.enqueue(event());
    const payload = message.payload;
    let now = occurredAt;

    for (const [index, delayMs] of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000].entries()) {
      message.scheduleRetry(now);
      const dueAt = new Date(now.getTime() + delayMs);

      expect(message.attempts).toBe(index + 1);
      expect(message.nextAttemptAt).toEqual(dueAt);
      expect(message.isPending()).toBe(true);
      expect(message.publishedAt).toBeUndefined();
      expect(message.isDue(new Date(dueAt.getTime() - 1))).toBe(false);
      expect(message.isDue(dueAt)).toBe(true);
      expect(message.isDue(new Date(dueAt.getTime() + 1))).toBe(true);
      now = dueAt;
    }

    expect(message.payload).toEqual(payload);
    expect(message.occurredAt).toEqual(occurredAt);
    expect(message.id).toBe("event-1");
  });

  test("keeps the retry date finite after a large persisted attempt count", () => {
    const message = OutboxMessage.rehydrate({ ...persistedState(), attempts: 1_000_000 });
    message.scheduleRetry(occurredAt);

    expect(message.attempts).toBe(1_000_001);
    expect(message.nextAttemptAt).toEqual(new Date(occurredAt.getTime() + 60_000));
    expect(message.isPending()).toBe(true);
  });

  test("publication clears the retry deadline but preserves failed-attempt history", () => {
    const message = OutboxMessage.enqueue(event());
    message.scheduleRetry(occurredAt);
    const publishedAt = new Date(occurredAt.getTime() + 1_000);
    message.markPublished(publishedAt);

    expect(message.publishedAt).toEqual(publishedAt);
    expect(message.nextAttemptAt).toBeUndefined();
    expect(message.attempts).toBe(1);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(new Date(occurredAt.getTime() + 1_000_000))).toBe(false);
  });

  test("successful first publication records no failed attempts", () => {
    const message = OutboxMessage.enqueue(event());
    message.markPublished(occurredAt);

    expect(message.attempts).toBe(0);
    expect(message.publishedAt).toEqual(occurredAt);
    expect(message.isPending()).toBe(false);
  });

  test("refuses retries and repeated publication after a terminal transition", () => {
    const message = OutboxMessage.enqueue(event());
    message.markPublished(occurredAt);
    const later = new Date(occurredAt.getTime() + 1_000);
    const error = new DomainError("INVALID_OUTBOX_STATE", "A published outbox message cannot change state");

    expect(() => message.scheduleRetry(later)).toThrow(error);
    expect(() => message.markPublished(later)).toThrow(error);
    expect(message.publishedAt).toEqual(occurredAt);
    expect(message.nextAttemptAt).toBeUndefined();
    expect(message.attempts).toBe(0);
  });

  test("rehydrates a pending retry without restarting or advancing its backoff", () => {
    const nextAttemptAt = new Date(occurredAt.getTime() + 32_000);
    const message = OutboxMessage.rehydrate({ ...persistedState(), attempts: 6, nextAttemptAt });

    expect(message.attempts).toBe(6);
    expect(message.nextAttemptAt).toEqual(nextAttemptAt);
    expect(message.isDue(occurredAt)).toBe(false);
    expect(message.isDue(nextAttemptAt)).toBe(true);
    message.scheduleRetry(nextAttemptAt);
    expect(message.attempts).toBe(7);
    expect(message.nextAttemptAt).toEqual(new Date(nextAttemptAt.getTime() + 60_000));
  });

  test("rehydrates published state exactly without replaying a transition", () => {
    const nextAttemptAt = new Date(occurredAt.getTime() + 1_000);
    const publishedAt = new Date(occurredAt.getTime() + 2_000);
    const message = OutboxMessage.rehydrate({
      ...persistedState(), attempts: 3, nextAttemptAt, publishedAt,
    });

    expect(message.attempts).toBe(3);
    expect(message.nextAttemptAt).toEqual(nextAttemptAt);
    expect(message.publishedAt).toEqual(publishedAt);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(new Date(occurredAt.getTime() + 1_000_000))).toBe(false);
    expect(() => message.scheduleRetry(publishedAt)).toThrow("A published outbox message cannot change state");
    expect(() => message.markPublished(publishedAt)).toThrow("A published outbox message cannot change state");
  });

  test("protects the saved envelope from nested mutations through source and returned payloads", () => {
    const source = event().toJSON();
    const message = OutboxMessage.rehydrate({ ...persistedState(), payload: { ...source } });
    const snapshot = message.payload;
    const returnedData = snapshot["data"] as typeof source.data;
    Reflect.set(source.data.money, "amount", "999.00");
    Reflect.set(returnedData.money, "amount", "888.00");
    Reflect.set(snapshot, "eventId", "another-event");

    expect(message.payload).toEqual({ ...event().toJSON() });
    expect(message.id).toBe("event-1");
  });

  test("protects identity and delivery state from direct assignment", () => {
    const message = OutboxMessage.enqueue(event());

    expect(Reflect.set(message, "id", "different-id")).toBe(false);
    expect(Reflect.set(message, "aggregateId", "different-wallet")).toBe(false);
    expect(Reflect.set(message, "eventType", "DifferentEvent")).toBe(false);
    expect(Reflect.set(message, "payload", {})).toBe(false);
    expect(Reflect.set(message, "attempts", 9)).toBe(false);
    expect(Reflect.set(message, "publishedAt", occurredAt)).toBe(false);
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    message.scheduleRetry(occurredAt);
    expect(message.attempts).toBe(1);
  });

  test("copies every persisted timestamp on both construction and access", () => {
    const source = persistedState();
    const nextAttemptAt = new Date(occurredAt.getTime() + 1_000);
    const publishedAt = new Date(occurredAt.getTime() + 2_000);
    const message = OutboxMessage.rehydrate({ ...source, nextAttemptAt, publishedAt });
    source.occurredAt.setTime(0);
    nextAttemptAt.setTime(0);
    publishedAt.setTime(0);
    message.occurredAt.setTime(0);
    message.nextAttemptAt?.setTime(0);
    message.publishedAt?.setTime(0);

    expect(message.occurredAt).toEqual(occurredAt);
    expect(message.nextAttemptAt).toEqual(new Date(occurredAt.getTime() + 1_000));
    expect(message.publishedAt).toEqual(new Date(occurredAt.getTime() + 2_000));
  });

  test("copies timestamps supplied to retry and publication transitions", () => {
    const message = OutboxMessage.enqueue(event());
    const retryAt = new Date(occurredAt);
    message.scheduleRetry(retryAt);
    retryAt.setTime(0);
    message.nextAttemptAt?.setTime(0);
    expect(message.nextAttemptAt).toEqual(new Date(occurredAt.getTime() + 1_000));

    const publishedAt = new Date(occurredAt.getTime() + 1_000);
    message.markPublished(publishedAt);
    publishedAt.setTime(0);
    message.publishedAt?.setTime(0);
    expect(message.publishedAt).toEqual(new Date(occurredAt.getTime() + 1_000));
  });
});
