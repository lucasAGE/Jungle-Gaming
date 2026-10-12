import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
async function run(command: string[], env = process.env): Promise<void> {
  const child = Bun.spawn(command, { cwd: root, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command.join(" ")} exited with ${code}`);
}

// Startup import skips existing realms; recreate only the disposable IdP so fixture changes apply.
await run(["docker", "compose", "--profile", "auth-test", "up", "-d", "--force-recreate", "--wait", "keycloak-test"]);
await run(["docker", "compose", "--profile", "test", "up", "-d", "--wait", "postgres-test", "ministack-test"]);
const environment = {
  ...process.env, NODE_ENV: "test", RUN_DATABASE_INTEGRATION: "1", RUN_SQS_INTEGRATION: "1", RUN_AUTH_INTEGRATION: "1",
  TEST_DATABASE_URL: "postgresql://wagering:wagering_test@127.0.0.1:55433/wagering_test",
  SQS_ENDPOINT: "http://127.0.0.1:4567", TEST_SQS_ENDPOINT: "http://127.0.0.1:4567",
  AUTH_ISSUER: "http://127.0.0.1:58081/realms/wagering", AUTH_JWKS_URL: "http://127.0.0.1:58081/realms/wagering/protocol/openid-connect/certs",
};
await run([process.execPath, "scripts/setup-queues.ts"], environment);
await run([process.execPath, "run", "build"]);
await run([process.execPath, "test", "tests/auth", "--timeout", "30000"], environment);
