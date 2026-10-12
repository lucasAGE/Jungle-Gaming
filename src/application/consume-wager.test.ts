import { describe, expect, spyOn, test } from "bun:test";
import { DomainError } from "../domain/domain-error.js";
import { MoneyError } from "../domain/money.js";
import { ApplicationError } from "./application-error.js";
import { ConsumeWager, wagerConsumerName } from "./consume-wager.js";
import { ProcessingError } from "./processing-error.js";
import { ProcessWager, type WagerResult } from "./process-wager.js";
import type { QueueDelivery, WagerQueue } from "./wager-queue.js";

const walletId = "0192f291-27dd-7d3f-8071-5f8685deef37";
const business = {
  providerId: "provider-a", externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", walletId,
  roundId: "round-987", gameId: "fortune-chimp", kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};
const result: WagerResult = {
  transactionId: "0192f298-345e-7e38-af88-e43f851a819d", status: "PROCESSED",
  balance: { amount: "75.00", currency: "BRL" }, idempotentReplay: false,
};
const delivery: QueueDelivery = {
  brokerMessageId: "broker-message-123", receiptHandle: "receipt-123", receiveCount: 1,
  messageGroupId: walletId,
  body: JSON.stringify({
    messageId: "message-123", type: "WagerTransactionRequested", occurredAt: "2026-10-10T12:00:00.000Z",
    data: { ...business, idempotencyKey: "provider-a:transaction-123" },
  }),
};

function fixture(handle: ProcessWager["execute"] = async () => result) {
  const acknowledgments: QueueDelivery[] = [];
  const retries: { delivery: QueueDelivery; delaySeconds: number }[] = [];
  const deadLetters: { delivery: QueueDelivery; reasonCode: string }[] = [];
  const queue: WagerQueue = {
    async receive() { throw new Error("Polling belongs to the worker"); },
    async acknowledge(message) { acknowledgments.push(message); },
    async retry(message, delaySeconds) { retries.push({ delivery: message, delaySeconds }); },
    async deadLetter(message, reasonCode) { deadLetters.push({ delivery: message, reasonCode }); },
  };
  const processWager = new ProcessWager({
    async findById() { throw new Error("This test replaces the financial use case"); },
    async findByKey() { throw new Error("This test replaces the financial use case"); },
    async findByExternal() { throw new Error("This test replaces the financial use case"); },
    async transaction() { throw new Error("This test replaces the financial use case"); },
  });
  const processing = spyOn(processWager, "execute").mockImplementation(handle);
  return { consumer: new ConsumeWager(processWager, queue), processing, queue, acknowledgments, retries, deadLetters };
}

