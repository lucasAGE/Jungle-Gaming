import { IsolationLevel, LockMode } from "@mikro-orm/core";
import { ReconciliationReader, type ReconciliationResult } from "../../application/reconciliation-reader.js";
import { WalletSchema } from "./entities.js";
import type { createOrm } from "./orm.js";

interface LedgerTotals {
  calculated: string;
  difference: string;
  consistent: boolean;
  entries: string;
}

export class PostgresReconciliationReader extends ReconciliationReader {
  constructor(private readonly orm: Awaited<ReturnType<typeof createOrm>>) { super(); }

  override async read(walletId: string): Promise<ReconciliationResult | null> {
    return this.orm.em.fork().transactional(async (em) => {
      const wallet = await em.findOne(WalletSchema, { id: walletId }, {
        lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true,
      });
      if (!wallet) return null;

      // A separate READ COMMITTED statement sees the ledger committed by any writer
      // we waited for. Holding its wallet lock keeps the two balances comparable.
      const [totals] = await em.getConnection().execute<LedgerTotals[]>(`
        select calculated::text,
          (?::numeric - calculated)::text as difference,
          ?::numeric = calculated as consistent, entries::text
        from (
          select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0.00) as calculated,
            count(*) as entries
          from wallet_ledger where wallet_id = ?
        ) ledger
      `, [wallet.balance, wallet.balance, wallet.id], "all", em.getTransactionContext());
      if (!totals) throw new Error("Ledger aggregation must return one row");
      const checkedEntries = Number(totals.entries);
      if (!Number.isSafeInteger(checkedEntries) || checkedEntries < 0) {
        throw new Error("Ledger entry count exceeds the supported response range");
      }
      return {
        walletId: wallet.id,
        storedBalance: { amount: wallet.balance, currency: wallet.currency },
        calculatedBalance: { amount: totals.calculated, currency: wallet.currency },
        difference: { amount: totals.difference, currency: wallet.currency },
        consistent: totals.consistent, checkedEntries,
      };
    }, { isolationLevel: IsolationLevel.READ_COMMITTED });
  }
}
