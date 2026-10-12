import { QueryOrder, UniqueConstraintViolationException } from "@mikro-orm/core";
import { ApplicationError } from "../../application/application-error.js";
import { WalletStore, type LedgerPosition, type WalletOpening } from "../../application/wallet-store.js";
import { Money } from "../../domain/money.js";
import { AccountingTransfer } from "../../domain/accounting-transfer.js";
import { Wallet } from "../../domain/wallet.js";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry.js";
import { AccountingAccountSchema, AccountingJournalSchema, LedgerSchema, WagerTransactionSchema, OutboxSchema, WalletSchema } from "./entities.js";
import type { createOrm } from "./orm.js";
import { tracedEnvelope } from "../observability/tracing.js";

export class PostgresWalletStore extends WalletStore {
  constructor(private readonly orm: Awaited<ReturnType<typeof createOrm>>) {
    super();
  }

  override async saveOpening({ wallet, credit }: WalletOpening): Promise<void> {
    try {
      await this.orm.em.fork().transactional(async (em) => {
        const walletRecord = em.create(WalletSchema, {
          id: wallet.id, playerId: wallet.playerId, currency: wallet.currency,
          balance: wallet.balance.toString(), version: wallet.version,
          createdAt: wallet.createdAt, updatedAt: wallet.updatedAt,
        });
        // Scalar persistence records need explicit FK order; each flush stays in this transaction.
        await em.persistAndFlush(walletRecord);
        await em.persistAndFlush(em.create(AccountingAccountSchema, {
          id: `wallet:${wallet.id}`, kind: "WALLET_LIABILITY", walletId: wallet.id, currency: wallet.currency,
        }));
        if (!credit) return;

        const { transaction, entry, events } = credit;
        await em.persistAndFlush(em.create(WagerTransactionSchema, {
          id: transaction.id, walletId: transaction.walletId, playerId: transaction.playerId,
          currency: transaction.money.currency, amount: transaction.money.toString(),
          idempotencyKey: transaction.idempotencyKey, kind: transaction.kind, status: transaction.status,
          createdAt: transaction.createdAt, processedAt: transaction.processedAt,
        }));
        await em.persistAndFlush(em.create(LedgerSchema, {
          id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId,
          currency: entry.money.currency, direction: entry.direction, amount: entry.money.toString(),
          balanceBefore: entry.balanceBefore.toString(), balanceAfter: entry.balanceAfter.toString(),
          createdAt: entry.createdAt,
        }));
        const transfer = AccountingTransfer.fromLedger(entry, transaction.kind);
        await em.persistAndFlush(em.create(AccountingJournalSchema, {
          ledgerEntryId: transfer.ledgerEntryId, transactionId: transfer.transactionId,
          currency: transfer.money.currency, amount: transfer.money.toString(),
          debitAccountId: transfer.debitAccountId, creditAccountId: transfer.creditAccountId,
          createdAt: transfer.createdAt,
        }));
        await em.persistAndFlush(events.map((event) => em.create(OutboxSchema, {
          id: event.eventId, aggregateId: event.aggregateId, eventType: event.eventType,
          payload: tracedEnvelope(event.toJSON()), occurredAt: event.occurredAt,
          attempts: 0, nextAttemptAt: null, publishedAt: null,
        })));
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException &&
        "constraint" in error && error.constraint === "wallets_player_currency_unique") {
        throw new ApplicationError("WALLET_ALREADY_EXISTS", "A wallet already exists for this player and currency");
      }
      throw error;
    }
  }

  override async findWallet(id: string): Promise<Wallet | null> {
    const record = await this.orm.em.fork().findOne(WalletSchema, { id });
    if (!record) return null;
    return Wallet.rehydrate({
      id: record.id, playerId: record.playerId,
      balance: Money.from({ amount: record.balance, currency: record.currency }),
      version: record.version, createdAt: record.createdAt, updatedAt: record.updatedAt,
    });
  }

  override async listLedger(walletId: string, limit: number, after?: LedgerPosition): Promise<WalletLedgerEntry[]> {
    const records = await this.orm.em.fork().find(LedgerSchema, {
      walletId,
      ...(after ? { $or: [
        { createdAt: { $gt: after.createdAt } },
        { createdAt: after.createdAt, id: { $gt: after.id } },
      ] } : {}),
    }, { orderBy: { createdAt: QueryOrder.ASC, id: QueryOrder.ASC }, limit });
    return records.map((record) => WalletLedgerEntry.rehydrate({
      id: record.id, walletId: record.walletId, transactionId: record.transactionId,
      direction: record.direction,
      money: Money.from({ amount: record.amount, currency: record.currency }),
      balanceBefore: Money.from({ amount: record.balanceBefore, currency: record.currency }),
      balanceAfter: Money.from({ amount: record.balanceAfter, currency: record.currency }),
      createdAt: record.createdAt,
    }));
  }

  override async listAccountingTransfers(walletId: string, limit: number, after?: LedgerPosition): Promise<AccountingTransfer[]> {
    const accountId = `wallet:${walletId}`;
    const records = await this.orm.em.fork().find(AccountingJournalSchema, {
      $and: [
        { $or: [{ debitAccountId: accountId }, { creditAccountId: accountId }] },
        ...(after ? [{ $or: [
          { createdAt: { $gt: after.createdAt } },
          { createdAt: after.createdAt, ledgerEntryId: { $gt: after.id } },
        ] }] : []),
      ],
    }, { orderBy: { createdAt: QueryOrder.ASC, ledgerEntryId: QueryOrder.ASC }, limit });
    return records.map((record) => AccountingTransfer.rehydrate({
      ledgerEntryId: record.ledgerEntryId, transactionId: record.transactionId, walletId,
      money: Money.from({ amount: record.amount, currency: record.currency }),
      debitAccountId: record.debitAccountId, creditAccountId: record.creditAccountId, createdAt: record.createdAt,
    }));
  }
}
