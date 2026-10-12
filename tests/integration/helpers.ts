import { fileURLToPath } from "node:url";
import { createOrm } from "../../src/infrastructure/database/orm.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
export type Orm = Awaited<ReturnType<typeof createOrm>>;
export type Child = Bun.Subprocess<"ignore", "pipe", "pipe">;
export interface Application { child: Child; url: string }
export interface WalletResponse {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}
export interface LedgerResponse {
  items: Array<{
    id: string; walletId: string; transactionId: string; direction: string;
    money: { amount: string; currency: string };
    balanceBefore: { amount: string; currency: string };
    balanceAfter: { amount: string; currency: string };
    createdAt: string;
  }>;
  nextCursor: string | null;
}

export function isolatedDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("Integration tests require TEST_DATABASE_URL; use bun run test:integration");
  const url = new URL(databaseUrl);
  if (process.env.RUN_DATABASE_INTEGRATION !== "1" || url.pathname !== "/wagering_test"
    || !["localhost", "127.0.0.1"].includes(url.hostname) || url.port !== "55433") {
    throw new Error("Integration tests require RUN_DATABASE_INTEGRATION=1 and local wagering_test on port 55433");
  }
  return databaseUrl;
}

export async function resetTestDatabase(): Promise<Orm> {
  // BET history cannot be erased by a production rollback. Only this disposable test schema is reset.
  const orm = await createOrm(isolatedDatabaseUrl());
  try {
    await orm.em.getConnection().execute("drop schema public cascade");
    await orm.em.getConnection().execute("create schema public");
    await orm.getMigrator().up();
    return orm;
  } catch (error) {
    await orm.close(true);
    throw error;
  }
}

export async function deadline<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function stop(child: Child): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  try {
    await deadline(child.exited, 5_000, "Application did not stop gracefully");
  } catch {
    child.kill("SIGKILL");
    await child.exited;
  }
}

export async function startApplication(
  children: Child[], environment: Record<string, string> = {},
): Promise<Application> {
  const child = Bun.spawn([process.execPath, "dist/main.js"], {
    cwd: root,
    env: {
      ...process.env, DATABASE_URL: isolatedDatabaseUrl(), PORT: "0", NODE_ENV: "test", AUTH_ENABLED: "false", OTEL_ENABLED: "false",
      OUTBOX_PUBLISHER_ENABLED: "false", SQS_CONSUMER_ENABLED: "false", REFERENCE_WORKER_ENABLED: "false", ...environment,
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  children.push(child);
  let output = "";
  let announce: (port: number) => void = () => {};
  const listening = new Promise<number>((resolve) => { announce = resolve; });

  async function capture(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const text = decoder.decode(chunk.value, { stream: true });
      output = (output + text).slice(-8_000);
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const log = JSON.parse(line) as { event?: string; port?: number };
          if (log.event === "application_listening" && typeof log.port === "number") announce(log.port);
        } catch { /* Framework log lines need not be JSON to discover the startup event. */ }
      }
    }
  }

  void capture(child.stdout).catch(() => {});
  void capture(child.stderr).catch(() => {});
  try {
    const port = await deadline(Promise.race([
      listening,
      child.exited.then((code) => { throw new Error(`Application exited with ${code}: ${output}`); }),
    ]), 15_000, "Application did not announce its listening port");
    return { child, url: `http://127.0.0.1:${port}` };
  } catch (error) {
    await stop(child);
    throw new Error(`${String(error)}\n${output}`);
  }
}
