import { describe, expect, test } from "bun:test";
import { DomainError } from "./domain-error.js";
import { Money } from "./money.js";
import {
  maxReferenceAttempts, WagerTransaction, type WagerFailureCode, type WagerKind, type WagerReference,
} from "./wager-transaction.js";

const createdAt = new Date("2026-10-10T12:00:00.000Z");
const processedAt = new Date("2026-10-10T12:00:01.000Z");

function props() {
  return {
    id: "bet-1", providerId: "provider-a", externalTransactionId: "external-1",
    idempotencyKey: "provider-a:external-1", payloadHash: "payload-hash",
    walletId: "wallet-1", playerId: "player-1", roundId: "round-1", gameId: "game-1",
    kind: "BET" as const, money: Money.from({ amount: "25.00", currency: "BRL" }), createdAt: new Date(createdAt),
  };
}

describe("permanent infrastructure failure", () => {
  test.each(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"] as const)("fails %s without a financial timestamp or resolved reference", (kind) => {
    const transaction = WagerTransaction.create({ ...props(), kind,
      money: kind === "LOSS" ? Money.zero("BRL") : props().money,
      ...(kind === "REFUND" || kind === "ROLLBACK" ? { referenceExternalTransactionId: "missing" } : {}) });
    transaction.fail("DATABASE_OPERATION_FAILED");
    expect(transaction.status).toBe("FAILED");
    expect(transaction.isTerminal()).toBe(true);
    expect(transaction.failureCode).toBe("DATABASE_OPERATION_FAILED");
    expect(transaction.processedAt).toBeUndefined();
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(() => transaction.markProcessed(processedAt)).toThrow("A terminal transaction cannot change state");
    expect(() => transaction.reject("INSUFFICIENT_FUNDS")).toThrow("A terminal transaction cannot change state");
    expect(() => transaction.fail("DATABASE_OPERATION_FAILED")).toThrow("A terminal transaction cannot change state");
    expect(() => transaction.markPendingReference(processedAt)).toThrow("A terminal transaction cannot change state");
    expect(() => transaction.retryMissingReference(processedAt)).toThrow("A terminal transaction cannot change state");
  });

  test("failure cancels a pending reference schedule while preserving its missing-check count", () => {
    const transaction = WagerTransaction.create({ ...props(), kind: "WIN", referenceExternalTransactionId: "missing" });
    transaction.markPendingReference(createdAt);
    transaction.retryMissingReference(processedAt);
    transaction.fail("DATABASE_OPERATION_FAILED");
    expect(transaction.referenceAttempts).toBe(1);
    expect(transaction.nextReferenceAttemptAt).toBeUndefined();
    expect(transaction.referenceExternalTransactionId).toBe("missing");
  });

  test("business rejection codes cannot masquerade as infrastructure failures", () => {
    const transaction = WagerTransaction.create(props());
    expect(() => transaction.fail("INSUFFICIENT_FUNDS")).toThrow("Only a permanent infrastructure failure can fail a wager");
    expect(transaction.status).toBe("PENDING");
    expect(() => transaction.reject("DATABASE_OPERATION_FAILED")).toThrow("The rejection reason does not apply");
  });

  test.each(["PROCESSED", "REJECTED"] as const)("never overwrites a terminal %s decision", (status) => {
    const transaction = WagerTransaction.create(props());
    if (status === "PROCESSED") transaction.markProcessed(processedAt);
    else transaction.reject("INSUFFICIENT_FUNDS");
    expect(() => transaction.fail("DATABASE_OPERATION_FAILED")).toThrow("A terminal transaction cannot change state");
    expect(transaction.status).toBe(status);
  });
});

