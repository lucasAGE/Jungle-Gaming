import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "../domain/domain-error.js";
import { InboxMessage } from "../domain/inbox-message.js";
import { WalletBalanceChanged, WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference, WagerTransactionFailed, type IntegrationEvent } from "../domain/integration-event.js";
import type { Money, MoneyProps } from "../domain/money.js";
import { WagerTransaction, type WagerFailureCode, type WagerReference } from "../domain/wager-transaction.js";
import type { Wallet } from "../domain/wallet.js";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry.js";
import { ApplicationError } from "./application-error.js";
import { ProcessingError } from "./processing-error.js";
import { Telemetry } from "./telemetry.js";
import { idempotencyKeyInput, wagerInput, wagerPayloadHash, type WagerInput } from "./wager-input.js";
import { WagerIdentityConflict, type StoredWager, type WageringStore, type WagerReader, type WagerUnitOfWork } from "./wagering-store.js";

export interface WagerDelivery {
  readonly messageId: string;
  readonly consumerName: string;
  readonly receivedAt: Date;
  readonly correlationId: string;
}

export interface WagerResult {
  readonly transactionId: string;
  readonly status: "PROCESSED" | "REJECTED" | "PENDING_REFERENCE" | "FAILED";
  readonly balance: MoneyProps;
  readonly idempotentReplay: boolean;
  readonly failureCode?: WagerFailureCode;
}

export interface ReferenceProcessingResult {
  readonly transactionId: string;
  readonly status: WagerResult["status"];
  readonly walletId: string;
  readonly providerId: string;
  readonly correlationId: string;
  readonly referenceAttempts: number;
  readonly nextReferenceAttemptAt?: Date;
}

export class ProcessWager {
  constructor(private readonly store: WageringStore, private readonly telemetry: Telemetry = Telemetry.noop) {}

  async execute(body: unknown, key: unknown, delivery?: WagerDelivery): Promise<WagerResult> {
    return this.telemetry.trace("wager.process", () => this.process(body, key, delivery));
  }

  private async process(body: unknown, key: unknown, delivery?: WagerDelivery): Promise<WagerResult> {
    const started = performance.now();
    const input = wagerInput(body);
    const idempotencyKey = idempotencyKeyInput(key);
    const payloadHash = wagerPayloadHash(input);
    // The inbox additionally binds the key, so changing a header cannot reuse a message identity.
    const inboxHash = createHash("sha256").update(JSON.stringify({ idempotencyKey, payloadHash })).digest("hex");
    const correlationId = delivery?.correlationId ?? this.telemetry.context().correlationId ?? randomUUID();
    const transact = (failed: boolean) => this.store.transaction(async (unit) => {
      const inbox = delivery ? await unit.claimInbox(InboxMessage.receive({ ...delivery, payloadHash: inboxHash })) : null;
      if (inbox) {
        if (!inbox.matchesPayload(inboxHash)) {
          throw new ApplicationError("INBOX_PAYLOAD_CONFLICT", "The message identity already belongs to a different request");
        }
        if (inbox.isProcessed()) {
          const existing = await unit.findById(inbox.transactionId!);
          if (!existing) throw new Error("A processed inbox message must reference its transaction");
          return this.originalResult(existing);
        }
      }
      const result = await this.apply(unit, input, idempotencyKey, payloadHash, correlationId, failed);
      if (inbox) {
        inbox.markProcessed(result.transactionId, new Date());
        await unit.completeInbox(inbox);
      }
      return result;
    });
    const commit = async (failed: boolean) => {
      try { return await transact(failed); }
      catch (error) {
        if (!(error instanceof WagerIdentityConflict)) throw error;
        // The uniqueness loser resolves the committed winner in a fresh transaction,
        // including the inbox; the failure path must never overwrite that winner.
        return transact(failed);
      }
    };
    let result: WagerResult;
    try { result = await commit(false); }
    catch (error) {
      if (!(error instanceof ProcessingError) || error.retryable) throw error;
      try { result = await commit(true); }
      catch (auditError) {
        if (auditError instanceof ApplicationError) throw auditError;
        // A failed audit commit is not a durable terminal decision. Retry safely;
        // when PostgreSQL is unavailable, the broker still retains the original input.
        throw new ProcessingError(true, auditError, true);
      }
    }
    this.telemetry.wagerCompleted({ correlationId, ...(delivery ? { messageId: delivery.messageId } : {}), transactionId: result.transactionId,
      walletId: input.walletId, providerId: input.providerId }, result.status, result.idempotentReplay, performance.now() - started);
    return result;
  }

