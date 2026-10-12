import type { IntegrationEvent } from "../domain/integration-event.js";
import type { AccountingTransfer } from "../domain/accounting-transfer.js";
import type { OpeningTransaction } from "../domain/opening-transaction.js";
import type { Wallet } from "../domain/wallet.js";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry.js";

export interface WalletOpening {
  readonly wallet: Wallet;
  readonly credit: {
    readonly transaction: OpeningTransaction;
    readonly entry: WalletLedgerEntry;
    readonly events: readonly IntegrationEvent<unknown>[];
  } | null;
}

export interface LedgerPosition {
  readonly createdAt: Date;
  readonly id: string;
}

// The adapter must commit all opening records together before returning.
export abstract class WalletStore {
  abstract saveOpening(opening: WalletOpening): Promise<void>;
  abstract findWallet(id: string): Promise<Wallet | null>;
  abstract listLedger(walletId: string, limit: number, after?: LedgerPosition): Promise<WalletLedgerEntry[]>;
  abstract listAccountingTransfers(walletId: string, limit: number, after?: LedgerPosition): Promise<AccountingTransfer[]>;
}
