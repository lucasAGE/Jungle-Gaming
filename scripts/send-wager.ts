import { randomUUID } from "node:crypto";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { uuidInput } from "../src/application/input-validation.js";
import { sqsWagerInput } from "../src/application/sqs-wager-input.js";
import { wagerInput } from "../src/application/wager-input.js";
import { createSqsClient, getWagerQueueUrl } from "../src/infrastructure/messaging/sqs-client.js";

const path = process.argv[2];
if (!path || process.argv.length !== 3) throw new Error("Usage: bun run sqs:send <message.json>");
const body = await Bun.file(path).text();
const parsed = JSON.parse(body) as { data?: { walletId?: unknown } } | null;
const groupId = uuidInput(parsed?.data?.walletId);
const request = sqsWagerInput(body, groupId);
wagerInput(request.body);
const client = createSqsClient();
try {
  const queueUrl = process.env.SQS_WAGER_QUEUE_URL ?? await getWagerQueueUrl(client);
  const response = await client.send(new SendMessageCommand({
    QueueUrl: queueUrl, MessageBody: body, MessageGroupId: groupId,
    // Every manual send reaches the consumer so repeating a file exercises database idempotency.
    MessageDeduplicationId: randomUUID(),
  }));
  console.log(JSON.stringify({ event: "wager_enqueued", messageId: request.messageId, brokerMessageId: response.MessageId }));
} finally {
  client.destroy();
}
