import { Controller, Get, Inject, Res } from "@nestjs/common";
import { DependencyProbes } from "../infrastructure/observability/dependency-probes.js";
import { Health, withinDeadline } from "../infrastructure/observability/health.js";
import { OperationalTelemetry } from "../infrastructure/observability/operational-telemetry.js";

interface OperationsResponse {
  status(code: number): OperationsResponse;
  type(value: string): OperationsResponse;
}

// Operational routes deliberately have no provider guard, as required by the challenge.
@Controller()
export class OperationsController {
  constructor(
    @Inject(Health) private readonly health: Health,
    @Inject(DependencyProbes) private readonly probes: DependencyProbes,
    @Inject(OperationalTelemetry) private readonly telemetry: OperationalTelemetry,
  ) {}

  @Get("health/live")
  live() { return { live: true }; }

  @Get("health/ready")
  async ready(@Res({ passthrough: true }) response: OperationsResponse) {
    const result = await this.health.ready();
    response.status(result.ready ? 200 : 503);
    return result;
  }

  @Get("metrics")
  async metrics(@Res({ passthrough: true }) response: OperationsResponse) {
    try {
      const outbox = await withinDeadline(this.probes.outbox(), 1_500);
      response.type("text/plain; version=0.0.4; charset=utf-8");
      return this.telemetry.render(outbox);
    } catch {
      // A failed scrape must not report a misleading zero backlog during a database outage.
      response.status(503);
      return { code: "METRICS_UNAVAILABLE" };
    }
  }
}
