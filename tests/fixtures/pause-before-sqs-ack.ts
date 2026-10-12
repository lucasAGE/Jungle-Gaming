import { ConsumeWager } from "../../src/application/consume-wager.js";
import { ProcessWager } from "../../src/application/process-wager.js";
import { WagerQueue, type QueueDelivery } from "../../src/application/wager-queue.js";
import { createOrm } from "../../src/infrastructure/database/orm.js";
import { PostgresWageringStore } from "../../src/infrastructure/database/postgres-wagering-store.js";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client.js";
import { SqsWagerQueue } from "../../src/infrastructure/messaging/sqs-wager-queue.js";
import { isolatedDatabaseUrl } from "../integration/helpers.js";

const endpoint = new URL(process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4567");
if (process.env.RUN_SQS_INTEGRATION !== "1" || endpoint.protocol !== "http:"
  || !["localhost", "127.0.0.1"].includes(endpoint.hostname) || endpoint.port !== "4567") {
  throw new Error("The crash fixture requires the isolated MiniStack integration environment");
}
const client = createSqsClient(endpoint.href);
const orm = await createOrm(isolatedDatabaseUrl());
const realQueue = new SqsWagerQueue(client, process.env.SQS_WAGER_QUEUE_URL, process.env.SQS_WAGER_DLQ_URL, 2);

class PauseBeforeAcknowledgment extends WagerQueue {
  override receive(): Promise<QueueDelivery | null> { return realQueue.receive(); }
  override retry(delivery: QueueDelivery, seconds: number): Promise<void> { return realQueue.retry(delivery, seconds); }
  override async deadLetter(delivery: QueueDelivery, _reasonCode: string): Promise<void> {
    // FAILED has also committed before its terminal DLQ settlement starts.
    console.log(JSON.stringify({ event: "sqs_ack_paused", brokerMessageId: delivery.brokerMessageId }));
    await new Promise<void>(() => {});
  }
  override async acknowledge(delivery: QueueDelivery): Promise<void> {
    // The parent kills this process after the SQL commit, while SQS still owns the unacknowledged message.
    console.log(JSON.stringify({ event: "sqs_ack_paused", brokerMessageId: delivery.brokerMessageId }));
    await new Promise<void>(() => {});
  }
}

const queue = new PauseBeforeAcknowledgment();
const delivery = await queue.receive();
if (!delivery) throw new Error("The crash fixture expected a queued wager");
await new ConsumeWager(new ProcessWager(new PostgresWageringStore(orm)), queue).execute(delivery);
await orm.close(true);
client.destroy();
