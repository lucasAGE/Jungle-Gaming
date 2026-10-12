import { Migration } from "@mikro-orm/migrations";

export class Migration202610100002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        add column provider_id text,
        add column external_transaction_id text,
        add column round_id text,
        add column game_id text,
        add column payload_hash text,
        add column failure_code text,
        add column result_balance numeric(20,2),
        alter column processed_at drop not null,
        drop constraint wager_transactions_opening_wallet_unique,
        drop constraint wager_transactions_kind_check,
        drop constraint wager_transactions_status_check,
        add constraint wager_transactions_kind_check check (kind in ('OPENING', 'BET')),
        add constraint wager_transactions_status_check check (
          (kind = 'OPENING' and status = 'PROCESSED')
          or (kind = 'BET' and status in ('PROCESSED', 'REJECTED'))
        ),
        add constraint wager_transactions_result_check check (
          (status = 'PROCESSED' and processed_at is not null and failure_code is null)
          or (status = 'REJECTED' and processed_at is null
            and failure_code is not null and failure_code = 'INSUFFICIENT_FUNDS')
        ),
        add constraint wager_transactions_metadata_check check (
          (kind = 'OPENING' and provider_id is null and external_transaction_id is null
            and round_id is null and game_id is null and payload_hash is null and result_balance is null)
          or (kind = 'BET'
            and provider_id is not null and length(provider_id) between 1 and 255
            and external_transaction_id is not null and length(external_transaction_id) between 1 and 255
            and round_id is not null and length(round_id) between 1 and 255
            and game_id is not null and length(game_id) between 1 and 255
            and payload_hash is not null and payload_hash ~ '^[0-9a-f]{64}$'
            and result_balance is not null and result_balance between 0 and 999999999999999999.99)
        );

      create unique index wager_transactions_opening_wallet_unique on wager_transactions (wallet_id)
        where kind = 'OPENING';
      create unique index wager_transactions_provider_external_unique
        on wager_transactions (provider_id, external_transaction_id) where kind = 'BET';

      alter table wallet_ledger drop constraint wallet_ledger_transaction_fk;
      alter table wager_transactions
        drop constraint wager_transactions_ledger_identity_unique,
        add constraint wager_transactions_ledger_identity_unique unique (id, wallet_id, currency, amount, status);
      alter table wallet_ledger
        add column transaction_status text not null default 'PROCESSED',
        add constraint wallet_ledger_processed_check check (transaction_status = 'PROCESSED'),
        add constraint wallet_ledger_transaction_fk
          foreign key (transaction_id, wallet_id, currency, amount, transaction_status)
          references wager_transactions (id, wallet_id, currency, amount, status);
    `);

    // The status FK prevents rejected transactions from receiving ledger entries;
    // this trigger additionally binds the direction to the transaction's operation.
    this.addSql(`
      create function check_ledger_transaction_direction() returns trigger language plpgsql as $$
      declare transaction_kind text;
      begin
        select kind into transaction_kind from wager_transactions where id = new.transaction_id;
        if (transaction_kind = 'OPENING' and new.direction <> 'CREDIT')
          or (transaction_kind = 'BET' and new.direction <> 'DEBIT') then
          raise exception 'Ledger direction does not match the transaction kind' using errcode = '23514';
        end if;
        return new;
      end;
      $$;

      create trigger wallet_ledger_transaction_direction
        before insert on wallet_ledger
        for each row execute function check_ledger_transaction_direction();

      create function reject_terminal_transaction_mutation() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED') then
          raise exception 'Terminal wager transactions are immutable' using errcode = '23514';
        end if;
        if tg_op = 'UPDATE' then
          return new;
        end if;
        return old;
      end;
      $$;

      create trigger wager_transactions_no_terminal_mutation
        before update or delete on wager_transactions
        for each row execute function reject_terminal_transaction_mutation();

      create function reject_transaction_truncate() returns trigger language plpgsql as $$
      begin
        raise exception 'Wager transactions cannot be truncated' using errcode = '23514';
      end;
      $$;

      create trigger wager_transactions_no_truncate
        before truncate on wager_transactions
        for each statement execute function reject_transaction_truncate();
    `);
  }

  override async down(): Promise<void> {
    // The old schema cannot represent BET history. Refuse to discard financial
    // records; a rollback is safe only before this feature has accepted wagers.
    this.addSql(`
      lock table wager_transactions in access exclusive mode;
      do $$
      begin
        if exists (select 1 from wager_transactions where kind = 'BET') then
          raise exception 'Cannot roll back BET schema while BET history exists' using errcode = '23514';
        end if;
      end;
      $$;

      drop trigger wager_transactions_no_truncate on wager_transactions;
      drop trigger wager_transactions_no_terminal_mutation on wager_transactions;
      drop function reject_transaction_truncate();
      drop function reject_terminal_transaction_mutation();
      drop trigger wallet_ledger_transaction_direction on wallet_ledger;
      drop function check_ledger_transaction_direction();

      alter table wallet_ledger
        drop constraint wallet_ledger_transaction_fk,
        drop constraint wallet_ledger_processed_check,
        drop column transaction_status;
      alter table wager_transactions
        drop constraint wager_transactions_ledger_identity_unique,
        add constraint wager_transactions_ledger_identity_unique unique (id, wallet_id, currency, amount);
      alter table wallet_ledger add constraint wallet_ledger_transaction_fk
        foreign key (transaction_id, wallet_id, currency, amount)
        references wager_transactions (id, wallet_id, currency, amount);

      drop index wager_transactions_provider_external_unique;
      drop index wager_transactions_opening_wallet_unique;
      alter table wager_transactions
        drop constraint wager_transactions_result_check,
        drop constraint wager_transactions_metadata_check,
        drop constraint wager_transactions_status_check,
        drop constraint wager_transactions_kind_check,
        add constraint wager_transactions_kind_check check (kind = 'OPENING'),
        add constraint wager_transactions_status_check check (status = 'PROCESSED'),
        add constraint wager_transactions_opening_wallet_unique unique (wallet_id),
        alter column processed_at set not null,
        drop column provider_id,
        drop column external_transaction_id,
        drop column round_id,
        drop column game_id,
        drop column payload_hash,
        drop column failure_code,
        drop column result_balance;
    `);
  }
}
