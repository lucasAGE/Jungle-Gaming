import { Migration } from "@mikro-orm/migrations";

export class Migration202610100003 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz(3) not null,
        processed_at timestamptz(3),
        transaction_id uuid,
        constraint inbox_messages_pkey primary key (consumer_name, message_id),
        constraint inbox_messages_consumer_name_check check (length(consumer_name) between 1 and 255),
        constraint inbox_messages_message_id_check check (length(message_id) between 1 and 255),
        constraint inbox_messages_payload_hash_check check (payload_hash ~ '^[0-9a-f]{64}$'),
        constraint inbox_messages_processing_check check (
          (processed_at is null and transaction_id is null)
          or (processed_at is not null and transaction_id is not null)
        ),
        constraint inbox_messages_transaction_fk foreign key (transaction_id) references wager_transactions (id)
      );

      create function protect_inbox_message() returns trigger language plpgsql as $$
      begin
        if old.processed_at is not null then
          raise exception 'Processed inbox messages are immutable' using errcode = '23514';
        end if;
        if tg_op = 'UPDATE' then
          if (new.consumer_name, new.message_id, new.payload_hash, new.received_at)
            is distinct from (old.consumer_name, old.message_id, old.payload_hash, old.received_at) then
            raise exception 'Inbox identity is immutable' using errcode = '23514';
          end if;
          return new;
        end if;
        return old;
      end;
      $$;

      create trigger inbox_messages_protect_identity_and_result
        before update or delete on inbox_messages
        for each row execute function protect_inbox_message();

      create function reject_inbox_truncate() returns trigger language plpgsql as $$
      begin
        raise exception 'Inbox messages cannot be truncated' using errcode = '23514';
      end;
      $$;

      create trigger inbox_messages_no_truncate
        before truncate on inbox_messages
        for each statement execute function reject_inbox_truncate();
    `);
  }

  override async down(): Promise<void> {
    // Removing accepted inbox history would also remove durable duplicate protection.
    // The lock prevents a concurrent claim between the emptiness check and the drop.
    this.addSql(`
      lock table inbox_messages in access exclusive mode;
      do $$
      begin
        if exists (select 1 from inbox_messages) then
          raise exception 'Cannot roll back inbox schema while inbox history exists' using errcode = '23514';
        end if;
      end;
      $$;

      drop table inbox_messages;
      drop function protect_inbox_message();
      drop function reject_inbox_truncate();
    `);
  }
}
