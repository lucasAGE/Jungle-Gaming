import { DomainError } from "./domain-error.js";
import { MoneyError, type MoneyProps } from "./money.js";
import type { OpeningTransaction } from "./opening-transaction.js";
import type { Wallet } from "./wallet.js";
import type { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry.js";
import type { WagerFailureCode, WagerKind, WagerReference, WagerTransaction } from "./wager-transaction.js";

export interface IntegrationEventProps<T> {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: T;
}

export interface IntegrationEventEnvelope<T> {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: string;
  readonly version: number;
  readonly data: T;
}

// Event payloads are DTOs: take a snapshot and freeze nested money objects too.
function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freezeSnapshot(nested);
    Object.freeze(value);
  }
  return value;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly data: Readonly<T>;
  readonly #occurredAt: Date;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    if (props.causationId !== undefined) this.causationId = props.causationId;
    this.#occurredAt = new Date(props.occurredAt);
    this.data = freezeSnapshot(structuredClone(props.data));
  }

  get occurredAt(): Date {
    return new Date(this.#occurredAt);
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.#occurredAt.toISOString(),
      version: this.version,
      data: structuredClone(this.data) as T,
    };
  }
}

interface OpeningEventProps {
  readonly eventId: string;
  readonly correlationId: string;
  readonly transaction: OpeningTransaction;
  readonly wallet: Wallet;
  readonly entry: WalletLedgerEntry;
}

function assertOpeningState({ transaction, wallet, entry }: OpeningEventProps): void {
  if (
    transaction.walletId !== wallet.id ||
    transaction.playerId !== wallet.playerId ||
    entry.walletId !== wallet.id ||
    entry.transactionId !== transaction.id ||
    entry.direction !== "CREDIT" ||
    !entry.balanceBefore.isZero() ||
    !entry.money.equals(transaction.money) ||
    !entry.balanceAfter.equals(wallet.balance) ||
    !entry.isBalanced()
  ) {
    throw new DomainError("EVENT_STATE_MISMATCH", "Opening event records must describe the same balance change");
  }
}

interface WagerEventProps {
  readonly eventId: string;
  readonly correlationId: string;
  readonly transaction: WagerTransaction;
  readonly wallet: Wallet;
  readonly entry: WalletLedgerEntry | null;
  readonly reference?: WagerReference;
}

function assertProcessedWagerState({ transaction, wallet, entry, reference }: WagerEventProps): Date {
  const processedAt = transaction.processedAt;
  if (
    transaction.status !== "PROCESSED" ||
    processedAt === undefined ||
    transaction.walletId !== wallet.id ||
    transaction.playerId !== wallet.playerId ||
    transaction.money.currency !== wallet.currency ||
    (transaction.requiresReference() && transaction.referenceExternalTransactionId === undefined) ||
    (transaction.referenceExternalTransactionId !== undefined && (
      (transaction.kind !== "WIN" && !transaction.requiresReference()) || transaction.referenceTransactionId === undefined ||
      transaction.referenceTransactionId.length === 0 || transaction.referenceTransactionId === transaction.id
    )) ||
    (transaction.referenceExternalTransactionId === undefined && transaction.referenceTransactionId !== undefined) ||
    (transaction.kind === "ROLLBACK" && (reference === undefined ||
      reference.id !== transaction.referenceTransactionId || transaction.referenceFailure(reference) !== undefined))
  ) {
    throw new DomainError("EVENT_STATE_MISMATCH", "Wager event records must describe the same processed operation");
  }

  const matchesEffect = transaction.kind === "LOSS"
    ? transaction.money.isZero() && entry === null
    : entry !== null &&
      entry.walletId === wallet.id &&
      entry.transactionId === transaction.id &&
      entry.direction === transaction.ledgerDirectionFor(reference) &&
      entry.money.equals(transaction.money) &&
      entry.balanceAfter.equals(wallet.balance) &&
      entry.isBalanced();
  if (!matchesEffect) {
    throw new DomainError("EVENT_STATE_MISMATCH", "Wager event records must describe the same processed operation");
  }
  return processedAt;
}