describe("ConsumeWager commit and acknowledgment boundary", () => {
  test("dead-letters a durable FAILED result only after the audit commit, including replay", async () => {
    let commit: (value: WagerResult) => void = () => {};
    const committed = new Promise<WagerResult>((resolve) => { commit = resolve; });
    const state = fixture(async () => committed);
    const handling = state.consumer.execute(delivery);
    expect(state.deadLetters).toEqual([]);
    expect(state.acknowledgments).toEqual([]);
    const failed: WagerResult = { ...result, status: "FAILED", failureCode: "DATABASE_OPERATION_FAILED", idempotentReplay: true };
    commit(failed);
    expect(await handling).toMatchObject({ status: "dead_lettered", reasonCode: "DATABASE_OPERATION_FAILED", result: failed });
    expect(state.deadLetters).toEqual([{ delivery, reasonCode: "DATABASE_OPERATION_FAILED" }]);
    expect(state.acknowledgments).toEqual([]);
  });

  test("does not reclassify an audited failure when DLQ transport fails", async () => {
    const state = fixture(async () => ({ ...result, status: "FAILED", failureCode: "DATABASE_OPERATION_FAILED" }));
    const failure = new Error("DLQ is unavailable");
    spyOn(state.queue, "deadLetter").mockRejectedValue(failure);
    await expect(state.consumer.execute(delivery)).rejects.toBe(failure);
    expect(state.acknowledgments).toEqual([]);
    expect(state.retries).toEqual([]);
  });

  test("retries an unavailable audit rather than treating an uncommitted failure as terminal", async () => {
    const state = fixture(async () => { throw new ProcessingError(true, new Error("Audit unavailable"), true); });
    expect(await state.consumer.execute(delivery)).toMatchObject({ status: "retry_scheduled", reasonCode: "FAILURE_AUDIT_UNAVAILABLE" });
    expect(state.deadLetters).toEqual([]);
    expect(state.acknowledgments).toEqual([]);
  });
  test("waits for the financial use case to commit before acknowledging", async () => {
    let commit: (value: WagerResult) => void = () => {};
    const committed = new Promise<WagerResult>((resolve) => { commit = resolve; });
    const { consumer, processing, acknowledgments, retries, deadLetters } = fixture(async () => committed);
    const handling = consumer.execute(delivery);

    expect(processing).toHaveBeenCalledTimes(1);
    expect(processing).toHaveBeenCalledWith(business, "provider-a:transaction-123", {
      consumerName: wagerConsumerName, messageId: "message-123", correlationId: "message-123",
      receivedAt: expect.any(Date),
    });
    expect(acknowledgments).toEqual([]);
    expect(retries).toEqual([]);
    expect(deadLetters).toEqual([]);

    commit(result);
    expect(await handling).toEqual({
      status: "acknowledged", messageId: "message-123", walletId, providerId: "provider-a", result,
    });
    expect(acknowledgments).toEqual([delivery]);
  });

  test("acknowledges a persisted insufficient-funds decision instead of retrying the business rejection", async () => {
    const rejection: WagerResult = {
      ...result, status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS",
      balance: { amount: "20.00", currency: "BRL" },
    };
    const { consumer, acknowledgments, retries, deadLetters } = fixture(async () => rejection);

    expect(await consumer.execute(delivery)).toMatchObject({ status: "acknowledged", result: rejection });
    expect(acknowledgments).toEqual([delivery]);
    expect(retries).toEqual([]);
    expect(deadLetters).toEqual([]);
  });

  test("acknowledges a committed duplicate while preserving its original result", async () => {
    const replay = { ...result, idempotentReplay: true };
    const { consumer, acknowledgments } = fixture(async () => replay);

    expect(await consumer.execute(delivery)).toMatchObject({ status: "acknowledged", result: replay });
    expect(acknowledgments).toEqual([delivery]);
  });

  test("propagates a failed acknowledgment without reclassifying the committed operation", async () => {
    const { consumer, processing, queue, retries, deadLetters } = fixture();
    const failure = new ProcessingError(true, new Error("Lost delete response"));
    const acknowledge = spyOn(queue, "acknowledge").mockRejectedValue(failure);

    await expect(consumer.execute({ ...delivery, receiveCount: 5 })).rejects.toBe(failure);
    expect(processing).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(retries).toEqual([]);
    expect(deadLetters).toEqual([]);
  });

  test.each([
    { failure: undefined, status: "acknowledged" },
    { failure: new ProcessingError(true, new Error("Database unavailable")), status: "retry_scheduled" },
    { failure: new ApplicationError("INVALID_INPUT", "Invalid request"), status: "dead_lettered" },
  ])("drains in-flight visibility renewal before settling a delivery: %j", async ({ failure, status }) => {
    const { consumer, acknowledgments, retries, deadLetters } = fixture(async () => {
      if (failure) throw failure;
      return result;
    });
    let startDrain: () => void = () => {};
    let finishDrain: () => void = () => {};
    const drainStarted = new Promise<void>((resolve) => { startDrain = resolve; });
    const drained = new Promise<void>((resolve) => { finishDrain = resolve; });
    const handling = consumer.execute(delivery, async () => {
      startDrain();
      await drained;
    });
    await drainStarted;

    expect(acknowledgments).toEqual([]);
    expect(retries).toEqual([]);
    expect(deadLetters).toEqual([]);
    finishDrain();
    expect(await handling).toMatchObject({ status });
    expect(acknowledgments.length + retries.length + deadLetters.length).toBe(1);
  });

  test("does not settle when visibility renewal cannot be drained safely", async () => {
    const { consumer, processing, acknowledgments, retries, deadLetters } = fixture();
    const failure = new Error("Visibility renewal failed");

    await expect(consumer.execute(delivery, async () => { throw failure; })).rejects.toBe(failure);
    expect(processing).toHaveBeenCalledTimes(1);
    expect(acknowledgments).toEqual([]);
    expect(retries).toEqual([]);
    expect(deadLetters).toEqual([]);
  });
});

