import { assertAccountingConsistent } from "./accounting-audit.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, SendMessageCommand, SQSClient,
} from "@aws-sdk/client-sqs";
import { ProcessWager } from "../../src/application/process-wager.js";
import { PostgresWageringStore } from "../../src/infrastructure/database/postgres-wagering-store.js";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client.js";
import {
  deadline, resetTestDatabase, startApplication, stop,
  type Application, type Child, type Orm, type WalletResponse,
} from "./helpers.js";

const integration = process.env.RUN_DATABASE_INTEGRATION === "1" && process.env.RUN_SQS_INTEGRATION === "1"
  ? describe : describe.skip;
const endpoint = process.env.TEST_SQS_ENDPOINT ?? "http://127.0.0.1:4567";
interface WagerInput {
  providerId: string; externalTransactionId: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: "BET" | "WIN" | "LOSS"; money: WalletResponse["balance"];
  referenceExternalTransactionId?: string;
}
interface Result {
  transactionId: string; status: "PENDING_REFERENCE" | "PROCESSED" | "REJECTED";
  balance: WalletResponse["balance"]; idempotentReplay: boolean; failureCode?: string;
}
interface PendingRecord {
  status: string; reference_attempts: number; next_reference_attempt_at: Date | null;
  result_balance: string; failure_code: string | null; reference_transaction_id: string | null;
}

