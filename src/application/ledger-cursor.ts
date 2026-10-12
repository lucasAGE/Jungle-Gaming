import { invalidInput, objectInput, uuidInput } from "./input-validation.js";
import type { LedgerPosition } from "./wallet-store.js";

export function encodeLedgerCursor(walletId: string, position: LedgerPosition): string {
  return Buffer.from(JSON.stringify({
    version: 1, walletId, createdAt: position.createdAt.toISOString(), id: position.id,
  })).toString("base64url");
}

export function decodeLedgerCursor(cursor: unknown, walletId: string): LedgerPosition {
  try {
    if (typeof cursor !== "string" || cursor.length > 512 || !/^[A-Za-z0-9_-]+(?![\s\S])/.test(cursor)) {
      return invalidInput("Invalid ledger cursor");
    }
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) return invalidInput("Invalid ledger cursor");
    const data = objectInput(JSON.parse(decoded.toString("utf8")), ["version", "walletId", "createdAt", "id"]);
    if (data.version !== 1 || data.walletId !== walletId || typeof data.createdAt !== "string") {
      return invalidInput("Invalid ledger cursor");
    }
    const createdAt = new Date(data.createdAt);
    if (createdAt.toISOString() !== data.createdAt) return invalidInput("Invalid ledger cursor");
    return { id: uuidInput(data.id), createdAt };
  } catch {
    return invalidInput("Invalid ledger cursor");
  }
}
