import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { WagerQueue, type QueueDelivery } from "../../application/wager-queue.js";
import { getWagerDlqUrl, getWagerQueueUrl, inputVisibilityTimeoutSeconds } from "./sqs-client.js";
import { traceCarrier } from "../observability/tracing.js";

export class SqsWagerQueue extends WagerQueue {
  constructor(
    private readonly client: SQSClient,
    private queueUrl: string | undefined = process.env.SQS_WAGER_QUEUE_URL,
    private dlqUrl: string | undefined = process.env.SQS_WAGER_DLQ_URL,
    private readonly visibilityTimeoutSeconds = inputVisibilityTimeoutSeconds(),
  ) { super(); }

  override async receive(): Promise<QueueDelivery | null> {
    this.queueUrl ??= await getWagerQueueUrl(this.client);
    const response = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.queueUrl,
      MaxNumberOfMessages: 1,
      // Stay below the client's three-second request timeout, including during shutdown.
      WaitTimeSeconds: 1,
      VisibilityTimeout: this.visibilityTimeoutSeconds,
      MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
      MessageAttributeNames: ["traceparent", "tracestate"],
    }));
    const message = response.Messages?.[0];
    if (!message) return null;
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount);
    if (!message.MessageId || !message.ReceiptHandle || message.Body === undefined
      || !Number.isSafeInteger(receiveCount) || receiveCount < 1) {
      throw new Error("SQS returned incomplete delivery metadata");
    }
    const carrier = traceCarrier({ traceparent: message.MessageAttributes?.traceparent?.StringValue,
      tracestate: message.MessageAttributes?.tracestate?.StringValue });
    return {
      brokerMessageId: message.MessageId,
      receiptHandle: message.ReceiptHandle,
      body: message.Body,
      receiveCount,
      messageGroupId: message.Attributes?.MessageGroupId,
      ...(Object.keys(carrier).length ? { traceContext: carrier } : {}),
    };
  }

  override async acknowledge(delivery: QueueDelivery): Promise<void> {
    this.queueUrl ??= await getWagerQueueUrl(this.client);
    await this.client.send(new DeleteMessageCommand({
      QueueUrl: this.queueUrl,
      ReceiptHandle: delivery.receiptHandle,
    }));
  }

  override async retry(delivery: QueueDelivery, delaySeconds: number): Promise<void> {
    if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 43_200) {
      throw new Error("SQS visibility must be an integer from zero through 43200 seconds");
    }
    this.queueUrl ??= await getWagerQueueUrl(this.client);
    await this.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: this.queueUrl,
      ReceiptHandle: delivery.receiptHandle,
      VisibilityTimeout: delaySeconds,
    }));
  }

  override async deadLetter(delivery: QueueDelivery, reasonCode: string): Promise<void> {
    this.dlqUrl ??= await getWagerDlqUrl(this.client);
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.dlqUrl,
      MessageBody: delivery.body,
      MessageGroupId: delivery.messageGroupId ?? "invalid",
      // A failed delete can redeliver the source after the DLQ send already succeeded.
      MessageDeduplicationId: delivery.brokerMessageId,
      MessageAttributes: {
        FailureCode: { DataType: "String", StringValue: reasonCode },
        OriginalMessageId: { DataType: "String", StringValue: delivery.brokerMessageId },
      },
    }));
    // Send and delete cannot be atomic: prefer duplicate DLQ entries over message loss.
    await this.acknowledge(delivery);
  }
}