describe("ConsumeWager retry and dead-letter decisions", () => {
  test.each([
    new ApplicationError("INVALID_INPUT", "Invalid request"),
    new ApplicationError("IDEMPOTENCY_CONFLICT", "Different payload"),
    new ApplicationError("INBOX_PAYLOAD_CONFLICT", "Different message content"),
    new ApplicationError("WALLET_NOT_FOUND", "Unknown wallet"),
    new MoneyError("INVALID_MONEY_AMOUNT", "Invalid decimal"),
    new DomainError("INVALID_TRANSACTION_STATE", "Terminal transaction"),
    new ProcessingError(false, new Error("Database constraint contains confidential SQL details")),
  ])("sends a permanent processing failure to the DLQ with its stable code: %s", async (failure) => {
    const { consumer, acknowledgments, retries, deadLetters } = fixture(async () => { throw failure; });

    expect(await consumer.execute(delivery)).toEqual({
      status: "dead_lettered", reasonCode: failure.code, messageId: "message-123", walletId, providerId: "provider-a",
    });
    expect(deadLetters).toEqual([{ delivery, reasonCode: failure.code }]);
    expect(acknowledgments).toEqual([]);
    expect(retries).toEqual([]);
  });

  test.each([[1, 1], [2, 2], [3, 4], [4, 8]] as const)(
    "schedules persisted receive %i for retry after %i seconds", async (receiveCount, delaySeconds) => {
      const { consumer, acknowledgments, retries, deadLetters } = fixture(async () => {
        throw new ProcessingError(true, new Error("PostgreSQL is unavailable"));
      });
      const message = { ...delivery, receiveCount };

      expect(await consumer.execute(message)).toEqual({
        status: "retry_scheduled", reasonCode: "DATABASE_UNAVAILABLE", messageId: "message-123", walletId, providerId: "provider-a",
      });
      expect(retries).toEqual([{ delivery: message, delaySeconds }]);
      expect(acknowledgments).toEqual([]);
      expect(deadLetters).toEqual([]);
    },
  );

  test.each([5, 6])("dead-letters exhausted transient failure on receive %i", async (receiveCount) => {
    const { consumer, acknowledgments, retries, deadLetters } = fixture(async () => {
      throw new ProcessingError(true, new Error("PostgreSQL is unavailable"));
    });
    const message = { ...delivery, receiveCount };

    expect(await consumer.execute(message)).toMatchObject({ status: "dead_lettered", reasonCode: "RETRY_EXHAUSTED" });
    expect(deadLetters).toEqual([{ delivery: message, reasonCode: "RETRY_EXHAUSTED" }]);
    expect(acknowledgments).toEqual([]);
    expect(retries).toEqual([]);
  });

  test("bounds unexpected errors using the same persisted receive limit", async () => {
    const { consumer, retries, deadLetters } = fixture(async () => { throw new Error("Unexpected failure"); });

    expect(await consumer.execute(delivery)).toMatchObject({ status: "retry_scheduled", reasonCode: "INTERNAL_ERROR" });
    expect(await consumer.execute({ ...delivery, receiveCount: 5 }))
      .toMatchObject({ status: "dead_lettered", reasonCode: "RETRY_EXHAUSTED" });
    expect(retries).toHaveLength(1);
    expect(deadLetters).toHaveLength(1);
  });

  test.each([
    { ...delivery, body: "not JSON" },
    { ...delivery, messageGroupId: "different-wallet" },
  ])("never invokes financial processing for an invalid envelope or FIFO group", async (message) => {
    const { consumer, processing, acknowledgments, retries, deadLetters } = fixture();

    expect(await consumer.execute(message)).toMatchObject({ status: "dead_lettered" });
    expect(processing).not.toHaveBeenCalled();
    expect(deadLetters).toHaveLength(1);
    expect(acknowledgments).toEqual([]);
    expect(retries).toEqual([]);
  });

  test("propagates retry scheduling failure without deleting or dead-lettering the source", async () => {
    const { consumer, queue, acknowledgments, deadLetters } = fixture(async () => {
      throw new ProcessingError(true, new Error("PostgreSQL unavailable"));
    });
    const failure = new Error("Visibility update failed");
    spyOn(queue, "retry").mockRejectedValue(failure);

    await expect(consumer.execute(delivery)).rejects.toBe(failure);
    expect(acknowledgments).toEqual([]);
    expect(deadLetters).toEqual([]);
  });

  test("propagates a DLQ transport failure without separately acknowledging the source", async () => {
    const { consumer, queue, acknowledgments, retries } = fixture();
    const failure = new Error("DLQ send failed");
    spyOn(queue, "deadLetter").mockRejectedValue(failure);

    await expect(consumer.execute({ ...delivery, body: "not JSON" })).rejects.toBe(failure);
    expect(acknowledgments).toEqual([]);
    expect(retries).toEqual([]);
  });
});
