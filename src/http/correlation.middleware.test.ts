import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { context, trace, type Span, type Tracer } from "@opentelemetry/api";
import { StructuredLogger } from "../infrastructure/observability/structured-logger.js";
import { correlationMiddleware } from "./correlation.middleware.js";

afterEach(() => { mock.restore(); });

function fixture(next: () => void = mock(() => {})) {
  const end = mock(() => {});
  const span = { updateName: () => {}, setAttributes: () => {}, setStatus: () => {}, end } as unknown as Span;
  spyOn(trace, "getTracer").mockReturnValue({ startSpan: () => span } as unknown as Tracer);
  const log = spyOn(StructuredLogger.prototype, "log").mockImplementation(() => {});
  const handlers = new Map<string, () => void>();
  const response = { statusCode: 200, setHeader: () => {},
    once: (event: "finish" | "close", handler: () => void) => { handlers.set(event, handler); } };
  return { next, end, log,
    start: () => correlationMiddleware({ headers: {}, method: "POST", route: { path: "/wallets" } }, response, next),
    finish: () => { handlers.get("finish")!(); }, close: () => { handlers.get("close")!(); } };
}

describe("HTTP tracing remains an optional observer", () => {
  test("a context manager that fails before entry cannot block the request or escape completion", () => {
    const current = fixture();
    spyOn(context, "with").mockImplementation(() => { throw new Error("observer unavailable"); });
    expect(current.start).not.toThrow();
    expect(current.finish).not.toThrow();
    expect(current.close).not.toThrow();
    expect(current.finish).not.toThrow();
    expect(current.next).toHaveBeenCalledTimes(1);
    expect(current.log).toHaveBeenCalledTimes(1);
    expect(current.end).toHaveBeenCalledTimes(1);
  });

  test("failure after entering a context does not repeat the downstream handler or completion log", () => {
    const current = fixture();
    const originalWith = context.with;
    spyOn(context, "with").mockImplementation(((...args: unknown[]) => {
      Reflect.apply(originalWith, context, args);
      throw new Error("observer failed after entry");
    }) as typeof context.with);
    expect(current.start).not.toThrow();
    expect(current.finish).not.toThrow();
    expect(current.close).not.toThrow();
    expect(current.next).toHaveBeenCalledTimes(1);
    expect(current.log).toHaveBeenCalledTimes(1);
    expect(current.end).toHaveBeenCalledTimes(1);
  });

  test("failed span context setup and span completion do not alter HTTP handling", () => {
    const current = fixture();
    spyOn(trace, "setSpan").mockImplementation(() => { throw new Error("span context unavailable"); });
    current.end.mockImplementation(() => { throw new Error("span completion unavailable"); });
    expect(current.start).not.toThrow();
    expect(current.finish).not.toThrow();
    expect(current.close).not.toThrow();
    expect(current.next).toHaveBeenCalledTimes(1);
    expect(current.end).toHaveBeenCalledTimes(1);
  });

  test("preserves the original downstream exception even when context cleanup also fails", () => {
    const original = new Error("original handler failure");
    const next = mock(() => { throw original; });
    const current = fixture(next);
    const originalWith = context.with;
    spyOn(context, "with").mockImplementation(((...args: unknown[]) => {
      try { return Reflect.apply(originalWith, context, args); }
      finally { throw new Error("observer context cleanup failed"); }
    }) as typeof context.with);
    let received: unknown;
    try { current.start(); } catch (error) { received = error; }
    expect(received).toBe(original);
    expect(next).toHaveBeenCalledTimes(1);
    expect(current.finish).not.toThrow();
    expect(current.close).not.toThrow();
    expect(current.end).toHaveBeenCalledTimes(1);
  });
});
