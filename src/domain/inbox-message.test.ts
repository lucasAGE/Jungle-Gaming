import { describe, expect, test } from "bun:test";
import { DomainError } from "./domain-error.js";
import { InboxMessage } from "./inbox-message.js";

const receivedAt = new Date("2026-10-10T12:00:00.000Z");
const processedAt = new Date("2026-10-10T12:00:01.000Z");

function props() {
  return {
    messageId: "message-1", consumerName: "wager-transactions",
    payloadHash: "a".repeat(64), receivedAt: new Date(receivedAt),
  };
}

describe("InboxMessage", () => {
  test("receives an unprocessed message with its consumer and payload identity", () => {
    const source = props();
    const message = InboxMessage.receive(source);

    expect(message.messageId).toBe(source.messageId);
    expect(message.consumerName).toBe(source.consumerName);
    expect(message.payloadHash).toBe(source.payloadHash);
    expect(message.receivedAt).toEqual(receivedAt);
    expect(message.processedAt).toBeUndefined();
    expect(message.transactionId).toBeUndefined();
    expect(message.isProcessed()).toBe(false);
  });

  test("records the transaction whose committed result acknowledges the message", () => {
    const message = InboxMessage.receive(props());
    message.markProcessed("transaction-1", processedAt);

    expect(message.isProcessed()).toBe(true);
    expect(message.transactionId).toBe("transaction-1");
    expect(message.processedAt).toEqual(processedAt);
    expect(message.receivedAt).toEqual(receivedAt);
  });

  test("refuses repeated processing without replacing the original transaction or timestamp", () => {
    const message = InboxMessage.receive(props());
    message.markProcessed("transaction-1", processedAt);

    expect(() => message.markProcessed("transaction-2", new Date(processedAt.getTime() + 1_000)))
      .toThrow(new DomainError("INVALID_INBOX_STATE", "A processed inbox message cannot change state"));
    expect(message.isProcessed()).toBe(true);
    expect(message.transactionId).toBe("transaction-1");
    expect(message.processedAt).toEqual(processedAt);
  });

  test("distinguishes repeated content from a conflicting payload", () => {
    const message = InboxMessage.receive(props());

    expect(message.matchesPayload("a".repeat(64))).toBe(true);
    expect(message.matchesPayload("b".repeat(64))).toBe(false);
    message.markProcessed("transaction-1", processedAt);
    expect(message.matchesPayload("a".repeat(64))).toBe(true);
    expect(message.matchesPayload("b".repeat(64))).toBe(false);
  });

  test("rehydrates pending state without applying a processing transition", () => {
    const message = InboxMessage.rehydrate(props());

    expect(message.isProcessed()).toBe(false);
    expect(message.transactionId).toBeUndefined();
    expect(message.processedAt).toBeUndefined();
    message.markProcessed("transaction-1", processedAt);
    expect(message.isProcessed()).toBe(true);
  });

  test("rehydrates completed state without reopening it", () => {
    const message = InboxMessage.rehydrate({ ...props(), transactionId: "transaction-1", processedAt });

    expect(message.isProcessed()).toBe(true);
    expect(message.transactionId).toBe("transaction-1");
    expect(message.processedAt).toEqual(processedAt);
    expect(() => message.markProcessed("transaction-2", new Date()))
      .toThrow("A processed inbox message cannot change state");
  });

  test("protects identity and state from direct assignment while permitting explicit processing", () => {
    const message = InboxMessage.receive(props());

    expect(Reflect.set(message, "messageId", "message-2")).toBe(false);
    expect(Reflect.set(message, "consumerName", "another-consumer")).toBe(false);
    expect(Reflect.set(message, "payloadHash", "b".repeat(64))).toBe(false);
    expect(Reflect.set(message, "processedAt", processedAt)).toBe(false);
    expect(Reflect.set(message, "transactionId", "transaction-2")).toBe(false);
    expect(message.isProcessed()).toBe(false);
    message.markProcessed("transaction-1", processedAt);
    expect(message.transactionId).toBe("transaction-1");
  });

  test("copies timestamps supplied to construction, processing and rehydration", () => {
    const source = props();
    const at = new Date(processedAt);
    const message = InboxMessage.receive(source);
    source.receivedAt.setTime(0);
    message.receivedAt.setTime(0);
    message.markProcessed("transaction-1", at);
    at.setTime(0);
    message.processedAt?.setTime(0);

    expect(message.receivedAt).toEqual(receivedAt);
    expect(message.processedAt).toEqual(processedAt);

    const persisted = { ...props(), transactionId: "transaction-1", processedAt: new Date(processedAt) };
    const restored = InboxMessage.rehydrate(persisted);
    persisted.receivedAt.setTime(0);
    persisted.processedAt.setTime(0);
    restored.receivedAt.setTime(0);
    restored.processedAt?.setTime(0);

    expect(restored.receivedAt).toEqual(receivedAt);
    expect(restored.processedAt).toEqual(processedAt);
  });
});
