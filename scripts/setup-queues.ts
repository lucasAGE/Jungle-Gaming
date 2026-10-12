import { CreateQueueCommand, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import {
  createSqsClient,
  eventsQueueName,
  wagerDlqName,
  wagerQueueName,
} from "../src/infrastructure/messaging/sqs-client.js";

const client = createSqsClient();
try {
  // Repeating CreateQueue with the same attributes preserves existing messages.
  const result = await client.send(new CreateQueueCommand({
    QueueName: eventsQueueName,
    Attributes: { MessageRetentionPeriod: "1209600", VisibilityTimeout: "30" },
  }));
  if (!result.QueueUrl) throw new Error("SQS did not return the events queue URL");
  console.log(JSON.stringify({ event: "events_queue_ready", queueName: eventsQueueName, queueUrl: result.QueueUrl }));

  const dlq = await client.send(new CreateQueueCommand({
    QueueName: wagerDlqName,
    Attributes: {
      FifoQueue: "true",
      ContentBasedDeduplication: "false",
      MessageRetentionPeriod: "1209600",
      VisibilityTimeout: "30",
    },
  }));
  if (!dlq.QueueUrl) throw new Error("SQS did not return the wager DLQ URL");
  const attributes = await client.send(new GetQueueAttributesCommand({
    QueueUrl: dlq.QueueUrl,
    AttributeNames: ["QueueArn"],
  }));
  const dlqArn = attributes.Attributes?.QueueArn;
  if (!dlqArn) throw new Error("SQS did not return the wager DLQ ARN");

  const input = await client.send(new CreateQueueCommand({
    QueueName: wagerQueueName,
    Attributes: {
      FifoQueue: "true",
      ContentBasedDeduplication: "false",
      MessageRetentionPeriod: "345600",
      VisibilityTimeout: "30",
      // Broker redrive still works if a process repeatedly dies before handling an error.
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 5 }),
    },
  }));
  if (!input.QueueUrl) throw new Error("SQS did not return the wager input queue URL");
  console.log(JSON.stringify({
    event: "wager_queues_ready",
    queueName: wagerQueueName,
    queueUrl: input.QueueUrl,
    dlqUrl: dlq.QueueUrl,
    maxReceiveCount: 5,
  }));
} finally {
  client.destroy();
}
