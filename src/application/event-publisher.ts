import type { OutboxMessage } from "../domain/outbox-message.js";

export abstract class EventPublisher {
  abstract publish(message: OutboxMessage): Promise<void>;
}
