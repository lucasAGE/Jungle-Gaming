import { DomainError } from "./domain-error.js";
import type { Money } from "./money.js";
import type { LedgerDirection } from "./wallet-ledger-entry.js";

export type WagerTransactionStatus = "PENDING" | "PENDING_REFERENCE" | "PROCESSED" | "REJECTED" | "FAILED";
export type WagerKind = "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
export type WagerFailureCode = "INSUFFICIENT_FUNDS" | "BALANCE_LIMIT_EXCEEDED" |
  "REFERENCE_MISMATCH" | "REFERENCE_KIND_MISMATCH" | "REFERENCE_NOT_PROCESSED" | "REFERENCE_NOT_FOUND" |
  "REFERENCE_AMOUNT_MISMATCH" | "REFERENCE_ALREADY_REFUNDED" |
  "REFERENCE_ALREADY_ROLLED_BACK" | "REVERSAL_INSUFFICIENT_FUNDS" | "DATABASE_OPERATION_FAILED";

export const maxReferenceAttempts = 10;

export interface WagerReference {
  readonly id: string;
  readonly providerId: string | null;
  readonly playerId: string;
  readonly walletId: string;
  readonly currency: string;
  readonly money: Money;
  readonly roundId: string | null;
  readonly kind: string;
  readonly status: string;
}

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly status: WagerTransactionStatus;
  readonly failureCode?: WagerFailureCode;
  readonly processedAt?: Date;
  readonly referenceTransactionId?: string;
  readonly referenceAttempts?: number;
  readonly nextReferenceAttemptAt?: Date;
}

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly #createdAt: Date;
  #status: WagerTransactionStatus;
  #failureCode: WagerFailureCode | undefined;
  #processedAt: Date | undefined;
  #referenceTransactionId: string | undefined;
  #referenceAttempts: number;
  #nextReferenceAttemptAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    if (state.referenceExternalTransactionId !== undefined) {
      this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    }
    this.#createdAt = new Date(state.createdAt);
    this.#status = state.status;
    this.#failureCode = state.failureCode;
    this.#processedAt = state.processedAt === undefined ? undefined : new Date(state.processedAt);
    this.#referenceTransactionId = state.referenceTransactionId;
    this.#referenceAttempts = state.referenceAttempts ?? 0;
    this.#nextReferenceAttemptAt = state.nextReferenceAttemptAt === undefined
      ? undefined : new Date(state.nextReferenceAttemptAt);
    // Public identity is immutable; only explicit transitions may change private state.
    Object.freeze(this);
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if ((props.kind === "REFUND" || props.kind === "ROLLBACK") && !props.referenceExternalTransactionId) {
      throw new DomainError("REFERENCE_REQUIRED", `A ${props.kind.toLowerCase()} requires a reference`);
    }
    if (props.referenceExternalTransactionId !== undefined) {
      if (props.kind !== "WIN" && props.kind !== "REFUND" && props.kind !== "ROLLBACK") {
        throw new DomainError("REFERENCE_NOT_ALLOWED", "Only a win, refund or rollback may reference another transaction");
      }
      if (props.referenceExternalTransactionId === props.externalTransactionId) {
        throw new DomainError("SELF_REFERENCE", "A transaction cannot reference itself");
      }
    }
    if (props.kind === "LOSS") {
      if (!props.money.isZero()) {
        throw new DomainError("LOSS_REQUIRES_ZERO_AMOUNT", "A loss requires a zero amount");
      }
    } else if (!props.money.isPositive()) {
      throw new DomainError(
        `${props.kind}_REQUIRES_POSITIVE_AMOUNT`,
        `A ${props.kind.toLowerCase()} requires a positive amount`,
      );
    }
    return new WagerTransaction({ ...props, status: "PENDING" });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this.#status;
  }

  get failureCode(): WagerFailureCode | undefined {
    return this.#failureCode;
  }

  get createdAt(): Date {
    return new Date(this.#createdAt);
  }

  get processedAt(): Date | undefined {
    return this.#processedAt === undefined ? undefined : new Date(this.#processedAt);
  }

  get referenceTransactionId(): string | undefined {
    return this.#referenceTransactionId;
  }

  get referenceAttempts(): number {
    return this.#referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this.#nextReferenceAttemptAt === undefined ? undefined : new Date(this.#nextReferenceAttemptAt);
  }

  markProcessed(at: Date, referenceTransactionId?: string): void {
    this.assertActive();
    if (this.referenceExternalTransactionId !== undefined) {
      if (referenceTransactionId === undefined || referenceTransactionId.length === 0 || referenceTransactionId === this.id) {
        throw new DomainError("INVALID_REFERENCE", "A referenced transaction requires a distinct resolved transaction");
      }
    } else if (referenceTransactionId !== undefined) {
      throw new DomainError("INVALID_REFERENCE", "An unreferenced transaction cannot have a resolved reference");
    }
    this.#status = "PROCESSED";
    this.#processedAt = new Date(at);
    this.#referenceTransactionId = referenceTransactionId;
    this.#nextReferenceAttemptAt = undefined;
  }

  markPendingReference(at: Date): void {
    this.assertActive();
    if (this.#status !== "PENDING" || (this.kind !== "WIN" && this.kind !== "REFUND" && this.kind !== "ROLLBACK") ||
      this.referenceExternalTransactionId === undefined) {
      throw new DomainError("INVALID_TRANSACTION_STATE", "Only a new referenced transaction can await a reference");
    }
    this.#status = "PENDING_REFERENCE";
    this.#nextReferenceAttemptAt = new Date(at.getTime() + 1_000);
  }

  retryMissingReference(at: Date): void {
    this.assertActive();
    if (this.#status !== "PENDING_REFERENCE") {
      throw new DomainError("INVALID_TRANSACTION_STATE", "Only a pending reference can be retried");
    }
    this.#referenceAttempts += 1;
    if (this.#referenceAttempts >= maxReferenceAttempts) {
      this.reject("REFERENCE_NOT_FOUND");
      return;
    }
    // The initial lookup is not a retry; persisted attempts bound recovery across restarts.
    const delaySeconds = Math.min(60, 2 ** this.#referenceAttempts);
    this.#nextReferenceAttemptAt = new Date(at.getTime() + delaySeconds * 1_000);
  }

  reject(code: WagerFailureCode): void {
    this.assertActive();
    if (
      !(this.kind === "BET" && code === "INSUFFICIENT_FUNDS") &&
      !((this.kind === "WIN" || this.kind === "REFUND" || this.kind === "ROLLBACK") && code === "BALANCE_LIMIT_EXCEEDED") &&
      !(this.kind === "REFUND" && this.referenceExternalTransactionId !== undefined && code === "REFERENCE_ALREADY_REFUNDED") &&
      !(this.kind === "ROLLBACK" && this.referenceExternalTransactionId !== undefined && [
        "REFERENCE_ALREADY_ROLLED_BACK", "REVERSAL_INSUFFICIENT_FUNDS",
      ].includes(code)) &&
      !(this.requiresReference() && this.referenceExternalTransactionId !== undefined && code === "REFERENCE_AMOUNT_MISMATCH") &&
      !((this.kind === "WIN" || this.requiresReference()) && this.referenceExternalTransactionId !== undefined && [
        "REFERENCE_MISMATCH", "REFERENCE_KIND_MISMATCH", "REFERENCE_NOT_PROCESSED", "REFERENCE_NOT_FOUND",
      ].includes(code) && (code !== "REFERENCE_NOT_FOUND" || (
        this.#status === "PENDING_REFERENCE" && this.#referenceAttempts === maxReferenceAttempts
      )))
    ) {
      throw new DomainError("INVALID_REJECTION_REASON", "The rejection reason does not apply to this transaction kind");
    }
    this.#status = "REJECTED";
    this.#failureCode = code;
    this.#nextReferenceAttemptAt = undefined;
  }

  referenceFailure(reference: WagerReference): WagerFailureCode | undefined {
    if ((this.kind !== "WIN" && !this.requiresReference()) || this.referenceExternalTransactionId === undefined) {
      throw new DomainError("REFERENCE_NOT_ALLOWED", "Only a referenced transaction can validate a reference");
    }
    if (
      reference.id === this.id ||
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.currency !== this.money.currency ||
      reference.money.currency !== this.money.currency ||
      reference.roundId !== this.roundId
    ) return "REFERENCE_MISMATCH";
    const allowedKind = this.kind === "ROLLBACK"
      ? reference.kind === "BET" || reference.kind === "WIN" || reference.kind === "REFUND"
      : reference.kind === "BET";
    if (!allowedKind) return "REFERENCE_KIND_MISMATCH";
    if (reference.status !== "PROCESSED") return "REFERENCE_NOT_PROCESSED";
    if (this.requiresReference() && !this.money.equals(reference.money)) return "REFERENCE_AMOUNT_MISMATCH";
    return undefined;
  }

  fail(code: WagerFailureCode): void {
    this.assertActive();
    if (code !== "DATABASE_OPERATION_FAILED") {
      throw new DomainError("INVALID_FAILURE_REASON", "Only a permanent infrastructure failure can fail a wager");
    }
    this.#status = "FAILED";
    this.#failureCode = code;
    this.#nextReferenceAttemptAt = undefined;
  }

  requiresReference(): boolean {
    return this.kind === "REFUND" || this.kind === "ROLLBACK";
  }

  ledgerDirectionFor(reference?: WagerReference): LedgerDirection | null {
    if (this.kind === "LOSS") return null;
    if (this.kind === "BET") return "DEBIT";
    if (this.kind !== "ROLLBACK") return "CREDIT";
    if (reference === undefined || this.referenceFailure(reference) !== undefined ||
      (this.referenceTransactionId !== undefined && reference.id !== this.referenceTransactionId)) {
      throw new DomainError("INVALID_REFERENCE", "A rollback requires its matching processed reference to determine direction");
    }
    return reference.kind === "BET" ? "CREDIT" : "DEBIT";
  }

  isTerminal(): boolean {
    return this.#status === "PROCESSED" || this.#status === "REJECTED" || this.#status === "FAILED";
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  affectsBalance(): boolean {
    return this.kind !== "LOSS";
  }

  private assertActive(): void {
    if (this.isTerminal()) {
      throw new DomainError("INVALID_TRANSACTION_STATE", "A terminal transaction cannot change state");
    }
  }
}
