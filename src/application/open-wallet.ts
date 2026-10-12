import { randomUUID } from "node:crypto";
import { WalletBalanceChanged, WagerTransactionProcessed } from "../domain/integration-event.js";
import { Money } from "../domain/money.js";
import { OpeningTransaction } from "../domain/opening-transaction.js";
import { Wallet } from "../domain/wallet.js";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry.js";
import { openWalletInput } from "./input-validation.js";
import type { WalletOpening, WalletStore } from "./wallet-store.js";
import { Telemetry } from "./telemetry.js";

export class OpenWallet {
  constructor(private readonly store: WalletStore, private readonly telemetry: Telemetry = Telemetry.noop) {}

  async execute(input: unknown): Promise<Wallet> {
    return this.telemetry.trace("wallet.open", () => this.open(input));
  }

  private async open(input: unknown): Promise<Wallet> {
    const started = performance.now();
    const correlationId = this.telemetry.context().correlationId ?? randomUUID();
    const { playerId, initialBalance } = openWalletInput(input);
    const createdAt = new Date();
    const wallet = Wallet.open({ id: randomUUID(), playerId, initialBalance, createdAt });
    let credit: WalletOpening["credit"] = null;

    if (initialBalance.isPositive()) {
      const transaction = OpeningTransaction.create({ id: randomUUID(), wallet, createdAt });
      const entry = WalletLedgerEntry.create({
        id: randomUUID(), walletId: wallet.id, transactionId: transaction.id,
        direction: "CREDIT", money: initialBalance,
        balanceBefore: Money.zero(wallet.currency), balanceAfter: wallet.balance, createdAt,
      });
      const context = { correlationId, transaction, wallet, entry };
      credit = {
        transaction, entry,
        events: [
          WagerTransactionProcessed.opening({ ...context, eventId: randomUUID() }),
          WalletBalanceChanged.opening({ ...context, eventId: randomUUID() }),
        ],
      };
    }

    await this.store.saveOpening({ wallet, credit });
    if (credit) this.telemetry.wagerCompleted({
      correlationId, walletId: wallet.id, transactionId: credit.transaction.id, providerId: "internal",
    }, "PROCESSED", false, performance.now() - started);
    return wallet;
  }
}
