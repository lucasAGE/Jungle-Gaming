import { describe, expect, test } from "bun:test";
import { sqsWagerInput } from "./sqs-wager-input.js";

const walletId = "0192f291-27dd-7d3f-8071-5f8685deef37";
const business = {
  providerId: "provider-a", externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", walletId,
  roundId: "round-987", gameId: "fortune-chimp", kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

function envelope() {
  return {
    messageId: "message-123", type: "WagerTransactionRequested", occurredAt: "2026-10-10T12:00:00.000Z",
    data: { ...business, idempotencyKey: "provider-a:transaction-123" },
  };
}

describe("SQS wager envelope validation", () => {
  test("extracts the financial request and idempotency key without adding transport fields", () => {
    expect(sqsWagerInput(JSON.stringify(envelope()), walletId)).toEqual({
      messageId: "message-123", walletId, body: business, idempotencyKey: "provider-a:transaction-123",
    });
  });

  test("canonicalizes the wallet used to check the group while leaving business validation to the use case", () => {
    const source = envelope();
    source.data.walletId = walletId.toUpperCase();
    const parsed = sqsWagerInput(JSON.stringify(source), walletId);

    expect(parsed.walletId).toBe(walletId);
    expect(parsed.body.walletId).toBe(walletId.toUpperCase());
  });

  test.each(["REFUND", "ROLLBACK"])("preserves the %s reference for the shared financial use case", (kind) => {
    const data = { ...envelope().data, kind, referenceExternalTransactionId: "bet-1" };
    const parsed = sqsWagerInput(JSON.stringify({ ...envelope(), data }), walletId);
    expect(parsed.body).toEqual({ ...business, kind, referenceExternalTransactionId: "bet-1" });
    expect(parsed.idempotencyKey).toBe(data.idempotencyKey);
  });

  test.each(["", "{", "null", "[]", '"message"', "42"])("rejects malformed or non-object body %s", (body) => {
    expect(() => sqsWagerInput(body, walletId)).toThrow();
  });

  test.each(["messageId", "type", "occurredAt", "data"])("requires envelope field %s", (field) => {
    const source: Record<string, unknown> = envelope();
    delete source[field];
    expect(() => sqsWagerInput(JSON.stringify(source), walletId)).toThrow();
  });

  test("rejects unknown envelope and data fields", () => {
    expect(() => sqsWagerInput(JSON.stringify({ ...envelope(), extra: true }), walletId)).toThrow();
    expect(() => sqsWagerInput(JSON.stringify({
      ...envelope(), data: { ...envelope().data, extra: true },
    }), walletId)).toThrow();
  });

  test.each(["WalletBalanceChanged", "WagerTransactionProcessed", "", null])("rejects unsupported type %s", (type) => {
    expect(() => sqsWagerInput(JSON.stringify({ ...envelope(), type }), walletId)).toThrow();
  });

  test.each([
    "", "invalid-date", "2026-02-30T12:00:00.000Z", "2026-10-10T12:00:00Z",
    "2026-10-10T09:00:00.000-03:00", "2026-10-10", 1_791_633_600_000, null,
  ])("rejects noncanonical occurredAt %s", (occurredAt) => {
    expect(() => sqsWagerInput(JSON.stringify({ ...envelope(), occurredAt }), walletId)).toThrow();
  });

  test.each(["", "with space", "trailing\n", "a".repeat(256), null])("rejects invalid message identity %s", (messageId) => {
    expect(() => sqsWagerInput(JSON.stringify({ ...envelope(), messageId }), walletId)).toThrow();
  });

  test.each([undefined, "", "opening:wallet-1", "with space", "a".repeat(256)])(
    "requires a valid explicit idempotency key %s", (idempotencyKey) => {
      expect(() => sqsWagerInput(JSON.stringify({
        ...envelope(), data: { ...business, idempotencyKey },
      }), walletId)).toThrow();
    },
  );

  test.each([{ data: null }, { data: [] }, { data: "request" }])("rejects non-object data %j", ({ data }) => {
    expect(() => sqsWagerInput(JSON.stringify({ ...envelope(), data }), walletId)).toThrow();
  });

  test.each([undefined, "another-wallet", walletId.toUpperCase()])(
    "requires the FIFO group to equal the canonical wallet UUID: %s", (group) => {
      expect(() => sqsWagerInput(JSON.stringify(envelope()), group))
        .toThrow("MessageGroupId must match the canonical wallet UUID");
    },
  );

  test("rejects a non-UUID wallet even if the FIFO group repeats that value", () => {
    const source = envelope();
    source.data.walletId = "wallet-1";
    expect(() => sqsWagerInput(JSON.stringify(source), "wallet-1")).toThrow("Expected a UUID");
  });
});
