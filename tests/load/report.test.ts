import { describe, expect, test } from "bun:test";
import { parseLoadOptions, summarizeLatencies } from "./report.js";

describe("load experiment options", () => {
  test("defaults to a bounded, reproducible workload", () => {
    expect(parseLoadOptions([])).toEqual({ requests: 600, concurrency: 12 });
    expect(parseLoadOptions(["--requests", "30"])).toEqual({ requests: 30, concurrency: 12 });
    expect(parseLoadOptions(["--concurrency", "1"])).toEqual({ requests: 600, concurrency: 1 });
  });

  test("accepts inclusive bounds and either option order", () => {
    expect(parseLoadOptions(["--requests", "30", "--concurrency", "1"]))
      .toEqual({ requests: 30, concurrency: 1 });
    expect(parseLoadOptions(["--concurrency", "100", "--requests", "5000"]))
      .toEqual({ requests: 5_000, concurrency: 100 });
  });

  test("rejects duplicate, unknown and incomplete arguments instead of silently changing a run", () => {
    for (const args of [
      ["--requests", "600", "--requests", "600"],
      ["--concurrency", "12", "--concurrency", "24"],
      ["--duration", "60"], ["--requests=600"], ["600"], ["--requests"], ["--concurrency"],
      ["--requests", "--concurrency", "12"],
    ]) expect(() => parseLoadOptions(args)).toThrow();
  });

  test("rejects numeric coercions, invalid syntax and workload limits", () => {
    for (const value of ["", " 30", "30 ", "30\n", "30\r\n", "\t30", "+30", "030", "30.0", "3e2", "0x20", "-30", "NaN", "Infinity"]) {
      expect(() => parseLoadOptions(["--requests", value])).toThrow();
    }
    for (const value of ["0", "29", "5001", "9007199254740993"]) {
      expect(() => parseLoadOptions(["--requests", value])).toThrow();
    }
    for (const value of ["0", "101", "01", "1.5"]) {
      expect(() => parseLoadOptions(["--concurrency", value])).toThrow();
    }
  });
});

describe("load latency summary", () => {
  test("distinguishes missing samples from a measured zero latency", () => {
    expect(summarizeLatencies([])).toEqual({ count: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null });
    expect(summarizeLatencies([0])).toEqual({ count: 1, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 });
  });

  test("preserves a single sample's precision for every percentile", () => {
    expect(summarizeLatencies([1.23456789]))
      .toEqual({ count: 1, p50Ms: 1.23456789, p95Ms: 1.23456789, p99Ms: 1.23456789, maxMs: 1.23456789 });
  });

  test("retains a slow tail in p99 without spreading it into p95", () => {
    const values = Object.freeze([1_000.25, ...Array<number>(19).fill(0.125)]);
    expect(summarizeLatencies(values)).toEqual({ count: 20, p50Ms: 0.125, p95Ms: 0.125, p99Ms: 1_000.25, maxMs: 1_000.25 });
    expect(values[0]).toBe(1_000.25);
  });

  test("uses numeric order and an observed nearest rank for an even sample count", () => {
    const values = [100, 2, 30, 1];
    expect(summarizeLatencies(values)).toEqual({ count: 4, p50Ms: 2, p95Ms: 100, p99Ms: 100, maxMs: 100 });
    expect(values).toEqual([100, 2, 30, 1]);
  });

  test("rejects invalid durations instead of emitting misleading statistics", () => {
    for (const value of [-0.001, NaN, Infinity, -Infinity]) {
      expect(() => summarizeLatencies([1, value, 2])).toThrow("Latencies must be finite, non-negative milliseconds");
    }
  });
});
