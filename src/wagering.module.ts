import { MikroORM } from "@mikro-orm/core";
import { Module } from "@nestjs/common";
import { ProcessWager } from "./application/process-wager.js";
import { ReadWager } from "./application/read-wager.js";
import { WageringStore } from "./application/wagering-store.js";
import { Telemetry } from "./application/telemetry.js";
import { AuthModule } from "./auth.module.js";
import { WageringController } from "./http/wagering.controller.js";
import { DatabaseModule } from "./infrastructure/database/database.module.js";
import type { createOrm } from "./infrastructure/database/orm.js";
import { PostgresWageringStore } from "./infrastructure/database/postgres-wagering-store.js";
import { ReferenceWorker } from "./infrastructure/reference-worker.js";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [WageringController],
  providers: [
    { provide: WageringStore, useFactory: (orm: Awaited<ReturnType<typeof createOrm>>, telemetry: Telemetry) => new PostgresWageringStore(orm, telemetry), inject: [MikroORM, Telemetry] },
    { provide: ProcessWager, useFactory: (store: WageringStore, telemetry: Telemetry) => new ProcessWager(store, telemetry), inject: [WageringStore, Telemetry] },
    { provide: ReadWager, useFactory: (store: WageringStore) => new ReadWager(store), inject: [WageringStore] },
    ReferenceWorker,
  ],
  exports: [ProcessWager],
})
export class WageringModule {}