describe("WagerTransaction BET", () => {
  test("starts pending with the provider and business identity intact", () => {
    const source = props();
    const transaction = WagerTransaction.create(source);

    expect(transaction.id).toBe(source.id);
    expect(transaction.providerId).toBe(source.providerId);
    expect(transaction.externalTransactionId).toBe(source.externalTransactionId);
    expect(transaction.idempotencyKey).toBe(source.idempotencyKey);
    expect(transaction.payloadHash).toBe(source.payloadHash);
    expect(transaction.walletId).toBe(source.walletId);
    expect(transaction.playerId).toBe(source.playerId);
    expect(transaction.roundId).toBe(source.roundId);
    expect(transaction.gameId).toBe(source.gameId);
    expect(transaction.money).toBe(source.money);
    expect(transaction.kind).toBe("BET");
    expect(transaction.status).toBe("PENDING");
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.failureCode).toBeUndefined();
    expect(transaction.processedAt).toBeUndefined();
  });

  test.each([Money.zero("BRL"), Money.from({ amount: "0.01", currency: "BRL" }).negate()])(
    "rejects non-positive amount %s", (money) => {
      expect(() => WagerTransaction.create({ ...props(), money }))
        .toThrow(new DomainError("BET_REQUIRES_POSITIVE_AMOUNT", "A bet requires a positive amount"));
    },
  );

  test("records a successful terminal transition and its timestamp", () => {
    const transaction = WagerTransaction.create(props());
    transaction.markProcessed(processedAt);

    expect(transaction.status).toBe("PROCESSED");
    expect(transaction.isTerminal()).toBe(true);
    expect(transaction.processedAt).toEqual(processedAt);
    expect(transaction.failureCode).toBeUndefined();
  });

  test("records a rejected terminal transition without a processing timestamp", () => {
    const transaction = WagerTransaction.create(props());
    transaction.reject("INSUFFICIENT_FUNDS");

    expect(transaction.status).toBe("REJECTED");
    expect(transaction.isTerminal()).toBe(true);
    expect(transaction.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(transaction.processedAt).toBeUndefined();
  });

  test.each(["PROCESSED", "REJECTED"] as const)("refuses every transition from %s", (status) => {
    const transaction = WagerTransaction.create(props());
    if (status === "PROCESSED") transaction.markProcessed(processedAt);
    else transaction.reject("INSUFFICIENT_FUNDS");

    const error = new DomainError("INVALID_TRANSACTION_STATE", "A terminal transaction cannot change state");
    expect(() => transaction.markProcessed(new Date())).toThrow(error);
    expect(() => transaction.reject("INSUFFICIENT_FUNDS")).toThrow(error);
    expect(transaction.status).toBe(status);
    expect(transaction.processedAt).toEqual(status === "PROCESSED" ? processedAt : undefined);
    expect(transaction.failureCode).toBe(status === "REJECTED" ? "INSUFFICIENT_FUNDS" : undefined);
  });

  test("matches the persisted payload hash exactly", () => {
    const transaction = WagerTransaction.create(props());

    expect(transaction.matchesPayload("payload-hash")).toBe(true);
    expect(transaction.matchesPayload("other-payload-hash")).toBe(false);
  });

  test("rehydrates terminal state without applying the bet again", () => {
    const processed = WagerTransaction.rehydrate({ ...props(), status: "PROCESSED", processedAt });
    const rejected = WagerTransaction.rehydrate({
      ...props(), status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS",
    });

    expect(processed.status).toBe("PROCESSED");
    expect(processed.processedAt).toEqual(processedAt);
    expect(processed.createdAt).toEqual(createdAt);
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(() => processed.markProcessed(processedAt)).toThrow("A terminal transaction cannot change state");
    expect(() => rejected.markProcessed(processedAt)).toThrow("A terminal transaction cannot change state");
  });

  test("protects public fields and mutable timestamps while allowing explicit transitions", () => {
    const source = props();
    const transaction = WagerTransaction.create(source);
    const at = new Date(processedAt);
    source.createdAt.setTime(0);
    transaction.createdAt.setTime(0);
    transaction.markProcessed(at);
    at.setTime(0);
    transaction.processedAt?.setTime(0);

    expect(Reflect.set(transaction, "idempotencyKey", "different-key")).toBe(false);
    expect(Reflect.set(transaction, "status", "REJECTED")).toBe(false);
    expect(Reflect.set(transaction, "money", Money.zero("BRL"))).toBe(false);
    expect(transaction.createdAt).toEqual(createdAt);
    expect(transaction.processedAt).toEqual(processedAt);
    expect(transaction.status).toBe("PROCESSED");
    expect(transaction.idempotencyKey).toBe(source.idempotencyKey);
  });
});

function referencedWinProps() {
  return { ...props(), kind: "WIN" as const, referenceExternalTransactionId: "external-bet" };
}

function reference(): WagerReference {
  return {
    id: "referenced-bet", providerId: "provider-a", playerId: "player-1", walletId: "wallet-1",
    currency: "BRL", money: props().money, roundId: "round-1", kind: "BET", status: "PROCESSED",
  };
}

