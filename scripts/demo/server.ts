import { HttpException } from "@nestjs/common";
import { ApplicationError } from "../../src/application/application-error.js";
import { MoneyError } from "../../src/domain/money.js";
import { requireOperator, requireProvider, type ProviderIdentity } from "../../src/http/authentication.js";
import { AccessTokenVerifier } from "../../src/infrastructure/auth/access-token-verifier.js";
import { authConfiguration } from "../../src/infrastructure/auth/auth-configuration.js";
import type { DemoRuntime } from "./runtime.js";

export type DemoRuntimeLike = Pick<DemoRuntime, "initialize" | "reset" | "close" | "state" | "target"
  | "process" | "connectivity" | "send" | "sendInvalid" | "inspect" | "redrive" | "audit">;

interface ServerOptions {
  runtime: DemoRuntimeLike;
  port?: number;
  verify?: { verify(header: unknown): Promise<ProviderIdentity> };
}

type Phase = "starting" | "ready" | "resetting" | "unavailable";
const bodyLimit = 65_536;

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

function invalid(message: string): never { throw new HttpException({ code: "INVALID_DEMO_INPUT", message }, 400); }

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("A JSON object is required");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) invalid("Unexpected control field");
  return result;
}

function processId(value: unknown): 1 | 2 | 3 {
  if (value !== 1 && value !== 2 && value !== 3) invalid("Process must be 1, 2 or 3");
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[!-~]{1,255}$/.test(value)) invalid("A nonempty message ID is required");
  return value;
}

function financialRoute(method: string, path: string): boolean {
  if (method === "GET") return /^\/(health\/(live|ready)|metrics|wallets\/[^/]+(\/(ledger|journal))?|wagering\/transactions\/[^/]+|providers\/[^/]+\/wagering\/transactions\/[^/]+)$/.test(path);
  return method === "POST" && /^\/(wallets|wallets\/[^/]+\/reconciliation|wagering\/transactions)$/.test(path);
}

