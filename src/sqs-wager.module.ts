import { SQSClient } from "@aws-sdk/client-sqs";
import { Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { ConsumeWager } from "./application/consume-wager.js";
import { ProcessWager } from "./application/process-wager.js";
import { WagerQueue } from "./application/wager-queue.js";
import { createSqsClient } from "./infrastructure/messaging/sqs-client.js";
import { SqsWagerQueue } from "./infrastructure/messaging/sqs-wager-queue.js";
import { SqsWagerWorker } from "./infrastructure/messaging/sqs-wager-worker.js";
import { WageringModule } from "./wagering.module.js";

@Injectable()
class ConsumerSqsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SQSClient) private readonly client: SQSClient) {}
  onApplicationShutdown(): void { this.client.destroy(); }
}

@Module({
  imports: [WageringModule],
  providers: [
    { provide: SQSClient, useFactory: () => createSqsClient() },
    { provide: WagerQueue, useFactory: (client: SQSClient) => new SqsWagerQueue(client), inject: [SQSClient] },
    { provide: ConsumeWager, useFactory: (process: ProcessWager, queue: WagerQueue) => new ConsumeWager(process, queue), inject: [ProcessWager, WagerQueue] },
    SqsWagerWorker,
    ConsumerSqsLifecycle,
  ],
})
export class SqsWagerModule {}
