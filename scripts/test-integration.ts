import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

async function run(command: string[], env = process.env): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: root,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} exited with ${exitCode}`);
}

// Separate containers prevent schema resets and queue consumption from touching development data.
await run(["docker", "compose", "--profile", "test", "up", "-d", "--wait", "postgres-test", "ministack-test"]);
const integrationEnv = {
  ...process.env,
  NODE_ENV: "test",
  RUN_DATABASE_INTEGRATION: "1",
  RUN_SQS_INTEGRATION: "1",
  TEST_DATABASE_URL: "postgresql://wagering:wagering_test@127.0.0.1:55433/wagering_test",
  SQS_ENDPOINT: "http://127.0.0.1:4567",
  TEST_SQS_ENDPOINT: "http://127.0.0.1:4567",
};
await run([process.execPath, "scripts/setup-queues.ts"], integrationEnv);
await run([process.execPath, "run", "build"]);
await run([process.execPath, "test", "tests/integration", "--timeout", "30000"], integrationEnv);
