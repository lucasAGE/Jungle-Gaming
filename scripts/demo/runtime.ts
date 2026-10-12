import { invalidInput, objectInput } from "../../src/application/input-validation.js";
import { NetworkLink } from "./network-link.js";
import { DemoProcess, type ProcessAction, type ProcessFlags, type ProcessState } from "./processes.js";
import { DemoResources, type QueueCounts, type SeedWallet } from "./resources.js";

export interface DemoState {
  seedWallet: SeedWallet | null;
  processes: ProcessState[];
  dependencies: { postgres: boolean; sqs: boolean };
  queues: { input: QueueCounts; dlq: QueueCounts; events: QueueCounts };
  logs: string[];
}

export class DemoRuntime {
  private readonly logs: string[] = [];
  private readonly postgres = new NetworkLink(55434);
  private readonly sqs = new NetworkLink(4568);
  private readonly resources = new DemoResources((line) => this.log(line));
  private readonly processes = [1, 2, 3].map((id) => new DemoProcess(id as 1 | 2 | 3, (line) => this.log(line)));
  private next = 0;
  private seedWallet: SeedWallet | null = null;

  private log(line: string): void {
    this.logs.push(`${new Date().toISOString()} ${line.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database URL]").slice(0, 2_000)}`);
    if (this.logs.length > 120) this.logs.splice(0, this.logs.length - 120);
  }

  async initialize(): Promise<DemoState> {
    try {
      await this.resources.initialize();
      await Promise.all([this.postgres.start(), this.sqs.start()]);
      await this.startAll();
      this.log("Three independent application processes started with isolated demonstration resources");
      return await this.state();
    } catch (error) { await this.close(); throw error; }
  }

  async reset(): Promise<DemoState> {
    // The supervisor blocks incoming financial requests before calling reset.
    // Awaiting process exit also removes every background writer before DDL.
    await this.stopAll();
    this.postgres.setConnected(true); this.sqs.setConnected(true);
    this.seedWallet = null;
    await this.resources.reset();
    for (const process of this.processes) Object.assign(process.flags, {
      consumer: true, publisher: true, references: true, pauseBeforeAck: false,
    });
    await this.startAll();
    return this.state();
  }

  async close(): Promise<void> {
    await this.stopAll();
    await Promise.all([this.resources.close(), this.postgres.close(), this.sqs.close()]);
  }

  async state(): Promise<DemoState> {
    const [seed, queues] = await Promise.allSettled([this.resources.seedWallet(), this.resources.counts()]);
    if (seed.status === "fulfilled") this.seedWallet = seed.value;
    const unknown = { visible: null, inFlight: null };
    return { seedWallet: this.seedWallet, processes: this.processes.map((process) => process.state()),
      dependencies: { postgres: this.postgres.connected, sqs: this.sqs.connected },
      queues: queues.status === "fulfilled" ? queues.value : { input: unknown, dlq: unknown, events: unknown },
      logs: [...this.logs] };
  }

  target(processId?: number): string | null {
    if (processId !== undefined) return this.slot(processId).target();
    const available = this.processes.map((process) => process.target()).filter((url): url is string => url !== null);
    if (!available.length) return null;
    return available[this.next++ % available.length]!;
  }

  async process(id: number, action: ProcessAction, flags?: Partial<ProcessFlags>): Promise<DemoState> {
    const process = this.slot(id);
    if (!["start", "stop", "restart", "crash"].includes(action)) return invalidInput("Unknown demonstration process action");
    if (flags !== undefined) {
      const parsed = objectInput(flags, ["consumer", "publisher", "references", "pauseBeforeAck"]);
      if (Object.values(parsed).some((value) => typeof value !== "boolean")) return invalidInput("Process flags must be booleans");
    }
    const flagsChanged = flags !== undefined && (Object.keys(flags) as Array<keyof ProcessFlags>)
      .some((key) => flags[key] !== process.flags[key]);
    if (action !== "start" || flagsChanged) await process.stop(action === "crash");
    Object.assign(process.flags, flags);
    if (action === "start" || action === "restart") await process.start(this.postgres.port, this.sqs.port);
    this.log(`Process ${id}: ${action}`);
    return this.state();
  }

  async connectivity(dependency: "postgres" | "sqs", connected: boolean): Promise<DemoState> {
    if ((dependency !== "postgres" && dependency !== "sqs") || typeof connected !== "boolean") {
      return invalidInput("Select postgres or sqs and a boolean connection state");
    }
    this[dependency].setConnected(connected);
    this.log(`${dependency} connectivity for all demonstration processes ${connected ? "restored" : "interrupted"}`);
    return this.state();
  }

  send(input: { data: unknown; copies?: number; messageId?: string }) { return this.resources.send(input); }
  sendInvalid() { return this.resources.sendInvalid(); }
  inspect(queue: "dlq" | "events") { return this.resources.inspect(queue); }
  redrive(messageId: string) { return this.resources.redrive(messageId); }
  audit() { return this.resources.audit(); }

  private slot(id: number): DemoProcess {
    if (!Number.isInteger(id) || id < 1 || id > 3) return invalidInput("Process ID must be 1, 2 or 3");
    return this.processes[id - 1]!;
  }

  private async startAll(): Promise<void> {
    try { await Promise.all(this.processes.map((process) => process.start(this.postgres.port, this.sqs.port))); }
    catch (error) { await this.stopAll(); throw error; }
  }

  private async stopAll(): Promise<void> { await Promise.all(this.processes.map((process) => process.stop())); }
}
