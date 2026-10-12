import { Migration } from "@mikro-orm/migrations";

export class Migration202610100006 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_transactions_kind_check,
        drop constraint wager_transactions_amount_check,
        drop constraint wager_transactions_status_check,
        drop constraint wager_transactions_result_check,
        drop constraint wager_transactions_metadata_check,
        drop constraint wager_transactions_reference_check,
        add constraint wager_transactions_kind_check check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND')),
        add constraint wager_transactions_amount_check check (
          (kind in ('OPENING', 'BET', 'WIN', 'REFUND') and amount > 0 and amount <= 999999999999999999.99)
          or (kind = 'LOSS' and amount = 0)
        ),
        add constraint wager_transactions_status_check check (
          (kind in ('OPENING', 'LOSS') and status = 'PROCESSED')
          or (kind = 'BET' and status in ('PROCESSED', 'REJECTED'))
          or (kind in ('WIN', 'REFUND') and status in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED'))
        ),
        add constraint wager_transactions_result_check check (
          (status = 'PROCESSED' and processed_at is not null and failure_code is null)
          or (status = 'REJECTED' and processed_at is null and failure_code is not null
            and ((kind = 'BET' and failure_code = 'INSUFFICIENT_FUNDS')
              or (kind in ('WIN', 'REFUND') and failure_code = 'BALANCE_LIMIT_EXCEEDED')
              or (kind in ('WIN', 'REFUND') and reference_external_transaction_id is not null
                and failure_code in ('REFERENCE_MISMATCH', 'REFERENCE_KIND_MISMATCH',
                  'REFERENCE_NOT_PROCESSED', 'REFERENCE_NOT_FOUND'))
              or (kind = 'REFUND' and failure_code in ('REFERENCE_AMOUNT_MISMATCH', 'REFERENCE_ALREADY_REFUNDED'))))
          or (status = 'PENDING_REFERENCE' and kind in ('WIN', 'REFUND')
            and reference_external_transaction_id is not null
            and processed_at is null and failure_code is null)
        ),
        add constraint wager_transactions_metadata_check check (
          (kind = 'OPENING' and provider_id is null and external_transaction_id is null
            and round_id is null and game_id is null and payload_hash is null and result_balance is null)
          or (kind in ('BET', 'WIN', 'LOSS', 'REFUND')
            and provider_id is not null and length(provider_id) between 1 and 255
            and external_transaction_id is not null and length(external_transaction_id) between 1 and 255
            and round_id is not null and length(round_id) between 1 and 255
            and game_id is not null and length(game_id) between 1 and 255
            and payload_hash is not null and payload_hash ~ '^[0-9a-f]{64}$'
            and result_balance is not null and result_balance between 0 and 999999999999999999.99)
        ),
        add constraint wager_transactions_reference_check check (
          (reference_external_transaction_id is null and kind <> 'REFUND'
            and reference_transaction_id is null and reference_attempts = 0
            and next_reference_attempt_at is null and status <> 'PENDING_REFERENCE')
          or (reference_external_transaction_id is not null and kind in ('WIN', 'REFUND')
            and length(reference_external_transaction_id) between 1 and 255
            and reference_external_transaction_id <> external_transaction_id
            and processing_correlation_id is not null
            and (
              (status = 'PENDING_REFERENCE' and reference_transaction_id is null
                and next_reference_attempt_at is not null and reference_attempts <= 9)
              or (status = 'PROCESSED' and reference_transaction_id is not null
                and next_reference_attempt_at is null and reference_attempts <= 9)
              or (status = 'REJECTED' and next_reference_attempt_at is null
                and ((failure_code = 'REFERENCE_NOT_FOUND' and reference_attempts = 10)
                  or (failure_code <> 'REFERENCE_NOT_FOUND' and reference_attempts <= 9)))
            ))
        );

      drop index wager_transactions_provider_external_unique;
      create unique index wager_transactions_provider_external_unique
        on wager_transactions (provider_id, external_transaction_id) where kind in ('BET', 'WIN', 'LOSS', 'REFUND');

      create unique index wager_transactions_refund_reference_unique
        on wager_transactions (reference_transaction_id) where kind = 'REFUND' and status = 'PROCESSED';
    `);

    // The unique index protects against distinct requests refunding the same BET.
    // The reference guard also rejects partial refunds even when SQL bypasses the workflow.
    this.addSql(`
      create or replace function check_wager_reference() returns trigger language plpgsql as $$
      declare reference_row wager_transactions%rowtype;
      begin
        if new.reference_transaction_id is null then
          return new;
        end if;
        select * into reference_row from wager_transactions where id = new.reference_transaction_id;
        if not found
          or reference_row.kind is distinct from 'BET'
          or reference_row.status is distinct from 'PROCESSED'
          or reference_row.provider_id is distinct from new.provider_id
          or reference_row.external_transaction_id is distinct from new.reference_external_transaction_id
          or reference_row.player_id is distinct from new.player_id
          or reference_row.wallet_id is distinct from new.wallet_id
          or reference_row.currency is distinct from new.currency
          or reference_row.round_id is distinct from new.round_id then
          raise exception 'Resolved reference must be a processed BET with matching identity' using errcode = '23514';
        end if;
        if new.kind = 'REFUND' and new.amount is distinct from reference_row.amount then
          raise exception 'REFUND amount must equal the referenced BET amount' using errcode = '23514';
        end if;
        return new;
      end;
      $$;

      create or replace function check_ledger_transaction_direction() returns trigger language plpgsql as $$
      declare transaction_kind text;
      begin
        select kind into transaction_kind from wager_transactions where id = new.transaction_id;
        if transaction_kind = 'LOSS'
          or (transaction_kind in ('OPENING', 'WIN', 'REFUND') and new.direction <> 'CREDIT')
          or (transaction_kind = 'BET' and new.direction <> 'DEBIT') then
          raise exception 'Ledger direction does not match the transaction kind' using errcode = '23514';
        end if;
        return new;
      end;
      $$;
    `);
  }

  override async down(): Promise<void> {
    // Existing WIN references remain representable after this downgrade. REFUND
    // history does not, including accepted pending requests, so refuse to erase it.
    this.addSql(`
      lock table wager_transactions in access exclusive mode;
      do $$
      begin
        if exists (select 1 from wager_transactions where kind = 'REFUND') then
          raise exception 'Cannot roll back REFUND schema while REFUND history exists' using errcode = '23514';
        end if;
      end;
      $$;

      drop index wager_transactions_refund_reference_unique;
      drop index wager_transactions_provider_external_unique;
      create unique index wager_transactions_provider_external_unique
        on wager_transactions (provider_id, external_transaction_id) where kind in ('BET', 'WIN', 'LOSS');

      alter table wager_transactions
        drop constraint wager_transactions_kind_check,
        drop constraint wager_transactions_amount_check,
        drop constraint wager_transactions_status_check,
        drop constraint wager_transactions_result_check,
        drop constraint wager_transactions_metadata_check,
        drop constraint wager_transactions_reference_check,
        add constraint wager_transactions_kind_check check (kind in ('OPENING', 'BET', 'WIN', 'LOSS')),
        add constraint wager_transactions_amount_check check (
          (kind in ('OPENING', 'BET', 'WIN') and amount > 0 and amount <= 999999999999999999.99)
          or (kind = 'LOSS' and amount = 0)
        ),
        add constraint wager_transactions_status_check check (
          (kind in ('OPENING', 'LOSS') and status = 'PROCESSED')
          or (kind = 'BET' and status in ('PROCESSED', 'REJECTED'))
          or (kind = 'WIN' and status in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED'))
        ),
        add constraint wager_transactions_result_check check (
          (status = 'PROCESSED' and processed_at is not null and failure_code is null)
          or (status = 'REJECTED' and processed_at is null and failure_code is not null
            and ((kind = 'BET' and failure_code = 'INSUFFICIENT_FUNDS')
              or (kind = 'WIN' and failure_code = 'BALANCE_LIMIT_EXCEEDED')
              or (kind = 'WIN' and reference_external_transaction_id is not null
                and failure_code in ('REFERENCE_MISMATCH', 'REFERENCE_KIND_MISMATCH',
                  'REFERENCE_NOT_PROCESSED', 'REFERENCE_NOT_FOUND'))))
          or (status = 'PENDING_REFERENCE' and kind = 'WIN'
            and reference_external_transaction_id is not null
            and processed_at is null and failure_code is null)
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
        ),
        add constraint wager_transactions_reference_check check (
          (reference_external_transaction_id is null
            and reference_transaction_id is null and reference_attempts = 0
            and next_reference_attempt_at is null and status <> 'PENDING_REFERENCE')
          or (reference_external_transaction_id is not null and kind = 'WIN'
            and length(reference_external_transaction_id) between 1 and 255
            and reference_external_transaction_id <> external_transaction_id
            and processing_correlation_id is not null
            and (
              (status = 'PENDING_REFERENCE' and reference_transaction_id is null
                and next_reference_attempt_at is not null and reference_attempts <= 9)
              or (status = 'PROCESSED' and reference_transaction_id is not null
                and next_reference_attempt_at is null and reference_attempts <= 9)
              or (status = 'REJECTED' and next_reference_attempt_at is null
                and ((failure_code = 'REFERENCE_NOT_FOUND' and reference_attempts = 10)
                  or (failure_code <> 'REFERENCE_NOT_FOUND' and reference_attempts <= 9)))
            ))
        );

      create or replace function check_wager_reference() returns trigger language plpgsql as $$
      declare reference_row wager_transactions%rowtype;
      begin
        if new.reference_transaction_id is null then
          return new;
        end if;
        select * into reference_row from wager_transactions where id = new.reference_transaction_id;
        if not found
          or reference_row.kind is distinct from 'BET'
          or reference_row.status is distinct from 'PROCESSED'
          or reference_row.provider_id is distinct from new.provider_id
          or reference_row.external_transaction_id is distinct from new.reference_external_transaction_id
          or reference_row.player_id is distinct from new.player_id
          or reference_row.wallet_id is distinct from new.wallet_id
          or reference_row.currency is distinct from new.currency
          or reference_row.round_id is distinct from new.round_id then
          raise exception 'Resolved reference must be a processed BET with matching identity' using errcode = '23514';
        end if;
        return new;
      end;
      $$;

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
}
