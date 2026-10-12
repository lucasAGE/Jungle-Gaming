import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { createOrm } from "../database/orm.js";
import { eventsQueueName, wagerDlqName, wagerQueueName } from "../messaging/sqs-client.js";

export class DependencyProbes {
  private databaseProbe: Promise<void> | undefined;
  private outboxProbe: Promise<{ pending: number; lagSeconds: number }> | undefined;

  constructor(private readonly orm: Awaited<ReturnType<typeof createOrm>>, private readonly sqs: SQSClient) {}

  postgres(): Promise<void> {
    // Keep at most one outstanding acquisition if the financial pool is exhausted.
    // Knex cancels the PostgreSQL statement once acquired; the HTTP deadline is separate.
    this.databaseProbe ??= this.orm.em.getConnection().getKnex().raw("select 1").timeout(1_000, { cancel: true })
      .then(() => {}).finally(() => { this.databaseProbe = undefined; });
    return this.databaseProbe;
  }

  async queues(signal: AbortSignal): Promise<void> {
    const queues = [
      [wagerQueueName, process.env.SQS_WAGER_QUEUE_URL],
      [wagerDlqName, process.env.SQS_WAGER_DLQ_URL],
      [eventsQueueName, process.env.SQS_EVENTS_QUEUE_URL],
    ] as const;
    await Promise.all(queues.map(async ([name, configuredUrl]) => {
      const url = configuredUrl ?? (await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }), { abortSignal: signal })).QueueUrl;
      if (!url) throw new Error("Queue unavailable");
      // Checking attributes detects a deleted or inaccessible queue even with a configured URL.
      await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["QueueArn"] }), { abortSignal: signal });
    }));
  }

  outbox(): Promise<{ pending: number; lagSeconds: number }> {
    this.outboxProbe ??= this.orm.em.getConnection().getKnex().raw(`
      select count(*)::text as pending,
        coalesce(extract(epoch from (clock_timestamp() - min(occurred_at))), 0)::text as lag_seconds
      from outbox_messages where published_at is null
    `).timeout(1_000, { cancel: true }).then((result: { rows: Array<{ pending: string; lag_seconds: string }> }) => {
      const row = result.rows[0]!;
      return { pending: Number(row.pending), lagSeconds: Math.max(0, Number(row.lag_seconds)) };
    }).finally(() => { this.outboxProbe = undefined; });
    return this.outboxProbe;
  }
}
