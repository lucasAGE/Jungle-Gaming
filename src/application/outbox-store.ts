import type { OutboxMessage } from "../domain/outbox-message.js";

export abstract class OutboxStore {
  // Select one committed, due row exclusively; commit delivery state before returning.
  // A crash releases the claim automatically and leaves the event eligible for recovery.
  abstract withNextDue(work: (message: OutboxMessage) => Promise<void>): Promise<OutboxMessage | null>;
}
