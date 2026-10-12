import type { Wallet } from "../domain/wallet.js";
import { ApplicationError } from "./application-error.js";
import { invalidInput, objectInput, uuidInput } from "./input-validation.js";
import { decodeLedgerCursor, encodeLedgerCursor } from "./ledger-cursor.js";
import type { WalletStore } from "./wallet-store.js";

export function walletResponse(wallet: Wallet) {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

function pageInput(walletId: string, query: unknown) {
  const input = objectInput(query, ["cursor", "limit"]);
  let limit = 50;
  if (input.limit !== undefined) {
    if (typeof input.limit !== "string" || !/^[1-9][0-9]{0,2}(?![\s\S])/.test(input.limit)) {
      return invalidInput("Limit must be an integer between 1 and 100");
    }
    limit = Number(input.limit);
    if (limit > 100) return invalidInput("Limit must be an integer between 1 and 100");
  }
  const after = input.cursor === undefined ? undefined : decodeLedgerCursor(input.cursor, walletId);
  return { limit, after };
}

export class ReadWallet {
  constructor(private readonly store: WalletStore) {}

  async execute(id: unknown): Promise<Wallet> {
    const wallet = await this.store.findWallet(uuidInput(id));
    if (!wallet) throw new ApplicationError("WALLET_NOT_FOUND", "Wallet not found");
    return wallet;
  }

  async ledger(id: unknown, query: unknown) {
    const walletId = uuidInput(id);
    const { limit, after } = pageInput(walletId, query);
    await this.execute(walletId);
    const entries = await this.store.listLedger(walletId, limit + 1, after);
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((entry) => ({
        id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId,
        direction: entry.direction, money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: entries.length > limit && last ? encodeLedgerCursor(walletId, last) : null,
    };
  }

  async accounting(id: unknown, query: unknown) {
    const walletId = uuidInput(id);
    const { limit, after } = pageInput(walletId, query);
    await this.execute(walletId);
    const entries = await this.store.listAccountingTransfers(walletId, limit + 1, after);
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((entry) => ({
        ledgerEntryId: entry.ledgerEntryId, transactionId: entry.transactionId,
        money: entry.money.toJSON(), debitAccountId: entry.debitAccountId,
        creditAccountId: entry.creditAccountId, createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: entries.length > limit && last
        ? encodeLedgerCursor(walletId, { id: last.ledgerEntryId, createdAt: last.createdAt }) : null,
    };
  }
}
