import { ApplicationError } from "./application-error.js";
import { uuidInput } from "./input-validation.js";
import type { ReconciliationReader, ReconciliationResult } from "./reconciliation-reader.js";
import { Telemetry } from "./telemetry.js";

export class ReconcileWallet {
  constructor(
    private readonly reader: ReconciliationReader,
    private readonly telemetry: Telemetry = Telemetry.noop,
  ) {}

  async execute(id: unknown): Promise<ReconciliationResult> {
    const result = await this.reader.read(uuidInput(id));
    if (!result) throw new ApplicationError("WALLET_NOT_FOUND", "Wallet not found");
    this.telemetry.reconciliationCompleted({
      walletId: result.walletId, consistent: result.consistent, checkedEntries: result.checkedEntries,
    });
    return result;
  }
}
