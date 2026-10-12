import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { PublishOutbox, type PublicationResult } from "../../application/publish-outbox.js";
import { Telemetry } from "../../application/telemetry.js";

@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name);
  private stopping = false;
  private running: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    @Inject(PublishOutbox) private readonly publishOutbox: PublishOutbox,
    @Optional() @Inject(Telemetry) private readonly telemetry: Telemetry = Telemetry.noop,
  ) {}

  onApplicationBootstrap(): void {
    const enabled = process.env.OUTBOX_PUBLISHER_ENABLED ?? "true";
    if (!["true", "false"].includes(enabled)) throw new Error("OUTBOX_PUBLISHER_ENABLED must be true or false");
    if (enabled === "true") this.running = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    // Drain the in-flight attempt before Nest closes the database and SQS client.
    await this.running;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const result = await this.publishOutbox.execute();
        if (result) this.log(result);
        if (result?.status === "published") continue;
      } catch (error) {
        // SQL/connection failures roll back the claim. Do not log queries or event bodies.
        this.logger.error({ event: "outbox_poll_failed", errorType: error instanceof Error ? error.name : "Unknown" });
      }
      if (!this.stopping) await this.waitForPoll();
    }
  }

  private async waitForPoll(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250);
      this.wake = () => { clearTimeout(timer); resolve(); };
    });
    this.wake = undefined;
  }

  private log({ status, message, errorType }: PublicationResult): void {
    if (status === "retry_scheduled") this.telemetry.retry("outbox");
    const payload = message.payload;
    const data = payload.data as Record<string, unknown> | undefined;
    const entry = {
      event: status === "published" ? "outbox_published" : "outbox_retry_scheduled",
      messageId: message.id, eventType: message.eventType, walletId: message.aggregateId,
      correlationId: payload.correlationId, transactionId: data?.transactionId, providerId: data?.providerId,
      attempts: message.attempts, nextAttemptAt: message.nextAttemptAt?.toISOString(), errorType,
    };
    if (status === "published") this.logger.log(entry);
    else this.logger.warn(entry);
  }
}
