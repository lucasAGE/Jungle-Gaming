import { Migration } from "@mikro-orm/migrations";

export class Migration202610100001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency varchar(3) not null,
        balance numeric(20,2) not null,
        version integer not null,
        created_at timestamptz(3) not null,
        updated_at timestamptz(3) not null,
        constraint wallets_player_currency_unique unique (player_id, currency),
        constraint wallets_identity_unique unique (id, player_id, currency),
        constraint wallets_currency_check check (currency = 'BRL'),
        constraint wallets_balance_check check (balance between 0 and 999999999999999999.99),
        constraint wallets_version_check check (version >= 1)
      );

      create table wager_transactions (
        id uuid primary key,
        wallet_id uuid not null,
        player_id uuid not null,
        currency varchar(3) not null,
        amount numeric(20,2) not null,
        idempotency_key text not null,
        kind text not null,
        status text not null,
        created_at timestamptz(3) not null,
        processed_at timestamptz(3) not null,
        constraint wager_transactions_idempotency_unique unique (idempotency_key),
        constraint wager_transactions_opening_wallet_unique unique (wallet_id),
        constraint wager_transactions_ledger_identity_unique unique (id, wallet_id, currency, amount),
        constraint wager_transactions_wallet_fk foreign key (wallet_id, player_id, currency)
          references wallets (id, player_id, currency),
        constraint wager_transactions_amount_check check (amount > 0 and amount <= 999999999999999999.99),
        constraint wager_transactions_key_check check (length(idempotency_key) between 1 and 255),
        constraint wager_transactions_kind_check check (kind = 'OPENING'),
        constraint wager_transactions_status_check check (status = 'PROCESSED')
      );

      create table wallet_ledger (
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null,
        currency varchar(3) not null,
        direction text not null,
        amount numeric(20,2) not null,
        balance_before numeric(20,2) not null,
        balance_after numeric(20,2) not null,
        created_at timestamptz(3) not null,
        constraint wallet_ledger_transaction_wallet_unique unique (transaction_id, wallet_id),
        constraint wallet_ledger_transaction_fk foreign key (transaction_id, wallet_id, currency, amount)
          references wager_transactions (id, wallet_id, currency, amount),
        constraint wallet_ledger_amount_check check (amount > 0 and amount <= 999999999999999999.99),
        constraint wallet_ledger_before_check check (balance_before between 0 and 999999999999999999.99),
        constraint wallet_ledger_after_check check (balance_after between 0 and 999999999999999999.99),
        constraint wallet_ledger_arithmetic_check check (
          (direction = 'CREDIT' and balance_after = balance_before + amount)
          or (direction = 'DEBIT' and balance_after = balance_before - amount)
        )
      );

      create index wallet_ledger_wallet_cursor_idx on wallet_ledger (wallet_id, created_at, id);

      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz(3) not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz(3),
        published_at timestamptz(3),
        constraint outbox_messages_attempts_check check (attempts >= 0),
        constraint outbox_messages_envelope_check check (
          jsonb_typeof(payload) = 'object'
          and payload ?& array['eventId', 'aggregateId', 'eventType', 'correlationId', 'occurredAt', 'version', 'data']
          and jsonb_typeof(payload->'eventId') = 'string'
          and jsonb_typeof(payload->'aggregateId') = 'string'
          and jsonb_typeof(payload->'eventType') = 'string'
          and payload->>'eventId' = id::text
          and payload->>'aggregateId' = aggregate_id::text
          and payload->>'eventType' = event_type
          and jsonb_typeof(payload->'correlationId') = 'string'
          and length(payload->>'correlationId') > 0
          and jsonb_typeof(payload->'occurredAt') = 'string'
          and payload->'version' = '1'::jsonb
          and jsonb_typeof(payload->'data') = 'object'
        )
      );

      create unique index outbox_messages_event_id_unique on outbox_messages ((payload->>'eventId'));
      create index outbox_messages_pending_idx on outbox_messages (next_attempt_at, occurred_at, id)
        where published_at is null;
    `);

    // Statement triggers reject even bulk operations, including TRUNCATE by the table owner.
    this.addSql(`
      create function reject_ledger_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'Wallet ledger entries are immutable' using errcode = '23514';
      end;
      $$;

      create trigger wallet_ledger_no_update_delete
        before update or delete on wallet_ledger
        for each statement execute function reject_ledger_mutation();

      create trigger wallet_ledger_no_truncate
        before truncate on wallet_ledger
        for each statement execute function reject_ledger_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop trigger wallet_ledger_no_truncate on wallet_ledger;
      drop trigger wallet_ledger_no_update_delete on wallet_ledger;
      drop function reject_ledger_mutation();
      drop table outbox_messages;
      drop table wallet_ledger;
      drop table wager_transactions;
      drop table wallets;
    `);
  }
}
