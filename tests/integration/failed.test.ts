import { assertAccountingConsistent } from "./accounting-audit.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { ProcessWager } from "../../src/application/process-wager.js";
import { PostgresWageringStore } from "../../src/infrastructure/database/postgres-wagering-store.js";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client.js";
import { deadline, isolatedDatabaseUrl, resetTestDatabase, startApplication, stop, type Application, type Child, type Orm, type WalletResponse } from "./helpers.js";

const integration = process.env.RUN_DATABASE_INTEGRATION === "1" && process.env.RUN_SQS_INTEGRATION === "1" ? describe : describe.skip;
const endpoint = process.env.TEST_SQS_ENDPOINT ?? "http://127.0.0.1:4567";
const root = fileURLToPath(new URL("../../", import.meta.url));
interface Input {
  providerId: string; externalTransactionId: string; playerId: string; walletId: string; roundId: string; gameId: string;
  kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK"; money: WalletResponse["balance"]; referenceExternalTransactionId?: string;
}
interface Result { transactionId: string; status: string; balance: WalletResponse["balance"]; failureCode?: string; idempotentReplay: boolean }

integration("durable FAILED decisions with PostgreSQL, SQS and three processes", () => {
  let orm: Orm;
  let client: SQSClient;
  let applications: Application[];
  let children: Child[];
  let queueUrl: string;
  let dlqUrl: string;
  let processWager: ProcessWager;
  const rows = <T = Record<string, unknown>>(sql: string, parameters: unknown[] = []) => orm.em.getConnection().execute<T[]>(sql, parameters);
  function environment() { return { SQS_ENDPOINT: endpoint, SQS_WAGER_QUEUE_URL: queueUrl, SQS_WAGER_DLQ_URL: dlqUrl, SQS_VISIBILITY_TIMEOUT_SECONDS: "2" }; }
  function input(wallet: WalletResponse, kind: Input["kind"] = "BET"): Input {
    return { providerId: "provider-a", externalTransactionId: crypto.randomUUID(), playerId: wallet.playerId, walletId: wallet.id,
      roundId: "round", gameId: "game", kind, money: { amount: kind === "LOSS" ? "0.00" : "25.00", currency: "BRL" },
      ...(kind === "REFUND" || kind === "ROLLBACK" ? { referenceExternalTransactionId: "missing-reference" } : {}) };
  }
  const key = (body: Input) => `${body.providerId}:${body.externalTransactionId}`;
  function request(path: string, body?: unknown, instance = 0, identity?: string) {
    return fetch(`${applications[instance]!.url}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(identity ? { "Idempotency-Key": identity } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  }
  const submit = (body: Input, instance = 0) => request("/wagering/transactions", body, instance, key(body));
  async function wallet(): Promise<WalletResponse> {
    const response = await request("/wallets", { playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } });
    expect(response.status).toBe(201);
    return response.json() as Promise<WalletResponse>;
  }
  async function snapshot(walletId: string) {
    return { wallet: await rows("select * from wallets where id = ?", [walletId]),
      transactions: await rows("select * from wager_transactions where wallet_id = ? order by id", [walletId]),
      ledger: await rows("select * from wallet_ledger where wallet_id = ? order by id", [walletId]),
      outbox: await rows("select * from outbox_messages where aggregate_id = ? order by id", [walletId]),
      inbox: await rows("select * from inbox_messages order by message_id") };
  }
  async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
    const expires = Date.now() + 15_000;
    let value: T;
    do { value = await read(); if (ready(value)) return value; await Bun.sleep(25); } while (Date.now() < expires);
    throw new Error(`Expected failure recovery to finish: ${JSON.stringify(value)}`);
  }
  async function rejectLedger() {
    await rows(`create function test_failed_ledger() returns trigger language plpgsql as $$
      begin raise exception 'injected permanent ledger rejection' using errcode = '23514'; end $$`);
    await rows("create trigger test_failed_ledger before insert on wallet_ledger for each row execute function test_failed_ledger()");
  }
  async function restoreLedger() {
    await rows("drop trigger test_failed_ledger on wallet_ledger");
    await rows("drop function test_failed_ledger()");
  }
  beforeEach(async () => {
    children = []; applications = [];
    const url = new URL(endpoint);
    if (url.origin !== "http://127.0.0.1:4567" && url.origin !== "http://localhost:4567") throw new Error("FAILED tests require isolated MiniStack on port 4567");
    orm = await resetTestDatabase();
    processWager = new ProcessWager(new PostgresWageringStore(orm));
    client = createSqsClient(endpoint);
    const suffix = crypto.randomUUID();
    dlqUrl = (await client.send(new CreateQueueCommand({ QueueName: `failed-dlq-${suffix}.fifo`, Attributes: { FifoQueue: "true" } }))).QueueUrl!;
    const attributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }));
    queueUrl = (await client.send(new CreateQueueCommand({ QueueName: `failed-${suffix}.fifo`, Attributes: { FifoQueue: "true", VisibilityTimeout: "2",
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: attributes.Attributes?.QueueArn, maxReceiveCount: "5" }) } }))).QueueUrl!;
    for (let index = 0; index < 3; index++) applications.push(await startApplication(children, environment()));
  }, 60_000);
  afterEach(async () => {
    await Promise.all(children.map(stop));
    try {
      if (orm) expect(await rows(`select w.id from wallets w left join wallet_ledger l on l.wallet_id = w.id
        group by w.id having w.balance <> coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)`)).toEqual([]);
    } finally {
      if (orm) { try { await assertAccountingConsistent(orm); } finally { await orm.close(true); } }
      if (queueUrl) await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      if (dlqUrl) await client.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
      client?.destroy();
    }
  });

  test("50 concurrent permanent failures commit one audit, preserve balance and replay the historical outcome", async () => {
    expect(new Set(applications.map(({ child }) => child.pid)).size).toBe(3);
    const target = await wallet();
    const body = input(target);
    await rejectLedger();
    const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => submit(body, index % 3)));
    expect(responses.every((response) => response.status === 500)).toBe(true);
    const results = await Promise.all(responses.map((response) => response.json() as Promise<Result>));
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(results.every((result) => result.status === "FAILED" && result.failureCode === "DATABASE_OPERATION_FAILED" && result.balance.amount === "100.00")).toBe(true);
    const failed = results[0]!;
    const before = await snapshot(target.id);
    expect(before.ledger).toHaveLength(1);
    expect(before.outbox).toHaveLength(3);
    expect(before.wallet).toEqual([expect.objectContaining({ balance: "100.00", version: 1 })]);
    await restoreLedger();
    expect((await submit(input(target, "WIN"))).status).toBe(200);
    expect(await (await submit(body, 2)).json()).toEqual({ ...failed, idempotentReplay: true });
    for (const path of [`/wagering/transactions/${failed.transactionId}`, `/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`]) {
      expect(await (await request(path)).json()).toMatchObject({ transactionId: failed.transactionId, status: "FAILED", processedAt: null,
        failureCode: "DATABASE_OPERATION_FAILED", balance: { amount: "100.00", currency: "BRL" } });
    }
    expect((await submit({ ...body, money: { amount: "26.00", currency: "BRL" } })).status).toBe(409);
    await expect(rows("update wager_transactions set status = 'PROCESSED' where id = ?", [failed.transactionId])).rejects.toThrow("Terminal wager transactions are immutable");
    await expect(rows("delete from wager_transactions where id = ?", [failed.transactionId])).rejects.toThrow("Terminal wager transactions are immutable");
    await expect(rows(`insert into wallet_ledger (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, created_at)
      values (?, ?, ?, 'BRL', 'DEBIT', 25.00, 125.00, 100.00, now())`, [crypto.randomUUID(), target.id, failed.transactionId])).rejects.toThrow();
  }, 30_000);

  test("every externally supported operation can fail permanently without changing wallet or ledger", async () => {
    const target = await wallet();
    await rows(`create function test_failed_decision() returns trigger language plpgsql as $$ begin
      if new.status <> 'FAILED' then raise exception 'injected permanent decision rejection' using errcode = '23514'; end if; return new; end $$`);
    await rows("create trigger test_failed_decision before insert on wager_transactions for each row execute function test_failed_decision()");
    for (const kind of ["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"] as const) {
      const response = await submit(input(target, kind));
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ status: "FAILED", failureCode: "DATABASE_OPERATION_FAILED", balance: { amount: "100.00" } });
    }
    expect(await rows("select balance, version from wallets where id = ?", [target.id])).toEqual([{ balance: "100.00", version: 1 }]);
    expect(await rows("select id from wallet_ledger where wallet_id = ?", [target.id])).toHaveLength(1);
    expect(await rows("select id from outbox_messages where event_type = 'WagerTransactionFailed'")).toHaveLength(5);
  });

  test("an unavailable failure outbox rolls back the audit and inbox, then redelivery commits them together", async () => {
    const target = await wallet();
    const body = input(target);
    const delivery = { consumerName: "wager-transactions", messageId: crypto.randomUUID(), correlationId: crypto.randomUUID(), receivedAt: new Date() };
    const before = await snapshot(target.id);
    await rejectLedger();
    await rows(`create function test_failed_audit() returns trigger language plpgsql as $$
      begin raise exception 'injected audit failure' using errcode = '23514'; end $$`);
    await rows("create trigger test_failed_audit before insert on outbox_messages for each row execute function test_failed_audit()");
    await expect(processWager.execute(body, key(body), delivery)).rejects.toMatchObject({ retryable: true, code: "FAILURE_AUDIT_UNAVAILABLE" });
    expect(await snapshot(target.id)).toEqual(before);
    await rows("drop trigger test_failed_audit on outbox_messages");
    const result = await processWager.execute(body, key(body), delivery);
    expect(result.status).toBe("FAILED");
    expect(await rows("select transaction_id, processed_at from inbox_messages where message_id = ?", [delivery.messageId]))
      .toEqual([{ transaction_id: result.transactionId, processed_at: expect.anything() }]);
    expect(await rows("select event_type from outbox_messages where payload->'data'->>'transactionId' = ?", [result.transactionId]))
      .toEqual([{ event_type: "WagerTransactionFailed" }]);
    const committed = await snapshot(target.id);
    expect(await processWager.execute(body, key(body), delivery)).toEqual({ ...result, idempotentReplay: true });
    expect(await snapshot(target.id)).toEqual(committed);
  });

  test("a permanent reference-worker failure terminates only the claimed identity and clears its retry schedule", async () => {
    const target = await wallet();
    const bet = input(target);
    const win = { ...input(target, "WIN"), referenceExternalTransactionId: bet.externalTransactionId };
    const pending = await (await submit(win)).json() as Result;
    expect(pending.status).toBe("PENDING_REFERENCE");
    const other = await (await submit({ ...input(target, "WIN"), referenceExternalTransactionId: "still-missing" })).json() as Result;
    expect((await submit(bet)).status).toBe(200);
    const [schedule] = await rows<{ next_reference_attempt_at: string }>("select next_reference_attempt_at from wager_transactions where id = ?", [pending.transactionId]);
    await rejectLedger();
    const result = await processWager.reprocessNext(new Date(schedule!.next_reference_attempt_at));
    expect(result).toMatchObject({ transactionId: pending.transactionId, status: "FAILED", referenceAttempts: 0 });
    expect(await rows("select status, next_reference_attempt_at, reference_attempts, result_balance from wager_transactions where id = ?", [pending.transactionId]))
      .toEqual([{ status: "FAILED", next_reference_attempt_at: null, reference_attempts: 0, result_balance: "75.00" }]);
    expect(await rows("select status from wager_transactions where id = ?", [other.transactionId])).toEqual([{ status: "PENDING_REFERENCE" }]);
    expect(await rows("select event_type from outbox_messages where payload->'data'->>'transactionId' = ? order by event_type", [pending.transactionId]))
      .toEqual([{ event_type: "WagerTransactionFailed" }, { event_type: "WagerTransactionPendingReference" }]);
    await restoreLedger();
    const replay = await (await submit(win)).json() as Result;
    expect(replay).toMatchObject({ status: "FAILED", idempotentReplay: true, balance: { amount: "75.00" } });
    expect(await rows("select id from wallet_ledger where transaction_id = ?", [pending.transactionId])).toEqual([]);
  });

  test("FAILED survives a consumer crash before DLQ settlement and restarts without another audit or financial effect", async () => {
    const target = await wallet();
    const body = input(target);
    await rejectLedger();
    const message = { messageId: crypto.randomUUID(), type: "WagerTransactionRequested", occurredAt: new Date().toISOString(), data: { ...body, idempotencyKey: key(body) } };
    await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message), MessageGroupId: target.id, MessageDeduplicationId: crypto.randomUUID() }));
    const child = Bun.spawn([process.execPath, "tests/fixtures/pause-before-sqs-ack.ts"], { cwd: root,
      env: { ...process.env, DATABASE_URL: isolatedDatabaseUrl(), ...environment() }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    children.push(child);
    let announce: () => void = () => {};
    const committed = new Promise<void>((resolve) => { announce = resolve; });
    let output = "";
    void (async () => { for await (const chunk of child.stdout) { output += new TextDecoder().decode(chunk); if (output.includes('"event":"sqs_ack_paused"')) announce(); } })();
    void new Response(child.stderr).text().then((value) => { output += value; });
    await deadline(Promise.race([committed, child.exited.then((code) => { throw new Error(`Crash fixture exited ${code}: ${output}`); })]), 15_000, "FAILED did not reach its settlement barrier");
    const before = await snapshot(target.id);
    expect(before.inbox).toHaveLength(1);
    expect(before.transactions).toEqual(expect.arrayContaining([expect.objectContaining({ status: "FAILED" })]));
    expect(before.wallet).toEqual([expect.objectContaining({ balance: "100.00", version: 1 })]);
    child.kill("SIGKILL"); await child.exited;
    await Promise.all(applications.map(({ child: application }) => stop(application)));
    applications = [];
    for (let index = 0; index < 3; index++) applications.push(await startApplication(children, { ...environment(), SQS_CONSUMER_ENABLED: "true" }));
    const deadLetters = await eventually(async () => (await client.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, MessageAttributeNames: ["All"], WaitTimeSeconds: 1 }))).Messages ?? [], (items) => items.length > 0);
    expect(deadLetters[0]!.Body).toBe(JSON.stringify(message));
    expect(deadLetters[0]!.MessageAttributes?.FailureCode?.StringValue).toBe("DATABASE_OPERATION_FAILED");
    await eventually(async () => (await client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }))).Attributes,
      (attributes) => attributes?.ApproximateNumberOfMessages === "0" && attributes.ApproximateNumberOfMessagesNotVisible === "0");
    expect(await snapshot(target.id)).toEqual(before);
  }, 40_000);

  test("migration 008 round-trips earlier history but refuses to erase a permanent failure", async () => {
    const target = await wallet();
    expect((await submit(input(target))).status).toBe(200);
    const before = await snapshot(target.id);
    await orm.getMigrator().down({ to: "Migration202610100008" });
    expect((await orm.getMigrator().getPendingMigrations()).map(({ name }) => name)).toEqual(["Migration202610100008", "Migration202610120001"]);
    expect(await snapshot(target.id)).toEqual(before);
    await orm.getMigrator().up();
    expect(await snapshot(target.id)).toEqual(before);
    await rejectLedger();
    expect((await submit(input(target))).status).toBe(500);
    const failed = await snapshot(target.id);
    await expect(orm.getMigrator().down({ to: "Migration202610100008" })).rejects.toThrow();
    expect(await snapshot(target.id)).toEqual(failed);
    expect(await orm.getMigrator().getPendingMigrations()).toHaveLength(0);
  });
});
