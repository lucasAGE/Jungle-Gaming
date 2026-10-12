import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";

if (process.platform !== "linux" || process.env.LINUX_INTEGRATION_RUNNER !== "1") {
  throw new Error("Use bun run test:integration:linux to run inside the Linux test container");
}

const sockets = new Set<Socket>();

function forward(localPort: number, host: string, targetPort: number) {
  const server = createServer((incoming) => {
    const outgoing = createConnection({ host, port: targetPort });
    for (const socket of [incoming, outgoing]) {
      // Preserve the pg driver's low-latency behavior for small database messages.
      socket.setNoDelay(true);
      sockets.add(socket);
      socket.on("close", () => { sockets.delete(socket); incoming.destroy(); outgoing.destroy(); });
      socket.on("error", () => { incoming.destroy(); outgoing.destroy(); });
    }
    incoming.pipe(outgoing).pipe(incoming);
  });
  const ready = once(server, "listening");
  server.listen(localPort, "127.0.0.1");
  return { server, ready };
}

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`bun ${args.join(" ")} exited with ${exitCode}`);
}

// Keep the existing loopback-only test guards while reaching only Compose test services.
const forwards = [forward(55433, "postgres-test", 5432), forward(4567, "ministack-test", 4566)];
try {
  await Promise.all(forwards.map(({ ready }) => ready));
  console.log(`Integration runtime: Bun ${Bun.version}, ${process.platform}/${process.arch}`);
  await run(["scripts/setup-queues.ts"]);
  const selection = process.argv.slice(2);
  await run(["test", ...(selection.length ? selection : ["tests/integration"]), "--timeout", "30000"]);
} finally {
  for (const socket of sockets) socket.destroy();
  for (const { server } of forwards) server.close();
}
