export interface HealthDependencies {
  postgres(): Promise<void>;
  queues(signal: AbortSignal): Promise<void>;
}

export async function withinDeadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Dependency deadline exceeded")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export class Health {
  private checking: Promise<{ ready: boolean; dependencies: { postgres: "up" | "down"; sqs: "up" | "down" } }> | undefined;

  constructor(private readonly probes: HealthDependencies, private readonly deadlineMs = 1_500) {}

  ready() {
    this.checking ??= this.check().finally(() => { this.checking = undefined; });
    return this.checking;
  }

  private async check() {
    const abort = new AbortController();
    try {
      const [postgres, sqs] = await Promise.allSettled([
        withinDeadline(this.probes.postgres(), this.deadlineMs),
        withinDeadline(this.probes.queues(abort.signal), this.deadlineMs),
      ]);
      return {
        ready: postgres.status === "fulfilled" && sqs.status === "fulfilled",
        dependencies: {
          postgres: postgres.status === "fulfilled" ? "up" as const : "down" as const,
          sqs: sqs.status === "fulfilled" ? "up" as const : "down" as const,
        },
      };
    } finally { abort.abort(); }
  }
}
