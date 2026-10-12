/// <reference lib="dom" />
import Keycloak from "keycloak-js";
import { canReference, conflictRequest, decimalAmount, powerShellCommand, referenceFields, requireUuid, wagerRequest, type DemoKind, type DemoRequest, type DemoResponse, type DemoWager, type DemoWallet } from "./scenarios.js";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing presentation element: ${id}`);
  return found as T;
}
function value(id: string): string { return element<HTMLInputElement>(id).value; }
function put(id: string, text: string): void { element(id).textContent = text; }
function notice(text: string, error = false): void {
  put("notice", text);
  element("notice").classList.toggle("error", error);
}

let auth: Keycloak | undefined;
let wallet: DemoWallet | undefined;
let lastWager: DemoRequest | undefined;
let busy = false;
const history: { body: DemoWager; status: string; transactionId?: string }[] = [];

function availability(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-financial]")) {
    button.disabled = busy || !auth?.authenticated;
  }
  element<HTMLButtonElement>("replay").disabled ||= !lastWager;
  element<HTMLButtonElement>("conflict").disabled ||= !lastWager || (lastWager.body as DemoWager).kind === "LOSS";
  element<HTMLButtonElement>("new-player").disabled = busy;
  element<HTMLButtonElement>("new-external-id").disabled = busy;
}

async function run(action: () => Promise<unknown>): Promise<void> {
  if (busy) return;
  busy = true;
  availability();
  try { await action(); }
  catch (error) { notice(error instanceof Error ? error.message : "The request could not be completed.", true); }
  finally { busy = false; availability(); }
}

function selectWallet(next: DemoWallet): void {
  wallet = next;
  element<HTMLInputElement>("wallet-id").value = next.id;
  element<HTMLInputElement>("player-id").value = next.playerId;
  put("balance", `${next.balance.amount} ${next.balance.currency}`);
  put("version", String(next.version));
  put("balance-note", "Current balance from the latest wallet read.");
  renderReferences();
}

function selectedWallet(): DemoWallet {
  if (!wallet || wallet.id !== value("wallet-id")) throw new Error("Create a wallet or read the pasted wallet ID first.");
  return wallet;
}

async function token(): Promise<string> {
  if (!auth?.authenticated) throw new Error("Sign in before sending financial requests.");
  try { await auth.updateToken(30); }
  catch { throw new Error("Your session could not be refreshed. Sign in again."); }
  if (!auth.token) throw new Error("Your session has expired. Sign in again.");
  return auth.token;
}

async function refreshWallet(accessToken: string): Promise<void> {
  if (!wallet) return;
  try {
    const response = await fetch(`/wallets/${wallet.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Refresh failed");
    selectWallet(await response.json() as DemoWallet);
  } catch {
    put("balance-note", "Refresh failed. Read the wallet again to obtain its current balance.");
  }
}

