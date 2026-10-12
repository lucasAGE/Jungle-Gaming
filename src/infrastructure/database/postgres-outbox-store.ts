import { IsolationLevel, LockMode, QueryOrder } from "@mikro-orm/core";
import { OutboxStore } from "../../application/outbox-store.js";
import { OutboxMessage } from "../../domain/outbox-message.js";
import { OutboxSchema } from "./entities.js";
import type { createOrm } from "./orm.js";

export class PostgresOutboxStore extends OutboxStore {
  constructor(private readonly orm: Awaited<ReturnType<typeof createOrm>>) { super(); }

  override async withNextDue(work: (message: OutboxMessage) => Promise<void>): Promise<OutboxMessage | null> {
    return this.orm.em.fork().transactional(async (em) => {
      const row = await em.findOne(OutboxSchema, {
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: new Date() } }],
      }, {
        orderBy: { occurredAt: QueryOrder.ASC, id: QueryOrder.ASC },
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      });
      if (!row) return null;
      const message = OutboxMessage.rehydrate({
        id: row.id, aggregateId: row.aggregateId, eventType: row.eventType,
        payload: row.payload, occurredAt: row.occurredAt, attempts: row.attempts,
        ...(row.nextAttemptAt === null ? {} : { nextAttemptAt: row.nextAttemptAt }),
        ...(row.publishedAt === null ? {} : { publishedAt: row.publishedAt }),
      });
      // The bounded network call holds only this outbox row, never a wallet lock.
      // SKIP LOCKED lets other publishers make progress without leases or expiry races.
      await work(message);
      row.attempts = message.attempts;
      row.nextAttemptAt = message.nextAttemptAt ?? null;
      row.publishedAt = message.publishedAt ?? null;
      await em.flush();
      return message;
    }, { isolationLevel: IsolationLevel.READ_COMMITTED });
  }
}
