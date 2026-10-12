import { DomainError } from "./domain-error.js";

export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export interface InboxState extends ReceiveInboxProps {
  readonly processedAt?: Date;
  readonly transactionId?: string;
}

export class InboxMessage {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly #receivedAt: Date;
  #processedAt: Date | undefined;
  #transactionId: string | undefined;

  private constructor(state: InboxState) {
    this.messageId = state.messageId;
    this.consumerName = state.consumerName;
    this.payloadHash = state.payloadHash;
    this.#receivedAt = new Date(state.receivedAt);
    this.#processedAt = state.processedAt === undefined ? undefined : new Date(state.processedAt);
    this.#transactionId = state.transactionId;
    Object.freeze(this);
  }

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(props);
  }

  static rehydrate(state: InboxState): InboxMessage {
    return new InboxMessage(state);
  }

  get receivedAt(): Date {
    return new Date(this.#receivedAt);
  }

  get processedAt(): Date | undefined {
    return this.#processedAt === undefined ? undefined : new Date(this.#processedAt);
  }

  get transactionId(): string | undefined {
    return this.#transactionId;
  }

  isProcessed(): boolean {
    return this.#processedAt !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(transactionId: string, at: Date): void {
    if (this.isProcessed()) {
      throw new DomainError("INVALID_INBOX_STATE", "A processed inbox message cannot change state");
    }
    this.#transactionId = transactionId;
    this.#processedAt = new Date(at);
  }
}
