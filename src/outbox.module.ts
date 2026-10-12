import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/core";
import { Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { EventPublisher } from "./application/event-publisher.js";
import { OutboxStore } from "./application/outbox-store.js";
import { PublishOutbox } from "./application/publish-outbox.js";
import { DatabaseModule } from "./infrastructure/database/database.module.js";
import type { createOrm } from "./infrastructure/database/orm.js";
import { PostgresOutboxStore } from "./infrastructure/database/postgres-outbox-store.js";
import { OutboxWorker } from "./infrastructure/messaging/outbox-worker.js";
import { createSqsClient } from "./infrastructure/messaging/sqs-client.js";
import { SqsEventPublisher } from "./infrastructure/messaging/sqs-event-publisher.js";

@Injectable()
class SqsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SQSClient) private readonly client: SQSClient) {}
  onApplicationShutdown(): void { this.client.destroy(); }
}

@Module({
  imports: [DatabaseModule],
  providers: [
    { provide: SQSClient, useFactory: () => createSqsClient() },
    { provide: EventPublisher, useFactory: (client: SQSClient) => new SqsEventPublisher(client, process.env.SQS_EVENTS_QUEUE_URL), inject: [SQSClient] },
    { provide: OutboxStore, useFactory: (orm: Awaited<ReturnType<typeof createOrm>>) => new PostgresOutboxStore(orm), inject: [MikroORM] },
    { provide: PublishOutbox, useFactory: (store: OutboxStore, publisher: EventPublisher) => new PublishOutbox(store, publisher), inject: [OutboxStore, EventPublisher] },
    OutboxWorker,
    SqsLifecycle,
  ],
})
export class OutboxModule {}
