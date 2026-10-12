import { DomainError } from "./domain-error.js";
import type { Money } from "./money.js";

export type LedgerDirection = "CREDIT" | "DEBIT";

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly #createdAt: Date;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.#createdAt = new Date(state.createdAt);
    Object.freeze(this);
  }

  static create(props: LedgerEntryState): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new DomainError("LEDGER_NON_POSITIVE_AMOUNT", "A ledger entry requires a positive amount");
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new DomainError("LEDGER_NEGATIVE_BALANCE", "Ledger balances must not be negative");
    }

    const entry = new WalletLedgerEntry(props);
    if (!entry.isBalanced()) {
      throw new DomainError("LEDGER_UNBALANCED", "The ledger amount must match the balance change");
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  get createdAt(): Date {
    return new Date(this.#createdAt);
  }

  isBalanced(): boolean {
    const expectedBalance = this.direction === "CREDIT"
      ? this.balanceBefore.add(this.money)
      : this.balanceBefore.subtract(this.money);
    return expectedBalance.equals(this.balanceAfter);
  }
}
