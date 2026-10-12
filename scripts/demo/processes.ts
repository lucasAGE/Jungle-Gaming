import { fileURLToPath } from "node:url";

export interface ProcessFlags { consumer: boolean; publisher: boolean; references: boolean; pauseBeforeAck: boolean }
export interface ProcessState extends ProcessFlags { id: 1 | 2 | 3; pid: number | null; running: boolean; ackPaused: boolean }
export type ProcessAction = "start" | "stop" | "restart" | "crash";
type Child = Bun.Subprocess<"ignore", "pipe", "pipe">;
const root = fileURLToPath(new URL("../../", import.meta.url));

export function exitWithParent(): void {
  if (!process.send || !process.connected) throw new Error("A managed demonstration process requires its supervisor IPC connection");
  // A killed supervisor cannot run cleanup. Closing its IPC pipe stops children
  // before a later supervisor can reset their shared demonstration database.
  process.once("disconnect", () => process.exit(0));
}

async function deadline<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export class DemoProcess {
  private child: Child | undefined;
  private url: string | undefined;
  private ackPaused = false;
  readonly flags: ProcessFlags = { consumer: true, publisher: true, references: true, pauseBeforeAck: false };

  constructor(readonly id: 1 | 2 | 3, private readonly log: (line: string) => void) {}

  state(): ProcessState {
    const running = this.child !== undefined && this.child.exitCode === null;
    return { id: this.id, pid: running ? this.child!.pid : null, running, ...this.flags, ackPaused: running && this.ackPaused };
  }

  target(): string | null { return this.state().running ? this.url ?? null : null; }

  async start(databasePort: number, sqsPort: number): Promise<void> {
    if (this.state().running) return;
    this.url = undefined;
    this.ackPaused = false;
    // Resource addresses and worker settings cannot leak in from a developer's
    // shell. Only OS necessities and the external identity provider are inherited.
    const environment: Record<string, string> = {};
    for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE",
      "AUTH_ISSUER", "AUTH_AUDIENCE", "AUTH_JWKS_URL"]) {
      if (process.env[key] !== undefined) environment[key] = process.env[key]!;
    }
    const child = Bun.spawn([process.execPath, "scripts/demo/child.ts"], {
      cwd: root,
      env: { ...environment, PORT: "0", NODE_ENV: "development", AUTH_ENABLED: "true", OTEL_ENABLED: "false",
        DEMO_MANAGED_PROCESS: "true", DEMO_PAUSE_BEFORE_ACK: String(this.flags.pauseBeforeAck),
        DATABASE_URL: `postgresql://wagering:wagering_demo@127.0.0.1:${databasePort}/wagering_demo`,
        SQS_ENDPOINT: `http://127.0.0.1:${sqsPort}`, SQS_VISIBILITY_TIMEOUT_SECONDS: "5",
        SQS_CONSUMER_ENABLED: String(this.flags.consumer), OUTBOX_PUBLISHER_ENABLED: String(this.flags.publisher),
        REFERENCE_WORKER_ENABLED: String(this.flags.references) },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
      ipc() {},
    });
    this.child = child;
    let announce: (port: number) => void = () => {};
    const listening = new Promise<number>((resolve) => { announce = resolve; });
    const capture = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        const lines = pending.split("\n");
        pending = (lines.pop() ?? "").slice(-8_000);
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          this.log(`[P${this.id}] ${line.slice(0, 2_000)}`);
          try {
            const entry = JSON.parse(line) as { event?: string; port?: number };
            if (entry.event === "application_listening" && Number.isInteger(entry.port)) announce(entry.port!);
            if (entry.event === "demo_ack_paused" && this.child === child) this.ackPaused = true;
          } catch { /* Startup errors can include non-JSON framework output. */ }
        }
      }
    };
    void capture(child.stdout).catch(() => this.log(`[P${this.id}] Log stream closed`));
    void capture(child.stderr).catch(() => this.log(`[P${this.id}] Error stream closed`));
    void child.exited.then((code) => {
      this.log(`[P${this.id}] Process exited (${code})`);
      // Bun on Windows can leave exitCode null after signal termination. The
      // settled exited promise, rather than that property, owns our lifecycle.
      if (this.child === child) { this.child = undefined; this.url = undefined; this.ackPaused = false; }
    });
    try {
      const port = await deadline(Promise.race([listening, child.exited.then((code) => {
        throw new Error(`Demonstration process ${this.id} exited during startup (${code})`);
      })]), 20_000, `Demonstration process ${this.id} did not start`);
      this.url = `http://127.0.0.1:${port}`;
    } catch (error) { await this.stop(true); throw error; }
  }

  async stop(crash = false): Promise<void> {
    const child = this.child;
    this.url = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill(crash ? "SIGKILL" : "SIGTERM");
    try { await deadline(child.exited, 5_000, "Process did not stop"); }
    catch { child.kill("SIGKILL"); await child.exited; }
    if (this.child === child) { this.child = undefined; this.url = undefined; this.ackPaused = false; }
  }
}
