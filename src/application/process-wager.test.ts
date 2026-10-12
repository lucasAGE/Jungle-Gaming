import { describe, expect, test } from "bun:test";
import { Money } from "../domain/money.js";
import { Wallet } from "../domain/wallet.js";
import { WagerTransaction } from "../domain/wager-transaction.js";
import { ProcessingError } from "./processing-error.js";
import { ProcessWager } from "./process-wager.js";
import { wagerInput, wagerPayloadHash } from "./wager-input.js";
import type { StoredWager, WagerDecision, WageringStore, WagerUnitOfWork } from "./wagering-store.js";

const key = "provider-a:transaction-123";
const payload = {
  providerId: "provider-a", externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987", gameId: "fortune-chimp", kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

function committedWager(overrides: Partial<StoredWager> = {}): StoredWager {
  return {
    ...wagerInput(payload), transactionId: "0192f298-345e-7e38-af88-e43f851a819d",
    idempotencyKey: key, payloadHash: wagerPayloadHash(wagerInput(payload)),
    status: "PROCESSED", balance: Money.from({ amount: "75.00", currency: "BRL" }), failureCode: null,
    createdAt: new Date("2026-10-10T12:00:00.000Z"), processedAt: new Date("2026-10-10T12:00:00.000Z"),
    ...overrides,
  };
}

function commitBetweenReads(existing: StoredWager) {
  const calls: string[] = [];
  const unit: WagerUnitOfWork = {
    async hasProcessedReversal() { throw new Error("A replay does not check reversal eligibility again"); },
    async claimDueReference() { throw new Error("An HTTP replay does not claim scheduled work"); },
    async lockPendingReference() { throw new Error("An HTTP replay does not retry failed pending work"); },
    async claimInbox() { throw new Error("HTTP does not claim an inbox message"); },
    async completeInbox() { throw new Error("HTTP does not complete an inbox message"); },
    async findById() { throw new Error("This flow does not query by internal ID"); },
    async findByKey(requestedKey) {
      calls.push("key");
      expect(requestedKey).toBe(key);
      return null;
    },
    async findByExternal(providerId, externalId) {
      calls.push("external");
      expect(providerId).toBe(payload.providerId);
      expect(externalId).toBe(payload.externalTransactionId);
      // Under READ COMMITTED, a competing commit may become visible only to this second statement.
      return existing;
    },
    async lockWallet() {
      calls.push("lock");
      throw new Error("An existing decision must not lock or debit the wallet again");
    },
    async saveDecision() {
      calls.push("save");
      throw new Error("An existing decision must not create another financial record");
    },
  };
  const store: WageringStore = {
    findById: unit.findById,
    findByKey: unit.findByKey,
    findByExternal: unit.findByExternal,
    transaction: (work) => work(unit),
  };
  return { process: new ProcessWager(store), calls };
}

describe("BET duplicate committed between identity lookups", () => {
  test("replays a matching processed transaction discovered by its external identity", async () => {
    const existing = committedWager();
    const { process, calls } = commitBetweenReads(existing);

    expect(await process.execute(payload, key)).toEqual({
      transactionId: existing.transactionId, status: "PROCESSED",
      balance: { amount: "75.00", currency: "BRL" }, idempotentReplay: true,
    });
    expect(calls).toEqual(["key", "external"]);
  });

  test("replays a matching rejection with its original balance and failure code", async () => {
    const existing = committedWager({
      status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", processedAt: null,
      balance: Money.from({ amount: "20.00", currency: "BRL" }),
    });
    const { process, calls } = commitBetweenReads(existing);

    expect(await process.execute(payload, key)).toEqual({
      transactionId: existing.transactionId, status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS",
      balance: { amount: "20.00", currency: "BRL" }, idempotentReplay: true,
    });
    expect(calls).toEqual(["key", "external"]);
  });

  test("detects divergent payload under the same key even when found by external identity", async () => {
    const { process, calls } = commitBetweenReads(committedWager());
    const divergent = { ...payload, money: { amount: "26.00", currency: "BRL" } };

    await expect(process.execute(divergent, key)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(calls).toEqual(["key", "external"]);
  });

  test("keeps a genuinely different key for the same external identity as a conflict", async () => {
    const { process, calls } = commitBetweenReads(committedWager({ idempotencyKey: "other-key" }));

    await expect(process.execute(payload, key)).rejects.toMatchObject({ code: "EXTERNAL_TRANSACTION_CONFLICT" });
    expect(calls).toEqual(["key", "external"]);
  });
});

describe("ProcessWager permanent failure audit boundary", () => {
  test("does not fail a pending identity that another worker resolved before the audit relock", async () => {
    const wallet = Wallet.open({ id: payload.walletId, playerId: payload.playerId,
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }), createdAt: new Date() });
    const transaction = WagerTransaction.create({ ...wagerInput(payload), id: "pending-win", kind: "WIN",
      externalTransactionId: "pending-external", referenceExternalTransactionId: payload.externalTransactionId,
      idempotencyKey: "pending-key", payloadHash: "hash", createdAt: new Date() });
    transaction.markPendingReference(new Date());
    let attempts = 0;
    const saved: string[] = [];
    const locked: string[] = [];
    const unit: WagerUnitOfWork = {
      async findById() { return null; }, async findByKey() { return null; }, async findByExternal() { return committedWager(); },
      async lockWallet() { return wallet; }, async hasProcessedReversal() { return false; },
      async claimInbox(message) { return message; }, async completeInbox() {},
      async claimDueReference() {
        expect(attempts).toBe(1);
        return { transaction, wallet, correlationId: "pending-correlation", acceptedBalance: wallet.balance };
      },
      async lockPendingReference(id) {
        locked.push(id);
        // The fresh lock/status check sees the competing commit, not the stale failed attempt.
        return null;
      },
      async saveDecision(decision) {
        saved.push(decision.transaction.status);
        throw new ProcessingError(false, new Error("Permanent ledger rejection"));
      },
    };
    const process = new ProcessWager({ findById: unit.findById, findByKey: unit.findByKey, findByExternal: unit.findByExternal,
      transaction(work) { attempts++; return work(unit); } });
    expect(await process.reprocessNext()).toBeNull();
    expect(locked).toEqual(["pending-win"]);
    expect(saved).toEqual(["PROCESSED"]);
    expect(attempts).toBe(2);
  });

  function fixture(failure: unknown, winner: StoredWager | null = null, auditFails = false) {
    const wallet = Wallet.open({ id: payload.walletId, playerId: payload.playerId,
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }), createdAt: new Date() });
    let attempts = 0;
    const decisions: WagerDecision[] = [];
    const committed: WagerDecision[] = [];
    const store: WageringStore = {
      async findById() { return null; }, async findByKey() { return null; }, async findByExternal() { return null; },
      async transaction(work) {
        attempts++;
        let decision: WagerDecision | undefined;
        const unit: WagerUnitOfWork = {
          async findById() { return null; }, async findByKey() { return attempts > 1 ? winner : null; }, async findByExternal() { return null; },
          async lockWallet() { return wallet; }, async hasProcessedReversal() { return false; },
          async claimDueReference() { return null; }, async lockPendingReference() { return null; },
          async claimInbox(message) { return message; }, async completeInbox() {},
          async saveDecision(value) { decision = value; decisions.push(value); },
        };
        const result = await work(unit);
        if (attempts === 1) throw failure;
        if (auditFails) throw new ProcessingError(false, new Error("Audit outbox rejected"));
        if (decision) committed.push(decision);
        return result;
      },
    };
    return { process: new ProcessWager(store), decisions, committed, attempts: () => attempts, wallet };
  }

  test("rolls back the failed movement before committing a terminal audit and one event", async () => {
    const state = fixture(new ProcessingError(false, new Error("Permanent SQL rejection")));
    const result = await state.process.execute(payload, key);
    expect(result).toMatchObject({ status: "FAILED", failureCode: "DATABASE_OPERATION_FAILED", balance: { amount: "100.00" } });
    expect(state.attempts()).toBe(2);
    expect(state.decisions[0]!.entry?.direction).toBe("DEBIT");
    expect(state.committed).toHaveLength(1);
    expect(state.committed[0]!.entry).toBeNull();
    expect(state.committed[0]!.wallet.version).toBe(1);
    expect(state.committed[0]!.events.map((event) => event.eventType)).toEqual(["WagerTransactionFailed"]);
    expect(state.wallet.balance.toString()).toBe("100.00");
  });

  test("preserves a committed winner found during the fresh audit identity check", async () => {
    const winner = committedWager();
    const state = fixture(new ProcessingError(false, new Error("Permanent SQL rejection")), winner);
    expect(await state.process.execute(payload, key)).toMatchObject({ status: "PROCESSED", transactionId: winner.transactionId,
      idempotentReplay: true, balance: { amount: "75.00" } });
    expect(state.committed).toEqual([]);
  });

  test.each([new ProcessingError(true, new Error("Commit response lost")), new Error("Unknown failure")])(
    "never invents a FAILED decision for an ambiguous or unknown result: %s", async (failure) => {
      const state = fixture(failure);
      await expect(state.process.execute(payload, key)).rejects.toBe(failure);
      expect(state.attempts()).toBe(1);
      expect(state.committed).toEqual([]);
    },
  );

  test("keeps an unavailable audit retryable with no committed terminal result", async () => {
    const state = fixture(new ProcessingError(false, new Error("Permanent SQL rejection")), null, true);
    await expect(state.process.execute(payload, key)).rejects.toMatchObject({ retryable: true, code: "FAILURE_AUDIT_UNAVAILABLE" });
    expect(state.committed).toEqual([]);
    expect(state.wallet.version).toBe(1);
  });
});
