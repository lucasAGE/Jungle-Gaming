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
  readonly processId?: 1 | 2 | 3;
}

export interface DemoResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly data: Record<string, unknown>;
}

export function sqsSubmission(body: DemoWager, messageId: string, copies: number): {
  data: DemoWager & { idempotencyKey: string }; messageId: string; copies: number;
} {
  if (!Number.isInteger(copies) || copies < 1 || copies > 50) throw new Error("Choose between 1 and 50 SQS copies.");
  return { data: { ...structuredClone(body), idempotencyKey: `${body.providerId}:${body.externalTransactionId}` },
    messageId: requireUuid(messageId), copies };
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

export function parallelWagerRequests(body: DemoWager, count: number, distinct: boolean): DemoRequest[] {
  if (!Number.isInteger(count) || count < 2 || count > 50) throw new Error("Choose between 2 and 50 parallel HTTP requests.");
  return Array.from({ length: count }, () => wagerRequest(distinct ? { ...body, externalTransactionId: crypto.randomUUID() } : body));
}

export function targetRequest(request: DemoRequest, processId?: 1 | 2 | 3): DemoRequest {
  // Routing can change during recovery without changing the saved financial identity.
  const { processId: _previous, ...unrouted } = request;
  return processId ? { ...unrouted, processId } : unrouted;
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
  if (request.processId) headers.push(`  'X-Demo-Process' = '${request.processId}'`);
  if (request.method === "POST" && request.path.startsWith("/demo/control/")) headers.push(`  Origin = ${psLiteral(baseUrl)}`);
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

export function parallelPowerShellCommand(baseUrl: string, requests: readonly DemoRequest[]): string {
  return [
    "# Obtain $accessToken using SETUP.md. Start-Job also works in Windows PowerShell 5.",
    "# Jobs start separate shell processes; their startup differs from the browser's parallel HTTP dispatch.",
    `$baseUrl = ${psLiteral(baseUrl)}`,
    `$requests = ${psLiteral(JSON.stringify(requests, null, 2))} | ConvertFrom-Json`,
    "$jobs = foreach ($request in $requests) {",
    "  Start-Job -ArgumentList $baseUrl, $accessToken, ($request | ConvertTo-Json -Depth 10 -Compress) -ScriptBlock {",
    "    param($baseUrl, $accessToken, $requestJson)",
    "    $request = $requestJson | ConvertFrom-Json",
    '    $headers = @{ Authorization = "Bearer $accessToken"; \'Idempotency-Key\' = $request.idempotencyKey }',
    "    if ($request.processId) { $headers['X-Demo-Process'] = [string]$request.processId }",
    "    try {",
    "      $result = Invoke-RestMethod -Method Post -Uri ($baseUrl + $request.path) -Headers $headers -ContentType 'application/json' -Body ($request.body | ConvertTo-Json -Depth 10 -Compress)",
    "      [PSCustomObject]@{ externalTransactionId = $request.body.externalTransactionId; result = $result }",
    "    } catch {",
    "      [PSCustomObject]@{ externalTransactionId = $request.body.externalTransactionId; error = $_.ErrorDetails.Message; message = $_.Exception.Message }",
    "    }",
    "  }",
    "}",
    "try { $jobs | Wait-Job | Receive-Job | ConvertTo-Json -Depth 15 }",
    "finally { $jobs | Remove-Job }",
  ].join("\n");
}
