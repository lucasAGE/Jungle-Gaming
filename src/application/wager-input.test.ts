import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Money, MoneyError } from "../domain/money.js";
import { ApplicationError } from "./application-error.js";
import { idempotencyKeyInput, identifierInput, wagerInput, wagerPayloadHash } from "./wager-input.js";

const playerId = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";
const walletId = "0192f291-27dd-7d3f-8071-5f8685deef37";

function payload() {
  return {
    providerId: "provider-a", externalTransactionId: "transaction-123", playerId, walletId,
    roundId: "round-987", gameId: "fortune-chimp", kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
  };
}

describe("shared wager input validation", () => {
  test("keeps exact money and business identifiers while normalizing UUID case", () => {
    const input = wagerInput({
      ...payload(), playerId: playerId.toUpperCase(), walletId: walletId.toUpperCase(),
      money: { amount: "9007199254740993.01", currency: "BRL" },
    });

    expect(input.playerId).toBe(playerId);
    expect(input.walletId).toBe(walletId);
    expect(input.providerId).toBe("provider-a");
    expect(input.externalTransactionId).toBe("transaction-123");
    expect(input.roundId).toBe("round-987");
    expect(input.gameId).toBe("fortune-chimp");
    expect(input.kind).toBe("BET");
    expect(input.money).toBeInstanceOf(Money);
    expect(input.money.toJSON()).toEqual({ amount: "9007199254740993.01", currency: "BRL" });
  });

  test.each([null, undefined, [], "BET", 1, true].map((value) => ({ value })))("rejects a non-object request %j", ({ value }) => {
    expect(() => wagerInput(value)).toThrow(ApplicationError);
  });

  test.each([
    "providerId", "externalTransactionId", "playerId", "walletId", "roundId", "gameId", "kind", "money",
  ])("requires business field %s", (field) => {
    const body = payload();
    Reflect.deleteProperty(body, field);
    expect(() => wagerInput(body)).toThrow(ApplicationError);
  });

  test.each(["OPENING", "UNKNOWN", "bet", "BET ", null])(
    "rejects unsupported kind %j", (kind) => {
      expect(() => wagerInput({ ...payload(), kind })).toThrow(
        new ApplicationError("INVALID_INPUT", "Only BET, WIN, LOSS, REFUND and ROLLBACK are supported"),
      );
    },
  );

  test.each([
    { ...payload(), idempotencyKey: "body-key" },
    { ...payload(), messageId: "message-1" },
    { ...payload(), money: { amount: "25.00", currency: "BRL", extra: true } },
  ])("rejects unknown body or nested money fields %j", (body) => {
    expect(() => wagerInput(body)).toThrow(new ApplicationError("INVALID_INPUT", "Unexpected input field"));
  });

  test.each(["playerId", "walletId"])("rejects an invalid UUID in %s", (field) => {
    expect(() => wagerInput({ ...payload(), [field]: "invalid" })).toThrow(ApplicationError);
    expect(() => wagerInput({ ...payload(), [field]: `${playerId}\n` })).toThrow(ApplicationError);
  });

  test.each(["providerId", "externalTransactionId", "roundId", "gameId"])(
    "validates identifier %s without silently trimming it", (field) => {
      expect(() => wagerInput({ ...payload(), [field]: " leading-space" })).toThrow(ApplicationError);
      expect(() => wagerInput({ ...payload(), [field]: "" })).toThrow(ApplicationError);
    },
  );

  test("rejects zero as an invalid BET before creating a transaction", () => {
    expect(() => wagerInput({ ...payload(), money: { amount: "0.00", currency: "BRL" } })).toThrow(
      new ApplicationError("INVALID_INPUT", "BET requires a positive amount"),
    );
  });

  test.each(["-0.01", "25", "25.0", "25.000", "25.001", "2.5e1", "NaN", "Infinity", "", "025.00"])(
    "rejects invalid decimal amount %j without rounding", (amount) => {
      expect(() => wagerInput({ ...payload(), money: { amount, currency: "BRL" } })).toThrow(MoneyError);
    },
  );

  test.each([
    { kind: "WIN", amount: "0.01" },
    { kind: "WIN", amount: "999999999999999999.99" },
    { kind: "LOSS", amount: "0.00" },
  ])("accepts $kind with exact amount $amount", ({ kind, amount }) => {
    const input = wagerInput({ ...payload(), kind, money: { amount, currency: "BRL" } });
    expect(input.kind).toBe(kind);
    expect(input.money.toJSON()).toEqual({ amount, currency: "BRL" });
  });

  test.each([
    { kind: "WIN", amount: "0.00" },
    { kind: "LOSS", amount: "0.01" },
    { kind: "LOSS", amount: "999999999999999999.99" },
  ])("rejects $kind with amount $amount before processing", ({ kind, amount }) => {
    expect(() => wagerInput({ ...payload(), kind, money: { amount, currency: "BRL" } }))
      .toThrow(ApplicationError);
  });

  test.each(["WIN", "LOSS", "REFUND", "ROLLBACK"])("rejects malformed money and disabled currency for %s", (kind) => {
    for (const amount of ["-0.01", "0", "0.0", "0.001", "1e2"]) {
      expect(() => wagerInput({ ...payload(), kind, money: { amount, currency: "BRL" } })).toThrow(MoneyError);
    }
    expect(() => wagerInput({ ...payload(), kind, money: { amount: "0.00", currency: "USD" } }))
      .toThrow(new ApplicationError("UNSUPPORTED_CURRENCY", "Only BRL is enabled"));
  });

  test("accepts a WIN reference as a business field and includes it in the payload hash", () => {
    const win = { ...payload(), kind: "WIN" };
    const referenced = wagerInput({ ...win, referenceExternalTransactionId: "bet-1" });
    expect(referenced.referenceExternalTransactionId).toBe("bet-1");
    expect(wagerPayloadHash(referenced)).not.toBe(wagerPayloadHash(wagerInput(win)));
    expect(wagerPayloadHash(referenced)).not.toBe(wagerPayloadHash(wagerInput({ ...win, referenceExternalTransactionId: "bet-2" })));
  });

  test.each(["BET", "LOSS"])("rejects a reference on %s", (kind) => {
    expect(() => wagerInput({ ...payload(), kind, money: { amount: kind === "LOSS" ? "0.00" : "25.00", currency: "BRL" },
      referenceExternalTransactionId: "bet-1" }))
      .toThrow(new ApplicationError("INVALID_INPUT", "Only WIN, REFUND and ROLLBACK accept a reference"));
  });

  test.each([null, "", "with space", "transaction-123"])("rejects malformed or self WIN reference %s", (referenceExternalTransactionId) => {
    expect(() => wagerInput({ ...payload(), kind: "WIN", referenceExternalTransactionId })).toThrow(ApplicationError);
  });

  test.each(["REFUND", "ROLLBACK"])("accepts %s with an explicit reference included in its canonical payload", (kind) => {
    const body = { ...payload(), kind, referenceExternalTransactionId: "bet-1" };
    const input = wagerInput(body);
    expect(input.kind).toBe(kind);
    expect(input.money.toJSON()).toEqual(body.money);
    expect(input.referenceExternalTransactionId).toBe("bet-1");
    expect(wagerPayloadHash(input)).not.toBe(wagerPayloadHash(wagerInput({ ...body, referenceExternalTransactionId: "bet-2" })));
    expect(wagerPayloadHash(input)).not.toBe(wagerPayloadHash(wagerInput({ ...body, kind: "WIN" })));
  });

  test.each([undefined, null, "", "with space", "transaction-123"])("requires a valid non-self REFUND reference %s", (referenceExternalTransactionId) => {
    const body = { ...payload(), kind: "REFUND",
      ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }) };
    expect(() => wagerInput(body)).toThrow(ApplicationError);
  });

  test.each([undefined, null, "", "with space", "transaction-123"])("requires a valid non-self ROLLBACK reference %s", (referenceExternalTransactionId) => {
    const body = { ...payload(), kind: "ROLLBACK",
      ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }) };
    expect(() => wagerInput(body)).toThrow(ApplicationError);
  });

  test.each(["REFUND", "ROLLBACK"])("rejects zero %s before resolving its reference", (kind) => {
    expect(() => wagerInput({ ...payload(), kind, referenceExternalTransactionId: "bet-1",
      money: { amount: "0.00", currency: "BRL" } }))
      .toThrow(new ApplicationError("INVALID_INPUT", `${kind} requires a positive amount`));
  });

  test.each([
    null, [], {}, { amount: "25.00" }, { currency: "BRL" }, { amount: 25, currency: "BRL" },
  ].map((money) => ({ money })))("rejects invalid money structure %j", ({ money }) => {
    expect(() => wagerInput({ ...payload(), money })).toThrow(ApplicationError);
  });

  test("keeps currency syntax errors distinct from disabled currencies", () => {
    expect(() => wagerInput({ ...payload(), money: { amount: "25.00", currency: "brl" } })).toThrow(MoneyError);
    expect(() => wagerInput({ ...payload(), money: { amount: "25.00", currency: "USD" } })).toThrow(
      new ApplicationError("UNSUPPORTED_CURRENCY", "Only BRL is enabled"),
    );
  });
});

