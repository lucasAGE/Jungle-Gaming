import { MikroORM } from "@mikro-orm/core";
import { Module } from "@nestjs/common";
import { OpenWallet } from "./application/open-wallet.js";
import { ReadWallet } from "./application/read-wallet.js";
import { ReconcileWallet } from "./application/reconcile-wallet.js";
import { ReconciliationReader } from "./application/reconciliation-reader.js";
import { Telemetry } from "./application/telemetry.js";
import { WalletStore } from "./application/wallet-store.js";
import { AuthModule } from "./auth.module.js";
import { WalletController } from "./http/wallet.controller.js";
import { DatabaseModule } from "./infrastructure/database/database.module.js";
import type { createOrm } from "./infrastructure/database/orm.js";
import { PostgresWalletStore } from "./infrastructure/database/postgres-wallet-store.js";
import { PostgresReconciliationReader } from "./infrastructure/database/postgres-reconciliation-reader.js";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [WalletController],
  providers: [
    { provide: WalletStore, useFactory: (orm: Awaited<ReturnType<typeof createOrm>>) => new PostgresWalletStore(orm), inject: [MikroORM] },
    { provide: OpenWallet, useFactory: (store: WalletStore, telemetry: Telemetry) => new OpenWallet(store, telemetry), inject: [WalletStore, Telemetry] },
    { provide: ReadWallet, useFactory: (store: WalletStore) => new ReadWallet(store), inject: [WalletStore] },
    { provide: ReconciliationReader, useFactory: (orm: Awaited<ReturnType<typeof createOrm>>) => new PostgresReconciliationReader(orm), inject: [MikroORM] },
    { provide: ReconcileWallet, useFactory: (reader: ReconciliationReader, telemetry: Telemetry) => new ReconcileWallet(reader, telemetry), inject: [ReconciliationReader, Telemetry] },
  ],
})
export class WalletModule {}
