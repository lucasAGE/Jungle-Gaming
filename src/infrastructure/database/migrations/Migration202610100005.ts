import { Migration } from "@mikro-orm/migrations";

export class Migration202610100005 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        add column reference_external_transaction_id text,
        add column reference_transaction_id uuid,
        add column reference_attempts integer not null default 0,
        add column next_reference_attempt_at timestamptz(3),
        add column processing_correlation_id text,
        add constraint wager_transactions_reference_fk
          foreign key (reference_transaction_id) references wager_transactions (id),
        add constraint wager_transactions_reference_attempts_check check (reference_attempts between 0 and 10),
        add constraint wager_transactions_correlation_check check (
          processing_correlation_id is null or length(processing_correlation_id) between 1 and 255
        ),
        drop constraint wager_transactions_status_check,
        drop constraint wager_transactions_result_check,
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

      create index wager_transactions_pending_reference_idx
        on wager_transactions (next_reference_attempt_at, id) where status = 'PENDING_REFERENCE';
    `);

    // A resolved reference must identify the immutable BET that the WIN actually
    // belongs to. A UUID FK alone would accept an unrelated financial operation.
    this.addSql(`
      create function check_wager_reference() returns trigger language plpgsql as $$
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

      create trigger wager_transactions_reference_matches
        before insert or update on wager_transactions
        for each row execute function check_wager_reference();

      create or replace function reject_terminal_transaction_mutation() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED') then
          raise exception 'Terminal wager transactions are immutable' using errcode = '23514';
        end if;
        if tg_op = 'DELETE' then
          raise exception 'Pending wager transactions cannot be deleted' using errcode = '23514';
        end if;
        if old.status <> 'PENDING_REFERENCE'
          or new.status not in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED') then
          raise exception 'Invalid pending reference transition' using errcode = '23514';
        end if;
        if row(new.id, new.wallet_id, new.player_id, new.currency, new.amount,
            new.idempotency_key, new.kind, new.provider_id, new.external_transaction_id,
            new.round_id, new.game_id, new.payload_hash, new.created_at,
            new.reference_external_transaction_id, new.processing_correlation_id)
          is distinct from row(old.id, old.wallet_id, old.player_id, old.currency, old.amount,
            old.idempotency_key, old.kind, old.provider_id, old.external_transaction_id,
            old.round_id, old.game_id, old.payload_hash, old.created_at,
            old.reference_external_transaction_id, old.processing_correlation_id) then
          raise exception 'Pending wager identity is immutable' using errcode = '23514';
        end if;
        if new.status = 'PENDING_REFERENCE' then
          if new.result_balance is distinct from old.result_balance
            or new.reference_attempts <> old.reference_attempts + 1
            or new.next_reference_attempt_at <= old.next_reference_attempt_at then
            raise exception 'Pending reference retries must advance the schedule once' using errcode = '23514';
          end if;
        elsif new.failure_code = 'REFERENCE_NOT_FOUND' then
          if old.reference_attempts <> 9 or new.reference_attempts <> 10 then
            raise exception 'Reference rejection requires ten missing checks' using errcode = '23514';
          end if;
        elsif new.reference_attempts <> old.reference_attempts then
          raise exception 'Resolved references preserve the missing-check count' using errcode = '23514';
        end if;
        return new;
      end;
      $$;
    `);
  }

  override async down(): Promise<void> {
    // Downgrades may discard unused columns, never accepted references or their
    // retry history. The lock prevents a reference arriving during this check.
    this.addSql(`
      lock table wager_transactions in access exclusive mode;
      do $$
      begin
        if exists (select 1 from wager_transactions
          where reference_external_transaction_id is not null
            or reference_transaction_id is not null or reference_attempts > 0
            or status = 'PENDING_REFERENCE') then
          raise exception 'Cannot roll back reference schema while reference history exists' using errcode = '23514';
        end if;
      end;
      $$;

      drop trigger wager_transactions_reference_matches on wager_transactions;
      drop function check_wager_reference();
      drop index wager_transactions_pending_reference_idx;

      alter table wager_transactions
        drop constraint wager_transactions_reference_fk,
        drop constraint wager_transactions_reference_attempts_check,
        drop constraint wager_transactions_reference_check,
        drop constraint wager_transactions_correlation_check,
        drop constraint wager_transactions_status_check,
        drop constraint wager_transactions_result_check,
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
        drop column reference_external_transaction_id,
        drop column reference_transaction_id,
        drop column reference_attempts,
        drop column next_reference_attempt_at,
        drop column processing_correlation_id;

      create or replace function reject_terminal_transaction_mutation() returns trigger language plpgsql as $$
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
    `);
  }
}
