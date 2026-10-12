import { Migration } from "@mikro-orm/migrations";

export class Migration202610100004 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_transactions_amount_check,
        drop constraint wager_transactions_kind_check,
        drop constraint wager_transactions_status_check,
        drop constraint wager_transactions_result_check,
        drop constraint wager_transactions_metadata_check,
        add constraint wager_transactions_kind_check check (kind in ('OPENING', 'BET', 'WIN', 'LOSS')),
        add constraint wager_transactions_amount_check check (
          (kind in ('OPENING', 'BET', 'WIN') and amount > 0 and amount <= 999999999999999999.99)
          or (kind = 'LOSS' and amount = 0)
        ),
        add constraint wager_transactions_status_check check (
          (kind in ('OPENING', 'LOSS') and status = 'PROCESSED')
          or (kind in ('BET', 'WIN') and status in ('PROCESSED', 'REJECTED'))
        ),
        add constraint wager_transactions_result_check check (
          (status = 'PROCESSED' and processed_at is not null and failure_code is null)
          or (status = 'REJECTED' and processed_at is null and failure_code is not null
            and ((kind = 'BET' and failure_code = 'INSUFFICIENT_FUNDS')
              or (kind = 'WIN' and failure_code = 'BALANCE_LIMIT_EXCEEDED')))
        ),
        add constraint wager_transactions_metadata_check check (
          (kind = 'OPENING' and provider_id is null and external_transaction_id is null
            and round_id is null and game_id is null and payload_hash is null and result_balance is null)
          or (kind in ('BET', 'WIN', 'LOSS')
            and provider_id is not null and length(provider_id) between 1 and 255
            and external_transaction_id is not null and length(external_transaction_id) between 1 and 255
            and round_id is not null and length(round_id) between 1 and 255
            and game_id is not null and length(game_id) between 1 and 255
            and payload_hash is not null and payload_hash ~ '^[0-9a-f]{64}$'
            and result_balance is not null and result_balance between 0 and 999999999999999999.99)
        );

      drop index wager_transactions_provider_external_unique;
      create unique index wager_transactions_provider_external_unique
        on wager_transactions (provider_id, external_transaction_id) where kind in ('BET', 'WIN', 'LOSS');
    `);

    // LOSS has no financial movement. The existing positive ledger amount and
    // status FK remain in place; this guard also rejects any ledger for its kind.
    this.addSql(`
      create or replace function check_ledger_transaction_direction() returns trigger language plpgsql as $$
      declare transaction_kind text;
      begin
        select kind into transaction_kind from wager_transactions where id = new.transaction_id;
        if transaction_kind = 'LOSS'
          or (transaction_kind in ('OPENING', 'WIN') and new.direction <> 'CREDIT')
          or (transaction_kind = 'BET' and new.direction <> 'DEBIT') then
          raise exception 'Ledger direction does not match the transaction kind' using errcode = '23514';
        end if;
        return new;
      end;
      $$;
    `);
  }

  override async down(): Promise<void> {
    // A downgrade must not erase accepted results or their duplicate protection.
    // The lock excludes a concurrent WIN/LOSS insert during the history check.
    this.addSql(`
      lock table wager_transactions in access exclusive mode;
      do $$
      begin
        if exists (select 1 from wager_transactions where kind in ('WIN', 'LOSS')) then
          raise exception 'Cannot roll back WIN/LOSS schema while WIN/LOSS history exists' using errcode = '23514';
        end if;
      end;
      $$;

      alter table wager_transactions
        drop constraint wager_transactions_amount_check,
        drop constraint wager_transactions_kind_check,
        drop constraint wager_transactions_status_check,
        drop constraint wager_transactions_result_check,
        drop constraint wager_transactions_metadata_check,
        add constraint wager_transactions_amount_check check (amount > 0 and amount <= 999999999999999999.99),
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

      drop index wager_transactions_provider_external_unique;
      create unique index wager_transactions_provider_external_unique
        on wager_transactions (provider_id, external_transaction_id) where kind = 'BET';

      create or replace function check_ledger_transaction_direction() returns trigger language plpgsql as $$
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
    `);
  }
}
