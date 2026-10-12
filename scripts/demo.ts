import "reflect-metadata";
import { fileURLToPath } from "node:url";
import { DemoRuntime } from "./demo/runtime.js";
import { createDemoServer } from "./demo/server.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const demo = createDemoServer({ runtime: new DemoRuntime(), port: 3100 });
let closing = false;

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await demo.close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void close(); });

try {
  // Claim the port before starting resources so a second supervisor cannot own the same demo.
  const identityProvider = Bun.spawn(["docker", "compose", "--file", "compose.yaml", "--project-name", "jungle-wagering", "--profile", "auth", "up", "-d", "--wait", "keycloak"], {
    cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  if (await identityProvider.exited !== 0) throw new Error("Keycloak could not start; check Docker");
  await demo.start();
  console.log(JSON.stringify({ event: "demo_ready", url: "http://127.0.0.1:3100/demo", database: "wagering_demo", processes: 3 }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Demo startup failed");
  await close();
  process.exitCode = 1;
}