describe("provider and idempotency identifiers", () => {
  test.each(["a", "a".repeat(255), "provider-a:transaction-123", "Case.Sensitive-_~"])(
    "accepts bounded ASCII identifier %s unchanged", (value) => {
      expect(identifierInput(value)).toBe(value);
      expect(idempotencyKeyInput(value)).toBe(value);
    },
  );

  test.each([undefined, null, 123, ["key"], "", "a".repeat(256), "has space", "key\n", "key\t", "chavé", "key\u007f"].map((value) => ({ value })))(
    "rejects missing or invalid identifier and idempotency key %j", ({ value }) => {
      expect(() => identifierInput(value)).toThrow(ApplicationError);
      expect(() => idempotencyKeyInput(value)).toThrow(ApplicationError);
    },
  );

  test.each(["opening:", "opening:wallet-123"])("reserves internal opening key %s", (key) => {
    expect(identifierInput(key)).toBe(key);
    expect(() => idempotencyKeyInput(key)).toThrow(
      new ApplicationError("INVALID_INPUT", "The opening: idempotency namespace is reserved"),
    );
  });

  test("treats identifiers and external idempotency keys as case-sensitive", () => {
    expect(idempotencyKeyInput("Provider:TX-1")).not.toBe(idempotencyKeyInput("provider:tx-1"));
    expect(idempotencyKeyInput("Opening:wallet-123")).toBe("Opening:wallet-123");
  });
});

