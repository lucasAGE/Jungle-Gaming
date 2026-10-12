import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { CreateQueueCommand, DeleteQueueCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client.js";
import { resetTestDatabase, startApplication, stop, type Application, type Child, type Orm, type WalletResponse } from "../integration/helpers.js";
import { presenterTokens } from "./keycloak-login.js";

const integration = process.env.RUN_AUTH_INTEGRATION === "1" ? describe : describe.skip;
integration("external Keycloak authentication with real PostgreSQL and SQS", () => {
  const issuer = "http://127.0.0.1:58081/realms/wagering";
  const children: Child[] = [];
  const queues: string[] = [];
  let orm: Orm;
  let app: Application;
  let client: SQSClient;
  let operator: string;
  let providerA: string;
  let providerB: string;

  async function token(clientId: string) {
    const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
      method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: `${clientId}_local` }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBe(200);
    return (await response.json() as { access_token: string }).access_token;
  }
  function request(path: string, accessToken?: string, body?: unknown, key?: string, target = app) {
    return fetch(`${target.url}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(key ? { "Idempotency-Key": key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
  }
  async function wallet() {
    const response = await request("/wallets", operator, { playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } });
    expect(response.status).toBe(201);
    return response.json() as Promise<WalletResponse>;
  }
  function wager(target: WalletResponse) {
    return { providerId: "provider-a", externalTransactionId: crypto.randomUUID(), playerId: target.playerId, walletId: target.id,
      roundId: "auth-round", gameId: "fortune-chimp", kind: "BET", money: { amount: "25.00", currency: "BRL" } };
  }
  const environment = { AUTH_ENABLED: "true", AUTH_ISSUER: issuer, AUTH_AUDIENCE: "wagering-api",
    AUTH_JWKS_URL: `${issuer}/protocol/openid-connect/certs` };

  beforeAll(async () => {
    orm = await resetTestDatabase();
    const endpoint = process.env.TEST_SQS_ENDPOINT ?? "http://127.0.0.1:4567";
    if (endpoint !== "http://127.0.0.1:4567") throw new Error("Authentication tests require isolated MiniStack on port 4567");
    client = createSqsClient(endpoint);
    [operator, providerA, providerB] = await Promise.all([token("wallet-operator"), token("provider-a"), token("provider-b")]);
    app = await startApplication(children, environment);
  }, 60_000);
  afterEach(async () => {
    expect(await orm.em.getConnection().execute(`select w.id from wallets w left join wallet_ledger l on l.wallet_id = w.id
      group by w.id having w.balance <> coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)`)).toEqual([]);
  });
  afterAll(async () => {
    await Promise.all(children.map(stop));
    if (client) { for (const QueueUrl of queues) await client.send(new DeleteQueueCommand({ QueueUrl })); client.destroy(); }
    if (orm) await orm.close(true);
  });

  test("requires a real access token while health and metrics remain public", async () => {
    expect((await request("/wallets", undefined, {})).status).toBe(401);
    expect((await request("/wagering/transactions", undefined, {})).status).toBe(401);
    const invalid = await request(`/wallets/${crypto.randomUUID()}`, "not-a-jwt");
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toMatchObject({ code: "INVALID_ACCESS_TOKEN" });
    for (const route of ["/health/live", "/health/ready", "/metrics"]) expect((await request(route)).status).toBe(200);
    expect(await orm.em.getConnection().execute("select id from wallets")).toEqual([]);
  });

  test("separates wallet management from provider submission and preserves idempotency", async () => {
    const target = await wallet();
    for (const route of [`/wallets/${target.id}`, `/wallets/${target.id}/ledger`, `/wallets/${target.id}/journal`]) {
      expect((await request(route, providerA)).status).toBe(403);
      expect((await request(route)).status).toBe(401);
    }
    expect((await request("/wallets", providerA, {})).status).toBe(403);
    expect((await request(`/wallets/${target.id}/reconciliation`, providerA, {})).status).toBe(403);
    const input = wager(target);
    const key = `provider-a:${input.externalTransactionId}`;
    expect((await request("/wagering/transactions", operator, input, key)).status).toBe(403);
    const first = await request("/wagering/transactions", providerA, input, key);
    expect(first.status).toBe(200);
    const original = await first.json() as { transactionId: string };
    const replay = await request("/wagering/transactions", providerA, input, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ transactionId: original.transactionId, idempotentReplay: true, balance: { amount: "75.00" } });
    expect((await request(`/wallets/${target.id}/reconciliation`, operator, {})).status).toBe(200);
    const journal = await request(`/wallets/${target.id}/journal`, operator);
    expect(journal.status).toBe(200);
    expect((await journal.json() as { items: unknown[] }).items).toHaveLength(2);
    expect(await orm.em.getConnection().execute("select direction, amount from wallet_ledger where wallet_id = ? and direction = 'DEBIT'", [target.id]))
      .toEqual([{ direction: "DEBIT", amount: "25.00" }]);
  });

  test("one real presenter login can open a wallet and submit a provider-a wager", async () => {
    const tokens = await presenterTokens(issuer);
    const opened = await request("/wallets", tokens.access_token, {
      playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" },
    });
    expect(opened.status).toBe(201);
    const target = await opened.json() as WalletResponse;
    const input = wager(target);
    const submitted = await request("/wagering/transactions", tokens.access_token, input, `provider-a:${input.externalTransactionId}`);
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toMatchObject({ status: "PROCESSED", balance: { amount: "75.00", currency: "BRL" } });
  });

  test("cannot submit or read another provider identity by either transaction URL", async () => {
    const target = await wallet();
    const input = wager(target);
    const key = `provider-a:${input.externalTransactionId}`;
    const denied = await request("/wagering/transactions", providerB, input, key);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "PROVIDER_FORBIDDEN" });
    const accepted = await request("/wagering/transactions", providerA, input, key);
    const result = await accepted.json() as { transactionId: string };
    for (const path of [`/wagering/transactions/${result.transactionId}`, `/providers/provider-a/wagering/transactions/${input.externalTransactionId}`]) {
      expect((await request(path, providerB)).status).toBe(404);
      expect((await request(path, providerA)).status).toBe(200);
      expect((await request(path, operator)).status).toBe(200);
    }
  });

  test("rejects a genuine Keycloak token intended for a different audience", async () => {
    const wrongAudience = await startApplication(children, { ...environment, AUTH_AUDIENCE: "different-api" });
    const response = await request("/wallets", operator, {}, undefined, wrongAudience);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "INVALID_ACCESS_TOKEN" });
    await stop(wrongAudience.child);
  });

  test("fails closed with a retryable error when trusted signing keys cannot be retrieved", async () => {
    const unavailable = await startApplication(children, { ...environment, AUTH_JWKS_URL: `${issuer}/missing-keys` });
    const response = await request("/wallets", operator, {}, undefined, unavailable);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "IDENTITY_PROVIDER_UNAVAILABLE", message: "The identity provider could not be reached" });
    await stop(unavailable.child);
  });

  test("the trusted SQS channel still invokes the same financial workflow without bearer tokens", async () => {
    async function queue() {
      const result = await client.send(new CreateQueueCommand({ QueueName: `auth-${crypto.randomUUID()}.fifo`, Attributes: { FifoQueue: "true" } }));
      queues.push(result.QueueUrl!);
      return result.QueueUrl!;
    }
    const inputQueue = await queue(); const dlqQueue = await queue();
    const target = await wallet(); const input = wager(target);
    const consumer = await startApplication(children, { ...environment, SQS_CONSUMER_ENABLED: "true",
      SQS_WAGER_QUEUE_URL: inputQueue, SQS_WAGER_DLQ_URL: dlqQueue });
    await client.send(new SendMessageCommand({ QueueUrl: inputQueue, MessageGroupId: target.id, MessageDeduplicationId: crypto.randomUUID(),
      MessageBody: JSON.stringify({ messageId: crypto.randomUUID(), type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
        data: { ...input, idempotencyKey: `provider-a:${input.externalTransactionId}` } }) }));
    let response: Response | undefined;
    const expires = Date.now() + 10_000;
    do { response = await request(`/providers/provider-a/wagering/transactions/${input.externalTransactionId}`, providerA);
      if (response.status === 200) break; await Bun.sleep(25);
    } while (Date.now() < expires);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "PROCESSED", balance: { amount: "75.00" } });
    await stop(consumer.child);
  });
});
