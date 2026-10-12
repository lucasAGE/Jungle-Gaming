import { describe, expect, test } from "bun:test";
import { OpenWallet } from "./open-wallet.js";
import { Telemetry, type TelemetryContext } from "./telemetry.js";
import { WalletStore, type WalletOpening } from "./wallet-store.js";

class OpeningStore extends WalletStore {
  opening?: WalletOpening;
  constructor(private readonly commit: () => Promise<void> = async () => {}) { super(); }
  async saveOpening(opening: WalletOpening): Promise<void> { this.opening = opening; await this.commit(); }
  async findWallet() { return null; }
  async listLedger() { return []; }
  async listAccountingTransfers() { return []; }
}

class OpeningTelemetry extends Telemetry {
  readonly observed: TelemetryContext[] = [];
  override context() { return { correlationId: "opening-request" }; }
  override wagerCompleted(context: TelemetryContext) { this.observed.push(context); }
}

const input = { playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", initialBalance: { amount: "100.00", currency: "BRL" } };

describe("opening observability", () => {
  test("propagates HTTP correlation to both events and reports success only after commit", async () => {
    let release: () => void = () => {};
    const committed = new Promise<void>((resolve) => { release = resolve; });
    const store = new OpeningStore(() => committed);
    const telemetry = new OpeningTelemetry();
    const opening = new OpenWallet(store, telemetry).execute(input);
    expect(store.opening?.credit?.events.map((event) => event.correlationId)).toEqual(["opening-request", "opening-request"]);
    expect(telemetry.observed).toEqual([]);
    release();
    const wallet = await opening;
    expect(telemetry.observed).toEqual([{
      correlationId: "opening-request", walletId: wallet.id, transactionId: store.opening!.credit!.transaction.id, providerId: "internal",
    }]);
  });

  test("does not report a financial transaction for a zero opening or a rolled-back save", async () => {
    const telemetry = new OpeningTelemetry();
    await new OpenWallet(new OpeningStore(), telemetry).execute({ ...input, initialBalance: { amount: "0.00", currency: "BRL" } });
    const failed = new OpeningStore(async () => { throw new Error("Simulated commit failure"); });
    await expect(new OpenWallet(failed, telemetry).execute(input)).rejects.toThrow("Simulated commit failure");
    expect(telemetry.observed).toEqual([]);
  });
});
