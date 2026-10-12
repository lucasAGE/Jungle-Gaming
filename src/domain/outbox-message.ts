import { DomainError } from "./domain-error.js";
import type { IntegrationEvent } from "./integration-event.js";

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt?: Date;
  readonly publishedAt?: Date;
}

export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly #payload: Readonly<Record<string, unknown>>;
  readonly #occurredAt: Date;
  #attempts: number;
  #nextAttemptAt: Date | undefined;
  #publishedAt: Date | undefined;

  private constructor(state: OutboxMessageState) {
    this.id = state.id;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.#payload = structuredClone(state.payload);
    this.#occurredAt = new Date(state.occurredAt);
    this.#attempts = state.attempts;
    this.#nextAttemptAt = state.nextAttemptAt === undefined ? undefined : new Date(state.nextAttemptAt);
    this.#publishedAt = state.publishedAt === undefined ? undefined : new Date(state.publishedAt);
    Object.freeze(this);
  }

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: { ...event.toJSON() },
      occurredAt: event.occurredAt,
      attempts: 0,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }

  get payload(): Readonly<Record<string, unknown>> {
    return structuredClone(this.#payload);
  }

  get occurredAt(): Date {
    return new Date(this.#occurredAt);
  }

  get attempts(): number {
    return this.#attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this.#nextAttemptAt === undefined ? undefined : new Date(this.#nextAttemptAt);
  }

  get publishedAt(): Date | undefined {
    return this.#publishedAt === undefined ? undefined : new Date(this.#publishedAt);
  }

  isPending(): boolean {
    return this.#publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this.#nextAttemptAt === undefined || this.#nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    this.assertPending();
    this.#publishedAt = new Date(at);
    this.#nextAttemptAt = undefined;
  }

  scheduleRetry(now: Date): void {
    this.assertPending();
    this.#attempts += 1;
    // Cap the exponent too: long outages must not overflow or discard confirmed events.
    const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(this.#attempts - 1, 6));
    this.#nextAttemptAt = new Date(now.getTime() + delayMs);
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new DomainError("INVALID_OUTBOX_STATE", "A published outbox message cannot change state");
    }
  }
}