async function execute(request: DemoRequest, record?: DemoWager): Promise<DemoResponse> {
  put("command", powerShellCommand(location.origin, request));
  const correlationId = crypto.randomUUID();
  put("request", JSON.stringify({ method: request.method, url: `${location.origin}${request.path}`,
    headers: { Authorization: "Bearer [redacted]", "X-Correlation-Id": correlationId,
      ...(request.idempotencyKey ? { "Idempotency-Key": request.idempotencyKey } : {}),
      ...(request.body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(request.body === undefined ? {} : { body: request.body }) }, null, 2));
  put("response", "// Request in progress…");
  put("http-status", "SENDING");
  put("latency", "— ms");
  put("correlation", `correlation ${correlationId}`);
  element("http-status").className = "";
  let accessToken: string;
  try { accessToken = await token(); }
  catch (error) {
    put("http-status", "REQUEST NOT SENT");
    put("response", "Authentication failed before the API request was sent. Sign in again.");
    throw error;
  }
  const started = performance.now();
  let response: Response;
  let text: string;
  try {
    response = await fetch(request.path, {
      method: request.method,
      headers: { Authorization: `Bearer ${accessToken}`, "X-Correlation-Id": correlationId,
        ...(request.idempotencyKey ? { "Idempotency-Key": request.idempotencyKey } : {}),
        ...(request.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.timeout(15_000),
    });
    text = await response.text();
  } catch {
    put("http-status", "NO COMPLETE HTTP RESPONSE");
    put("latency", `${Math.round(performance.now() - started)} ms`);
    const recovery = request.path === "/wagering/transactions"
      ? "The server may have committed the operation. Replay the same wager request to resolve its result; do not submit a new identity."
      : request.path === "/wallets"
        ? "The wallet may have been created. Retry with this same player ID; an existing wallet returns a duplicate-creation conflict."
        : "Retry the same read or reconciliation request.";
    put("response", `The connection failed or timed out. ${recovery}`);
    throw new Error(`No complete HTTP response received. ${recovery}`);
  }
  let result: Record<string, unknown>;
  try { result = JSON.parse(text) as Record<string, unknown>; }
  catch { result = { response: text }; }
  put("latency", `${Math.round(performance.now() - started)} ms`);
  put("http-status", `HTTP ${response.status} ${response.statusText}`);
  element("http-status").className = response.ok ? "success" : "error";
  put("response", JSON.stringify(result, null, 2));
  const code = typeof result.failureCode === "string" ? result.failureCode : typeof result.code === "string" ? result.code : "";
  notice(`${request.method} ${request.path} → HTTP ${response.status}${code ? ` · ${code}` : ""}${result.idempotentReplay === true ? " · Original result replayed; no second financial effect." : ""}`, !response.ok);
  if (record) {
    const existing = history.find((item) => item.body.externalTransactionId === record.externalTransactionId);
    const status = typeof result.status === "string" ? result.status : `HTTP ${response.status}`;
    if (!existing) history.unshift({ body: structuredClone(record), status,
      ...(typeof result.transactionId === "string" ? { transactionId: result.transactionId } : {}) });
    else if (response.status !== 409) existing.status = status;
    renderHistory();
  }
  if (request.method === "GET" && request.path.includes("/wagering/transactions/") && typeof result.externalTransactionId === "string") {
    const existing = history.find((item) => item.body.externalTransactionId === result.externalTransactionId);
    if (existing && typeof result.status === "string") {
      existing.status = result.status;
      renderHistory();
    }
  }
  if (response.ok && (request.path === "/wallets" || /^\/wallets\/[^/]+$/.test(request.path))) {
    selectWallet(result as unknown as DemoWallet);
    put("reconciled", "Not checked");
  }
  if (response.ok && request.path.endsWith("/reconciliation")) {
    put("reconciled", result.consistent === true ? "Consistent" : "Divergence found");
    const difference = result.difference as { amount: string };
    put("reconciliation-note", `${result.checkedEntries} entries checked · Difference ${difference.amount} BRL`);
  }
  if (request.path === "/wagering/transactions") {
    put("reconciled", "Check again");
    put("reconciliation-note", "Reconcile after your operations to verify the ledger.");
    // Replayed responses carry a historical balance; a fresh read drives the summary.
    await refreshWallet(accessToken);
  }
  return { ok: response.ok, status: response.status, data: result };
}

function kind(): DemoKind { return value("kind") as DemoKind; }

function renderReferences(): void {
  const select = element<HTMLSelectElement>("reference-history");
  select.replaceChildren(new Option("Select a compatible reference…", ""));
  for (const item of history) {
    if (item.status !== "PROCESSED" || item.body.walletId !== wallet?.id || !canReference(kind(), item.body.kind)) continue;
    select.add(new Option(`${item.body.kind} · ${item.body.money.amount} BRL · ${item.body.externalTransactionId.slice(0, 8)}`, item.body.externalTransactionId));
  }
}

function renderHistory(): void {
  const container = element("history");
  container.replaceChildren();
  for (const item of history.slice(0, 50)) {
    const row = document.createElement("div");
    row.className = "history-item";
    const name = document.createElement("strong"); name.textContent = `${item.body.kind} · ${item.body.money.amount} BRL`;
    const status = document.createElement("span"); status.textContent = item.status;
    const id = document.createElement("small"); id.textContent = item.body.externalTransactionId;
    const read = document.createElement("button"); read.textContent = "Read persisted transaction →";
    read.addEventListener("click", () => { void run(async () => {
      await execute({ method: "GET", path: `/providers/${encodeURIComponent(item.body.providerId)}/wagering/transactions/${encodeURIComponent(item.body.externalTransactionId)}` });
    }); });
    const replay = document.createElement("button"); replay.textContent = "Replay this transaction →";
    replay.addEventListener("click", () => { void run(async () => {
      lastWager = wagerRequest(item.body);
      await execute(lastWager, item.body);
    }); });
    row.append(name, status, id, read, replay);
    container.append(row);
  }
  renderReferences();
}

const help: Record<DemoKind, string> = {
  BET: "BET debits the wallet; insufficient funds produce a persisted rejection.",
  WIN: "WIN credits the wallet. An optional BET reference must belong to this same round.",
  LOSS: "LOSS records a result with 0.00. It does not change the balance or add a ledger entry.",
  REFUND: "REFUND credits the full amount of a processed BET in this same round, once.",
  ROLLBACK: "ROLLBACK reverses a processed BET, WIN or REFUND in this same round, once.",
};

element("kind").addEventListener("change", () => {
  const loss = kind() === "LOSS";
  const amount = element<HTMLInputElement>("amount");
  amount.disabled = loss;
  amount.value = loss ? "0.00" : amount.value === "0.00" ? "25.00" : amount.value;
  const acceptsReference = kind() !== "BET" && !loss;
  element<HTMLInputElement>("reference").disabled = !acceptsReference;
  element<HTMLSelectElement>("reference-history").disabled = !acceptsReference;
  if (!acceptsReference) element<HTMLInputElement>("reference").value = "";
  put("operation-help", help[kind()]);
  put("submit-wager", `Submit ${kind()}`);
  renderReferences();
});

element("reference-history").addEventListener("change", () => {
  const match = history.find((item) => item.body.externalTransactionId === value("reference-history"));
  if (!match) return;
  element<HTMLInputElement>("reference").value = match.body.externalTransactionId;
  element<HTMLInputElement>("round-id").value = match.body.roundId;
  element<HTMLInputElement>("game-id").value = match.body.gameId;
  if (kind() === "REFUND" || kind() === "ROLLBACK") element<HTMLInputElement>("amount").value = match.body.money.amount;
});

element("wallet-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(() => execute({ method: "POST", path: "/wallets", body: {
    playerId: requireUuid(value("player-id")), initialBalance: { amount: decimalAmount(value("initial-balance")), currency: "BRL" },
  } }));
});

