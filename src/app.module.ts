import { Module } from "@nestjs/common";
import { WalletModule } from "./wallet.module.js";
import { WageringModule } from "./wagering.module.js";
import { OutboxModule } from "./outbox.module.js";
import { SqsWagerModule } from "./sqs-wager.module.js";
import { ObservabilityModule } from "./observability.module.js";
import { DemoModule } from "./demo/demo.module.js";

@Module({ imports: [ObservabilityModule, WalletModule, WageringModule, OutboxModule, SqsWagerModule, DemoModule] })
export class AppModule {}
