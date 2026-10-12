import { Migration } from "@mikro-orm/migrations";

// These projections are intentionally migration-local. Their deterministic IDs
// let a downgrade preserve all source history and reproduce exactly the same journal.
const expectedAccounts = `
  select 'wallet:' || id::text as id, 'WALLET_LIABILITY'::text as kind,
    id as wallet_id, currency from wallets
  union all select 'house:BRL', 'HOUSE_SETTLEMENT', null::uuid, 'BRL'
  union all select 'opening-clearing:BRL', 'OPENING_CLEARING', null::uuid, 'BRL'
`;

const expectedJournal = `
  select l.id as ledger_entry_id, l.transaction_id, l.currency, l.amount,
    case when l.direction = 'DEBIT' then 'wallet:' || l.wallet_id::text
      when t.kind = 'OPENING' then 'opening-clearing:' || l.currency
      else 'house:' || l.currency end as debit_account_id,
    case when l.direction = 'CREDIT' then 'wallet:' || l.wallet_id::text
      when t.kind = 'OPENING' then 'opening-clearing:' || l.currency
      else 'house:' || l.currency end as credit_account_id,
    l.created_at
  from wallet_ledger l join wager_transactions t on t.id = l.transaction_id
`;

export class Migration202610120001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      lock table wallets, wager_transactions, wallet_ledger in access exclusive mode;

      alter table wallets add constraint wallets_accounting_currency_unique unique (id, currency);

      create table accounting_accounts (
        id text primary key,
        kind text not null,
        wallet_id uuid,
        currency varchar(3) not null,
        constraint accounting_accounts_wallet_unique unique (wallet_id),
        constraint accounting_accounts_currency_unique unique (id, currency),
        constraint accounting_accounts_wallet_fk foreign key (wallet_id, currency)
          references wallets (id, currency),
        constraint accounting_accounts_currency_check check (currency = 'BRL'),
        constraint accounting_accounts_identity_check check (
          (kind = 'WALLET_LIABILITY' and wallet_id is not null and id = 'wallet:' || wallet_id::text)
          or (kind = 'HOUSE_SETTLEMENT' and wallet_id is null and id = 'house:' || currency)
          or (kind = 'OPENING_CLEARING' and wallet_id is null and id = 'opening-clearing:' || currency)
        )
      );

      create table accounting_journal (
        ledger_entry_id uuid primary key,
        transaction_id uuid not null,
        currency varchar(3) not null,
        amount numeric(20,2) not null,
        debit_account_id text not null,
        credit_account_id text not null,
        created_at timestamptz(3) not null,
        constraint accounting_journal_ledger_fk foreign key (ledger_entry_id) references wallet_ledger (id),
        constraint accounting_journal_debit_account_fk foreign key (debit_account_id, currency)
          references accounting_accounts (id, currency),
        constraint accounting_journal_credit_account_fk foreign key (credit_account_id, currency)
          references accounting_accounts (id, currency),
        constraint accounting_journal_amount_check check (amount > 0 and amount <= 999999999999999999.99),
        constraint accounting_journal_distinct_accounts_check check (debit_account_id <> credit_account_id)
      );

      create index accounting_journal_debit_account_idx on accounting_journal (debit_account_id);
      create index accounting_journal_credit_account_idx on accounting_journal (credit_account_id);

      create function check_accounting_journal_entry() returns trigger language plpgsql as $$
      declare
        source_entry record;
        wallet_account text;
        counterparty_account text;
      begin
        select l.*, t.kind into source_entry
          from wallet_ledger l join wager_transactions t on t.id = l.transaction_id
          where l.id = new.ledger_entry_id;
        if not found then
          raise exception 'Accounting journal requires a wallet ledger entry' using errcode = '23503';
        end if;
        if row(new.transaction_id, new.currency, new.amount, new.created_at)
          is distinct from row(source_entry.transaction_id, source_entry.currency, source_entry.amount, source_entry.created_at) then
          raise exception 'Accounting journal must preserve the wallet ledger identity and amount' using errcode = '23514';
        end if;
        wallet_account := 'wallet:' || source_entry.wallet_id::text;
        counterparty_account := case when source_entry.kind = 'OPENING'
          then 'opening-clearing:' || source_entry.currency else 'house:' || source_entry.currency end;
        if (source_entry.direction = 'CREDIT'
            and row(new.debit_account_id, new.credit_account_id) is distinct from row(counterparty_account, wallet_account))
          or (source_entry.direction = 'DEBIT'
            and row(new.debit_account_id, new.credit_account_id) is distinct from row(wallet_account, counterparty_account)) then
          raise exception 'Accounting journal accounts must match the wallet ledger direction and operation' using errcode = '23514';
        end if;
        return new;
      end;
      $$;

      create trigger accounting_journal_check_entry
        before insert on accounting_journal for each row execute function check_accounting_journal_entry();

      insert into accounting_accounts (id, kind, wallet_id, currency) ${expectedAccounts};
      insert into accounting_journal
        (ledger_entry_id, transaction_id, currency, amount, debit_account_id, credit_account_id, created_at)
        ${expectedJournal};

      alter table wallets add constraint wallets_accounting_account_fk
        foreign key (id) references accounting_accounts (wallet_id) deferrable initially deferred;
      alter table wallet_ledger add constraint wallet_ledger_accounting_journal_fk
        foreign key (id) references accounting_journal (ledger_entry_id) deferrable initially deferred;

      create function reject_accounting_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'Accounting accounts and journal entries are immutable' using errcode = '23514';
      end;
      $$;

      create trigger accounting_accounts_no_update_delete
        before update or delete on accounting_accounts for each statement execute function reject_accounting_mutation();
      create trigger accounting_accounts_no_truncate
        before truncate on accounting_accounts for each statement execute function reject_accounting_mutation();
      create trigger accounting_journal_no_update_delete
        before update or delete on accounting_journal for each statement execute function reject_accounting_mutation();
      create trigger accounting_journal_no_truncate
        before truncate on accounting_journal for each statement execute function reject_accounting_mutation();

      create view accounting_postings as
        select ledger_entry_id, transaction_id, debit_account_id as account_id,
          'DEBIT'::text as direction, currency, amount, created_at from accounting_journal
        union all
        select ledger_entry_id, transaction_id, credit_account_id as account_id,
          'CREDIT'::text as direction, currency, amount, created_at from accounting_journal;
    `);
  }

  override async down(): Promise<void> {
    // Only a lossless projection may be removed. Independent account/journal
    // history would need a separate retention strategy and must stop this rollback.
    this.addSql(`
      lock table wallets, wager_transactions, wallet_ledger,
        accounting_accounts, accounting_journal in access exclusive mode;

      do $$
      begin
        if exists (
          with expected as (${expectedAccounts})
          (select id, kind, wallet_id, currency from accounting_accounts except select * from expected)
          union all
          (select * from expected except select id, kind, wallet_id, currency from accounting_accounts)
        ) then
          raise exception 'Cannot roll back accounting accounts that differ from their source history' using errcode = '23514';
        end if;
        if exists (
          with expected as (${expectedJournal})
          (select ledger_entry_id, transaction_id, currency, amount, debit_account_id, credit_account_id, created_at
            from accounting_journal except select * from expected)
          union all
          (select * from expected except
            select ledger_entry_id, transaction_id, currency, amount, debit_account_id, credit_account_id, created_at
            from accounting_journal)
        ) then
          raise exception 'Cannot roll back accounting journal entries that differ from their source history' using errcode = '23514';
        end if;
      end;
      $$;

      drop view accounting_postings;
      alter table wallet_ledger drop constraint wallet_ledger_accounting_journal_fk;
      alter table wallets drop constraint wallets_accounting_account_fk;
      drop table accounting_journal;
      drop table accounting_accounts;
      drop function check_accounting_journal_entry();
      drop function reject_accounting_mutation();
      alter table wallets drop constraint wallets_accounting_currency_unique;
    `);
  }
}