describe("canonical wager payload hashing", () => {
  test("uses SHA-256 over the documented business JSON with recursively sorted keys", () => {
    const canonical = '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",'
      + '"money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",'
      + '"providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}';
    const expectedHash = createHash("sha256").update(canonical, "utf8").digest("hex");

    expect(wagerPayloadHash(wagerInput(payload()))).toBe(expectedHash);
    expect(expectedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("normalizes UUID case and ignores JSON key order before hashing", () => {
    const original = payload();
    const reordered = {
      money: { currency: "BRL", amount: "25.00" }, kind: original.kind, gameId: original.gameId,
      roundId: original.roundId, walletId: walletId.toUpperCase(), playerId: playerId.toUpperCase(),
      externalTransactionId: original.externalTransactionId, providerId: original.providerId,
    };

    expect(wagerPayloadHash(wagerInput(reordered))).toBe(wagerPayloadHash(wagerInput(original)));
  });

  test("canonicalizes field ordering even when the typed DTO and money serialize in reverse order", () => {
    const input = wagerInput(payload());
    const reverseMoney = new Proxy(input.money, {
      get(target, property, receiver) {
        if (property === "toJSON") return () => ({ currency: "BRL", amount: "25.00" });
        return Reflect.get(target, property, receiver);
      },
    });
    const reordered = {
      money: reverseMoney, kind: input.kind, gameId: input.gameId, roundId: input.roundId,
      walletId: input.walletId, playerId: input.playerId,
      externalTransactionId: input.externalTransactionId, providerId: input.providerId,
    };

    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(input));
  });

  test.each([
    ["providerId", "provider-b"], ["externalTransactionId", "transaction-124"],
    ["playerId", "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2"],
    ["walletId", "0192f291-27dd-7d3f-8071-5f8685deef38"],
    ["roundId", "round-988"], ["gameId", "other-game"], ["kind", "WIN"],
    ["money", Money.from({ amount: "25.01", currency: "BRL" })],
    ["money", Money.from({ amount: "25.00", currency: "USD" })],
  ] as const)("hash changes when business field %s becomes %s", (field, value) => {
    const original = wagerInput(payload());
    const changed = { ...original };
    // Hash coverage also includes fields whose alternative values are not enabled at input yet.
    Reflect.set(changed, field, value);

    expect(wagerPayloadHash(changed)).not.toBe(wagerPayloadHash(original));
  });

  test("does not mutate the validated input or its Money object", () => {
    const input = wagerInput(payload());
    const before = JSON.stringify(input);
    const money = input.money;
    wagerPayloadHash(input);

    expect(input.money).toBe(money);
    expect(JSON.stringify(input)).toBe(before);
  });
});
