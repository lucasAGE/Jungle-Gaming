import "reflect-metadata";
import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { DriverException, MikroORM } from "@mikro-orm/core";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { OpenWallet } from "../../src/application/open-wallet.js";
import { ReadWallet } from "../../src/application/read-wallet.js";
import { ReconcileWallet } from "../../src/application/reconcile-wallet.js";
import { ApiErrorFilter } from "../../src/http/api-error.filter.js";
import { ChallengeAuthGuard } from "../../src/http/challenge-auth.guard.js";
import { AccessTokenVerifier } from "../../src/infrastructure/auth/access-token-verifier.js";
import { authConfiguration } from "../../src/infrastructure/auth/auth-configuration.js";
import { WalletController } from "../../src/http/wallet.controller.js";
import {
  LedgerSchema, WagerTransactionSchema, OutboxSchema, WalletSchema,
} from "../../src/infrastructure/database/entities.js";
import { PostgresWalletStore } from "../../src/infrastructure/database/postgres-wallet-store.js";
import { PostgresReconciliationReader } from "../../src/infrastructure/database/postgres-reconciliation-reader.js";

const integration = process.env.RUN_DATABASE_INTEGRATION === "1" ? test : test.skip;

integration("an unwrapped PostgreSQL connection failure during opening returns a sanitized HTTP 503", async () => {
  // Closing a temporary reservation produces a real refusal without stopping the shared database.
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => error ? reject(error) : resolve());
  });
  if (address === null || typeof address === "string") throw new Error("Expected a reserved TCP port");

  const orm = await MikroORM.init<PostgreSqlDriver>({
    driver: PostgreSqlDriver,
    clientUrl: `postgresql://outage_test:unused_password@127.0.0.1:${address.port}/unused_database`,
    entities: [WalletSchema, WagerTransactionSchema, LedgerSchema, OutboxSchema],
    connect: false,
    pool: { min: 0, max: 1, acquireTimeoutMillis: 1_000 },
    debug: false,
  });
  let app: INestApplication | undefined;
  try {
    // BEGIN uses a different driver path from a failed query and can escape ORM conversion.
    const connectionError = await orm.em.fork().transactional(async () => {}).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(connectionError).toMatchObject({ code: "ECONNREFUSED" });
    expect(connectionError).not.toBeInstanceOf(DriverException);

    const store = new PostgresWalletStore(orm);
    @Module({
      controllers: [WalletController],
      providers: [
        ChallengeAuthGuard,
        { provide: AccessTokenVerifier, useValue: new AccessTokenVerifier(authConfiguration({ NODE_ENV: "test", AUTH_ENABLED: "false" })) },
        { provide: OpenWallet, useValue: new OpenWallet(store) },
        { provide: ReadWallet, useValue: new ReadWallet(store) },
        { provide: ReconcileWallet, useValue: new ReconcileWallet(new PostgresReconciliationReader(orm)) },
      ],
    })
    class DatabaseOutageModule {}

    app = await NestFactory.create(DatabaseOutageModule, { logger: false });
    app.useGlobalFilters(new ApiErrorFilter());
    await app.listen(0, "127.0.0.1");
    const response = await fetch(`${await app.getUrl()}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: "123.45", currency: "BRL" },
      }),
      signal: AbortSignal.timeout(5_000),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "DATABASE_UNAVAILABLE",
      message: "The database operation could not be completed",
    });
    const reconciliation = await fetch(`${await app.getUrl()}/wallets/${crypto.randomUUID()}/reconciliation`, {
      method: "POST", signal: AbortSignal.timeout(5_000),
    });
    expect(reconciliation.status).toBe(503);
    expect(await reconciliation.json()).toEqual({
      code: "DATABASE_UNAVAILABLE", message: "The database operation could not be completed",
    });
  } finally {
    try {
      await app?.close();
    } finally {
      await orm.close(true);
    }
  }
}, 15_000);
