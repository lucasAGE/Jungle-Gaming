import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { ProcessWager } from "../application/process-wager.js";
import { Telemetry } from "../application/telemetry.js";

@Injectable()
export class ReferenceWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReferenceWorker.name);
  private stopping = false;
  private running: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    @Inject(ProcessWager) private readonly processWager: ProcessWager,
    @Optional() @Inject(Telemetry) private readonly telemetry: Telemetry = Telemetry.noop,
  ) {}

  onApplicationBootstrap(): void {
    const enabled = process.env.REFERENCE_WORKER_ENABLED ?? "true";
    if (!["true", "false"].includes(enabled)) throw new Error("REFERENCE_WORKER_ENABLED must be true or false");
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
        const result = await this.processWager.reprocessNext();
        if (result) {
          this.telemetry.retry("reference");
          // The transaction has committed before its outcome is reported or the next claim starts.
          this.logger.log({ event: "reference_checked", ...result,
            nextReferenceAttemptAt: result.nextReferenceAttemptAt?.toISOString() });
          continue;
        }
      } catch (error) {
        // Infrastructure failures roll back the claim and do not consume a missing-reference attempt.
        this.logger.error({ event: "reference_processing_failed", errorType: error instanceof Error ? error.name : "Unknown" });
      }
      if (!this.stopping) await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
      this.wake = undefined;
    }
  }
}
