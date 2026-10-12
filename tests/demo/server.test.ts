import "reflect-metadata";
import { afterEach, describe, expect, test } from "bun:test";
import { createDemoServer, type DemoRuntimeLike } from "../../scripts/demo/server.js";
import type { DemoState } from "../../scripts/demo/runtime.js";
import type { ProcessAction, ProcessFlags } from "../../scripts/demo/processes.js";
import { AuthenticationError, type ProviderIdentity } from "../../src/http/authentication.js";

class FakeRuntime implements DemoRuntimeLike {
  readonly calls: Array<{ action: string; args: unknown[] }> = [];
  onInitialize: (() => Promise<DemoState>) | undefined;
  onReset: (() => Promise<DemoState>) | undefined;
  onClose: (() => Promise<void>) | undefined;
  upstream: string | null = null;
  snapshot: DemoState = {
    seedWallet: null, processes: [], dependencies: { postgres: true, sqs: true },
    queues: { input: { visible: 0, inFlight: 0 }, dlq: { visible: 0, inFlight: 0 }, events: { visible: 0, inFlight: 0 } }, logs: [],
  };
  async initialize() { this.record("initialize"); return this.onInitialize ? this.onInitialize() : this.state(); }
  async reset() { this.record("reset"); return this.onReset ? this.onReset() : this.state(); }
  async close() { this.record("close"); await this.onClose?.(); }
  async state() { return this.snapshot; }
  target(id?: number) { this.record("target", id); return this.upstream; }
  async process(id: number, action: ProcessAction, flags?: Partial<ProcessFlags>) { this.record("process", id, action, flags); return this.state(); }
  async connectivity(dependency: "postgres" | "sqs", connected: boolean) { this.record("connectivity", dependency, connected); return this.state(); }
  async send(input: { data: unknown; copies?: number; messageId?: string }) {
    this.record("send", input); return { messageId: input.messageId ?? "message", copies: input.copies ?? 1, brokerMessageIds: ["broker-message"] };
  }
  async sendInvalid() { this.record("sendInvalid"); return { brokerMessageId: "invalid-message", body: "{", expected: "INVALID_INPUT in the DLQ" }; }
  async inspect(queue: "dlq" | "events") { this.record("inspect", queue); return { queue, messages: [], note: "No deletion" }; }
  async redrive(messageId: string) { this.record("redrive", messageId); return { messageId, brokerMessageId: "redriven-message" }; }
  async audit() {
    this.record("audit");
    return { consistent: true, counts: { wallets: 0, ledger: 0, journal: 0, postings: 0 }, wallets: [], currencies: [],
      statuses: [], inbox: [], outbox: [], note: "Read only" };
  }
  private record(action: string, ...args: unknown[]) { this.calls.push({ action, args }); }
}

