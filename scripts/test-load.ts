import { fileURLToPath } from "node:url";
import { parseLoadOptions } from "../tests/load/report.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = parseLoadOptions(process.argv.slice(2));

async function run(command: string[], env = process.env): Promise<void> {
  const child = Bun.spawn(command, { cwd: root, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} exited with ${exitCode}`);
}

console.log("Load testing resets the disposable integration database. Do not run integration tests at the same time.");
console.log("Financial baseline: authentication and tracing are disabled only in the three isolated test processes.");
await run(["docker", "compose", "--profile", "test", "up", "-d", "--wait", "postgres-test", "ministack-test"]);
await run([process.execPath, "run", "build"]);
await run([process.execPath, "tests/load/run.ts", "--requests", String(options.requests), "--concurrency", String(options.concurrency)], {
  ...process.env,
  NODE_ENV: "test",
  RUN_DATABASE_INTEGRATION: "1",
  RUN_SQS_INTEGRATION: "1",
  TEST_DATABASE_URL: "postgresql://wagering:wagering_test@127.0.0.1:55433/wagering_test",
  SQS_ENDPOINT: "http://127.0.0.1:4567",
  TEST_SQS_ENDPOINT: "http://127.0.0.1:4567",
});
