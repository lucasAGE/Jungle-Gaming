import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/core";
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { Telemetry } from "./application/telemetry.js";
import { OperationsController } from "./http/operations.controller.js";
import { DatabaseModule } from "./infrastructure/database/database.module.js";
import type { createOrm } from "./infrastructure/database/orm.js";
import { createSqsClient } from "./infrastructure/messaging/sqs-client.js";
import { DependencyProbes } from "./infrastructure/observability/dependency-probes.js";
import { Health } from "./infrastructure/observability/health.js";
import { OperationalTelemetry } from "./infrastructure/observability/operational-telemetry.js";
import { shutdownTracing } from "./infrastructure/observability/tracing.js";

@Injectable()
class TracingLifecycle implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> { await shutdownTracing(); }
}

@Injectable()
class HealthSqsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SQSClient) private readonly client: SQSClient) {}
  onApplicationShutdown(): void { this.client.destroy(); }
}

@Global()
@Module({
  imports: [DatabaseModule],
  controllers: [OperationsController],
  providers: [
    { provide: OperationalTelemetry, useFactory: () => new OperationalTelemetry() },
    { provide: Telemetry, useExisting: OperationalTelemetry },
    { provide: SQSClient, useFactory: () => createSqsClient() },
    { provide: DependencyProbes, useFactory: (orm: Awaited<ReturnType<typeof createOrm>>, client: SQSClient) => new DependencyProbes(orm, client), inject: [MikroORM, SQSClient] },
    { provide: Health, useFactory: (probes: DependencyProbes) => new Health(probes), inject: [DependencyProbes] },
    HealthSqsLifecycle,
    TracingLifecycle,
  ],
  exports: [Telemetry],
})
export class ObservabilityModule {}
