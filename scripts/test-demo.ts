import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
async function run(command: string[], env = process.env): Promise<void> {
  const child = Bun.spawn(command, { cwd: root, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command.join(" ")} exited with ${code}`);
}

// The control suite can erase only the disposable demonstration resources.
// Neither the normal development database nor the financial test database is used.
console.log("Stop bun run demo before testing. The suite must claim port 3100 before resetting the isolated demo database and queues.");
await run(["docker", "compose", "--file", "compose.yaml", "--project-name", "jungle-wagering", "--profile", "auth-test",
  "up", "-d", "--wait", "keycloak-test"]);
await run([process.execPath, "run", "build"]);
const issuer = "http://127.0.0.1:58081/realms/wagering";
await run([process.execPath, "test", "tests/demo", "--timeout", "60000"], {
  ...process.env,
  RUN_DEMO_INTEGRATION: "1", AUTH_ENABLED: "true", AUTH_ISSUER: issuer,
  AUTH_AUDIENCE: "wagering-api", AUTH_JWKS_URL: `${issuer}/protocol/openid-connect/certs`,
});