describe("WIN reference state", () => {
  test.each(["BET", "LOSS"] as const)("forbids a reference on %s", (kind) => {
    expect(() => WagerTransaction.create({
      ...referencedWinProps(), kind, money: kind === "LOSS" ? Money.zero("BRL") : props().money,
    })).toThrow(new DomainError("REFERENCE_NOT_ALLOWED", "Only a win, refund or rollback may reference another transaction"));
  });

  test("forbids a self reference", () => {
    expect(() => WagerTransaction.create({
      ...referencedWinProps(), referenceExternalTransactionId: props().externalTransactionId,
    })).toThrow(new DomainError("SELF_REFERENCE", "A transaction cannot reference itself"));
  });

  test("unreferenced operations have no reference state and cannot wait for a reference", () => {
    const transaction = WagerTransaction.create({ ...props(), kind: "WIN" });
    expect(transaction.referenceExternalTransactionId).toBeUndefined();
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(transaction.referenceAttempts).toBe(0);
    expect(transaction.nextReferenceAttemptAt).toBeUndefined();
    expect(() => transaction.markPendingReference(createdAt)).toThrow("Only a new referenced transaction can await a reference");
    expect(() => transaction.markProcessed(processedAt, "bet-2"))
      .toThrow("An unreferenced transaction cannot have a resolved reference");
    expect(transaction.status).toBe("PENDING");
    transaction.markProcessed(processedAt);
    expect(transaction.status).toBe("PROCESSED");
  });

  test("defers a missing reference without consuming the first retry", () => {
    const transaction = WagerTransaction.create(referencedWinProps());
    const at = new Date(createdAt);
    transaction.markPendingReference(at);
    at.setTime(0);
    transaction.nextReferenceAttemptAt?.setTime(0);
    expect(transaction.status).toBe("PENDING_REFERENCE");
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.referenceAttempts).toBe(0);
    expect(transaction.nextReferenceAttemptAt).toEqual(processedAt);
    expect(transaction.processedAt).toBeUndefined();
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(Reflect.set(transaction, "referenceExternalTransactionId", "other-bet")).toBe(false);
    expect(() => transaction.markPendingReference(createdAt)).toThrow("Only a new referenced transaction can await a reference");
  });

  test("persists exponential retry delays and rejects after the tenth missing lookup", () => {
    const transaction = WagerTransaction.create(referencedWinProps());
    transaction.markPendingReference(createdAt);
    const expectedDelays = [2, 4, 8, 16, 32, 60, 60, 60, 60];
    let at = transaction.nextReferenceAttemptAt!;
    for (const [index, seconds] of expectedDelays.entries()) {
      transaction.retryMissingReference(at);
      expect(transaction.referenceAttempts).toBe(index + 1);
      expect(transaction.status).toBe("PENDING_REFERENCE");
      expect(transaction.nextReferenceAttemptAt).toEqual(new Date(at.getTime() + seconds * 1_000));
      at = transaction.nextReferenceAttemptAt!;
    }
    expect(at.getTime() - createdAt.getTime()).toBe(303_000);
    transaction.retryMissingReference(at);
    expect(transaction.referenceAttempts).toBe(maxReferenceAttempts);
    expect(transaction.status).toBe("REJECTED");
    expect(transaction.failureCode).toBe("REFERENCE_NOT_FOUND");
    expect(transaction.nextReferenceAttemptAt).toBeUndefined();
    expect(transaction.processedAt).toBeUndefined();
    expect(() => transaction.retryMissingReference(at)).toThrow("A terminal transaction cannot change state");
  });

  test("reconstructs the retry budget and defensive timestamp after restart", () => {
    const nextReferenceAttemptAt = new Date(processedAt);
    const transaction = WagerTransaction.rehydrate({
      ...referencedWinProps(), status: "PENDING_REFERENCE", referenceAttempts: 9, nextReferenceAttemptAt,
    });
    nextReferenceAttemptAt.setTime(0);
    transaction.nextReferenceAttemptAt?.setTime(0);
    expect(transaction.nextReferenceAttemptAt).toEqual(processedAt);
    expect(transaction.referenceAttempts).toBe(9);
    transaction.retryMissingReference(processedAt);
    expect(transaction.failureCode).toBe("REFERENCE_NOT_FOUND");
    expect(transaction.referenceAttempts).toBe(10);
  });

  test.each([false, true])("requires a resolved reference before processing (deferred=%s)", (deferred) => {
    const transaction = WagerTransaction.create(referencedWinProps());
    if (deferred) transaction.markPendingReference(createdAt);
    for (const id of [undefined, "", transaction.id]) {
      expect(() => transaction.markProcessed(processedAt, id))
        .toThrow("A referenced transaction requires a distinct resolved transaction");
    }
    expect(transaction.status).toBe(deferred ? "PENDING_REFERENCE" : "PENDING");
    transaction.markProcessed(processedAt, "referenced-bet");
    expect(transaction.status).toBe("PROCESSED");
    expect(transaction.referenceTransactionId).toBe("referenced-bet");
    expect(transaction.nextReferenceAttemptAt).toBeUndefined();
    expect(transaction.processedAt).toEqual(processedAt);
  });

  test("reconstructs a resolved reference without reapplying transitions", () => {
    const transaction = WagerTransaction.rehydrate({
      ...referencedWinProps(), status: "PROCESSED", referenceTransactionId: "referenced-bet", processedAt,
      referenceAttempts: 3,
    });
    expect(transaction.referenceTransactionId).toBe("referenced-bet");
    expect(transaction.referenceAttempts).toBe(3);
    expect(transaction.processedAt).toEqual(processedAt);
  });

  test("cannot retry an operation that has not entered pending-reference state", () => {
    const transaction = WagerTransaction.create(referencedWinProps());
    expect(() => transaction.retryMissingReference(createdAt)).toThrow("Only a pending reference can be retried");
    expect(transaction.referenceAttempts).toBe(0);
  });

  const referenceCodes = [
    "REFERENCE_MISMATCH", "REFERENCE_KIND_MISMATCH", "REFERENCE_NOT_PROCESSED", "REFERENCE_NOT_FOUND",
  ] as const;
  test.each([...referenceCodes])("persists terminal %s from pending-reference state and clears the schedule", (code) => {
    const transaction = WagerTransaction.create(referencedWinProps());
    transaction.markPendingReference(createdAt);
    transaction.retryMissingReference(processedAt);
    if (code === "REFERENCE_NOT_FOUND") {
      for (let attempt = 1; attempt < maxReferenceAttempts; attempt += 1) {
        transaction.retryMissingReference(transaction.nextReferenceAttemptAt!);
      }
    } else transaction.reject(code);
    expect(transaction.status).toBe("REJECTED");
    expect(transaction.failureCode).toBe(code);
    expect(transaction.referenceAttempts).toBe(code === "REFERENCE_NOT_FOUND" ? maxReferenceAttempts : 1);
    expect(transaction.nextReferenceAttemptAt).toBeUndefined();
    expect(() => transaction.markPendingReference(createdAt)).toThrow("A terminal transaction cannot change state");
    expect(() => transaction.markProcessed(processedAt, "referenced-bet")).toThrow("A terminal transaction cannot change state");
    expect(() => transaction.retryMissingReference(processedAt)).toThrow("A terminal transaction cannot change state");
    expect(() => transaction.reject(code)).toThrow("A terminal transaction cannot change state");
  });

  test("cannot reject a missing reference before exhausting the durable retry budget", () => {
    const transaction = WagerTransaction.create(referencedWinProps());
    expect(() => transaction.reject("REFERENCE_NOT_FOUND"))
      .toThrow("The rejection reason does not apply to this transaction kind");
    expect(transaction.status).toBe("PENDING");
    expect(transaction.failureCode).toBeUndefined();

    transaction.markPendingReference(createdAt);
    for (let attempt = 0; attempt < maxReferenceAttempts; attempt += 1) {
      const due = transaction.nextReferenceAttemptAt;
      expect(() => transaction.reject("REFERENCE_NOT_FOUND"))
        .toThrow("The rejection reason does not apply to this transaction kind");
      expect(transaction.status).toBe("PENDING_REFERENCE");
      expect(transaction.failureCode).toBeUndefined();
      expect(transaction.nextReferenceAttemptAt).toEqual(due);
      expect(transaction.referenceAttempts).toBe(attempt);
      transaction.retryMissingReference(due!);
    }
    expect(transaction.status).toBe("REJECTED");
    expect(transaction.failureCode).toBe("REFERENCE_NOT_FOUND");
  });

  test.each([...referenceCodes])("forbids %s on an unreferenced WIN", (code) => {
    const transaction = WagerTransaction.create({ ...props(), kind: "WIN" });
    expect(() => transaction.reject(code)).toThrow("The rejection reason does not apply to this transaction kind");
    expect(transaction.status).toBe("PENDING");
  });

  test("a processed reference cannot return to pending-reference state", () => {
    const transaction = WagerTransaction.create(referencedWinProps());
    transaction.markProcessed(processedAt, "referenced-bet");
    expect(() => transaction.markPendingReference(createdAt)).toThrow("A terminal transaction cannot change state");
    expect(() => transaction.retryMissingReference(processedAt)).toThrow("A terminal transaction cannot change state");
    expect(transaction.referenceTransactionId).toBe("referenced-bet");
  });
});

