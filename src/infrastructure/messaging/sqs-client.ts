import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";

export const eventsQueueName = "wager-events";
export const wagerQueueName = "wager-transactions.fifo";
export const wagerDlqName = "wager-transactions-dlq.fifo";

export function inputVisibilityTimeoutSeconds(): number {
  const value = Number(process.env.SQS_VISIBILITY_TIMEOUT_SECONDS ?? "30");
  if (!Number.isInteger(value) || value < 2 || value > 43_200) {
    throw new Error("SQS_VISIBILITY_TIMEOUT_SECONDS must be an integer from 2 through 43200");
  }
  return value;
}

export function createSqsClient(endpoint = process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566"): SQSClient {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("SQS_ENDPOINT must be a local MiniStack HTTP endpoint");
  }

  return new SQSClient({
    endpoint: url.origin,
    region: "us-east-1",
    // This local challenge must never discover credentials from the user's AWS profile.
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    // Workers own retry schedules; hidden SDK retries would obscure delivery attempts.
    maxAttempts: 1,
    useQueueUrlAsEndpoint: false,
    requestHandler: { connectionTimeout: 1_000, requestTimeout: 3_000, throwOnRequestTimeout: true },
  });
}

export async function getEventsQueueUrl(client: SQSClient): Promise<string> {
  return getQueueUrl(client, eventsQueueName);
}

export async function getQueueUrl(client: SQSClient, queueName: string): Promise<string> {
  const result = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (!result.QueueUrl) throw new Error(`SQS did not return the ${queueName} queue URL`);
  return result.QueueUrl;
}

export async function getWagerQueueUrl(client: SQSClient): Promise<string> {
  return getQueueUrl(client, wagerQueueName);
}

export async function getWagerDlqUrl(client: SQSClient): Promise<string> {
  return getQueueUrl(client, wagerDlqName);
}
