import { DecimalType, EntitySchema } from "@mikro-orm/core";

// Persistence records remain separate from domain classes and their factories.
export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WagerTransactionRecord {
  id: string;
  walletId: string;
  playerId: string;
  currency: string;
  amount: string;
  idempotencyKey: string;
  kind: "OPENING" | "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
  status: "PENDING_REFERENCE" | "PROCESSED" | "REJECTED" | "FAILED";
  providerId?: string | null;
  externalTransactionId?: string | null;
  roundId?: string | null;
  gameId?: string | null;
  payloadHash?: string | null;
  failureCode?: "INSUFFICIENT_FUNDS" | "BALANCE_LIMIT_EXCEEDED" | "REFERENCE_MISMATCH"
    | "REFERENCE_KIND_MISMATCH" | "REFERENCE_NOT_PROCESSED" | "REFERENCE_NOT_FOUND"
    | "REFERENCE_AMOUNT_MISMATCH" | "REFERENCE_ALREADY_REFUNDED" | "REFERENCE_ALREADY_ROLLED_BACK"
    | "REVERSAL_INSUFFICIENT_FUNDS" | "DATABASE_OPERATION_FAILED" | null;
  resultBalance?: string | null;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  referenceAttempts?: number;
  nextReferenceAttemptAt?: Date | null;
  processingCorrelationId?: string | null;
  createdAt: Date;
  processedAt: Date | null;
}

export interface LedgerRecord {
  id: string;
  walletId: string;
  transactionId: string;
  transactionStatus?: "PROCESSED";
  currency: string;
  direction: "CREDIT" | "DEBIT";
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export interface OutboxRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}

export interface AccountingAccountRecord {
  id: string;
  kind: "WALLET_LIABILITY" | "HOUSE_SETTLEMENT" | "OPENING_CLEARING";
  walletId: string | null;
  currency: string;
}

export interface AccountingJournalRecord {
  ledgerEntryId: string;
  transactionId: string;
  currency: string;
  amount: string;
  debitAccountId: string;
  creditAccountId: string;
  createdAt: Date;
}

export interface InboxRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
  transactionId: string | null;
}

class ExactDecimalType extends DecimalType<"string"> {
  constructor() {
    super("string");
  }

  // MikroORM's default decimal dirty check uses Number internally. Both Money and
  // numeric(20,2) produce canonical strings, so exact comparison preserves cents.
  override compareValues(a: string, b: string): boolean {
    return a === b;
  }
}

const amount = () => ({ type: new ExactDecimalType(), precision: 20, scale: 2 });
const timestamp = () => ({ type: Date, columnType: "timestamptz(3)" });

export const WalletSchema = new EntitySchema<WalletRecord>({
  name: "WalletRecord",
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "uuid" },
    currency: { type: "string", length: 3 },
    balance: amount(),
    version: { type: "integer" },
    createdAt: timestamp(),
    updatedAt: timestamp(),
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: "WagerTransactionRecord",
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid" },
    playerId: { type: "uuid" },
    currency: { type: "string", length: 3 },
    amount: amount(),
    idempotencyKey: { type: "text" },
    kind: { type: "text" },
    status: { type: "text" },
    providerId: { type: "text", nullable: true },
    externalTransactionId: { type: "text", nullable: true },
    roundId: { type: "text", nullable: true },
    gameId: { type: "text", nullable: true },
    payloadHash: { type: "text", nullable: true },
    failureCode: { type: "text", nullable: true },
    resultBalance: { ...amount(), nullable: true },
    referenceExternalTransactionId: { type: "text", nullable: true },
    referenceTransactionId: { type: "uuid", nullable: true },
    referenceAttempts: { type: "integer", default: 0 },
    nextReferenceAttemptAt: { ...timestamp(), nullable: true },
    processingCorrelationId: { type: "text", nullable: true },
    createdAt: timestamp(),
    processedAt: { ...timestamp(), nullable: true },
  },
});

export const LedgerSchema = new EntitySchema<LedgerRecord>({
  name: "LedgerRecord",
  tableName: "wallet_ledger",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid" },
    transactionId: { type: "uuid" },
    transactionStatus: { type: "text", default: "PROCESSED" },
    currency: { type: "string", length: 3 },
    direction: { type: "text" },
    amount: amount(),
    balanceBefore: amount(),
    balanceAfter: amount(),
    createdAt: timestamp(),
  },
});

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  name: "OutboxRecord",
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "uuid" },
    eventType: { type: "text" },
    payload: { type: "json", columnType: "jsonb" },
    occurredAt: timestamp(),
    attempts: { type: "integer", default: 0 },
    nextAttemptAt: { ...timestamp(), nullable: true },
    publishedAt: { ...timestamp(), nullable: true },
  },
});

export const AccountingAccountSchema = new EntitySchema<AccountingAccountRecord>({
  name: "AccountingAccountRecord",
  tableName: "accounting_accounts",
  properties: {
    id: { type: "text", primary: true },
    kind: { type: "text" },
    walletId: { type: "uuid", nullable: true },
    currency: { type: "string", length: 3 },
  },
});

export const AccountingJournalSchema = new EntitySchema<AccountingJournalRecord>({
  name: "AccountingJournalRecord",
  tableName: "accounting_journal",
  properties: {
    ledgerEntryId: { type: "uuid", primary: true },
    transactionId: { type: "uuid" },
    currency: { type: "string", length: 3 },
    amount: amount(),
    debitAccountId: { type: "text" },
    creditAccountId: { type: "text" },
    createdAt: timestamp(),
  },
});

export const InboxSchema = new EntitySchema<InboxRecord>({
  name: "InboxRecord",
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "text", primary: true },
    messageId: { type: "text", primary: true },
    payloadHash: { type: "text" },
    receivedAt: timestamp(),
    processedAt: { ...timestamp(), nullable: true },
    transactionId: { type: "uuid", nullable: true },
  },
});
