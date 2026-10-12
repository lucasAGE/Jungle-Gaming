import { expect } from "bun:test";
import type { Orm } from "./helpers.js";

// Reuse this audit after crash, retry and reversal scenarios so the accounting
// extension is checked against the same committed history as the original ledger.
export async function assertAccountingConsistent(orm: Orm): Promise<void> {
  const rows = (sql: string) => orm.em.getConnection().execute(sql);
  expect(await rows(`
    select w.id from wallets w
    left join accounting_accounts a on a.wallet_id = w.id
    where a.id is null or a.id <> 'wallet:' || w.id::text
      or a.kind <> 'WALLET_LIABILITY' or a.currency <> w.currency
  `)).toEqual([]);
  expect(await rows(`
    select l.id from wallet_ledger l
    join wager_transactions t on t.id = l.transaction_id
    left join accounting_journal j on j.ledger_entry_id = l.id
    where j.ledger_entry_id is null or j.transaction_id <> l.transaction_id
      or j.amount <> l.amount or j.currency <> l.currency or j.created_at <> l.created_at
      or j.debit_account_id <> case when l.direction = 'DEBIT' then 'wallet:' || l.wallet_id::text
        when t.kind = 'OPENING' then 'opening-clearing:' || l.currency else 'house:' || l.currency end
      or j.credit_account_id <> case when l.direction = 'CREDIT' then 'wallet:' || l.wallet_id::text
        else 'house:' || l.currency end
  `)).toEqual([]);
  expect(await rows(`
    select j.ledger_entry_id from accounting_journal j
    left join wallet_ledger l on l.id = j.ledger_entry_id
    where l.id is null
  `)).toEqual([]);
  expect(await rows(`
    select j.ledger_entry_id from accounting_journal j
    left join accounting_postings p on p.ledger_entry_id = j.ledger_entry_id
    group by j.ledger_entry_id
    having count(*) <> 2 or count(distinct p.account_id) <> 2
      or count(*) filter (where p.direction = 'DEBIT') <> 1
      or count(*) filter (where p.direction = 'CREDIT') <> 1
      or sum(case when p.direction = 'CREDIT' then p.amount else -p.amount end) <> 0
  `)).toEqual([]);
  expect(await rows(`
    select w.id from wallets w
    left join accounting_postings p on p.account_id = 'wallet:' || w.id::text
    group by w.id
    having w.balance <> coalesce(sum(case when p.direction = 'CREDIT' then p.amount else -p.amount end), 0)
  `)).toEqual([]);
  expect(await rows(`
    select currency from accounting_postings group by currency
    having sum(case when direction = 'CREDIT' then amount else -amount end) <> 0
  `)).toEqual([]);
}