function currentWager(): DemoWager {
    const target = selectedWallet();
    const reference = value("reference");
    const externalTransactionId = value("external-id").trim();
    if (!externalTransactionId || externalTransactionId.length > 128) throw new Error("Enter an external transaction ID between 1 and 128 characters.");
    return {
      providerId: "provider-a", externalTransactionId,
      playerId: target.playerId, walletId: target.id, roundId: value("round-id"), gameId: value("game-id"), kind: kind(),
      money: { amount: decimalAmount(value("amount"), kind() === "LOSS"), currency: "BRL" },
      ...referenceFields(kind(), reference),
    };
}

function freshExternalId(): void { element<HTMLInputElement>("external-id").value = crypto.randomUUID(); }
element("new-external-id").addEventListener("click", freshExternalId);

element("wager-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(async () => {
    const body = currentWager();
    lastWager = wagerRequest(body);
    const result = await execute(lastWager, body);
    if (result.ok || result.data.status === "REJECTED" || result.data.status === "FAILED") freshExternalId();
  });
});

for (const [id, suffix, method] of [["read-wallet", "", "GET"], ["read-ledger", "/ledger?limit=50", "GET"], ["read-journal", "/journal?limit=50", "GET"], ["reconcile", "/reconciliation", "POST"]] as const) {
  element(id).addEventListener("click", () => { void run(() => execute({ method, path: `/wallets/${requireUuid(value("wallet-id"))}${suffix}` })); });
}
element("replay").addEventListener("click", () => { void run(async () => {
  if (lastWager) await execute(lastWager, lastWager.body as DemoWager);
}); });
element("conflict").addEventListener("click", () => { void run(async () => {
  if (lastWager) await execute(conflictRequest(lastWager, value("amount")));
}); });

function newPlayer(): void {
  wallet = undefined;
  lastWager = undefined;
  freshExternalId();
  element<HTMLInputElement>("player-id").value = crypto.randomUUID();
  element<HTMLInputElement>("wallet-id").value = "";
  put("balance", "— BRL"); put("version", "—"); put("reconciled", "Not checked");
  put("balance-note", "Create or read a wallet to see its balance.");
  put("reconciliation-note", "Compare the stored balance with the ledger.");
  renderReferences(); availability();
}
element("new-player").addEventListener("click", () => { newPlayer(); notice("A fresh player UUID is ready. Existing database records are unchanged."); });
element("copy-command").addEventListener("click", () => { void navigator.clipboard.writeText(element("command").textContent ?? "")
  .then(() => notice("Command copied. Supply your own valid $accessToken in PowerShell."))
  .catch(() => notice("Clipboard access was unavailable. Select and copy the command manually.", true)); });
element("clear-output").addEventListener("click", () => {
  put("response", "// Output cleared. Database records and the last wager identity are unchanged.");
  put("http-status", "WAITING FOR REQUEST"); put("latency", "— ms"); put("correlation", "");
  put("request", "No request displayed."); element("http-status").className = "";
});

newPlayer();
element<HTMLInputElement>("reference").disabled = true;
element<HTMLSelectElement>("reference-history").disabled = true;
try {
  const response = await fetch("/demo/config");
  if (!response.ok) throw new Error("Presentation configuration is unavailable.");
  const config = await response.json() as { issuer: string; clientId: string };
  auth = new Keycloak({ oidcProvider: config.issuer, clientId: config.clientId });
  await auth.init({ pkceMethod: "S256", checkLoginIframe: false, responseMode: "query", redirectUri: `${location.origin}/demo` });
  put("session-label", auth.authenticated ? `Signed in · ${auth.tokenParsed?.preferred_username ?? "presenter"}` : "Authentication required");
  put("login", auth.authenticated ? "Sign out" : "Sign in");
  element<HTMLButtonElement>("login").disabled = false;
  element("login").addEventListener("click", () => { void run(async () => {
    if (auth?.authenticated) await auth.logout({ redirectUri: `${location.origin}/demo` });
    else await auth?.login({ redirectUri: `${location.origin}/demo` });
  }); });
  if (auth.authenticated) notice("Ready. Create a wallet to begin, or paste an existing wallet ID and read it.");
} catch {
  put("session-label", "Identity provider unavailable");
  notice("Authentication could not initialize. Start Keycloak with bun run auth:up, then reload this page.", true);
}
availability();
