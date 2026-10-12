import type { IntegrationEvent } from "../domain/integration-event.js";
import type { InboxMessage } from "../domain/inbox-message.js";
import type { Money } from "../domain/money.js";
import type { WagerFailureCode, WagerKind, WagerTransaction } from "../domain/wager-transaction.js";
import type { Wallet } from "../domain/wallet.js";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry.js";

export interface StoredWager {
  readonly transactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string | null;
  readonly providerId: string | null;
  readonly externalTransactionId: string | null;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | null;
  readonly gameId: string | null;
  readonly kind: "OPENING" | WagerKind;
  readonly status: "PROCESSED" | "REJECTED" | "PENDING_REFERENCE" | "FAILED";
  readonly money: Money;
  readonly balance: Money;
  readonly failureCode: WagerFailureCode | null;
  readonly createdAt: Date;
  readonly processedAt: Date | null;
  readonly referenceExternalTransactionId?: string;
  readonly referenceTransactionId?: string;
  readonly referenceAttempts?: number;
  readonly nextReferenceAttemptAt?: Date;
}

export interface WagerReader {
  findById(id: string): Promise<StoredWager | null>;
  findByKey(key: string): Promise<StoredWager | null>;
  findByExternal(providerId: string, externalId: string): Promise<StoredWager | null>;
}

export interface WagerDecision {
  readonly transaction: WagerTransaction;
  readonly wallet: Wallet;
  readonly entry: WalletLedgerEntry | null;
  readonly events: readonly IntegrationEvent<unknown>[];
  readonly correlationId: string;
  readonly resultBalance: Money;
}

export interface PendingReference {
  readonly transaction: WagerTransaction;
  readonly wallet: Wallet;
  readonly correlationId: string;
  readonly acceptedBalance: Money;
}

export interface WagerUnitOfWork extends WagerReader {
  // Called with the reference's wallet locked; reversal uniqueness is per operation kind.
  hasProcessedReversal(kind: "REFUND" | "ROLLBACK", referenceTransactionId: string): Promise<boolean>;
  claimDueReference(at: Date): Promise<PendingReference | null>;
  lockPendingReference(id: string): Promise<PendingReference | null>;
  claimInbox(message: InboxMessage): Promise<InboxMessage>;
  completeInbox(message: InboxMessage): Promise<void>;
  lockWallet(id: string): Promise<Wallet | null>;
  saveDecision(decision: WagerDecision): Promise<void>;
}

// A uniqueness race rolls back the entire SQL transaction before the application resolves its winner.
export class WagerIdentityConflict extends Error {}

export abstract class WageringStore implements WagerReader {
  abstract findById(id: string): Promise<StoredWager | null>;
  abstract findByKey(key: string): Promise<StoredWager | null>;
  abstract findByExternal(providerId: string, externalId: string): Promise<StoredWager | null>;
  // Inbox, locks, balance, transaction, ledger and outbox share one commit before this resolves.
  abstract transaction<T>(work: (unit: WagerUnitOfWork) => Promise<T>): Promise<T>;
}
