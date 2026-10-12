import { Migration } from "@mikro-orm/migrations";

export class Migration202610100008 extends Migration {
  override async up(): Promise<void> {
    this.constraints(true);
    this.terminalGuard(true);
  }

  override async down(): Promise<void> {
    this.addSql(`
      lock table wager_transactions in access exclusive mode;
      do $$ begin
        if exists (select 1 from wager_transactions where status = 'FAILED') then
          raise exception 'Cannot roll back FAILED schema while FAILED history exists' using errcode = '23514';
        end if;
      end $$;
    `);
    this.constraints(false);
    this.terminalGuard(false);
  }

  private constraints(failed: boolean): void {
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_transactions_status_check,
        drop constraint wager_transactions_result_check,
        drop constraint wager_transactions_reference_check,
        add constraint wager_transactions_status_check check (
          (kind in ('OPENING', 'LOSS') and status = 'PROCESSED')
          or (kind = 'BET' and status in ('PROCESSED', 'REJECTED'))
          or (kind in ('WIN', 'REFUND', 'ROLLBACK') and status in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED'))
          ${failed ? "or (kind <> 'OPENING' and status = 'FAILED')" : ""}
        ),
        add constraint wager_transactions_result_check check (
          (status = 'PROCESSED' and processed_at is not null and failure_code is null)
          or (status = 'REJECTED' and processed_at is null and failure_code is not null
            and ((kind = 'BET' and failure_code = 'INSUFFICIENT_FUNDS')
              or (kind in ('WIN', 'REFUND', 'ROLLBACK') and failure_code = 'BALANCE_LIMIT_EXCEEDED')
              or (kind in ('WIN', 'REFUND', 'ROLLBACK') and reference_external_transaction_id is not null
                and failure_code in ('REFERENCE_MISMATCH', 'REFERENCE_KIND_MISMATCH',
                  'REFERENCE_NOT_PROCESSED', 'REFERENCE_NOT_FOUND'))
              or (kind in ('REFUND', 'ROLLBACK') and failure_code = 'REFERENCE_AMOUNT_MISMATCH')
              or (kind = 'REFUND' and failure_code = 'REFERENCE_ALREADY_REFUNDED')
              or (kind = 'ROLLBACK' and failure_code in ('REFERENCE_ALREADY_ROLLED_BACK', 'REVERSAL_INSUFFICIENT_FUNDS'))))
          or (status = 'PENDING_REFERENCE' and kind in ('WIN', 'REFUND', 'ROLLBACK')
            and reference_external_transaction_id is not null and processed_at is null and failure_code is null)
          ${failed ? `or (status = 'FAILED' and kind <> 'OPENING' and processed_at is null
            and failure_code is not null and failure_code = 'DATABASE_OPERATION_FAILED'
            and reference_transaction_id is null and next_reference_attempt_at is null)` : ""}
        ),
        add constraint wager_transactions_reference_check check (
          (reference_external_transaction_id is null and kind not in ('REFUND', 'ROLLBACK')
            and reference_transaction_id is null and reference_attempts = 0
            and next_reference_attempt_at is null and status <> 'PENDING_REFERENCE')
          or (reference_external_transaction_id is not null and kind in ('WIN', 'REFUND', 'ROLLBACK')
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
              ${failed ? `or (status = 'FAILED' and reference_transaction_id is null
                and next_reference_attempt_at is null and reference_attempts <= 9)` : ""}
            ))
        );
    `);
  }

  private terminalGuard(failed: boolean): void {
    this.addSql(`
      create or replace function reject_terminal_transaction_mutation() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED'${failed ? ", 'FAILED'" : ""}) then
          raise exception 'Terminal wager transactions are immutable' using errcode = '23514';
        end if;
        if tg_op = 'DELETE' then
          raise exception 'Pending wager transactions cannot be deleted' using errcode = '23514';
        end if;
        if old.status <> 'PENDING_REFERENCE'
          or new.status not in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED'${failed ? ", 'FAILED'" : ""}) then
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
}
