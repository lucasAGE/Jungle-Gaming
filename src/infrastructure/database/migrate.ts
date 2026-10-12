import { createOrm } from "./orm.js";

const command = process.argv[2] ?? "up";
if (!["up", "down", "status"].includes(command)) {
  throw new Error("Usage: bun src/infrastructure/database/migrate.ts [up|down|status]");
}

const orm = await createOrm();
try {
  const migrator = orm.getMigrator();
  if (command === "up") {
    await migrator.up();
  } else if (command === "down") {
    await migrator.down();
  } else {
    const [executed, pending] = await Promise.all([
      migrator.getExecutedMigrations(),
      migrator.getPendingMigrations(),
    ]);
    console.log(JSON.stringify({ executed: executed.map((migration) => migration.name), pending }, null, 2));
  }
} finally {
  await orm.close(true);
}
