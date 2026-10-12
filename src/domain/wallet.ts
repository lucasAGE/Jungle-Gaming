import { DomainError } from "./domain-error.js";
import { type Money, MoneyError } from "./money.js";
import { WalletLedgerEntry } from "./wallet-ledger-entry.js";

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly balance: Money;
  readonly version: number;
  readonly #createdAt: Date;
  readonly #updatedAt: Date;

  private constructor(state: WalletState) {
    this.id = state.id;
    this.playerId = state.playerId;
    this.balance = state.balance;
    this.version = state.version;
    this.#createdAt = new Date(state.createdAt);
    this.#updatedAt = new Date(state.updatedAt);
    Object.freeze(this);
  }

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    createdAt: Date;
  }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new DomainError("WALLET_NEGATIVE_BALANCE", "A wallet cannot open with a negative balance");
    }

    return new Wallet({
      id: props.id,
      playerId: props.playerId,
      balance: props.initialBalance,
      version: 1,
      createdAt: props.createdAt,
      updatedAt: props.createdAt,
    });
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state);
  }

  debit(props: {
    money: Money;
    transactionId: string;
    entryId: string;
    at: Date;
  }): { readonly wallet: Wallet; readonly entry: WalletLedgerEntry } {
    if (!props.money.isPositive()) {
      throw new DomainError("BET_REQUIRES_POSITIVE_AMOUNT", "A bet requires a positive amount");
    }
    // Money compares only matching currencies, before any balance change is created.
    if (this.balance.isLessThan(props.money)) {
      throw new DomainError("INSUFFICIENT_FUNDS", "The wallet has insufficient funds for this bet");
    }

    const balance = this.balance.subtract(props.money);
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: "DEBIT",
      money: props.money,
      balanceBefore: this.balance,
      balanceAfter: balance,
      createdAt: props.at,
    });
    const wallet = new Wallet({
      id: this.id,
      playerId: this.playerId,
      balance,
      version: this.version + 1,
      createdAt: this.#createdAt,
      updatedAt: props.at,
    });
    return { wallet, entry };
  }

  credit(props: {
    money: Money;
    transactionId: string;
    entryId: string;
    at: Date;
  }): { readonly wallet: Wallet; readonly entry: WalletLedgerEntry } {
    if (!props.money.isPositive()) {
      throw new DomainError("WIN_REQUIRES_POSITIVE_AMOUNT", "A win requires a positive amount");
    }

    let balance: Money;
    try {
      balance = this.balance.add(props.money);
    } catch (error) {
      // Valid input can still overflow the wallet's exact database range.
      if (error instanceof MoneyError && error.code === "MONEY_OUT_OF_RANGE") {
        throw new DomainError("BALANCE_LIMIT_EXCEEDED", "The credit would exceed the supported wallet balance");
      }
      throw error;
    }

    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: "CREDIT",
      money: props.money,
      balanceBefore: this.balance,
      balanceAfter: balance,
      createdAt: props.at,
    });
    const wallet = new Wallet({
      id: this.id,
      playerId: this.playerId,
      balance,
      version: this.version + 1,
      createdAt: this.#createdAt,
      updatedAt: props.at,
    });
    return { wallet, entry };
  }

  get currency(): string {
    return this.balance.currency;
  }

  get createdAt(): Date {
    return new Date(this.#createdAt);
  }

  get updatedAt(): Date {
    return new Date(this.#updatedAt);
  }
}
