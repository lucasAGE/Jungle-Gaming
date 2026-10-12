import type { OutboxMessage } from "../domain/outbox-message.js";
import type { EventPublisher } from "./event-publisher.js";
import type { OutboxStore } from "./outbox-store.js";

export interface PublicationResult {
  readonly status: "published" | "retry_scheduled";
  readonly message: OutboxMessage;
  readonly errorType?: string;
}

export class PublishOutbox {
  constructor(private readonly store: OutboxStore, private readonly publisher: EventPublisher) {}

  async execute(): Promise<PublicationResult | null> {
    let errorType: string | undefined;
    const message = await this.store.withNextDue(async (pending) => {
      try {
        await this.publisher.publish(pending);
      } catch (error) {
        errorType = error instanceof Error ? error.name : "Unknown";
        // Keep confirmed events durable even through prolonged outages or bad queue configuration.
        pending.scheduleRetry(new Date());
        return;
      }
      pending.markPublished(new Date());
    });
    if (!message) return null;
    return {
      status: message.isPending() ? "retry_scheduled" : "published", message,
      ...(errorType === undefined ? {} : { errorType }),
    };
  }
}