describe("WIN reference eligibility", () => {
  test("accepts a processed BET matching the six ownership fields", () => {
    const transaction = WagerTransaction.create(referencedWinProps());
    expect(transaction.referenceFailure(reference())).toBeUndefined();
  });

  test("allows the win amount and game to differ from the referenced bet", () => {
    const transaction = WagerTransaction.create(referencedWinProps());
    const bet = { ...reference(), gameId: "another-game", money: Money.from({ amount: "0.01", currency: "BRL" }) };
    expect(transaction.referenceFailure(bet)).toBeUndefined();
  });

  test.each(["providerId", "playerId", "walletId", "currency", "roundId"] as const)(
    "rejects a different reference %s", (field) => {
      const transaction = WagerTransaction.create(referencedWinProps());
      expect(transaction.referenceFailure({ ...reference(), [field]: "different" })).toBe("REFERENCE_MISMATCH");
    },
  );

  test("rejects a resolved internal self reference", () => {
    const transaction = WagerTransaction.create(referencedWinProps());
    expect(transaction.referenceFailure({ ...reference(), id: transaction.id })).toBe("REFERENCE_MISMATCH");
  });

  test.each(["WIN", "LOSS", "REFUND", "ROLLBACK", "OPENING"])("rejects reference kind %s", (kind) => {
    expect(WagerTransaction.create(referencedWinProps()).referenceFailure({ ...reference(), kind }))
      .toBe("REFERENCE_KIND_MISMATCH");
  });

  test.each(["PENDING", "PENDING_REFERENCE", "REJECTED", "FAILED"])("rejects reference status %s", (status) => {
    expect(WagerTransaction.create(referencedWinProps()).referenceFailure({ ...reference(), status }))
      .toBe("REFERENCE_NOT_PROCESSED");
  });

  test("returns a deterministic ownership violation before kind and status violations", () => {
    expect(WagerTransaction.create(referencedWinProps()).referenceFailure({
      ...reference(), providerId: null, roundId: null, kind: "OPENING", status: "REJECTED",
    })).toBe("REFERENCE_MISMATCH");
  });

  test("does not inspect reference rules for an unreferenced operation", () => {
    expect(() => WagerTransaction.create(props()).referenceFailure(reference()))
      .toThrow("Only a referenced transaction can validate a reference");
  });
});

