import { DomainError } from "./domain-error.js";
import type { Money } from "./money.js";
import type { Wallet } from "./wallet.js";

export interface OpeningTransactionState {
  readonly id: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly money: Money;
  readonly createdAt: Date;
  readonly processedAt: Date;
}

export class OpeningTransaction {
  readonly id: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly money: Money;
  readonly kind = "OPENING";
  readonly status = "PROCESSED";
  readonly #createdAt: Date;
  readonly #processedAt: Date;

  private constructor(state: OpeningTransactionState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.money = state.money;
    this.#createdAt = new Date(state.createdAt);
    this.#processedAt = new Date(state.processedAt);
    Object.freeze(this);
  }

  static create(props: { id: string; wallet: Wallet; createdAt: Date }): OpeningTransaction {
    if (!props.wallet.balance.isPositive()) {
      throw new DomainError("OPENING_REQUIRES_POSITIVE_BALANCE", "An opening credit requires a positive balance");
    }

    return new OpeningTransaction({
      id: props.id,
      walletId: props.wallet.id,
      playerId: props.wallet.playerId,
      money: props.wallet.balance,
      createdAt: props.createdAt,
      processedAt: props.createdAt,
    });
  }

  static rehydrate(state: OpeningTransactionState): OpeningTransaction {
    return new OpeningTransaction(state);
  }

  get idempotencyKey(): string {
    return `opening:${this.walletId}`;
  }

  get createdAt(): Date {
    return new Date(this.#createdAt);
  }

  get processedAt(): Date {
    return new Date(this.#processedAt);
  }
}
