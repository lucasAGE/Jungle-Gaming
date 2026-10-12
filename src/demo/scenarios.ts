import { Money } from "../domain/money.js";

export type DemoKind = "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";

export interface DemoWallet {
  readonly id: string;
  readonly playerId: string;
  readonly balance: { readonly amount: string; readonly currency: string };
  readonly version: number;
}

export interface DemoWager {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: DemoKind;
  readonly money: { readonly amount: string; readonly currency: "BRL" };
  readonly referenceExternalTransactionId?: string;
}

export interface DemoRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}

export interface DemoResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly data: Record<string, unknown>;
}

export function decimalAmount(value: string, allowZero = true): string {
  const amount = Money.from({ amount: value, currency: "BRL" });
  if (!allowZero && amount.isZero()) throw new Error("Amount must be greater than 0.00.");
  return amount.toString();
}

export function requireUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Enter a valid wallet or player UUID.");
  }
  return value;
}

export function wagerRequest(body: DemoWager): DemoRequest {
  // Capture the submitted payload before a later form edit or retry changes it.
  return {
    method: "POST", path: "/wagering/transactions", body: structuredClone(body),
    idempotencyKey: `${body.providerId}:${body.externalTransactionId}`,
  };
}

export function conflictRequest(original: DemoRequest, amount: string): DemoRequest {
  const body = original.body as DemoWager;
  if (body.kind === "LOSS") throw new Error("LOSS requires 0.00. Use a BET, WIN or reversal to demonstrate an amount conflict.");
  const changed = decimalAmount(amount, false);
  if (changed === body.money.amount) throw new Error("Change the amount first; an identical amount is a replay.");
  return { ...original, body: { ...body, money: { ...body.money, amount: changed } } };
}

export function canReference(kind: DemoKind, candidate: DemoKind): boolean {
  return kind === "REFUND" || kind === "WIN"
    ? candidate === "BET"
    : kind === "ROLLBACK" && ["BET", "WIN", "REFUND"].includes(candidate);
}

export function referenceFields(kind: DemoKind, reference: string): Pick<DemoWager, "referenceExternalTransactionId"> {
  if (kind === "BET" || kind === "LOSS") return {};
  if (!reference && (kind === "REFUND" || kind === "ROLLBACK")) throw new Error("This operation requires a reference external ID.");
  return reference ? { referenceExternalTransactionId: reference } : {};
}

function psLiteral(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

export function powerShellCommand(baseUrl: string, request: DemoRequest): string {
  const headers = ['  Authorization = "Bearer $accessToken"'];
  if (request.idempotencyKey) headers.push(`  'Idempotency-Key' = ${psLiteral(request.idempotencyKey)}`);
  const body = request.body === undefined ? [] : [`$body = ${psLiteral(JSON.stringify(request.body, null, 2))}`];
  return [
    "# Obtain $accessToken using the authentication instructions in SETUP.md.",
    `$baseUrl = ${psLiteral(baseUrl)}`,
    "$headers = @{", ...headers, "}", ...body,
    "try {",
    `  Invoke-RestMethod -Method ${request.method} -Uri ($baseUrl + ${psLiteral(request.path)}) -Headers $headers${body.length ? " -ContentType 'application/json' -Body $body" : ""} | ConvertTo-Json -Depth 10`,
    "} catch {", "  $_.ErrorDetails.Message", "  $_.Exception.Message", "}",
  ].join("\n");
}