integration("referenced WIN with durable scheduling, PostgreSQL and SQS", () => {
  let orm: Orm;
  let processWager: ProcessWager;
  let client: SQSClient;
  let queueUrl: string;
  let dlqUrl: string;
  let applications: Application[];
  let children: Child[];

  function app(index = 0): Application { return applications[index]!; }

  function rows<T = Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    return orm.em.getConnection().execute<T[]>(sql, parameters);
  }

  function environment(): Record<string, string> {
    return { SQS_CONSUMER_ENABLED: "true", SQS_ENDPOINT: endpoint,
      SQS_WAGER_QUEUE_URL: queueUrl, SQS_WAGER_DLQ_URL: dlqUrl, SQS_VISIBILITY_TIMEOUT_SECONDS: "2" };
  }

  function request(path: string, body?: unknown, instance = 0, key?: string): Promise<Response> {
    return fetch(`${app(instance).url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(key === undefined ? {} : { "Idempotency-Key": key }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
  }

  async function wallet(amount = "100.00"): Promise<WalletResponse> {
    const response = await request("/wallets", {
      playerId: crypto.randomUUID(), initialBalance: { amount, currency: "BRL" },
    });
    expect(response.status).toBe(201);
    return response.json() as Promise<WalletResponse>;
  }

  function input(target: WalletResponse, kind: WagerInput["kind"], amount = kind === "LOSS" ? "0.00" : "25.00"): WagerInput {
    return { providerId: "provider-a", externalTransactionId: crypto.randomUUID(), playerId: target.playerId,
      walletId: target.id, roundId: crypto.randomUUID(), gameId: "fortune-chimp", kind, money: { amount, currency: "BRL" } };
  }

  function win(target: WalletResponse, bet: WagerInput): WagerInput {
    return { ...input(target, "WIN", "40.00"), roundId: bet.roundId,
      referenceExternalTransactionId: bet.externalTransactionId };
  }

  function key(body: WagerInput): string { return `${body.providerId}:${body.externalTransactionId}`; }

  function submit(body: WagerInput, instance = 0): Promise<Response> {
    return request("/wagering/transactions", body, instance, key(body));
  }

  function envelope(body: WagerInput) {
    return { messageId: crypto.randomUUID(), type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
      data: { ...body, idempotencyKey: key(body) } };
  }

  function send(message: ReturnType<typeof envelope>): Promise<unknown> {
    return client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message),
      MessageGroupId: message.data.walletId, MessageDeduplicationId: crypto.randomUUID() }));
  }

  async function eventually<T>(read: () => Promise<T>, ready: (result: T) => boolean): Promise<T> {
    const expires = Date.now() + 15_000;
    let result: T;
    do {
      result = await read();
      if (ready(result)) return result;
      await Bun.sleep(25);
    } while (Date.now() < expires);
    throw new Error(`Expected reference processing to finish: ${JSON.stringify(result)}`);
  }

  async function drained(): Promise<void> {
    await eventually(async () => {
      const response = await client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }));
      return Number(response.Attributes?.ApproximateNumberOfMessages ?? "0")
        + Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? "0");
    }, (count) => count === 0);
  }

  async function snapshot(walletId: string) {
    return { wallet: await rows("select * from wallets where id = ?", [walletId]),
      transactions: await rows("select * from wager_transactions where wallet_id = ? order by id", [walletId]),
      ledger: await rows("select * from wallet_ledger where wallet_id = ? order by id", [walletId]),
      outbox: await rows("select * from outbox_messages where aggregate_id = ? order by id", [walletId]),
      inbox: await rows(`select i.* from inbox_messages i join wager_transactions t on t.id = i.transaction_id
        where t.wallet_id = ? order by i.consumer_name, i.message_id`, [walletId]) };
  }

  async function pending(transactionId: string): Promise<PendingRecord> {
    const records = await rows<Omit<PendingRecord, "next_reference_attempt_at"> & { next_reference_attempt_at: string | null }>(`select status, reference_attempts, next_reference_attempt_at,
      result_balance, failure_code, reference_transaction_id from wager_transactions where id = ?`, [transactionId]);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    return { ...record, next_reference_attempt_at: record.next_reference_attempt_at === null
      ? null : new Date(record.next_reference_attempt_at) };
  }

  async function eventTypes(transactionId: string): Promise<string[]> {
    return (await rows<{ event_type: string }>(
      "select event_type from outbox_messages where payload->'data'->>'transactionId' = ? order by event_type",
      [transactionId])).map((row) => row.event_type);
  }

  beforeEach(async () => {
    children = [];
    applications = [];
    const url = new URL(endpoint);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)
      || url.port !== "4567" || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Reference tests require isolated local MiniStack on port 4567");
    }
    orm = await resetTestDatabase();
    processWager = new ProcessWager(new PostgresWageringStore(orm));
    client = createSqsClient(endpoint);
    const suffix = crypto.randomUUID();
    const dlq = await client.send(new CreateQueueCommand({ QueueName: `reference-dlq-${suffix}.fifo`,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } }));
    if (!dlq.QueueUrl) throw new Error("MiniStack did not return the DLQ URL");
    dlqUrl = dlq.QueueUrl;
    const attributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }));
    const created = await client.send(new CreateQueueCommand({ QueueName: `reference-${suffix}.fifo`,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false", VisibilityTimeout: "2",
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: attributes.Attributes?.QueueArn, maxReceiveCount: "5" }) } }));
    if (!created.QueueUrl) throw new Error("MiniStack did not return the input queue URL");
    queueUrl = created.QueueUrl;
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

  test("migration 005 reverses without losing previous financial and inbox history", async () => {
    const target = await wallet();
    for (const kind of ["BET", "WIN", "LOSS"] as const) {
      await send(envelope(input(target, kind)));
      await drained();
    }
    const before = await snapshot(target.id);
    expect(before.inbox).toHaveLength(3);
    await orm.getMigrator().down({ to: "Migration202610100005" });
    expect((await orm.getMigrator().getPendingMigrations()).map(({ name }) => name)).toEqual([
      "Migration202610100005", "Migration202610100006", "Migration202610100007", "Migration202610100008", "Migration202610120001",
    ]);
    const downgraded = await snapshot(target.id);
    expect(downgraded).toMatchObject({ wallet: before.wallet, ledger: before.ledger, outbox: before.outbox, inbox: before.inbox });
    expect(downgraded.transactions).toHaveLength(4);
    await orm.getMigrator().up();
    expect(await snapshot(target.id)).toEqual(before);
  });

  test("50 HTTP copies persist one pending decision and later replay the single credit", async () => {
    expect(new Set(applications.map(({ child }) => child.pid)).size).toBe(3);
    const target = await wallet();
    const bet = input(target, "BET");
    const body = win(target, bet);
    const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => submit(body, index % 3)));
    const results = await Promise.all(responses.map((response) => response.json() as Promise<Result>));
    expect(responses.map((response) => response.status)).toEqual(Array(50).fill(202));
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    const accepted = results[0]!;
    expect(accepted).toMatchObject({ status: "PENDING_REFERENCE", balance: { amount: "100.00", currency: "BRL" } });
    expect(await rows("select balance, version from wallets where id = ?", [target.id])).toEqual([{ balance: "100.00", version: 1 }]);
    expect(await rows("select id from wallet_ledger where transaction_id = ?", [accepted.transactionId])).toEqual([]);
    expect(await eventTypes(accepted.transactionId)).toEqual(["WagerTransactionPendingReference"]);
    const pendingView = await (await request(`/wagering/transactions/${accepted.transactionId}`)).json();
    expect(pendingView).toMatchObject({ status: "PENDING_REFERENCE", referenceExternalTransactionId: bet.externalTransactionId,
      processedAt: null, referenceAttempts: 0, nextReferenceAttemptAt: expect.any(String) });
    expect(pendingView).not.toHaveProperty("referenceTransactionId");
    const originalSchedule = await pending(accepted.transactionId);
    const processedBet = await (await submit(bet, 1)).json() as Result;
    expect((await submit(body, 2)).status).toBe(202);
    expect(await pending(accepted.transactionId)).toEqual(originalSchedule);
    await processWager.reprocessNext(new Date(originalSchedule.next_reference_attempt_at!.getTime()));
    const response = await submit(body, 2);
    expect(response.status).toBe(200);
    const processed = await response.json() as Result;
    expect(processed).toMatchObject({ transactionId: accepted.transactionId, status: "PROCESSED",
      balance: { amount: "115.00", currency: "BRL" }, idempotentReplay: true });
    expect(await pending(accepted.transactionId)).toMatchObject({ status: "PROCESSED", reference_transaction_id: processedBet.transactionId });
    expect(await eventTypes(accepted.transactionId)).toEqual([
      "WagerTransactionPendingReference", "WagerTransactionProcessed", "WalletBalanceChanged",
    ]);
    expect((await submit(input(target, "WIN", "1.00"))).status).toBe(200);
    expect(await (await submit(body)).json()).toEqual(processed);
    const conflict = await submit({ ...body, referenceExternalTransactionId: crypto.randomUUID() });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await rows("select id from wallet_ledger where transaction_id = ?", [accepted.transactionId])).toHaveLength(1);
  }, 30_000);

  test("SQS acknowledges pending duplicates so a later BET in the same FIFO group can arrive", async () => {
    const target = await wallet();
    const bet = input(target, "BET");
    const body = win(target, bet);
    const message = envelope(body);
    await Promise.all(Array.from({ length: 50 }, () => send(message)));
    await drained();
    const before = await snapshot(target.id);
    expect(before.inbox).toHaveLength(1);
    expect(before.inbox[0]).toMatchObject({ message_id: message.messageId, processed_at: expect.any(String) });
    const pendingResult = await (await submit(body)).json() as Result;
    expect(pendingResult.status).toBe("PENDING_REFERENCE");
    expect(await eventTypes(pendingResult.transactionId)).toEqual(["WagerTransactionPendingReference"]);
    await send(envelope(bet));
    await drained();
    const record = await pending(pendingResult.transactionId);
    await processWager.reprocessNext(record.next_reference_attempt_at!);
    const committed = await snapshot(target.id);
    await send(message);
    await drained();
    expect(await snapshot(target.id)).toEqual(committed);
    expect(await (await submit(body)).json()).toMatchObject({ status: "PROCESSED", balance: { amount: "115.00" } });
    expect(await rows("select correlation_id from (select payload->>'correlationId' as correlation_id from outbox_messages where payload->'data'->>'transactionId' = ?) events", [pendingResult.transactionId]))
      .toEqual(Array(3).fill({ correlation_id: message.messageId }));
  }, 30_000);

  test("a resolved WIN accepts its own amount and game but rejects incompatible references persistently", async () => {
    const target = await wallet();
    const bet = input(target, "BET");
    const betResult = await (await submit(bet)).json() as Result;
    const body = { ...win(target, bet), gameId: "another-game" };
    const response = await submit(body);
    expect(response.status).toBe(200);
    const result = await response.json() as Result;
    expect(result).toMatchObject({ status: "PROCESSED", balance: { amount: "115.00" } });
    expect(await pending(result.transactionId)).toMatchObject({ reference_transaction_id: betResult.transactionId });
    expect(await eventTypes(result.transactionId)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);

    const other = await wallet();
    const otherBet = input(other, "BET");
    const loss = { ...input(target, "LOSS"), roundId: bet.roundId };
    const rejectedBet = { ...input(target, "BET", "1000.00"), roundId: bet.roundId };
    await submit(otherBet);
    await submit(loss);
    await submit(rejectedBet);
    const cases: Array<[WagerInput, string]> = [
      [{ ...win(target, bet), roundId: "another-round" }, "REFERENCE_MISMATCH"],
      [win(target, otherBet), "REFERENCE_MISMATCH"],
      [win(target, loss), "REFERENCE_KIND_MISMATCH"],
      [win(target, body), "REFERENCE_KIND_MISMATCH"],
      [win(target, rejectedBet), "REFERENCE_NOT_PROCESSED"],
    ];
    for (const [invalid, failureCode] of cases) {
      const rejection = await submit(invalid);
      expect(rejection.status).toBe(422);
      const original = await rejection.json() as Result;
      expect(original).toMatchObject({ status: "REJECTED", failureCode, balance: { amount: "115.00" } });
      expect(await (await submit(invalid, 1)).json()).toEqual({ ...original, idempotentReplay: true });
      expect(await rows("select id from wallet_ledger where transaction_id = ?", [original.transactionId])).toEqual([]);
      expect(await eventTypes(original.transactionId)).toEqual(["WagerTransactionRejected"]);
    }
  });

  test("reference lookup is scoped to the provider, and invalid reference contracts persist nothing", async () => {
    const target = await wallet();
    const otherProviderBet = { ...input(target, "BET"), providerId: "provider-b" };
    expect((await submit(otherProviderBet)).status).toBe(200);
    const body = win(target, otherProviderBet);
    const response = await submit(body);
    expect(response.status).toBe(202);
    const accepted = await response.json() as Result;
    const beforeInvalid = await snapshot(target.id);
    for (const invalid of [
      { ...input(target, "BET"), referenceExternalTransactionId: otherProviderBet.externalTransactionId },
      { ...input(target, "LOSS"), referenceExternalTransactionId: otherProviderBet.externalTransactionId },
      { ...body, referenceExternalTransactionId: body.externalTransactionId },
      { ...body, referenceExternalTransactionId: "" },
      { ...body, referenceExternalTransactionId: "invalid reference" },
    ]) expect((await request("/wagering/transactions", invalid, 0, crypto.randomUUID())).status).toBe(400);
    expect(await snapshot(target.id)).toEqual(beforeInvalid);
    const ownProviderBet = { ...otherProviderBet, providerId: body.providerId };
    const processedBet = await (await submit(ownProviderBet)).json() as Result;
    await processWager.reprocessNext((await pending(accepted.transactionId)).next_reference_attempt_at!);
    expect(await pending(accepted.transactionId)).toMatchObject({ status: "PROCESSED", reference_transaction_id: processedBet.transactionId });
    expect(await rows("select balance, version from wallets where id = ?", [target.id])).toEqual([{ balance: "90.00", version: 4 }]);
  });

  test("ten scheduled missing checks persist exponential backoff and reject without repeating the pending event", async () => {
    const target = await wallet();
    const body = win(target, input(target, "BET"));
    const accepted = await (await submit(body)).json() as Result;
    let record = await pending(accepted.transactionId);
    expect(record).toMatchObject({ status: "PENDING_REFERENCE", reference_attempts: 0, result_balance: "100.00" });
    const [created] = await rows<{ created_at: string }>("select created_at from wager_transactions where id = ?", [accepted.transactionId]);
    expect(record.next_reference_attempt_at!.getTime() - new Date(created!.created_at).getTime()).toBe(1_000);
    expect((await submit(input(target, "WIN", "1.00"))).status).toBe(200);
    for (let attempt = 1; attempt <= 10; attempt++) {
      const due = record.next_reference_attempt_at!;
      expect(await processWager.reprocessNext(new Date(due.getTime() - 1))).toBeNull();
      expect(await pending(accepted.transactionId)).toEqual(record);
      await processWager.reprocessNext(due);
      record = await pending(accepted.transactionId);
      expect(record.reference_attempts).toBe(attempt);
      if (attempt < 10) {
        expect(record.status).toBe("PENDING_REFERENCE");
        expect(record.result_balance).toBe("100.00");
        expect(record.next_reference_attempt_at!.getTime() - due.getTime()).toBe(Math.min(60, 2 ** attempt) * 1_000);
        expect(await eventTypes(accepted.transactionId)).toEqual(["WagerTransactionPendingReference"]);
      }
    }
    expect(record).toMatchObject({ status: "REJECTED", failure_code: "REFERENCE_NOT_FOUND",
      result_balance: "101.00", next_reference_attempt_at: null, reference_transaction_id: null });
    expect(await eventTypes(accepted.transactionId)).toEqual(["WagerTransactionPendingReference", "WagerTransactionRejected"]);
    const response = await submit(body);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ failureCode: "REFERENCE_NOT_FOUND", balance: { amount: "101.00" }, idempotentReplay: true });
    expect(await rows("select id from wallet_ledger where transaction_id = ?", [accepted.transactionId])).toEqual([]);
    expect(await processWager.reprocessNext(new Date("2100-01-01T00:00:00.000Z"))).toBeNull();
  });

  test("outbox failures roll back initial inbox acceptance and later reference finalization atomically", async () => {
    const target = await wallet();
    const bet = input(target, "BET");
    const body = win(target, bet);
    const delivery = { messageId: crypto.randomUUID(), consumerName: "wager-transactions", receivedAt: new Date(), correlationId: crypto.randomUUID() };
    const before = await snapshot(target.id);
    async function failOutbox(): Promise<void> {
      await rows(`create function test_reference_outbox_failure() returns trigger language plpgsql as $$
        begin raise exception 'injected serialization failure' using errcode = '40001'; end $$`);
      await rows("create trigger test_reference_outbox_failure before insert on outbox_messages for each row execute function test_reference_outbox_failure()");
    }
    async function restoreOutbox(): Promise<void> {
      await rows("drop trigger test_reference_outbox_failure on outbox_messages");
      await rows("drop function test_reference_outbox_failure()");
    }
    await failOutbox();
    try {
      await expect(processWager.execute(body, key(body), delivery)).rejects.toMatchObject({ retryable: true });
      expect(await snapshot(target.id)).toEqual(before);
      expect(await rows("select * from inbox_messages where message_id = ?", [delivery.messageId])).toEqual([]);
    } finally { await restoreOutbox(); }
    const accepted = await processWager.execute(body, key(body), delivery);
    expect(accepted.status).toBe("PENDING_REFERENCE");
    expect((await submit(bet)).status).toBe(200);
    const committed = await snapshot(target.id);
    const due = (await pending(accepted.transactionId)).next_reference_attempt_at!;
    await failOutbox();
    try {
      await expect(processWager.reprocessNext(due)).rejects.toMatchObject({ retryable: true });
      expect(await snapshot(target.id)).toEqual(committed);
    } finally { await restoreOutbox(); }
    await processWager.reprocessNext(due);
    const after = await snapshot(target.id);
    expect(after.inbox).toEqual(committed.inbox);
    expect(after.wallet).toEqual([expect.objectContaining({ balance: "115.00", version: 3 })]);
    expect(await rows("select id from wallet_ledger where transaction_id = ?", [accepted.transactionId])).toHaveLength(1);
    expect(await eventTypes(accepted.transactionId)).toEqual([
      "WagerTransactionPendingReference", "WagerTransactionProcessed", "WalletBalanceChanged",
    ]);
  });

  test("three independent reference workers complete due wallets after restart without duplicate credits", async () => {
    const cases: Array<{ target: WalletResponse; bet: WagerInput; body: WagerInput; accepted: Result }> = [];
    for (let index = 0; index < 6; index++) {
      const target = await wallet();
      const bet = input(target, "BET");
      const body = win(target, bet);
      const accepted = await (await submit(body, index % 3)).json() as Result;
      expect(accepted.status).toBe("PENDING_REFERENCE");
      expect((await submit(bet, index % 3)).status).toBe(200);
      cases.push({ target, bet, body, accepted });
    }
    const before = await rows("select * from wager_transactions where status = 'PENDING_REFERENCE' order by id");
    for (const application of applications) application.child.kill("SIGKILL");
    await Promise.all(applications.map(({ child }) => deadline(child.exited, 5_000, "Application did not stop")));
    expect(await rows("select * from wager_transactions where status = 'PENDING_REFERENCE' order by id")).toEqual(before);
    let release: () => void = () => {};
    let acquired: () => void = () => {};
    const lockAcquired = new Promise<void>((resolve) => { acquired = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const holder = orm.em.fork().transactional(async (em) => {
      await em.execute("select id from wallets order by id for update");
      acquired();
      await hold;
    });
    try {
      await deadline(lockAcquired, 5_000, "Test did not acquire wallet locks");
      applications = [];
      for (let index = 0; index < 3; index++) {
        applications.push(await startApplication(children, { ...environment(), REFERENCE_WORKER_ENABLED: "true" }));
      }
      expect(new Set(applications.map(({ child }) => child.pid)).size).toBe(3);
      expect(applications.every(({ child }) => child.exitCode === null)).toBe(true);
      expect(await rows("select id from wager_transactions where status = 'PENDING_REFERENCE'")).toHaveLength(6);
    } finally { release(); await holder; }
    await eventually(() => rows("select id from wager_transactions where status = 'PENDING_REFERENCE'"), (records) => records.length === 0);
    for (const { target, body, accepted } of cases) {
      const responses = await Promise.all(applications.map((_, index) => submit(body, index)));
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ transactionId: accepted.transactionId, status: "PROCESSED",
          balance: { amount: "115.00" }, idempotentReplay: true });
      }
      expect(await rows("select balance, version from wallets where id = ?", [target.id])).toEqual([{ balance: "115.00", version: 3 }]);
      expect(await rows("select id from wallet_ledger where transaction_id = ?", [accepted.transactionId])).toHaveLength(1);
      expect(await eventTypes(accepted.transactionId)).toEqual([
        "WagerTransactionPendingReference", "WagerTransactionProcessed", "WalletBalanceChanged",
      ]);
    }
  }, 30_000);

  test("database constraints preserve pending identities, enforce reference state and forbid destructive rollback", async () => {
    const target = await wallet();
    const bet = input(target, "BET");
    const body = win(target, bet);
    const accepted = await (await submit(body)).json() as Result;
    const before = await snapshot(target.id);
    for (const [attempts, nextAttempt] of [["-1", "next_reference_attempt_at"], ["10", "next_reference_attempt_at"], ["0", "null"]]) {
      // Fresh inserts exercise CHECK constraints without an UPDATE transition guard masking them.
      await expect(rows(`insert into wager_transactions
        (id, wallet_id, player_id, currency, amount, idempotency_key, kind, status, created_at, processed_at,
          provider_id, external_transaction_id, round_id, game_id, payload_hash, result_balance, failure_code,
          reference_external_transaction_id, reference_transaction_id, reference_attempts,
          next_reference_attempt_at, processing_correlation_id)
        select ?, wallet_id, player_id, currency, amount, ?, kind, status, created_at, processed_at,
          provider_id, ?, round_id, game_id, payload_hash, result_balance, failure_code,
          reference_external_transaction_id, reference_transaction_id, ${attempts}, ${nextAttempt}, processing_correlation_id
        from wager_transactions where id = ?`,
      [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), accepted.transactionId])).rejects.toMatchObject({ code: "23514" });
    }
    for (const assignment of [
      "reference_external_transaction_id = 'another-bet'", "payload_hash = repeat('a', 64)",
      "result_balance = '0.00'", "reference_attempts = -1", "reference_attempts = 10",
      "next_reference_attempt_at = null", "status = 'PENDING'", "processed_at = now()",
      "reference_transaction_id = '00000000-0000-0000-0000-000000000001'",
    ]) await expect(rows(`update wager_transactions set ${assignment} where id = ?`, [accepted.transactionId])).rejects.toThrow();
    await expect(rows("delete from wager_transactions where id = ?", [accepted.transactionId])).rejects.toThrow();
    await expect(rows(`insert into wallet_ledger
      (id, wallet_id, transaction_id, direction, currency, amount, balance_before, balance_after, created_at)
      select ?, wallet_id, id, 'CREDIT', currency, amount, '100.00', '140.00', now()
      from wager_transactions where id = ?`, [crypto.randomUUID(), accepted.transactionId])).rejects.toThrow();
    await expect(orm.getMigrator().down({ to: "Migration202610100005" })).rejects.toThrow();
    expect(await snapshot(target.id)).toEqual(before);
    expect(await orm.getMigrator().getPendingMigrations()).toHaveLength(0);

    const unrelatedBet = { ...bet, externalTransactionId: crypto.randomUUID(), roundId: "another-round" };
    const wrongReference = await (await submit(unrelatedBet)).json() as Result;
    await expect(rows(`update wager_transactions set status = 'PROCESSED', processed_at = now(),
      next_reference_attempt_at = null, reference_transaction_id = ? where id = ?`,
    [wrongReference.transactionId, accepted.transactionId])).rejects.toThrow();
    expect((await submit(bet)).status).toBe(200);
    await processWager.reprocessNext((await pending(accepted.transactionId)).next_reference_attempt_at!);
    const finalized = await snapshot(target.id);
    await expect(rows("update wager_transactions set reference_transaction_id = null where id = ?", [accepted.transactionId])).rejects.toThrow();
    await expect(orm.getMigrator().down({ to: "Migration202610100005" })).rejects.toThrow();
    expect(await snapshot(target.id)).toEqual(finalized);
  });
});
