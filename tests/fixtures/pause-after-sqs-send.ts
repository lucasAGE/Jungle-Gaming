import { PublishOutbox } from "../../src/application/publish-outbox.js";
import { EventPublisher } from "../../src/application/event-publisher.js";
import { OutboxMessage } from "../../src/domain/outbox-message.js";
import { createOrm } from "../../src/infrastructure/database/orm.js";
import { PostgresOutboxStore } from "../../src/infrastructure/database/postgres-outbox-store.js";
import { SqsEventPublisher } from "../../src/infrastructure/messaging/sqs-event-publisher.js";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client.js";
import { isolatedDatabaseUrl } from "../integration/helpers.js";

const endpoint = new URL(process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4567");
if (process.env.RUN_SQS_INTEGRATION !== "1" || endpoint.port !== "4567") {
  throw new Error("The crash fixture requires the isolated MiniStack integration environment");
}
const client = createSqsClient(endpoint.href);
const orm = await createOrm(isolatedDatabaseUrl());
const realPublisher = new SqsEventPublisher(client, process.env.SQS_EVENTS_QUEUE_URL);

class PauseAfterSend extends EventPublisher {
  override async publish(message: OutboxMessage): Promise<void> {
    await realPublisher.publish(message);
    // The parent kills this process while SQS has the event but PostgreSQL has no publication commit.
    console.log(JSON.stringify({ event: "outbox_send_paused", eventId: message.id }));
    await new Promise<void>(() => {});
  }
}

await new PublishOutbox(new PostgresOutboxStore(orm), new PauseAfterSend()).execute();
await orm.close(true);
client.destroy();
