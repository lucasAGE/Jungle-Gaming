import type { MoneyProps } from "../domain/money.js";

export interface ReconciliationResult {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

export abstract class ReconciliationReader {
  // Both balances must describe the same committed wallet state.
  abstract read(walletId: string): Promise<ReconciliationResult | null>;
}
