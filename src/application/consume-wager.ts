import { DomainError } from "../domain/domain-error.js";
import { MoneyError } from "../domain/money.js";
import { ApplicationError } from "./application-error.js";
import { ProcessingError } from "./processing-error.js";
import type { ProcessWager, WagerResult } from "./process-wager.js";
import { sqsWagerInput } from "./sqs-wager-input.js";
import type { QueueDelivery, WagerQueue } from "./wager-queue.js";

export const wagerConsumerName = "wager-transactions";
export const maxWagerReceives = 5;

export interface ConsumptionResult {
  readonly status: "acknowledged" | "retry_scheduled" | "dead_lettered";
  readonly messageId?: string;
  readonly walletId?: string;
  readonly providerId?: string;
  readonly result?: WagerResult;
  readonly reasonCode?: string;
}

export class ConsumeWager {
  constructor(private readonly processWager: ProcessWager, private readonly queue: WagerQueue) {}

  async execute(delivery: QueueDelivery, beforeSettlement: () => Promise<void> = async () => {}): Promise<ConsumptionResult> {
    let request: ReturnType<typeof sqsWagerInput> | undefined;
    let result: WagerResult;
    try {
      request = sqsWagerInput(delivery.body, delivery.messageGroupId);
      result = await this.processWager.execute(request.body, request.idempotencyKey, {
        consumerName: wagerConsumerName, messageId: request.messageId,
        receivedAt: new Date(), correlationId: request.messageId,
      });
    } catch (error) {
      await beforeSettlement();
      const { retryable, code } = this.failure(error);
      const identity = request ? { messageId: request.messageId, walletId: request.walletId,
        ...(typeof request.body.providerId === "string" ? { providerId: request.body.providerId } : {}) } : {};
      if (retryable && delivery.receiveCount < maxWagerReceives) {
        const delaySeconds = Math.min(30, 2 ** Math.min(delivery.receiveCount - 1, 5));
        await this.queue.retry(delivery, delaySeconds);
        return { status: "retry_scheduled", reasonCode: code, ...identity };
      }
      const reasonCode = retryable ? "RETRY_EXHAUSTED" : code;
      await this.queue.deadLetter(delivery, reasonCode);
      return { status: "dead_lettered", reasonCode, ...identity };
    }
    // Ack failures must not be classified as financial failures or sent directly to DLQ.
    // The committed inbox makes the next delivery safe if this delete is lost.
    await beforeSettlement();
    if (result.status === "FAILED") {
      await this.queue.deadLetter(delivery, result.failureCode!);
      return { status: "dead_lettered", reasonCode: result.failureCode!, messageId: request.messageId,
        walletId: request.walletId,
        ...(typeof request.body.providerId === "string" ? { providerId: request.body.providerId } : {}), result };
    }
    await this.queue.acknowledge(delivery);
    return {
      status: "acknowledged", messageId: request.messageId, walletId: request.walletId,
      ...(typeof request.body.providerId === "string" ? { providerId: request.body.providerId } : {}), result,
    };
  }

  private failure(error: unknown): { retryable: boolean; code: string } {
    if (error instanceof ProcessingError) return { retryable: error.retryable, code: error.code };
    if (error instanceof ApplicationError || error instanceof MoneyError || error instanceof DomainError) {
      return { retryable: false, code: error.code };
    }
    // Unexpected failures get a bounded chance to recover, then remain inspectable in the DLQ.
    return { retryable: true, code: "INTERNAL_ERROR" };
  }
}
