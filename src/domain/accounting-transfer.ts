import { DomainError } from "./domain-error.js";
import type { Money } from "./money.js";
import type { WagerKind } from "./wager-transaction.js";
import type { WalletLedgerEntry } from "./wallet-ledger-entry.js";

export interface AccountingTransferState {
  readonly ledgerEntryId: string;
  readonly transactionId: string;
  readonly walletId: string;
  readonly money: Money;
  readonly debitAccountId: string;
  readonly creditAccountId: string;
  readonly createdAt: Date;
}

// One amount shared by both accounts makes an unequal debit and credit unrepresentable.
export class AccountingTransfer {
  readonly ledgerEntryId: string;
  readonly transactionId: string;
  readonly walletId: string;
  readonly money: Money;
  readonly debitAccountId: string;
  readonly creditAccountId: string;
  readonly #createdAt: Date;

  private constructor(state: AccountingTransferState) {
    this.ledgerEntryId = state.ledgerEntryId;
    this.transactionId = state.transactionId;
    this.walletId = state.walletId;
    this.money = state.money;
    this.debitAccountId = state.debitAccountId;
    this.creditAccountId = state.creditAccountId;
    this.#createdAt = new Date(state.createdAt);
    Object.freeze(this);
  }

  static fromLedger(entry: WalletLedgerEntry, kind: "OPENING" | WagerKind): AccountingTransfer {
    if (kind === "LOSS") {
      throw new DomainError("ACCOUNTING_NO_FINANCIAL_MOVEMENT", "A loss has no accounting transfer");
    }
    if (!entry.money.isPositive()) {
      throw new DomainError("ACCOUNTING_NON_POSITIVE_AMOUNT", "An accounting transfer requires a positive amount");
    }
    if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative() || !entry.isBalanced()) {
      throw new DomainError("ACCOUNTING_INVALID_LEDGER", "An accounting transfer requires a balanced non-negative wallet entry");
    }
    const expectedDirection = kind === "BET" ? "DEBIT" : "CREDIT";
    if ((entry.direction !== "CREDIT" && entry.direction !== "DEBIT") ||
      (kind !== "ROLLBACK" && entry.direction !== expectedDirection)) {
      throw new DomainError("ACCOUNTING_DIRECTION_MISMATCH", "The ledger direction does not match the transaction kind");
    }

    const walletAccountId = `wallet:${entry.walletId}`;
    const counterpartId = kind === "OPENING"
      ? `opening-clearing:${entry.money.currency}`
      : `house:${entry.money.currency}`;
    // Wallet funds are a liability: credit increases what the house owes the player.
    return new AccountingTransfer({
      ledgerEntryId: entry.id,
      transactionId: entry.transactionId,
      walletId: entry.walletId,
      money: entry.money,
      debitAccountId: entry.direction === "DEBIT" ? walletAccountId : counterpartId,
      creditAccountId: entry.direction === "CREDIT" ? walletAccountId : counterpartId,
      createdAt: entry.createdAt,
    });
  }

  static rehydrate(state: AccountingTransferState): AccountingTransfer {
    return new AccountingTransfer(state);
  }

  get createdAt(): Date {
    return new Date(this.#createdAt);
  }
}
