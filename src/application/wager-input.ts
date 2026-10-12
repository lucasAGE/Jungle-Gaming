import { createHash } from "node:crypto";
import type { Money } from "../domain/money.js";
import type { WagerKind } from "../domain/wager-transaction.js";
import { invalidInput, moneyInput, objectInput, uuidInput } from "./input-validation.js";

export interface WagerInput {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
}

export function identifierInput(value: unknown): string {
  if (typeof value !== "string" || !/^[!-~]{1,255}(?![\s\S])/.test(value)) {
    return invalidInput("Identifiers must contain 1 to 255 printable ASCII characters without spaces");
  }
  return value;
}

export function idempotencyKeyInput(value: unknown): string {
  const key = identifierInput(value);
  if (key.startsWith("opening:")) return invalidInput("The opening: idempotency namespace is reserved");
  return key;
}

export function wagerInput(value: unknown): WagerInput {
  const input = objectInput(value, [
    "providerId", "externalTransactionId", "playerId", "walletId", "roundId", "gameId", "kind", "money", "referenceExternalTransactionId",
  ]);
  const kind = input.kind;
  if (kind !== "BET" && kind !== "WIN" && kind !== "LOSS" && kind !== "REFUND" && kind !== "ROLLBACK") {
    return invalidInput("Only BET, WIN, LOSS, REFUND and ROLLBACK are supported");
  }
  const money = moneyInput(input.money);
  if (kind === "LOSS" && !money.isZero()) return invalidInput("A loss requires a zero amount");
  if (kind !== "LOSS" && !money.isPositive()) return invalidInput(`${kind} requires a positive amount`);
  const externalTransactionId = identifierInput(input.externalTransactionId);
  let referenceExternalTransactionId: string | undefined;
  if ("referenceExternalTransactionId" in input) {
    if (kind !== "WIN" && kind !== "REFUND" && kind !== "ROLLBACK") {
      return invalidInput("Only WIN, REFUND and ROLLBACK accept a reference");
    }
    referenceExternalTransactionId = identifierInput(input.referenceExternalTransactionId);
    if (referenceExternalTransactionId === externalTransactionId) return invalidInput("A transaction cannot reference itself");
  }
  if ((kind === "REFUND" || kind === "ROLLBACK") && referenceExternalTransactionId === undefined) {
    return invalidInput(`A ${kind.toLowerCase()} requires a reference`);
  }
  return {
    providerId: identifierInput(input.providerId),
    externalTransactionId,
    playerId: uuidInput(input.playerId), walletId: uuidInput(input.walletId),
    roundId: identifierInput(input.roundId), gameId: identifierInput(input.gameId), kind, money,
    ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }),
  };
}

function sortedKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(value).sort().map((key) => {
    const child = value[key];
    return [key, child !== null && typeof child === "object"
      ? sortedKeys(child as Record<string, unknown>) : child];
  }));
}

// Only validated business fields enter this hash; headers and delivery metadata do not.
export function wagerPayloadHash(input: WagerInput): string {
  const payload = { ...input, money: input.money.toJSON() };
  return createHash("sha256").update(JSON.stringify(sortedKeys(payload)), "utf8").digest("hex");
}
