/// <reference lib="dom" />
import { sqsSubmission, type DemoRequest, type DemoResponse, type DemoWager, type DemoWallet } from "./scenarios.js";

interface DemoState {
  phase: string;
  seedWallet: DemoWallet | null;
  processes: { id: 1 | 2 | 3; pid: number | null; running: boolean; consumer: boolean; publisher: boolean;
    references: boolean; pauseBeforeAck: boolean; ackPaused: boolean }[];
  dependencies: { postgres: boolean; sqs: boolean };
  queues: Record<"input" | "dlq" | "events", { visible: number | null; inFlight: number | null }>;
  logs: string[];
}

interface ControlsContext {
  run(action: () => Promise<unknown>): Promise<void>;
  execute(request: DemoRequest): Promise<DemoResponse>;
  token(): Promise<string>;
  wager(): DemoWager;
  rememberWager(body: DemoWager): void;
  selectWallet(wallet: DemoWallet): void;
  resetSession(): void;
  parallel(count: number, distinct: boolean): Promise<void>;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing demo control: ${id}`);
  return found as T;
}

export class DemoControls {
  private state: DemoState | undefined;
  private lastSqs: ReturnType<typeof sqsSubmission> | undefined;

  constructor(private readonly context: ControlsContext) {
    element("demo-controls").hidden = false;
    element("request-target-field").hidden = false;
    this.action("demo-refresh", async () => {
      const response = await this.context.execute({ method: "GET", path: "/demo/control/state" });
      if (response.ok) this.render(response.data as unknown as DemoState);
    });
    this.action("demo-seed", async () => {
      await this.refresh();
      if (!this.state?.seedWallet) throw new Error("The seed wallet is not available. Restore PostgreSQL and refresh the state.");
      this.context.selectWallet(this.state.seedWallet);
      await this.context.execute({ method: "GET", path: `/wallets/${this.state.seedWallet.id}` });
    });
    this.action("demo-audit", () => this.context.execute({ method: "GET", path: "/demo/control/audit" }));
    this.action("http-parallel", () => this.context.parallel(Number(element<HTMLInputElement>("http-copies").value),
      element<HTMLSelectElement>("http-identities").value === "distinct"));
    for (const dependency of ["postgres", "sqs"] as const) {
      this.action(`demo-${dependency}`, async () => {
        if (!this.state) throw new Error("Refresh the demo state first.");
        await this.mutate("connectivity", { dependency, connected: !this.state.dependencies[dependency] });
      });
    }
    this.action("sqs-send", async () => {
      const body = this.context.wager();
      // Keep both identities before sending: a lost HTTP response does not prove the broker rejected the message.
      this.lastSqs = sqsSubmission(body, crypto.randomUUID(), Number(element<HTMLInputElement>("sqs-copies").value));
      await this.sendLastSqs();
    });
    this.action("sqs-replay", () => this.sendLastSqs());
    this.action("sqs-redeliver", async () => {
      if (!this.lastSqs) throw new Error("Send a wager through SQS first.");
      this.lastSqs = { ...this.lastSqs, messageId: crypto.randomUUID() };
      await this.sendLastSqs();
    });
    this.action("sqs-invalid", () => this.mutate("sqs/invalid", {}));
    for (const queue of ["dlq", "events"] as const) {
      this.action(`inspect-${queue}`, async () => {
        const response = await this.context.execute({ method: "POST", path: "/demo/control/queues/inspect", body: { queue } });
        if (response.ok && queue === "dlq") {
          const select = element<HTMLSelectElement>("dlq-message");
          select.replaceChildren(new Option("Select an inspected DLQ message…", ""));
          for (const message of response.data.messages as { messageId: string }[]) {
            select.add(new Option(message.messageId, message.messageId));
          }
        }
        await this.refresh();
      });
    }
    this.action("dlq-redrive", async () => {
      const messageId = element<HTMLSelectElement>("dlq-message").value;
      if (!messageId) throw new Error("Inspect the DLQ and select a message first.");
      const response = await this.mutate("queues/redrive", { messageId });
      if (response.ok) element<HTMLSelectElement>("dlq-message").selectedOptions[0]?.remove();
    });
    element("reset-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.context.run(async () => {
        const confirmation = element<HTMLInputElement>("reset-confirmation");
        if (confirmation.value !== "RESET DEMO") throw new Error("Type RESET DEMO exactly to clear this isolated demonstration.");
        const response = await this.context.execute({ method: "POST", path: "/demo/control/reset", body: { confirmation: confirmation.value } });
        if (!response.ok) { await this.refresh(); return; }
        this.lastSqs = undefined;
        this.context.resetSession();
        element<HTMLInputElement>("http-copies").value = "2";
        element<HTMLSelectElement>("http-identities").value = "same";
        element<HTMLInputElement>("sqs-copies").value = "1";
        element<HTMLSelectElement>("dlq-message").replaceChildren(new Option("Select an inspected DLQ message…", ""));
        element("sqs-last-identity").textContent = "No SQS wager sent in this session.";
        confirmation.value = "";
        this.render(response.data as unknown as DemoState);
        if (this.state?.seedWallet) this.context.selectWallet(this.state.seedWallet);
      });
    });
  }

  availability(busy: boolean, authenticated: boolean): void {
    for (const id of ["sqs-replay", "sqs-redeliver"]) element<HTMLButtonElement>(id).disabled = busy || !authenticated || !this.lastSqs;
  }

  async refresh(): Promise<void> {
    const response = await fetch("/demo/control/state", { headers: { Authorization: `Bearer ${await this.context.token()}` },
      signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Demo state could not be read (HTTP ${response.status}).`);
    this.render(await response.json() as DemoState);
  }

  private action(id: string, action: () => Promise<unknown>): void {
    element(id).addEventListener("click", () => { void this.context.run(action); });
  }

  private async mutate(path: string, body: unknown): Promise<DemoResponse> {
    const response = await this.context.execute({ method: "POST", path: `/demo/control/${path}`, body });
    await this.refresh();
    return response;
  }

  private async sendLastSqs(): Promise<void> {
    if (!this.lastSqs) throw new Error("Send a wager through SQS first.");
    const response = await this.context.execute({ method: "POST", path: "/demo/control/sqs/send", body: this.lastSqs });
    element("sqs-last-identity").textContent = `Business ID: ${this.lastSqs.data.externalTransactionId} · Envelope message ID: ${this.lastSqs.messageId}`;
    if (response.ok) {
      const { idempotencyKey: _key, ...body } = this.lastSqs.data;
      this.context.rememberWager(body);
    }
    await this.refresh();
  }

  private render(state: DemoState): void {
    this.state = state;
    element("demo-phase").textContent = state.phase;
    for (const dependency of ["postgres", "sqs"] as const) {
      const label = dependency === "postgres" ? "PostgreSQL" : "SQS";
      element(`demo-${dependency}`).textContent = `${state.dependencies[dependency] ? "Disconnect" : "Restore"} ${label}`;
      element(`${dependency}-state`).textContent = state.dependencies[dependency] ? "Connected" : "Disconnected";
    }
    element("queue-counts").textContent = Object.entries(state.queues)
      .map(([queue, counts]) => `${queue}: ${counts.visible ?? "unknown"} visible / ${counts.inFlight ?? "unknown"} in flight`).join(" · ");
    element("demo-logs").textContent = state.logs.join("\n") || "No process output yet.";
    const container = element("demo-processes");
    container.replaceChildren();
    const template = element<HTMLTemplateElement>("process-template");
    for (const process of state.processes) {
      const card = (template.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
      card.querySelector("h3")!.textContent = `Process ${process.id}`;
      card.querySelector(".process-status")!.textContent = process.running
        ? `PID ${process.pid}${process.ackPaused ? " · COMMITTED, ACK PAUSED" : " · Running"}` : "Stopped";
      for (const flag of ["consumer", "publisher", "references", "pauseBeforeAck"] as const) {
        const input = card.querySelector<HTMLInputElement>(`input[name="${flag}"]`)!;
        input.checked = process[flag];
        input.setAttribute("aria-label", `Process ${process.id} ${flag}`);
      }
      for (const button of card.querySelectorAll<HTMLButtonElement>("[data-action]")) {
        const action = button.dataset.action!;
        button.setAttribute("aria-label", `${button.textContent} process ${process.id}`);
        button.addEventListener("click", () => { void this.context.run(async () => {
          const flags = Object.fromEntries([...card.querySelectorAll<HTMLInputElement>("input")].map((input) => [input.name, input.checked]));
          await this.mutate("process", { id: process.id, action,
            ...(["start", "restart"].includes(action) ? { flags } : {}) });
        }); });
      }
      container.append(card);
    }
  }
}