  async reprocessNext(at = new Date()): Promise<ReferenceProcessingResult | null> {
    const started = performance.now();
    let claimedId: string | undefined;
    const process = () => this.store.transaction(async (unit) => {
      const pending = await unit.claimDueReference(at);
      if (!pending) return null;
      claimedId = pending.transaction.id;
      const { transaction, wallet, correlationId, acceptedBalance } = pending;
      const result = await this.decide(unit, transaction, wallet, correlationId, at, acceptedBalance);
      return {
        transactionId: transaction.id, status: result.status, walletId: wallet.id,
        providerId: transaction.providerId, correlationId, referenceAttempts: transaction.referenceAttempts,
        ...(transaction.nextReferenceAttemptAt ? { nextReferenceAttemptAt: transaction.nextReferenceAttemptAt } : {}),
      };
    });
    let result: ReferenceProcessingResult | null;
    try { result = await process(); }
    catch (error) {
      if (!(error instanceof ProcessingError) || error.retryable || claimedId === undefined) throw error;
      try {
        result = await this.store.transaction(async (unit) => {
          const pending = await unit.lockPendingReference(claimedId!);
          if (!pending) return null;
          const { transaction, wallet, correlationId } = pending;
          await this.saveFailure(unit, transaction, wallet, correlationId, at);
          return { transactionId: transaction.id, status: "FAILED" as const, walletId: wallet.id,
            providerId: transaction.providerId, correlationId, referenceAttempts: transaction.referenceAttempts };
        });
      } catch (auditError) { throw new ProcessingError(true, auditError, true); }
    }
    if (result && result.status !== "PENDING_REFERENCE") {
      this.telemetry.wagerCompleted(result, result.status, false, performance.now() - started);
    }
    return result;
  }

  private async apply(unit: WagerUnitOfWork, input: WagerInput, key: string, hash: string, correlationId: string, failed = false): Promise<WagerResult> {
    const existing = await this.findReplay(unit, input, key, hash);
    if (existing) return existing;
    const current = await unit.lockWallet(input.walletId);
    if (!current) throw new ApplicationError("WALLET_NOT_FOUND", "Wallet was not found");
    if (current.playerId !== input.playerId || current.currency !== input.money.currency) {
      throw new ApplicationError("INVALID_INPUT", "The player and currency must match the wallet");
    }
    // A request waiting for this wallet lock may now have a committed duplicate.
    const replay = await this.findReplay(unit, input, key, hash);
    if (replay) return replay;
    const at = new Date();
    const transaction = WagerTransaction.create({ ...input, id: randomUUID(), idempotencyKey: key, payloadHash: hash, createdAt: at });
    if (failed) return this.saveFailure(unit, transaction, current, correlationId, at);
    return this.decide(unit, transaction, current, correlationId, at, current.balance);
  }

  private async saveFailure(unit: WagerUnitOfWork, transaction: WagerTransaction, wallet: Wallet,
    correlationId: string, at: Date): Promise<WagerResult> {
    transaction.fail("DATABASE_OPERATION_FAILED");
    const event = WagerTransactionFailed.wager({ transaction, wallet, correlationId, occurredAt: at, eventId: randomUUID() });
    await unit.saveDecision({ transaction, wallet, entry: null, events: [event], correlationId, resultBalance: wallet.balance });
    return { transactionId: transaction.id, status: "FAILED", balance: wallet.balance.toJSON(),
      idempotentReplay: false, failureCode: "DATABASE_OPERATION_FAILED" };
  }