export interface WagerTransactionProcessedData {
  readonly transactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly kind: "OPENING" | WagerKind;
  readonly status: "PROCESSED";
  readonly providerId?: string;
  readonly externalTransactionId?: string;
  readonly roundId?: string;
  readonly gameId?: string;
  readonly referenceExternalTransactionId?: string;
  readonly referenceTransactionId?: string;
  readonly money: MoneyProps;
  readonly balance: MoneyProps;
  readonly walletVersion: number;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
    Object.freeze(this);
  }

  static opening(props: OpeningEventProps): WagerTransactionProcessed {
    assertOpeningState(props);
    const { transaction, wallet } = props;
    return new WagerTransactionProcessed({
      eventId: props.eventId,
      aggregateId: wallet.id,
      correlationId: props.correlationId,
      causationId: transaction.id,
      occurredAt: transaction.createdAt,
      data: {
        transactionId: transaction.id,
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: transaction.kind,
        status: transaction.status,
        money: transaction.money.toJSON(),
        balance: wallet.balance.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }

  static wager(props: WagerEventProps): WagerTransactionProcessed {
    const processedAt = assertProcessedWagerState(props);
    const { transaction, wallet } = props;
    return new WagerTransactionProcessed({
      eventId: props.eventId,
      aggregateId: wallet.id,
      correlationId: props.correlationId,
      causationId: transaction.id,
      occurredAt: processedAt,
      data: {
        transactionId: transaction.id,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        ...referenceData(transaction),
        kind: transaction.kind,
        status: "PROCESSED",
        money: transaction.money.toJSON(),
        balance: wallet.balance.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
    Object.freeze(this);
  }

  static opening(props: OpeningEventProps): WalletBalanceChanged {
    assertOpeningState(props);
    const { transaction, wallet, entry } = props;
    return new WalletBalanceChanged({
      eventId: props.eventId,
      aggregateId: wallet.id,
      correlationId: props.correlationId,
      causationId: transaction.id,
      occurredAt: transaction.createdAt,
      data: {
        walletId: wallet.id,
        transactionId: transaction.id,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }

  static wager(props: WagerEventProps & { readonly entry: WalletLedgerEntry }): WalletBalanceChanged {
    const processedAt = assertProcessedWagerState(props);
    const { transaction, wallet, entry } = props;
    return new WalletBalanceChanged({
      eventId: props.eventId,
      aggregateId: wallet.id,
      correlationId: props.correlationId,
      causationId: transaction.id,
      occurredAt: processedAt,
      data: {
        walletId: wallet.id,
        transactionId: transaction.id,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

export interface WagerTransactionRejectedData {
  readonly transactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly referenceExternalTransactionId?: string;
  readonly referenceTransactionId?: string;
  readonly kind: WagerKind;
  readonly status: "REJECTED";
  readonly failureCode: WagerFailureCode;
  readonly money: MoneyProps;
  readonly balance: MoneyProps;
  readonly walletVersion: number;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
    Object.freeze(this);
  }

  static wager(props: Omit<WagerEventProps, "entry"> & { readonly occurredAt?: Date }): WagerTransactionRejected {
    const { transaction, wallet } = props;
    const failureCode = transaction.failureCode;
    if (
      transaction.status !== "REJECTED" ||
      failureCode === undefined ||
      transaction.walletId !== wallet.id ||
      transaction.playerId !== wallet.playerId ||
      transaction.money.currency !== wallet.currency ||
      !matchesRejection(transaction, wallet, props.reference)
    ) {
      throw new DomainError("EVENT_STATE_MISMATCH", "Rejected wager records must describe the same balance rule violation");
    }
    return new WagerTransactionRejected({
      eventId: props.eventId,
      aggregateId: wallet.id,
      correlationId: props.correlationId,
      causationId: transaction.id,
      occurredAt: props.occurredAt ?? transaction.createdAt,
      data: {
        transactionId: transaction.id,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        ...referenceData(transaction),
        kind: transaction.kind,
        status: "REJECTED",
        failureCode,
        money: transaction.money.toJSON(),
        balance: wallet.balance.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

function matchesRejection(transaction: WagerTransaction, wallet: Wallet, reference?: WagerReference): boolean {
  if (transaction.requiresReference() && transaction.referenceExternalTransactionId === undefined) return false;
  if (transaction.requiresReference() && transaction.failureCode === "REFERENCE_AMOUNT_MISMATCH") return true;
  if (transaction.kind === "REFUND" && transaction.failureCode === "REFERENCE_ALREADY_REFUNDED") return true;
  if (transaction.kind === "ROLLBACK" && transaction.failureCode === "REFERENCE_ALREADY_ROLLED_BACK") return true;
  if ((transaction.kind === "WIN" || transaction.requiresReference()) && transaction.referenceExternalTransactionId !== undefined && [
    "REFERENCE_MISMATCH", "REFERENCE_KIND_MISMATCH", "REFERENCE_NOT_PROCESSED", "REFERENCE_NOT_FOUND",
  ].includes(transaction.failureCode ?? "")) return true;
  if (transaction.kind === "BET" && transaction.failureCode === "INSUFFICIENT_FUNDS") {
    return wallet.balance.isLessThan(transaction.money);
  }
  if (transaction.kind === "ROLLBACK" && transaction.failureCode === "REVERSAL_INSUFFICIENT_FUNDS") {
    return reference !== undefined && transaction.referenceFailure(reference) === undefined &&
      (reference.kind === "WIN" || reference.kind === "REFUND") && wallet.balance.isLessThan(transaction.money);
  }
  const isCredit = transaction.kind === "WIN" || transaction.kind === "REFUND" ||
    (transaction.kind === "ROLLBACK" && reference !== undefined && reference.kind === "BET" &&
      transaction.referenceFailure(reference) === undefined);
  if (isCredit && transaction.failureCode === "BALANCE_LIMIT_EXCEEDED") {
    try {
      wallet.balance.add(transaction.money);
    } catch (error) {
      if (error instanceof MoneyError && error.code === "MONEY_OUT_OF_RANGE") return true;
      throw error;
    }
  }
  return false;
}

export interface WagerTransactionFailedData extends Omit<WagerTransactionRejectedData, "status"> {
  readonly status: "FAILED";
}

export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = "WagerTransactionFailed";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionFailedData>) {
    super(props);
    Object.freeze(this);
  }

  static wager(props: Omit<WagerEventProps, "entry"> & { readonly occurredAt: Date }): WagerTransactionFailed {
    const { transaction, wallet } = props;
    if (transaction.status !== "FAILED" || transaction.failureCode !== "DATABASE_OPERATION_FAILED" ||
      transaction.processedAt !== undefined || transaction.referenceTransactionId !== undefined ||
      transaction.nextReferenceAttemptAt !== undefined || transaction.walletId !== wallet.id ||
      transaction.playerId !== wallet.playerId || transaction.money.currency !== wallet.currency) {
      throw new DomainError("EVENT_STATE_MISMATCH", "Failed wager records must describe the same unapplied operation");
    }
    return new WagerTransactionFailed({
      eventId: props.eventId, aggregateId: wallet.id, correlationId: props.correlationId,
      causationId: transaction.id, occurredAt: props.occurredAt,
      data: {
        transactionId: transaction.id, walletId: wallet.id, playerId: wallet.playerId,
        providerId: transaction.providerId, externalTransactionId: transaction.externalTransactionId,
        roundId: transaction.roundId, gameId: transaction.gameId, ...referenceData(transaction),
        kind: transaction.kind, status: "FAILED", failureCode: transaction.failureCode,
        money: transaction.money.toJSON(), balance: wallet.balance.toJSON(), walletVersion: wallet.version,
      },
    });
  }
}

function referenceData(transaction: WagerTransaction) {
  return {
    ...(transaction.referenceExternalTransactionId === undefined
      ? {} : { referenceExternalTransactionId: transaction.referenceExternalTransactionId }),
    ...(transaction.referenceTransactionId === undefined
      ? {} : { referenceTransactionId: transaction.referenceTransactionId }),
  };
}

export interface WagerTransactionPendingReferenceData {
  readonly transactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly referenceExternalTransactionId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: "WIN" | "REFUND" | "ROLLBACK";
  readonly status: "PENDING_REFERENCE";
  readonly money: MoneyProps;
  readonly balance: MoneyProps;
  readonly walletVersion: number;
  readonly referenceAttempts: number;
  readonly nextReferenceAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
    Object.freeze(this);
  }

  static wager(props: Omit<WagerEventProps, "entry">): WagerTransactionPendingReference {
    const { transaction, wallet } = props;
    const referenceExternalTransactionId = transaction.referenceExternalTransactionId;
    const nextReferenceAttemptAt = transaction.nextReferenceAttemptAt;
    if (
      transaction.status !== "PENDING_REFERENCE" ||
      (transaction.kind !== "WIN" && transaction.kind !== "REFUND" && transaction.kind !== "ROLLBACK") ||
      referenceExternalTransactionId === undefined || nextReferenceAttemptAt === undefined ||
      transaction.referenceTransactionId !== undefined || transaction.referenceAttempts !== 0 ||
      transaction.walletId !== wallet.id || transaction.playerId !== wallet.playerId ||
      transaction.money.currency !== wallet.currency
    ) {
      throw new DomainError("EVENT_STATE_MISMATCH", "Pending reference records must describe the initial deferred transaction");
    }
    return new WagerTransactionPendingReference({
      eventId: props.eventId,
      aggregateId: wallet.id,
      correlationId: props.correlationId,
      causationId: transaction.id,
      occurredAt: transaction.createdAt,
      data: {
        transactionId: transaction.id,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        referenceExternalTransactionId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        status: "PENDING_REFERENCE",
        money: transaction.money.toJSON(),
        balance: wallet.balance.toJSON(),
        walletVersion: wallet.version,
        referenceAttempts: transaction.referenceAttempts,
        nextReferenceAttemptAt: nextReferenceAttemptAt.toISOString(),
      },
    });
  }
}
