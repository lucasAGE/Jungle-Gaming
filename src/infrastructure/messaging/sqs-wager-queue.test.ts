import { describe, expect, test } from "bun:test";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { QueueDelivery } from "../../application/wager-queue.js";
import { SqsWagerQueue } from "./sqs-wager-queue.js";

type Command = ChangeMessageVisibilityCommand | DeleteMessageCommand | ReceiveMessageCommand | SendMessageCommand;
const delivery: QueueDelivery = {
  brokerMessageId: "broker-message-1",
  receiptHandle: "latest-receipt",
  body: "not valid JSON",
  receiveCount: 3,
  messageGroupId: "wallet-1",
};

function fixture(handle: (command: Command) => Promise<object> = async () => ({})) {
  const commands: Command[] = [];
  const client = { send: async (command: Command) => {
    commands.push(command);
    return handle(command);
  } } as unknown as SQSClient;
  return { queue: new SqsWagerQueue(client, "source-url", "dlq-url"), commands };
}

describe("SQS wager queue delivery safety", () => {
  test("leaves the source unacknowledged when sending to the DLQ fails", async () => {
    const { queue, commands } = fixture(async () => { throw new Error("SQS unavailable"); });
    await expect(queue.deadLetter(delivery, "INVALID_INPUT")).rejects.toThrow("SQS unavailable");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(SendMessageCommand);
  });

  test("acknowledges only after the DLQ send has completed", async () => {
    let completeSend: () => void = () => {};
    const sendCompleted = new Promise<void>((resolve) => { completeSend = resolve; });
    const { queue, commands } = fixture(async (command) => {
      if (command instanceof SendMessageCommand) await sendCompleted;
      return {};
    });
    const handling = queue.deadLetter(delivery, "INVALID_INPUT");
    expect(commands).toHaveLength(1);
    const send = commands[0] as SendMessageCommand;
    expect(send.input.MessageBody).toBe(delivery.body);
    expect(send.input.MessageDeduplicationId).toBe(delivery.brokerMessageId);
    expect(send.input.MessageGroupId).toBe(delivery.messageGroupId);
    expect(send.input.MessageAttributes?.FailureCode?.StringValue).toBe("INVALID_INPUT");
    expect(send.input.MessageAttributes?.OriginalMessageId?.StringValue).toBe(delivery.brokerMessageId);
    completeSend();
    await handling;
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBeInstanceOf(DeleteMessageCommand);
    expect((commands[1] as DeleteMessageCommand).input.ReceiptHandle).toBe("latest-receipt");
  });

  test("keeps a stable DLQ deduplication ID when source deletion fails and is retried", async () => {
    const { queue, commands } = fixture(async (command) => {
      if (command instanceof DeleteMessageCommand) throw new Error("Delete response lost");
      return {};
    });
    await expect(queue.deadLetter(delivery, "INVALID_INPUT")).rejects.toThrow("Delete response lost");
    await expect(queue.deadLetter({ ...delivery, receiptHandle: "redelivery-receipt" }, "INVALID_INPUT"))
      .rejects.toThrow("Delete response lost");
    const sends = commands.filter((command) => command instanceof SendMessageCommand);
    expect(sends).toHaveLength(2);
    expect(sends.map((command) => command.input.MessageDeduplicationId))
      .toEqual([delivery.brokerMessageId, delivery.brokerMessageId]);
    expect((commands[3] as DeleteMessageCommand).input.ReceiptHandle).toBe("redelivery-receipt");
  });

  test("returns the raw body for application validation and the persisted broker receive count", async () => {
    const { queue } = fixture(async () => ({ Messages: [{
      MessageId: delivery.brokerMessageId,
      ReceiptHandle: delivery.receiptHandle,
      Body: delivery.body,
      Attributes: { ApproximateReceiveCount: "3", MessageGroupId: "wallet-1" },
    }] }));
    expect(await queue.receive()).toEqual(delivery);
  });

  test("does not process messages with incomplete broker metadata", async () => {
    const { queue, commands } = fixture(async () => ({ Messages: [{
      MessageId: delivery.brokerMessageId, Body: delivery.body,
    }] }));
    await expect(queue.receive()).rejects.toThrow("SQS returned incomplete delivery metadata");
    expect(commands).toHaveLength(1);
  });

  test("returns null when the receive poll has no message", async () => {
    expect(await fixture().queue.receive()).toBeNull();
  });

  test("returns visibility immediately on retry zero without acknowledging", async () => {
    const { queue, commands } = fixture();
    await queue.retry(delivery, 0);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(ChangeMessageVisibilityCommand);
    expect((commands[0] as ChangeMessageVisibilityCommand).input).toEqual({
      QueueUrl: "source-url", ReceiptHandle: "latest-receipt", VisibilityTimeout: 0,
    });
  });
});