  private async decide(
    unit: WagerUnitOfWork, transaction: WagerTransaction, current: Wallet,
    correlationId: string, at: Date, acceptedBalance: Money,
  ): Promise<WagerResult> {
    let referenceId: string | undefined;
    let reference: WagerReference | undefined;
    if (transaction.referenceExternalTransactionId !== undefined) {
      const storedReference = await unit.findByExternal(transaction.providerId, transaction.referenceExternalTransactionId);
      if (!storedReference) {
        if (transaction.status === "PENDING") transaction.markPendingReference(at);
        else transaction.retryMissingReference(at);
      } else {
        reference = {
          id: storedReference.transactionId, providerId: storedReference.providerId, playerId: storedReference.playerId,
          walletId: storedReference.walletId, currency: storedReference.money.currency,
          roundId: storedReference.roundId, kind: storedReference.kind, status: storedReference.status, money: storedReference.money,
        };
        const failure = transaction.referenceFailure(reference);
        if (failure) transaction.reject(failure);
        else if ((transaction.kind === "REFUND" || transaction.kind === "ROLLBACK")
          && await unit.hasProcessedReversal(transaction.kind, reference.id)) {
          // The wallet lock serializes distinct reversal identities; database indexes also enforce uniqueness.
          transaction.reject(transaction.kind === "REFUND" ? "REFERENCE_ALREADY_REFUNDED" : "REFERENCE_ALREADY_ROLLED_BACK");
        } else {
          referenceId = reference.id;
        }
      }
    }
    let wallet: Wallet = current;
    let entry: WalletLedgerEntry | null = null;
    if (!transaction.isTerminal() && (transaction.referenceExternalTransactionId === undefined || referenceId !== undefined)) {
      try {
        const movement = { money: transaction.money, transactionId: transaction.id, entryId: randomUUID(), at };
        const direction = transaction.ledgerDirectionFor(reference);
        if (direction === "DEBIT") ({ wallet, entry } = current.debit(movement));
        if (direction === "CREDIT") ({ wallet, entry } = current.credit(movement));
        // LOSS is a processed result without a balance change or a ledger entry.
        transaction.markProcessed(at, referenceId);
      } catch (error) {
        if (!(error instanceof DomainError)
          || (error.code !== "INSUFFICIENT_FUNDS" && error.code !== "BALANCE_LIMIT_EXCEEDED")) throw error;
        transaction.reject(transaction.kind === "ROLLBACK" && error.code === "INSUFFICIENT_FUNDS"
          ? "REVERSAL_INSUFFICIENT_FUNDS" : error.code);
      }
    }
    const context = { transaction, wallet, correlationId, ...(reference ? { reference } : {}) };
    const status = transaction.status;
    if (status === "PENDING") throw new Error("Processing must produce a persisted wager decision");
    const events: IntegrationEvent<unknown>[] = status === "REJECTED"
      ? [WagerTransactionRejected.wager({ ...context, eventId: randomUUID(), occurredAt: at })]
      : status === "PROCESSED"
        ? [WagerTransactionProcessed.wager({ ...context, entry, eventId: randomUUID() })]
        : transaction.referenceAttempts === 0
          ? [WagerTransactionPendingReference.wager({ ...context, eventId: randomUUID() })] : [];
    if (entry) events.push(WalletBalanceChanged.wager({ ...context, entry, eventId: randomUUID() }));
    const resultBalance = status === "PENDING_REFERENCE" ? acceptedBalance : wallet.balance;
    await unit.saveDecision({ transaction, wallet, entry, events, correlationId, resultBalance });
    return {
      transactionId: transaction.id, status,
      balance: resultBalance.toJSON(), idempotentReplay: false,
      ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
    };
  }

  private async findReplay(reader: WagerReader, input: WagerInput, key: string, hash: string): Promise<WagerResult | null> {
    const existing = await reader.findByKey(key)
      ?? await reader.findByExternal(input.providerId, input.externalTransactionId);
    if (!existing) return null;
    // A commit can occur between these reads; the external lookup may find the same key.
    if (existing.idempotencyKey !== key) {
      throw new ApplicationError("EXTERNAL_TRANSACTION_CONFLICT", "The provider transaction already has another idempotency key");
    }
    if (existing.payloadHash !== hash) {
      throw new ApplicationError("IDEMPOTENCY_CONFLICT", "The idempotency key already belongs to a different payload");
    }
    return this.originalResult(existing);
  }

  private originalResult(existing: StoredWager): WagerResult {
    return {
      transactionId: existing.transactionId, status: existing.status, balance: existing.balance.toJSON(),
      idempotentReplay: true, ...(existing.failureCode ? { failureCode: existing.failureCode } : {}),
    };
  }
}
