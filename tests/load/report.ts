export function parseLoadOptions(args: string[]): { requests: number; concurrency: number } {
  const options = { requests: 600, concurrency: 12 };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    if (flag !== "--requests" && flag !== "--concurrency") {
      throw new Error(`Unknown load option: ${flag}`);
    }
    if (seen.has(flag)) throw new Error(`Repeated load option: ${flag}`);
    seen.add(flag);
    const value = args[index + 1];
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
      throw new Error(`${flag} requires a canonical positive integer`);
    }
    const key = flag === "--requests" ? "requests" : "concurrency";
    const minimum = key === "requests" ? 30 : 1;
    const maximum = key === "requests" ? 5_000 : 100;
    if (parsed < minimum || parsed > maximum) {
      throw new Error(`${flag} must be between ${minimum} and ${maximum}`);
    }
    options[key] = parsed;
  }
  return options;
}

export function summarizeLatencies(values: readonly number[]): {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
} {
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Latencies must be finite, non-negative milliseconds");
  }
  if (values.length === 0) return { count: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
  const sorted = [...values].sort((first, second) => first - second);
  // Nearest rank preserves an observed latency rather than interpolating away a small sample's tail.
  const percentile = (fraction: number): number => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return { count: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
    maxMs: sorted[sorted.length - 1]! };
}