describe("WIN and LOSS transactions", () => {
  test.each(["WIN", "LOSS"] as const)("preserves %s identity through processing and rehydration", (kind) => {
    const source = { ...props(), kind, money: kind === "LOSS" ? Money.zero("BRL") : props().money };
    const transaction = WagerTransaction.create(source);

    expect(transaction.kind).toBe(kind);
    expect(transaction.status).toBe("PENDING");
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.affectsBalance()).toBe(kind === "WIN");
    expect(Reflect.set(transaction, "kind", "BET")).toBe(false);
    transaction.markProcessed(processedAt);
    const restored = WagerTransaction.rehydrate({ ...source, status: "PROCESSED", processedAt });
    expect(restored.kind).toBe(kind);
    expect(restored.status).toBe("PROCESSED");
    expect(restored.processedAt).toEqual(processedAt);
    expect(restored.money.equals(source.money)).toBe(true);
    expect(() => transaction.markProcessed(processedAt)).toThrow("A terminal transaction cannot change state");
    expect(() => transaction.reject("BALANCE_LIMIT_EXCEEDED")).toThrow("A terminal transaction cannot change state");
    expect(transaction.failureCode).toBeUndefined();
  });

  test.each([Money.zero("BRL"), Money.from({ amount: "0.01", currency: "BRL" }).negate()])(
    "requires a positive WIN amount instead of %s", (money) => {
      expect(() => WagerTransaction.create({ ...props(), kind: "WIN", money }))
        .toThrow(new DomainError("WIN_REQUIRES_POSITIVE_AMOUNT", "A win requires a positive amount"));
    },
  );

  test.each([Money.from({ amount: "0.01", currency: "BRL" }), Money.from({ amount: "0.01", currency: "BRL" }).negate()])(
    "requires a zero LOSS amount instead of %s", (money) => {
      expect(() => WagerTransaction.create({ ...props(), kind: "LOSS", money }))
        .toThrow(new DomainError("LOSS_REQUIRES_ZERO_AMOUNT", "A loss requires a zero amount"));
    },
  );

  test("BET continues to affect balance", () => {
    expect(WagerTransaction.create(props()).affectsBalance()).toBe(true);
  });

  test("records and rehydrates a terminal WIN balance-limit rejection", () => {
    const source = { ...props(), kind: "WIN" as const };
    const transaction = WagerTransaction.create(source);
    transaction.reject("BALANCE_LIMIT_EXCEEDED");
    const restored = WagerTransaction.rehydrate({
      ...source, status: "REJECTED", failureCode: "BALANCE_LIMIT_EXCEEDED",
    });

    expect(transaction.status).toBe("REJECTED");
    expect(transaction.isTerminal()).toBe(true);
    expect(transaction.failureCode).toBe("BALANCE_LIMIT_EXCEEDED");
    expect(transaction.processedAt).toBeUndefined();
    expect(restored.kind).toBe("WIN");
    expect(restored.failureCode).toBe("BALANCE_LIMIT_EXCEEDED");
    expect(() => restored.markProcessed(processedAt)).toThrow("A terminal transaction cannot change state");
    expect(() => transaction.reject("BALANCE_LIMIT_EXCEEDED")).toThrow("A terminal transaction cannot change state");
  });

  const invalidRejections: readonly [WagerKind, WagerFailureCode][] = [
    ["BET", "BALANCE_LIMIT_EXCEEDED"],
    ["WIN", "INSUFFICIENT_FUNDS"],
    ["LOSS", "INSUFFICIENT_FUNDS"],
    ["LOSS", "BALANCE_LIMIT_EXCEEDED"],
  ];
  test.each(invalidRejections)("rejects the incompatible %s rejection code %s", (kind, code) => {
    const transaction = WagerTransaction.create({
      ...props(), kind, money: kind === "LOSS" ? Money.zero("BRL") : props().money,
    });

    expect(() => transaction.reject(code))
      .toThrow(new DomainError("INVALID_REJECTION_REASON", "The rejection reason does not apply to this transaction kind"));
    expect(transaction.status).toBe("PENDING");
    expect(transaction.failureCode).toBeUndefined();
    expect(transaction.processedAt).toBeUndefined();
  });
});

function refundProps() {
  return { ...referencedWinProps(), kind: "REFUND" as const };
}

