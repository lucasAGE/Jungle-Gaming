import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { ConsumeWager, type ConsumptionResult } from "../../application/consume-wager.js";
import { Telemetry } from "../../application/telemetry.js";
import { WagerQueue, type QueueDelivery } from "../../application/wager-queue.js";
import { inputVisibilityTimeoutSeconds } from "./sqs-client.js";
import { SpanKind } from "@opentelemetry/api";
import { extractTraceContext, inSpan } from "../observability/tracing.js";

@Injectable()
export class SqsWagerWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SqsWagerWorker.name);
  private stopping = false;
  private running: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    @Inject(ConsumeWager) private readonly consumeWager: ConsumeWager,
    @Inject(WagerQueue) private readonly queue: WagerQueue,
    @Optional() @Inject(Telemetry) private readonly telemetry: Telemetry = Telemetry.noop,
  ) {}

  onApplicationBootstrap(): void {
    const enabled = process.env.SQS_CONSUMER_ENABLED ?? "true";
    if (!["true", "false"].includes(enabled)) throw new Error("SQS_CONSUMER_ENABLED must be true or false");
    if (enabled === "true") this.running = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const delivery = await this.queue.receive();
        if (this.stopping) {
          if (delivery) await this.queue.retry(delivery, 0);
          break;
        }
        if (delivery) {
          await inSpan("sqs.wager.process", SpanKind.CONSUMER, async () => {
            this.log(delivery, await this.process(delivery));
          }, { "messaging.system": "aws_sqs", "messaging.operation.type": "process",
            "messaging.message.id": delivery.brokerMessageId, "messaging.destination.name": "wager-transactions.fifo" },
          extractTraceContext(delivery.traceContext));
          continue;
        }
      } catch (error) {
        // A failed receive/delete/DLQ send leaves the broker message available for recovery.
        this.logger.error({ event: "sqs_operation_failed", errorType: error instanceof Error ? error.name : "Unknown" });
      }
      if (!this.stopping) await this.waitForPoll();
    }
  }

  private async process(delivery: QueueDelivery): Promise<ConsumptionResult> {
    const visibilitySeconds = inputVisibilityTimeoutSeconds();
    let stopped = false;
    let heartbeat = Promise.resolve();
    let timer: ReturnType<typeof setTimeout>;
    const extend = () => {
      heartbeat = this.queue.retry(delivery, visibilitySeconds).catch((error: unknown) => {
        this.logger.warn({ event: "sqs_visibility_failed", brokerMessageId: delivery.brokerMessageId,
          errorType: error instanceof Error ? error.name : "Unknown" });
      }).then(() => {
        if (!stopped) timer = setTimeout(extend, visibilitySeconds * 1_000 / 3);
      });
    };
    timer = setTimeout(extend, visibilitySeconds * 1_000 / 3);
    const stopHeartbeat = async () => {
      stopped = true;
      clearTimeout(timer);
      // An in-flight extension must finish before changing retry visibility or deleting the receipt.
      await heartbeat;
    };
    try {
      return await this.consumeWager.execute(delivery, stopHeartbeat);
    } finally {
      await stopHeartbeat();
    }
  }

  private async waitForPoll(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250);
      this.wake = () => { clearTimeout(timer); resolve(); };
    });
    this.wake = undefined;
  }

  private log(delivery: QueueDelivery, outcome: ConsumptionResult): void {
    if (outcome.status === "retry_scheduled") this.telemetry.retry("sqs");
    if (outcome.status === "dead_lettered") this.telemetry.deadLetter();
    const entry = {
      event: `sqs_${outcome.status}`, brokerMessageId: delivery.brokerMessageId,
      messageId: outcome.messageId, correlationId: outcome.messageId, walletId: outcome.walletId,
      providerId: outcome.providerId, transactionId: outcome.result?.transactionId,
      transactionStatus: outcome.result?.status, idempotentReplay: outcome.result?.idempotentReplay,
      receiveCount: delivery.receiveCount, reasonCode: outcome.reasonCode,
    };
    if (outcome.status === "acknowledged") this.logger.log(entry);
    else this.logger.warn(entry);
  }
}
