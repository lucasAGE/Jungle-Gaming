import { Money } from "../domain/money.js";
import { ApplicationError } from "./application-error.js";

export function invalidInput(message: string): never {
  throw new ApplicationError("INVALID_INPUT", message);
}

export function objectInput(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidInput("Expected a JSON object");
  }
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    return invalidInput("Unexpected input field");
  }
  return value as Record<string, unknown>;
}

export function uuidInput(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/i.test(value)) {
    return invalidInput("Expected a UUID");
  }
  return value.toLowerCase();
}

// Transport-independent validation can be reused by the future SQS adapter.
export function moneyInput(value: unknown): Money {
  const input = objectInput(value, ["amount", "currency"]);
  if (typeof input.amount !== "string" || typeof input.currency !== "string") {
    return invalidInput("Amount and currency must be strings");
  }
  const money = Money.from({ amount: input.amount, currency: input.currency });
  if (money.currency !== "BRL") {
    throw new ApplicationError("UNSUPPORTED_CURRENCY", "Only BRL is enabled");
  }
  return money;
}

export function openWalletInput(value: unknown): { playerId: string; initialBalance: Money } {
  const input = objectInput(value, ["playerId", "initialBalance"]);
  return { playerId: uuidInput(input.playerId), initialBalance: moneyInput(input.initialBalance) };
}