describe("REFUND transactions", () => {
  test("requires a nonempty external reference", () => {
    const { referenceExternalTransactionId: _reference, ...source } = refundProps();
    expect(() => WagerTransaction.create(source))
      .toThrow(new DomainError("REFERENCE_REQUIRED", "A refund requires a reference"));
    expect(() => WagerTransaction.create({ ...source, referenceExternalTransactionId: "" }))
      .toThrow(new DomainError("REFERENCE_REQUIRED", "A refund requires a reference"));
  });

  test.each([Money.zero("BRL"), Money.from({ amount: "0.01", currency: "BRL" }).negate()])(
    "rejects a non-positive refund of %s", (money) => {
      expect(() => WagerTransaction.create({ ...refundProps(), money }))
        .toThrow(new DomainError("REFUND_REQUIRES_POSITIVE_AMOUNT", "A refund requires a positive amount"));
    },
  );

  test("forbids an external self reference", () => {
    expect(() => WagerTransaction.create({
      ...refundProps(), referenceExternalTransactionId: props().externalTransactionId,
    })).toThrow(new DomainError("SELF_REFERENCE", "A transaction cannot reference itself"));
  });

  test("accepts the full value of a processed BET without requiring the same game", () => {
    const transaction = WagerTransaction.create(refundProps());
    const bet = { ...reference(), gameId: "another-game" };
    expect(transaction.referenceFailure(bet)).toBeUndefined();
    expect(transaction.kind).toBe("REFUND");
    expect(transaction.affectsBalance()).toBe(true);
    expect(transaction.status).toBe("PENDING");
    expect(transaction.money.equals(reference().money)).toBe(true);
  });

  test.each(["24.99", "25.01"])("rejects a partial or excessive reference amount of %s", (amount) => {
    const transaction = WagerTransaction.create(refundProps());
    expect(transaction.referenceFailure({ ...reference(), money: Money.from({ amount, currency: "BRL" }) }))
      .toBe("REFERENCE_AMOUNT_MISMATCH");
    expect(transaction.status).toBe("PENDING");
  });

  test("compares cents exactly beyond JavaScript's safe integer range", () => {
    const money = Money.from({ amount: "9007199254740992.01", currency: "BRL" });
    const transaction = WagerTransaction.create({ ...refundProps(), money });
    expect(transaction.referenceFailure({ ...reference(), money })).toBeUndefined();
    expect(transaction.referenceFailure({
      ...reference(), money: Money.from({ amount: "9007199254740992.02", currency: "BRL" }),
    })).toBe("REFERENCE_AMOUNT_MISMATCH");
  });

  test.each(["providerId", "playerId", "walletId", "currency", "roundId"] as const)(
    "rejects a refund reference with a different %s", (field) => {
      expect(WagerTransaction.create(refundProps()).referenceFailure({ ...reference(), [field]: "different" }))
        .toBe("REFERENCE_MISMATCH");
    },
  );

  test("rejects the currency of the referenced Money before comparing amounts", () => {
    expect(WagerTransaction.create(refundProps()).referenceFailure({
      ...reference(), money: Money.from({ amount: "25.00", currency: "USD" }),
    })).toBe("REFERENCE_MISMATCH");
  });

  test("reports identity, kind and status violations before an unequal amount", () => {
    const transaction = WagerTransaction.create(refundProps());
    const wrongAmount = { ...reference(), money: Money.from({ amount: "0.01", currency: "BRL" }) };
    expect(transaction.referenceFailure({ ...wrongAmount, id: transaction.id })).toBe("REFERENCE_MISMATCH");
    expect(transaction.referenceFailure({ ...wrongAmount, kind: "WIN", status: "REJECTED" }))
      .toBe("REFERENCE_KIND_MISMATCH");
    expect(transaction.referenceFailure({ ...wrongAmount, status: "REJECTED" })).toBe("REFERENCE_NOT_PROCESSED");
    expect(transaction.referenceFailure(wrongAmount)).toBe("REFERENCE_AMOUNT_MISMATCH");
  });

  test.each([false, true])("requires a resolved BET before processing (deferred=%s)", (deferred) => {
    const transaction = WagerTransaction.create(refundProps());
    if (deferred) transaction.markPendingReference(createdAt);
    for (const id of [undefined, "", transaction.id]) {
      expect(() => transaction.markProcessed(processedAt, id))
        .toThrow("A referenced transaction requires a distinct resolved transaction");
    }
    expect(transaction.status).toBe(deferred ? "PENDING_REFERENCE" : "PENDING");
    transaction.markProcessed(processedAt, "referenced-bet");
    expect(transaction.status).toBe("PROCESSED");
    expect(transaction.processedAt).toEqual(processedAt);
    expect(transaction.referenceTransactionId).toBe("referenced-bet");
    expect(transaction.nextReferenceAttemptAt).toBeUndefined();
    expect(() => transaction.markProcessed(processedAt, "referenced-bet"))
      .toThrow("A terminal transaction cannot change state");
    expect(() => transaction.markPendingReference(processedAt)).toThrow("A terminal transaction cannot change state");
    expect(() => transaction.retryMissingReference(processedAt)).toThrow("A terminal transaction cannot change state");
    expect(() => transaction.reject("REFERENCE_ALREADY_REFUNDED")).toThrow("A terminal transaction cannot change state");
  });

  test("resumes a pending refund's durable budget and completes without resetting attempts", () => {
    const initial = WagerTransaction.create(refundProps());
    initial.markPendingReference(createdAt);
    initial.retryMissingReference(initial.nextReferenceAttemptAt!);
    const transaction = WagerTransaction.rehydrate({
      ...refundProps(), status: initial.status, referenceAttempts: initial.referenceAttempts,
      nextReferenceAttemptAt: initial.nextReferenceAttemptAt!,
    });
    expect(transaction.referenceAttempts).toBe(1);
    expect(transaction.nextReferenceAttemptAt).toEqual(new Date("2026-10-10T12:00:03.000Z"));
    expect(transaction.referenceExternalTransactionId).toBe("external-bet");
    transaction.markProcessed(transaction.nextReferenceAttemptAt!, "referenced-bet");
    expect(transaction.referenceAttempts).toBe(1);
    expect(transaction.status).toBe("PROCESSED");
    expect(transaction.referenceTransactionId).toBe("referenced-bet");
    expect(transaction.nextReferenceAttemptAt).toBeUndefined();
  });

  test("only the tenth failed lookup can reject a missing refund reference", () => {
    const transaction = WagerTransaction.create(refundProps());
    transaction.markPendingReference(createdAt);
    for (let attempt = 0; attempt < maxReferenceAttempts; attempt += 1) {
      expect(() => transaction.reject("REFERENCE_NOT_FOUND"))
        .toThrow("The rejection reason does not apply to this transaction kind");
      expect(transaction.status).toBe("PENDING_REFERENCE");
      expect(transaction.referenceAttempts).toBe(attempt);
      transaction.retryMissingReference(transaction.nextReferenceAttemptAt!);
    }
    expect(transaction.status).toBe("REJECTED");
    expect(transaction.referenceAttempts).toBe(maxReferenceAttempts);
    expect(transaction.failureCode).toBe("REFERENCE_NOT_FOUND");
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(transaction.processedAt).toBeUndefined();
    expect(transaction.nextReferenceAttemptAt).toBeUndefined();
  });

  test.each([
    "REFERENCE_MISMATCH", "REFERENCE_KIND_MISMATCH", "REFERENCE_NOT_PROCESSED",
    "REFERENCE_AMOUNT_MISMATCH", "REFERENCE_ALREADY_REFUNDED", "BALANCE_LIMIT_EXCEEDED",
  ] as const)("makes %s terminal and clears a pending refund's schedule", (code) => {
    const transaction = WagerTransaction.create(refundProps());
    transaction.markPendingReference(createdAt);
    transaction.reject(code);
    expect(transaction.status).toBe("REJECTED");
    expect(transaction.failureCode).toBe(code);
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(transaction.processedAt).toBeUndefined();
    expect(transaction.nextReferenceAttemptAt).toBeUndefined();
    expect(transaction.money.toString()).toBe("25.00");
    expect(() => transaction.markProcessed(processedAt, "referenced-bet"))
      .toThrow("A terminal transaction cannot change state");
  });

  test("does not accept a debit rejection for a refund", () => {
    const transaction = WagerTransaction.create(refundProps());
    expect(() => transaction.reject("INSUFFICIENT_FUNDS"))
      .toThrow("The rejection reason does not apply to this transaction kind");
    expect(transaction.status).toBe("PENDING");
  });

  test.each(["REFERENCE_AMOUNT_MISMATCH", "REFERENCE_ALREADY_REFUNDED"] as const)(
    "rejects %s on operations without required references", (code) => {
      for (const source of [props(), referencedWinProps(), { ...props(), kind: "LOSS" as const, money: Money.zero("BRL") }]) {
        const transaction = WagerTransaction.create(source);
        expect(() => transaction.reject(code)).toThrow("The rejection reason does not apply to this transaction kind");
        expect(transaction.status).toBe("PENDING");
      }
    },
  );
});