/** Owns only the disposable demo environment; normal Nest routes never import these controls. */
export function createDemoServer({ runtime, port = 3100, verify }: ServerOptions) {
  const configuration = authConfiguration({ ...process.env, AUTH_ENABLED: "true" });
  const verifier = verify ?? new AccessTokenVerifier(configuration);
  let phase: Phase = "starting";
  let mutation = false;
  let startCalled = false;
  let closing = false;
  let startup: Promise<void> | undefined;
  const controls = new Set<Promise<Response>>();
  const assets: Record<string, [string, string]> = {
    "/demo": ["index.html", "text/html; charset=utf-8"],
    "/demo/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/demo/styles.css": ["styles.css", "text/css; charset=utf-8"],
  };

  async function control(request: Request, path: string): Promise<Response> {
    const identity = await verifier.verify(request.headers.get("authorization"));
    requireOperator(identity);
    if (closing) return response({ code: "DEMO_UNAVAILABLE" }, 503);
    if (request.method === "GET" && path === "/demo/control/state") {
      return response({ ...await runtime.state(), phase });
    }
    if (request.method === "GET" && path === "/demo/control/audit") {
      if (phase !== "ready" || mutation) return response({ code: "DEMO_BUSY" }, 409);
      return response(await runtime.audit());
    }
    if (request.method !== "POST") return response({ code: "NOT_FOUND" }, 404);
    if (request.headers.get("origin") !== server.url.origin) {
      return response({ code: "DEMO_ORIGIN_REQUIRED", message: `Origin must be ${server.url.origin}` }, 403);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
      return response({ code: "JSON_REQUIRED" }, 415);
    }
    if (mutation || phase === "starting" || phase === "resetting") return response({ code: "DEMO_BUSY" }, 409);
    if (phase !== "ready" && path !== "/demo/control/reset") return response({ code: "DEMO_UNAVAILABLE" }, 503);
    const text = await request.text();
    if (Buffer.byteLength(text) > bodyLimit) return response({ code: "BODY_TOO_LARGE" }, 413);
    let body: unknown;
    try { body = JSON.parse(text); } catch { invalid("Body must be valid JSON"); }

    // Recheck after reading the body: two arriving requests must not both enter a reset.
    if (mutation) return response({ code: "DEMO_BUSY" }, 409);
    mutation = true;
    try {
      switch (path) {
        case "/demo/control/reset": {
          const input = object(body, ["confirmation"]);
          if (input.confirmation !== "RESET DEMO") invalid("Type RESET DEMO to clear this demonstration");
          phase = "resetting";
          try {
            const state = await runtime.reset();
            phase = "ready";
            return response({ ...state, phase });
          } catch (error) { phase = "unavailable"; throw error; }
        }
        case "/demo/control/process": {
          const input = object(body, ["id", "action", "flags"]);
          const id = processId(input.id);
          const action = input.action;
          if (action !== "start" && action !== "stop" && action !== "restart" && action !== "crash") invalid("Unknown process action");
          const flags: { consumer?: boolean; publisher?: boolean; references?: boolean; pauseBeforeAck?: boolean } = {};
          if (input.flags !== undefined) {
            const values = object(input.flags, ["consumer", "publisher", "references", "pauseBeforeAck"]);
            for (const key of ["consumer", "publisher", "references", "pauseBeforeAck"] as const) {
              if (values[key] !== undefined) {
                if (typeof values[key] !== "boolean") invalid("Worker flags must be booleans");
                flags[key] = values[key];
              }
            }
          }
          return response({ ...await runtime.process(id, action, flags), phase });
        }
        case "/demo/control/connectivity": {
          const input = object(body, ["dependency", "connected"]);
          if (input.dependency !== "postgres" && input.dependency !== "sqs") invalid("Unknown dependency");
          if (typeof input.connected !== "boolean") invalid("connected must be a boolean");
          return response({ ...await runtime.connectivity(input.dependency, input.connected), phase });
        }
        case "/demo/control/sqs/send": {
          const input = object(body, ["data", "copies", "messageId"]);
          if (!input.data || typeof input.data !== "object" || Array.isArray(input.data)) invalid("Wager data is required");
          requireProvider(identity, (input.data as Record<string, unknown>).providerId);
          const options: { data: unknown; copies?: number; messageId?: string } = { data: input.data };
          if (input.copies !== undefined) {
            if (typeof input.copies !== "number" || !Number.isInteger(input.copies) || input.copies < 1 || input.copies > 50) invalid("copies must be between 1 and 50");
            options.copies = input.copies;
          }
          if (input.messageId !== undefined) options.messageId = identifier(input.messageId);
          return response(await runtime.send(options));
        }
        case "/demo/control/sqs/invalid":
          object(body, []);
          return response(await runtime.sendInvalid());
        case "/demo/control/queues/inspect": {
          const input = object(body, ["queue"]);
          if (input.queue !== "dlq" && input.queue !== "events") invalid("Inspect only dlq or events");
          return response(await runtime.inspect(input.queue));
        }
        case "/demo/control/queues/redrive": {
          const input = object(body, ["messageId"]);
          return response(await runtime.redrive(identifier(input.messageId)));
        }
        default: return response({ code: "NOT_FOUND" }, 404);
      }
    } finally { mutation = false; }
  }

  const server = Bun.serve({
    hostname: "127.0.0.1", port, maxRequestBodySize: bodyLimit, idleTimeout: 120,
    async fetch(request): Promise<Response> {
      try {
        const url = new URL(request.url);
        if (closing) return response({ code: "DEMO_UNAVAILABLE" }, 503);
        // Loopback binding alone does not protect local controls from DNS rebinding.
        if (url.host !== server.url.host) return response({ code: "INVALID_HOST" }, 403);
        const path = url.pathname;
        if (request.method === "GET" && path === "/") return Response.redirect(`${server.url.origin}/demo`, 302);
        if (request.method === "GET" && path === "/demo/config") {
          return response({ issuer: configuration.issuer, clientId: "demo-ui", controlsEnabled: true });
        }
        const asset = assets[path];
        if (request.method === "GET" && asset) {
          return new Response(Bun.file(new URL(`../../dist/demo/${asset[0]}`, import.meta.url)), {
            headers: { "Content-Type": asset[1], "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
          });
        }
        if (path.startsWith("/demo/control/")) {
          const work = control(request, path);
          controls.add(work);
          try { return await work; } finally { controls.delete(work); }
        }
        if (!financialRoute(request.method, path)) return response({ code: "NOT_FOUND" }, 404);
        const selected = request.headers.get("x-demo-process");
        const id = selected === null ? undefined : processId(Number(selected));
        const body = request.method === "POST" ? await request.arrayBuffer() : undefined;
        if (body && body.byteLength > bodyLimit) return response({ code: "BODY_TOO_LARGE" }, 413);
        if (phase !== "ready") return response({ code: "DEMO_UNAVAILABLE" }, 503);
        const target = runtime.target(id);
        if (!target) return response({ code: "NO_RUNNING_PROCESS", message: "Start a process in Demo controls" }, 503);
        const headers = new Headers();
        for (const name of ["authorization", "content-type", "idempotency-key", "x-correlation-id", "traceparent", "tracestate"]) {
          const value = request.headers.get(name);
          if (value !== null) headers.set(name, value);
        }
        // A financial request is sent once. A transport failure leaves its commit outcome unknown.
        const upstream = await fetch(`${target}${path}${url.search}`, {
          method: request.method, headers, ...(body === undefined ? {} : { body }),
          redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
        });
        const outgoing = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        for (const name of ["content-type", "x-correlation-id", "retry-after"]) {
          const value = upstream.headers.get(name);
          if (value !== null) outgoing.set(name, value);
        }
        return new Response(upstream.body, { status: upstream.status, headers: outgoing });
      } catch (error) {
        if (error instanceof HttpException) return response(error.getResponse(), error.getStatus());
        if (error instanceof ApplicationError || error instanceof MoneyError) return response({ code: error.code, message: error.message }, 400);
        console.error(JSON.stringify({ event: "demo_request_failed", error: error instanceof Error ? error.name : "UnknownError" }));
        return response({ code: "DEMO_ACTION_FAILED", message: "The action could not complete. A financial outcome may be unknown; retry the same identity." }, 503);
      }
    },
  });

  return {
    server,
    start(): Promise<void> {
      if (startCalled) throw new Error("Demo server has already started");
      if (closing) throw new Error("Demo server is closing");
      startCalled = true;
      startup = (async () => {
        try { await runtime.initialize(); phase = closing ? "unavailable" : "ready"; }
        catch (error) { phase = "unavailable"; throw error; }
      })();
      return startup;
    },
    async close(): Promise<void> {
      closing = true;
      phase = "unavailable";
      // A reset or startup must finish before closing its children and resource handles.
      // Keep the ownership port bound until cleanup finishes; no other supervisor may start yet.
      try {
        await Promise.allSettled([startup, ...controls]);
        await runtime.close();
      } finally { await server.stop(true); }
    },
  };
}
