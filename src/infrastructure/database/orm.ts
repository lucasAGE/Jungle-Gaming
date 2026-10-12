import { MikroORM } from "@mikro-orm/core";
import { Migrator } from "@mikro-orm/migrations";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { AccountingAccountSchema, AccountingJournalSchema, InboxSchema, LedgerSchema, WagerTransactionSchema, OutboxSchema, WalletSchema } from "./entities.js";
import { Migration202610100001 } from "./migrations/Migration202610100001.js";
import { Migration202610100002 } from "./migrations/Migration202610100002.js";
import { Migration202610100003 } from "./migrations/Migration202610100003.js";
import { Migration202610100004 } from "./migrations/Migration202610100004.js";
import { Migration202610100005 } from "./migrations/Migration202610100005.js";
import { Migration202610100006 } from "./migrations/Migration202610100006.js";
import { Migration202610100007 } from "./migrations/Migration202610100007.js";
import { Migration202610100008 } from "./migrations/Migration202610100008.js";
import { Migration202610120001 } from "./migrations/Migration202610120001.js";

export async function createOrm(
  databaseUrl = process.env.DATABASE_URL ?? "postgresql://wagering:wagering_local@127.0.0.1:55432/wagering",
): Promise<MikroORM<PostgreSqlDriver>> {
  return MikroORM.init({
    driver: PostgreSqlDriver,
    clientUrl: databaseUrl,
    entities: [WalletSchema, WagerTransactionSchema, LedgerSchema, OutboxSchema, InboxSchema, AccountingAccountSchema, AccountingJournalSchema],
    extensions: [Migrator],
    migrations: {
      // Explicit registration works both from Bun source and the compiled application.
      migrationsList: [Migration202610100001, Migration202610100002, Migration202610100003, Migration202610100004, Migration202610100005, Migration202610100006, Migration202610100007, Migration202610100008, Migration202610120001],
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    pool: { min: 0, max: 5, acquireTimeoutMillis: 3_000 },
    debug: false,
    allowGlobalContext: false,
  });
}