function rollbackProps() {
  return { ...referencedWinProps(), kind: "ROLLBACK" as const };
}

describe("ROLLBACK transactions", () => {
  test("requires a reference and refuses an external self reference", () => {
    const { referenceExternalTransactionId: _reference, ...source } = rollbackProps();
    for (const missing of [{ ...source }, { ...source, referenceExternalTransactionId: "" }]) {
      expect(() => WagerTransaction.create(missing))
        .toThrow(new DomainError("REFERENCE_REQUIRED", "A rollback requires a reference"));
    }
    expect(() => WagerTransaction.create({ ...source, referenceExternalTransactionId: source.externalTransactionId }))
      .toThrow(new DomainError("SELF_REFERENCE", "A transaction cannot reference itself"));
  });

  test.each([Money.zero("BRL"), Money.from({ amount: "0.01", currency: "BRL" }).negate()])(
    "rejects a non-positive rollback of %s", (money) => {
      expect(() => WagerTransaction.create({ ...rollbackProps(), money }))
        .toThrow(new DomainError("ROLLBACK_REQUIRES_POSITIVE_AMOUNT", "A rollback requires a positive amount"));
    },
  );

  test.each(["BET", "WIN", "REFUND"])("inverts a processed %s without requiring the same game", (kind) => {
    const transaction = WagerTransaction.create(rollbackProps());
    const original = { ...reference(), kind, gameId: "another-game" };
    expect(transaction.referenceFailure(original)).toBeUndefined();
    expect(transaction.requiresReference()).toBe(true);
    expect(transaction.affectsBalance()).toBe(true);
    expect(transaction.ledgerDirectionFor(original)).toBe(kind === "BET" ? "CREDIT" : "DEBIT");
    expect(transaction.status).toBe("PENDING");
    expect(original.status).toBe("PROCESSED");
    expect(original.money.toString()).toBe("25.00");
  });

  test.each(["LOSS", "ROLLBACK", "OPENING"])("refuses reference kind %s", (kind) => {
    const transaction = WagerTransaction.create(rollbackProps());
    const original = { ...reference(), kind };
    expect(transaction.referenceFailure(original)).toBe("REFERENCE_KIND_MISMATCH");
    expect(() => transaction.ledgerDirectionFor(original)).toThrow("A rollback requires its matching processed reference");
  });

  test.each(["PENDING", "PENDING_REFERENCE", "REJECTED", "FAILED"])("refuses an existing %s reference", (status) => {
    const transaction = WagerTransaction.create(rollbackProps());
    const original = { ...reference(), kind: "WIN", status };
    expect(transaction.referenceFailure(original)).toBe("REFERENCE_NOT_PROCESSED");
    expect(() => transaction.ledgerDirectionFor(original)).toThrow("A rollback requires its matching processed reference");
    transaction.reject("REFERENCE_NOT_PROCESSED");
    expect(transaction.status).toBe("REJECTED");
    expect(transaction.nextReferenceAttemptAt).toBeUndefined();
  });

  test.each(["providerId", "playerId", "walletId", "currency", "roundId"] as const)(
    "refuses a reference owned by another %s", (field) => {
      const transaction = WagerTransaction.create(rollbackProps());
      const original = { ...reference(), [field]: "another" };
      expect(transaction.referenceFailure(original)).toBe("REFERENCE_MISMATCH");
      expect(() => transaction.ledgerDirectionFor(original)).toThrow("A rollback requires its matching processed reference");
    },
  );

  test("rejects a resolved self reference and mismatched Money currency", () => {
    const transaction = WagerTransaction.create(rollbackProps());
    expect(transaction.referenceFailure({ ...reference(), id: transaction.id })).toBe("REFERENCE_MISMATCH");
    expect(transaction.referenceFailure({
      ...reference(), money: Money.from({ amount: "25.00", currency: "USD" }),
    })).toBe("REFERENCE_MISMATCH");
  });

  test.each(["BET", "WIN", "REFUND"])("requires the exact full amount of a %s beyond safe integer precision", (kind) => {
    const money = Money.from({ amount: "9007199254740992.01", currency: "BRL" });
    const transaction = WagerTransaction.create({ ...rollbackProps(), money });
    expect(transaction.referenceFailure({ ...reference(), kind, money })).toBeUndefined();
    for (const amount of ["9007199254740992.00", "9007199254740992.02"]) {
      const original = { ...reference(), kind, money: Money.from({ amount, currency: "BRL" }) };
      expect(transaction.referenceFailure(original)).toBe("REFERENCE_AMOUNT_MISMATCH");
      expect(() => transaction.ledgerDirectionFor(original)).toThrow("A rollback requires its matching processed reference");
    }
  });

  test("cannot guess rollback direction from a missing or unrelated resolved reference", () => {
    const transaction = WagerTransaction.create(rollbackProps());
    expect(() => transaction.ledgerDirectionFor()).toThrow("A rollback requires its matching processed reference");
    expect(() => transaction.markProcessed(processedAt)).toThrow("A referenced transaction requires a distinct resolved transaction");
    transaction.markProcessed(processedAt, reference().id);
    expect(transaction.ledgerDirectionFor(reference())).toBe("CREDIT");
    expect(() => transaction.ledgerDirectionFor({ ...reference(), id: "other-reference" }))
      .toThrow("A rollback requires its matching processed reference");
  });

  test("resumes the persisted missing-reference budget and clears the schedule on resolution", () => {
    const initial = WagerTransaction.create(rollbackProps());
    initial.markPendingReference(createdAt);
    initial.retryMissingReference(initial.nextReferenceAttemptAt!);
    const due = initial.nextReferenceAttemptAt!;
    const transaction = WagerTransaction.rehydrate({
      ...rollbackProps(), status: "PENDING_REFERENCE", referenceAttempts: initial.referenceAttempts,
      nextReferenceAttemptAt: due,
    });
    due.setTime(0);
    expect(transaction.nextReferenceAttemptAt).toEqual(new Date("2026-10-10T12:00:03.000Z"));
    expect(transaction.referenceAttempts).toBe(1);
    transaction.markProcessed(processedAt, reference().id);
    expect(transaction.referenceAttempts).toBe(1);
    expect(transaction.referenceTransactionId).toBe(reference().id);
    expect(transaction.nextReferenceAttemptAt).toBeUndefined();
    expect(transaction.processedAt).toEqual(processedAt);
    expect(Reflect.set(transaction, "referenceExternalTransactionId", "another")).toBe(false);
  });

  test("expires only after ten missing lookups and cannot transition again", () => {
    const transaction = WagerTransaction.create(rollbackProps());
    transaction.markPendingReference(createdAt);
    for (let attempt = 0; attempt < maxReferenceAttempts; attempt += 1) {
      expect(() => transaction.reject("REFERENCE_NOT_FOUND")).toThrow("The rejection reason does not apply");
      expect(transaction.referenceAttempts).toBe(attempt);
      transaction.retryMissingReference(transaction.nextReferenceAttemptAt!);
    }
    expect(transaction.status).toBe("REJECTED");
    expect(transaction.failureCode).toBe("REFERENCE_NOT_FOUND");
    expect(transaction.referenceAttempts).toBe(10);
    expect(transaction.nextReferenceAttemptAt).toBeUndefined();
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(() => transaction.retryMissingReference(processedAt)).toThrow("A terminal transaction cannot change state");
  });

  test.each([
    "REFERENCE_MISMATCH", "REFERENCE_KIND_MISMATCH", "REFERENCE_NOT_PROCESSED", "REFERENCE_AMOUNT_MISMATCH",
    "REFERENCE_ALREADY_ROLLED_BACK", "REVERSAL_INSUFFICIENT_FUNDS", "BALANCE_LIMIT_EXCEEDED",
  ] as const)("persists terminal %s and clears the pending schedule", (code) => {
    const transaction = WagerTransaction.create(rollbackProps());
    transaction.markPendingReference(createdAt);
    transaction.reject(code);
    const restored = WagerTransaction.rehydrate({ ...rollbackProps(), status: "REJECTED", failureCode: code });
    expect(restored.failureCode).toBe(code);
    expect(transaction.status).toBe("REJECTED");
    expect(transaction.nextReferenceAttemptAt).toBeUndefined();
    expect(transaction.processedAt).toBeUndefined();
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(() => transaction.markProcessed(processedAt, reference().id)).toThrow("A terminal transaction cannot change state");
    expect(() => transaction.markPendingReference(processedAt)).toThrow("A terminal transaction cannot change state");
    expect(() => transaction.reject(code)).toThrow("A terminal transaction cannot change state");
  });

  test.each(["INSUFFICIENT_FUNDS", "REFERENCE_ALREADY_REFUNDED"] as const)("refuses the unrelated failure %s", (code) => {
    const transaction = WagerTransaction.create(rollbackProps());
    expect(() => transaction.reject(code)).toThrow("The rejection reason does not apply");
    expect(transaction.status).toBe("PENDING");
  });

  test.each(["REFERENCE_ALREADY_ROLLED_BACK", "REVERSAL_INSUFFICIENT_FUNDS"] as const)(
    "restricts %s to rollbacks", (code) => {
      for (const source of [props(), referencedWinProps(), refundProps(), { ...props(), kind: "LOSS" as const, money: Money.zero("BRL") }]) {
        const transaction = WagerTransaction.create(source);
        expect(() => transaction.reject(code)).toThrow("The rejection reason does not apply");
        expect(transaction.status).toBe("PENDING");
      }
    },
  );

  test("keeps existing operation directions and reference requirements explicit", () => {
    const bet = WagerTransaction.create(props());
    const win = WagerTransaction.create(referencedWinProps());
    const loss = WagerTransaction.create({ ...props(), kind: "LOSS", money: Money.zero("BRL") });
    const refund = WagerTransaction.create(refundProps());
    expect([bet, win, loss, refund].map((transaction) => transaction.ledgerDirectionFor()))
      .toEqual(["DEBIT", "CREDIT", null, "CREDIT"]);
    expect([bet, win, loss, refund].map((transaction) => transaction.requiresReference()))
      .toEqual([false, false, false, true]);
  });
});
