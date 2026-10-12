import { IsolationLevel, LockMode, UniqueConstraintViolationException, type EntityManager, type FilterQuery } from "@mikro-orm/core";
import {
  WagerIdentityConflict, WageringStore, type StoredWager, type WagerDecision, type WagerUnitOfWork, type PendingReference,
} from "../../application/wagering-store.js";
import { Money } from "../../domain/money.js";
import { AccountingTransfer } from "../../domain/accounting-transfer.js";
import { InboxMessage } from "../../domain/inbox-message.js";
import { ProcessingError } from "../../application/processing-error.js";
import { Telemetry } from "../../application/telemetry.js";
import { isDatabaseError, isTransientDatabaseError } from "./database-errors.js";
import { Wallet } from "../../domain/wallet.js";
import { WagerTransaction } from "../../domain/wager-transaction.js";
import { AccountingJournalSchema, InboxSchema, LedgerSchema, OutboxSchema, WagerTransactionSchema, WalletSchema, type WagerTransactionRecord } from "./entities.js";
import type { createOrm } from "./orm.js";
import { tracedEnvelope } from "../observability/tracing.js";

class PostgresWagerUnitOfWork implements WagerUnitOfWork {
  constructor(private readonly em: EntityManager) {}

  findById(id: string) { return this.find({ id }); }
  findByKey(idempotencyKey: string) { return this.find({ idempotencyKey }); }
  findByExternal(providerId: string, externalTransactionId: string) {
    return this.find({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(kind: "REFUND" | "ROLLBACK", referenceTransactionId: string): Promise<boolean> {
    return await this.em.findOne(WagerTransactionSchema, {
      kind, status: "PROCESSED", referenceTransactionId,
    }) !== null;
  }

  async claimDueReference(at: Date): Promise<PendingReference | null> {
    // Lock the wallet before the wager, matching HTTP/SQS lock order. Busy wallets
    // are skipped so another wallet can progress without a global worker lock.
    const candidates = await this.em.getConnection().execute<Array<{ id: string }>>(`
      select w.id from wallets w join wager_transactions t on t.wallet_id = w.id
      where t.status = 'PENDING_REFERENCE' and t.next_reference_attempt_at <= ?
      order by t.next_reference_attempt_at, t.id limit 1 for update of w skip locked
    `, [at], "all", this.em.getTransactionContext());
    const candidate = candidates[0];
    if (!candidate) return null;
    const wallet = await this.lockWallet(candidate.id);
    if (!wallet) throw new Error("A pending reference must belong to a wallet");
    const row = await this.em.findOne(WagerTransactionSchema, {
      walletId: wallet.id, status: "PENDING_REFERENCE", nextReferenceAttemptAt: { $lte: at },
    }, { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { nextReferenceAttemptAt: "asc", id: "asc" }, refresh: true });
    if (!row) return null;
    return this.pendingReference(row, wallet);
  }

  async lockPendingReference(id: string): Promise<PendingReference | null> {
    const known = await this.em.findOne(WagerTransactionSchema, { id });
    if (!known || known.status !== "PENDING_REFERENCE") return null;
    const wallet = await this.lockWallet(known.walletId);
    if (!wallet) throw new Error("A pending reference must belong to a wallet");
    const row = await this.em.findOne(WagerTransactionSchema, { id, status: "PENDING_REFERENCE" },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return row ? this.pendingReference(row, wallet) : null;
  }

  private pendingReference(row: WagerTransactionRecord, wallet: Wallet): PendingReference {
    if ((row.kind !== "WIN" && row.kind !== "REFUND" && row.kind !== "ROLLBACK")
      || !row.processingCorrelationId || !row.referenceExternalTransactionId || !row.nextReferenceAttemptAt) {
      throw new Error("A pending reference must have a supported wager and retry context");
    }
    return {
      wallet, correlationId: row.processingCorrelationId,
      acceptedBalance: Money.from({ amount: row.resultBalance!, currency: row.currency }),
      transaction: WagerTransaction.rehydrate({
        id: row.id, walletId: row.walletId, playerId: row.playerId,
        providerId: row.providerId!, externalTransactionId: row.externalTransactionId!,
        idempotencyKey: row.idempotencyKey, payloadHash: row.payloadHash!,
        roundId: row.roundId!, gameId: row.gameId!, kind: row.kind,
        money: Money.from({ amount: row.amount, currency: row.currency }),
        status: "PENDING_REFERENCE", createdAt: row.createdAt,
        referenceExternalTransactionId: row.referenceExternalTransactionId,
        referenceAttempts: row.referenceAttempts ?? 0, nextReferenceAttemptAt: row.nextReferenceAttemptAt,
      }),
    };
  }

  async claimInbox(message: InboxMessage): Promise<InboxMessage> {
    // A competing insert waits for its commit/rollback. The claim is never autocommitted.
    await this.em.getConnection().execute(`
      insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
      values (?, ?, ?, ?) on conflict (consumer_name, message_id) do nothing
    `, [message.consumerName, message.messageId, message.payloadHash, message.receivedAt], "run", this.em.getTransactionContext());
    const row = await this.em.findOneOrFail(InboxSchema, {
      consumerName: message.consumerName, messageId: message.messageId,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return InboxMessage.rehydrate({
      consumerName: row.consumerName, messageId: row.messageId, payloadHash: row.payloadHash, receivedAt: row.receivedAt,
      ...(row.processedAt === null ? {} : { processedAt: row.processedAt }),
      ...(row.transactionId === null ? {} : { transactionId: row.transactionId }),
    });
  }

  async completeInbox(message: InboxMessage): Promise<void> {
    if (!message.isProcessed() || !message.transactionId || !message.processedAt) throw new Error("Inbox completion requires a financial result");
    const row = await this.em.findOneOrFail(InboxSchema, { consumerName: message.consumerName, messageId: message.messageId });
    row.transactionId = message.transactionId;
    row.processedAt = message.processedAt;
    await this.em.flush();
  }

  private async find(where: FilterQuery<WagerTransactionRecord>): Promise<StoredWager | null> {
    const row = await this.em.findOne(WagerTransactionSchema, where);
    if (!row) return null;
    return {
      transactionId: row.id, idempotencyKey: row.idempotencyKey, payloadHash: row.payloadHash ?? null,
      providerId: row.providerId ?? null, externalTransactionId: row.externalTransactionId ?? null,
      walletId: row.walletId, playerId: row.playerId, roundId: row.roundId ?? null, gameId: row.gameId ?? null,
      kind: row.kind, status: row.status, failureCode: row.failureCode ?? null,
      money: Money.from({ amount: row.amount, currency: row.currency }),
      // OPENING's original resulting balance is its credit, including records predating BET.
      balance: Money.from({ amount: row.resultBalance ?? row.amount, currency: row.currency }),
      createdAt: row.createdAt, processedAt: row.processedAt,
      ...(row.referenceExternalTransactionId ? {
        referenceExternalTransactionId: row.referenceExternalTransactionId,
        referenceAttempts: row.referenceAttempts ?? 0,
        ...(row.referenceTransactionId ? { referenceTransactionId: row.referenceTransactionId } : {}),
        ...(row.nextReferenceAttemptAt ? { nextReferenceAttemptAt: row.nextReferenceAttemptAt } : {}),
      } : {}),
    };
  }

  async lockWallet(id: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletSchema, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    if (!row) return null;
    return Wallet.rehydrate({
      id: row.id, playerId: row.playerId, balance: Money.from({ amount: row.balance, currency: row.currency }),
      version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt,
    });
  }

  async saveDecision({ transaction, wallet, entry, events, correlationId, resultBalance }: WagerDecision): Promise<void> {
    const status = transaction.status;
    if (status === "PENDING") throw new Error("A wager must have a decision before persistence");
    const state = {
      id: transaction.id, walletId: transaction.walletId, playerId: transaction.playerId,
      currency: transaction.money.currency, amount: transaction.money.toString(),
      idempotencyKey: transaction.idempotencyKey, payloadHash: transaction.payloadHash,
      kind: transaction.kind, status,
      providerId: transaction.providerId, externalTransactionId: transaction.externalTransactionId,
      roundId: transaction.roundId, gameId: transaction.gameId,
      failureCode: transaction.failureCode ?? null, resultBalance: resultBalance.toString(),
      createdAt: transaction.createdAt, processedAt: transaction.processedAt ?? null,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      referenceAttempts: transaction.referenceAttempts,
      nextReferenceAttemptAt: transaction.nextReferenceAttemptAt ?? null,
      processingCorrelationId: transaction.referenceExternalTransactionId ? correlationId : null,
    };
    const existing = await this.em.findOne(WagerTransactionSchema, { id: transaction.id });
    if (existing) {
      // Only a worker's locked pending row may change. Database triggers also enforce this.
      if (existing.status !== "PENDING_REFERENCE") throw new Error("A terminal wager cannot be saved again");
      this.em.assign(existing, state);
      await this.em.flush();
    } else {
      await this.em.persistAndFlush(this.em.create(WagerTransactionSchema, state));
    }
    if (entry) {
      const row = await this.em.findOneOrFail(WalletSchema, { id: wallet.id });
      row.balance = wallet.balance.toString();
      row.version = wallet.version;
      row.updatedAt = wallet.updatedAt;
      await this.em.persistAndFlush(this.em.create(LedgerSchema, {
        id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId,
        currency: entry.money.currency, amount: entry.money.toString(), direction: entry.direction,
        balanceBefore: entry.balanceBefore.toString(), balanceAfter: entry.balanceAfter.toString(),
        createdAt: entry.createdAt,
      }));
      const transfer = AccountingTransfer.fromLedger(entry, transaction.kind);
      await this.em.persistAndFlush(this.em.create(AccountingJournalSchema, {
        ledgerEntryId: transfer.ledgerEntryId, transactionId: transfer.transactionId,
        currency: transfer.money.currency, amount: transfer.money.toString(),
        debitAccountId: transfer.debitAccountId, creditAccountId: transfer.creditAccountId,
        createdAt: transfer.createdAt,
      }));
    }
    await this.em.persistAndFlush(events.map((event) => this.em.create(OutboxSchema, {
      id: event.eventId, aggregateId: event.aggregateId, eventType: event.eventType,
      payload: tracedEnvelope(event.toJSON()), occurredAt: event.occurredAt, attempts: 0, nextAttemptAt: null, publishedAt: null,
    })));
  }
}

export class PostgresWageringStore extends WageringStore {
  constructor(private readonly orm: Awaited<ReturnType<typeof createOrm>>,
    private readonly telemetry: Telemetry = Telemetry.noop) { super(); }

  override findById(id: string) { return this.reader().findById(id); }
  override findByKey(key: string) { return this.reader().findByKey(key); }
  override findByExternal(providerId: string, externalId: string) { return this.reader().findByExternal(providerId, externalId); }

  override async transaction<T>(work: (unit: WagerUnitOfWork) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional((em) => work(new PostgresWagerUnitOfWork(em)), {
        isolationLevel: IsolationLevel.READ_COMMITTED,
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && ["40001", "40P01", "55P03"].includes(String(error.code))) {
        this.telemetry.lockConflict(this.telemetry.context());
      }
      if (error instanceof UniqueConstraintViolationException && "constraint" in error
        && ["wager_transactions_idempotency_unique", "wager_transactions_provider_external_unique"].includes(String(error.constraint))) {
        throw new WagerIdentityConflict("A concurrent request committed this identity", { cause: error });
      }
      if (isDatabaseError(error)) throw new ProcessingError(isTransientDatabaseError(error), error);
      throw error;
    }
  }

  private reader(): PostgresWagerUnitOfWork {
    return new PostgresWagerUnitOfWork(this.orm.em.fork());
  }
}