const verify = {
  async verify(header: unknown): Promise<ProviderIdentity> {
    if (header === "Bearer unavailable") throw new AuthenticationError("IDENTITY_PROVIDER_UNAVAILABLE", 503);
    if (!["Bearer operator", "Bearer provider", "Bearer presenter"].includes(String(header))) {
      throw new AuthenticationError("AUTHENTICATION_REQUIRED", 401);
    }
    return { subject: "test-subject", operator: header !== "Bearer provider",
      providerId: header === "Bearer operator" ? null : "provider-a", bypass: false };
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("local demo supervisor HTTP boundary", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });

  async function setup(start = true) {
    const runtime = new FakeRuntime();
    const control = createDemoServer({ runtime, port: 0, verify });
    cleanup.push(() => control.close());
    if (start) await control.start();
    const origin = control.server.url.origin;
    function request(path: string, body?: unknown, options: { token?: string | null; origin?: string | null; headers?: Record<string, string> } = {}) {
      return fetch(`${origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...(options.token === null ? {} : { Authorization: `Bearer ${options.token ?? "presenter"}` }),
          ...(options.origin === null ? {} : { Origin: options.origin ?? origin }),
          "Content-Type": "application/json", ...options.headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000),
      });
    }
    return { runtime, control, origin, request };
  }

  test("state and public configuration remain readable during startup but financial traffic cannot reach an uninitialized process", async () => {
    const { runtime, control, request } = await setup(false);
    expect(control.server.hostname).toBe("127.0.0.1");
    expect(await (await request("/demo/config", undefined, { token: null })).json()).toMatchObject({ controlsEnabled: true, clientId: "demo-ui" });
    expect(await (await request("/demo/control/state")).json()).toMatchObject({ phase: "starting" });
    expect((await request("/wallets", {})).status).toBe(503);
    expect((await request("/demo/control/reset", { confirmation: "RESET DEMO" })).status).toBe(409);
    expect(runtime.calls).toEqual([]);
    await control.start();
    expect(await (await request("/demo/control/state")).json()).toMatchObject({ phase: "ready" });
    expect(() => control.start()).toThrow("already started");
  });

  test("operator authorization applies to controls and identity-provider failure cannot invoke a destructive action", async () => {
    const { request, runtime } = await setup();
    for (const [token, status] of [[null, 401], ["provider", 403], ["unavailable", 503]] as const) {
      expect((await request("/demo/control/state", undefined, { token })).status).toBe(status);
      expect((await request("/demo/control/reset", { confirmation: "RESET DEMO" }, { token })).status).toBe(status);
    }
    expect((await request("/demo/control/audit", undefined, { token: "operator" })).status).toBe(200);
    expect(runtime.calls.map((call) => call.action)).toEqual(["initialize", "audit"]);
  });

  test("every mutation requires the exact local Origin, JSON and an explicit reset phrase", async () => {
    const { request, runtime } = await setup();
    for (const origin of [null, "null", "https://example.invalid", "http://localhost:3100"]) {
      expect((await request("/demo/control/reset", { confirmation: "RESET DEMO" }, { origin })).status).toBe(403);
    }
    expect((await request("/demo/control/reset", { confirmation: "RESET DEMO" }, { headers: { "Content-Type": "text/plain" } })).status).toBe(415);
    for (const body of [{}, { confirmation: "reset demo" }, { confirmation: "RESET DEMO", database: "wagering" }]) {
      expect((await request("/demo/control/reset", body)).status).toBe(400);
    }
    expect(runtime.calls.map((call) => call.action)).toEqual(["initialize"]);
    expect((await request("/demo/control/reset", { confirmation: "RESET DEMO" })).status).toBe(200);
    expect(runtime.calls.map((call) => call.action)).toEqual(["initialize", "reset"]);
  });

  test("invalid host, oversized payloads and malformed JSON are rejected before a runtime mutation", async () => {
    const { request, runtime, origin } = await setup();
    expect((await request("/demo/control/state", undefined, { headers: { Host: "example.invalid" } })).status).toBe(403);
    const invalid = await fetch(`${origin}/demo/control/reset`, { method: "POST", body: "{",
      headers: { Origin: origin, Authorization: "Bearer presenter", "Content-Type": "application/json" } });
    expect(invalid.status).toBe(400);
    expect((await request("/demo/control/reset", { confirmation: "x".repeat(70_000) })).status).toBe(413);
    expect(runtime.calls.map((call) => call.action)).toEqual(["initialize"]);
  });

  test("reset owns an exclusive mutation slot and blocks financial traffic until it finishes", async () => {
    const { request, runtime } = await setup();
    const entered = deferred<void>();
    const resume = deferred<DemoState>();
    runtime.onReset = () => { entered.resolve(); return resume.promise; };
    const reset = request("/demo/control/reset", { confirmation: "RESET DEMO" });
    await entered.promise;
    expect(await (await request("/demo/control/state")).json()).toMatchObject({ phase: "resetting" });
    expect((await request("/demo/control/process", { id: 1, action: "crash" })).status).toBe(409);
    expect((await request("/demo/control/reset", { confirmation: "RESET DEMO" })).status).toBe(409);
    expect((await request("/demo/control/audit")).status).toBe(409);
    expect((await request("/wallets", {})).status).toBe(503);
    resume.resolve(runtime.snapshot);
    expect((await reset).status).toBe(200);
    expect(runtime.calls.map((call) => call.action)).toEqual(["initialize", "reset"]);
    expect(await (await request("/demo/control/state")).json()).toMatchObject({ phase: "ready" });
  });

  test("a failed reset keeps traffic unavailable and permits a deliberate reset retry", async () => {
    const { request, runtime } = await setup();
    runtime.onReset = async () => { throw new Error("Private failure details must not escape"); };
    const failed = await request("/demo/control/reset", { confirmation: "RESET DEMO" });
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("Private failure");
    expect(await (await request("/demo/control/state")).json()).toMatchObject({ phase: "unavailable" });
    expect((await request("/demo/control/sqs/invalid", {})).status).toBe(503);
    expect((await request("/wallets", {})).status).toBe(503);
    runtime.onReset = undefined;
    expect((await request("/demo/control/reset", { confirmation: "RESET DEMO" })).status).toBe(200);
    expect(await (await request("/demo/control/state")).json()).toMatchObject({ phase: "ready" });
  });

  test("closing during startup waits for child initialization before releasing runtime resources", async () => {
    const { control, runtime } = await setup(false);
    const resume = deferred<DemoState>();
    runtime.onInitialize = () => resume.promise;
    const started = control.start();
    const closed = control.close();
    await Bun.sleep(10);
    expect(runtime.calls.map((call) => call.action)).toEqual(["initialize"]);
    resume.resolve(runtime.snapshot);
    await Promise.all([started, closed]);
    expect(runtime.calls.map((call) => call.action)).toEqual(["initialize", "close"]);
  });

  test("closing during reset waits for the reset writer instead of closing its resource handles midway", async () => {
    const { request, control, runtime } = await setup();
    const entered = deferred<void>();
    const resume = deferred<DemoState>();
    runtime.onReset = () => { entered.resolve(); return resume.promise; };
    // Stopping the listener may abort this client response; the control itself still must finish.
    const reset = request("/demo/control/reset", { confirmation: "RESET DEMO" }).catch(() => null);
    await entered.promise;
    const closed = control.close();
    await Bun.sleep(10);
    expect(runtime.calls.map((call) => call.action)).toEqual(["initialize", "reset"]);
    resume.resolve(runtime.snapshot);
    await closed;
    await reset;
    expect(runtime.calls.map((call) => call.action)).toEqual(["initialize", "reset", "close"]);
  });

  test("shutdown holds the exclusive listener until the managed children and resources are closed", async () => {
    const { request, control, runtime } = await setup();
    const entered = deferred<void>();
    const resume = deferred<void>();
    runtime.onClose = () => { entered.resolve(); return resume.promise; };
    const port = control.server.port!;
    const closed = control.close();
    await entered.promise;
    expect(() => Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("other owner") })).toThrow();
    expect((await request("/wallets", {})).status).toBe(503);
    resume.resolve();
    await closed;
    const nextOwner = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("new owner") });
    cleanup.push(async () => { await nextOwner.stop(true); });
    expect(await (await fetch(nextOwner.url)).text()).toBe("new owner");
  });

  test("process and connectivity controls accept only fixed targets and boolean worker flags", async () => {
    const { request, runtime } = await setup();
    for (const body of [{ id: 4, action: "crash" }, { id: "1", action: "restart" }, { id: 1, action: "exec" },
      { id: 1, action: "restart", command: "whoami" }, { id: 1, action: "start", flags: { consumer: "true" } },
      { id: 1, action: "start", flags: { port: 3000 } }]) {
      expect((await request("/demo/control/process", body)).status).toBe(400);
    }
    for (const body of [{ dependency: "postgres", connected: "false" }, { dependency: "redis", connected: false },
      { dependency: "postgres", connected: false, port: 55432 }]) {
      expect((await request("/demo/control/connectivity", body)).status).toBe(400);
    }
    expect(runtime.calls.map((call) => call.action)).toEqual(["initialize"]);
    expect((await request("/demo/control/process", { id: 2, action: "restart", flags: { publisher: false, pauseBeforeAck: true } })).status).toBe(200);
    expect((await request("/demo/control/connectivity", { dependency: "sqs", connected: false })).status).toBe(200);
    expect(runtime.calls.slice(1)).toEqual([
      { action: "process", args: [2, "restart", { publisher: false, pauseBeforeAck: true }] },
      { action: "connectivity", args: ["sqs", false] },
    ]);
  });

  test("normal SQS submission requires the operator and matching provider identity, with a bounded copy count", async () => {
    const { request, runtime } = await setup();
    const body = { data: { providerId: "provider-a" }, copies: 50, messageId: "stable-message-id" };
    expect((await request("/demo/control/sqs/send", body, { token: "operator" })).status).toBe(403);
    expect((await request("/demo/control/sqs/send", body, { token: "provider" })).status).toBe(403);
    expect((await request("/demo/control/sqs/send", { ...body, data: { providerId: "provider-b" } })).status).toBe(403);
    for (const copies of [0, 51, 1.5, "2"]) expect((await request("/demo/control/sqs/send", { ...body, copies })).status).toBe(400);
    expect((await request("/demo/control/sqs/send", { ...body, messageId: " " })).status).toBe(400);
    expect(runtime.calls.map((call) => call.action)).toEqual(["initialize"]);
    expect((await request("/demo/control/sqs/send", body)).status).toBe(200);
    expect(runtime.calls.at(-1)).toEqual({ action: "send", args: [body] });
  });

  test("poison submission and queue tools expose fixed operations without arbitrary payloads or queue URLs", async () => {
    const { request, runtime } = await setup();
    expect((await request("/demo/control/sqs/invalid", { body: "arbitrary" })).status).toBe(400);
    expect((await request("/demo/control/queues/inspect", { queue: "input" })).status).toBe(400);
    expect((await request("/demo/control/queues/inspect", { queue: "dlq", endpoint: "http://127.0.0.1:4566" })).status).toBe(400);
    expect((await request("/demo/control/queues/redrive", { messageId: "" })).status).toBe(400);
    expect((await request("/demo/control/sqs/invalid", {}, { token: "operator" })).status).toBe(200);
    expect((await request("/demo/control/queues/inspect", { queue: "events" })).status).toBe(200);
    expect((await request("/demo/control/queues/redrive", { messageId: "selected-broker-message" })).status).toBe(200);
    expect(runtime.calls.slice(1)).toEqual([
      { action: "sendInvalid", args: [] }, { action: "inspect", args: ["events"] },
      { action: "redrive", args: ["selected-broker-message"] },
    ]);
  });

  test("the financial proxy forwards one request to the selected process without exposing control-only headers", async () => {
    const received: Array<{ path: string; headers: Headers; body: unknown }> = [];
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      received.push({ path: new URL(request.url).pathname, headers: request.headers, body: await request.json() });
      return Response.json({ transactionId: "original-transaction", idempotentReplay: false },
        { status: 200, headers: { "X-Correlation-Id": "upstream-correlation", "Set-Cookie": "must-not-forward=1" } });
    } });
    cleanup.push(async () => { await upstream.stop(true); });
    const { request, runtime } = await setup();
    runtime.upstream = upstream.url.origin;
    const payload = { money: { amount: "25.00", currency: "BRL" } };
    const result = await request("/wagering/transactions", payload, { headers: {
      "X-Demo-Process": "2", "Idempotency-Key": "original-identity", Cookie: "private=1", "X-Arbitrary": "ignored",
    } });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ transactionId: "original-transaction", idempotentReplay: false });
    expect(result.headers.get("x-correlation-id")).toBe("upstream-correlation");
    expect(result.headers.get("set-cookie")).toBeNull();
    expect(received).toHaveLength(1);
    expect(received[0]!.body).toEqual(payload);
    expect(received[0]!.headers.get("authorization")).toBe("Bearer presenter");
    expect(received[0]!.headers.get("idempotency-key")).toBe("original-identity");
    expect(received[0]!.headers.get("x-demo-process")).toBeNull();
    expect(received[0]!.headers.get("cookie")).toBeNull();
    expect(received[0]!.headers.get("x-arbitrary")).toBeNull();
    expect(runtime.calls.at(-1)).toEqual({ action: "target", args: [2] });
  });

  test("unknown routes and process targets never reach a child and a stopped pool gives an explicit unavailable response", async () => {
    const { request, runtime } = await setup();
    for (const path of ["/shell", "/demo/control/shell", "/wallets/id/delete", "/http://example.invalid"]) {
      expect((await request(path, {})).status).toBe(404);
    }
    expect((await request("/wallets/id", undefined, { headers: { "X-Demo-Process": "4" } })).status).toBe(400);
    expect(runtime.calls.map((call) => call.action)).toEqual(["initialize"]);
    const unavailable = await request("/wallets/id");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: "NO_RUNNING_PROCESS" });
  });
});
