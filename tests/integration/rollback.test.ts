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
interface Input {
  providerId: string; externalTransactionId: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK"; money: WalletResponse["balance"];
  referenceExternalTransactionId?: string;
}
interface Result {
  transactionId: string; status: "PENDING_REFERENCE" | "PROCESSED" | "REJECTED";
  balance: WalletResponse["balance"]; idempotentReplay: boolean; failureCode?: string;
}

integration("ROLLBACK with PostgreSQL, SQS and independent application processes", () => {
  let orm: Orm;
  let processWager: ProcessWager;
  let client: SQSClient;
  let queueUrl: string;
  let dlqUrl: string;
  let applications: Application[];
  let children: Child[];

  function rows<T = Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    return orm.em.getConnection().execute<T[]>(sql, parameters);
  }

  function environment(): Record<string, string> {
    return { SQS_CONSUMER_ENABLED: "true", SQS_ENDPOINT: endpoint,
      SQS_WAGER_QUEUE_URL: queueUrl, SQS_WAGER_DLQ_URL: dlqUrl, SQS_VISIBILITY_TIMEOUT_SECONDS: "2" };
  }

  function request(path: string, body?: unknown, instance = 0, key?: string): Promise<Response> {
    return fetch(`${applications[instance]!.url}${path}`, {
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

  function input(target: WalletResponse, kind: Input["kind"], amount = kind === "LOSS" ? "0.00" : "25.00"): Input {
    return { providerId: "provider-a", externalTransactionId: crypto.randomUUID(), playerId: target.playerId,
      walletId: target.id, roundId: crypto.randomUUID(), gameId: "fortune-chimp", kind, money: { amount, currency: "BRL" } };
  }

  function refund(target: WalletResponse, bet: Input): Input {
    return { ...input(target, "REFUND", bet.money.amount), roundId: bet.roundId,
      referenceExternalTransactionId: bet.externalTransactionId };
  }

  function rollback(target: WalletResponse, reference: Input): Input {
    return { ...input(target, "ROLLBACK", reference.money.amount), roundId: reference.roundId,
      referenceExternalTransactionId: reference.externalTransactionId };
  }

  function key(body: Input): string { return `${body.providerId}:${body.externalTransactionId}`; }

  function submit(body: Input, instance = 0): Promise<Response> {
    return request("/wagering/transactions", body, instance, key(body));
  }

  function envelope(body: Input) {
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
    throw new Error(`Expected rollback processing to finish: ${JSON.stringify(result)}`);
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

  async function due(transactionId: string): Promise<Date> {
    const records = await rows<{ next_reference_attempt_at: string }>(
      "select next_reference_attempt_at from wager_transactions where id = ?", [transactionId]);
    expect(records).toHaveLength(1);
    return new Date(records[0]!.next_reference_attempt_at);
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
      throw new Error("Rollback tests require isolated local MiniStack on port 4567");
    }
    orm = await resetTestDatabase();
    processWager = new ProcessWager(new PostgresWageringStore(orm));
    client = createSqsClient(endpoint);
    const suffix = crypto.randomUUID();
    const dlq = await client.send(new CreateQueueCommand({ QueueName: `rollback-dlq-${suffix}.fifo`,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } }));
    if (!dlq.QueueUrl) throw new Error("MiniStack did not return the DLQ URL");
    dlqUrl = dlq.QueueUrl;
    const attributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }));
    const created = await client.send(new CreateQueueCommand({ QueueName: `rollback-${suffix}.fifo`,
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

  test("reverses BET, WIN and REFUND ledger directions without rewriting their history", async () => {
    const target = await wallet();
    const bet = input(target, "BET");
    const win = input(target, "WIN", "15.00");
    const refundedBet = input(target, "BET", "20.00");
    const refunded = refund(target, refundedBet);
    for (const [reference, direction, balance] of [
      [bet, "CREDIT", "100.00"], [win, "DEBIT", "100.00"], [refunded, "DEBIT", "80.00"],
    ] as const) {
      if (reference.kind === "REFUND") expect((await submit(refundedBet)).status).toBe(200);
      const referenceResponse = await submit(reference);
      expect(referenceResponse.status).toBe(200);
      const referenceResult = await referenceResponse.json() as Result;
      const originalTransaction = await rows("select * from wager_transactions where id = ?", [referenceResult.transactionId]);
      const originalLedger = await rows("select * from wallet_ledger where transaction_id = ?", [referenceResult.transactionId]);
      const body = { ...rollback(target, reference), gameId: "another-game" };
      const response = await submit(body);
      expect(response.status).toBe(200);
      const result = await response.json() as Result;
      expect(result).toMatchObject({ status: "PROCESSED", balance: { amount: balance, currency: "BRL" } });
      expect(await rows("select direction, amount from wallet_ledger where transaction_id = ?", [result.transactionId]))
        .toEqual([{ direction, amount: reference.money.amount }]);
      expect(await eventTypes(result.transactionId)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
      expect(await (await request(`/wagering/transactions/${result.transactionId}`)).json())
        .toMatchObject({ kind: "ROLLBACK", referenceTransactionId: referenceResult.transactionId,
          referenceExternalTransactionId: reference.externalTransactionId });
      expect(await rows("select * from wager_transactions where id = ?", [referenceResult.transactionId])).toEqual(originalTransaction);
      expect(await rows("select * from wallet_ledger where transaction_id = ?", [referenceResult.transactionId])).toEqual(originalLedger);
      expect(await (await submit(reference, 1)).json()).toEqual({ ...referenceResult, idempotentReplay: true });
      expect(await (await submit(body, 2)).json()).toEqual({ ...result, idempotentReplay: true });
    }
    expect(await rows("select balance, version from wallets where id = ?", [target.id]))
      .toEqual([{ balance: "80.00", version: 8 }]);
    expect(await rows("select id from wallet_ledger where wallet_id = ?", [target.id])).toHaveLength(8);
  });

  test("50 concurrent copies debit once and distinct competing identities cannot reverse a WIN twice", async () => {
    expect(new Set(applications.map(({ child }) => child.pid)).size).toBe(3);
    const target = await wallet();
    const win = input(target, "WIN");
    expect((await submit(win)).status).toBe(200);
    const body = rollback(target, win);
    const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => submit(body, index % 3)));
    expect(responses.map((response) => response.status)).toEqual(Array(50).fill(200));
    const results = await Promise.all(responses.map((response) => response.json() as Promise<Result>));
    const original = results.find((result) => !result.idempotentReplay)!;
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(original.balance.amount).toBe("100.00");
    expect(await rows("select direction, amount from wallet_ledger where transaction_id = ?", [original.transactionId]))
      .toEqual([{ direction: "DEBIT", amount: "25.00" }]);
    const message = envelope(body);
    await Promise.all(Array.from({ length: 5 }, () => send(message)));
    await drained();
    expect((await snapshot(target.id)).inbox).toHaveLength(1);

    const secondWin = input(target, "WIN");
    expect((await submit(secondWin)).status).toBe(200);
    const competitors = Array.from({ length: 12 }, () => rollback(target, secondWin));
    const race = await Promise.all(competitors.map((candidate, index) => submit(candidate, index % 3)));
    expect(race.filter((response) => response.status === 200)).toHaveLength(1);
    expect(race.filter((response) => response.status === 422)).toHaveLength(11);
    const decisions = await Promise.all(race.map((response) => response.json() as Promise<Result>));
    for (const decision of decisions) {
      expect(decision.balance.amount).toBe("100.00");
      if (decision.status === "REJECTED") {
        expect(decision.failureCode).toBe("REFERENCE_ALREADY_ROLLED_BACK");
        expect(await rows("select id from wallet_ledger where transaction_id = ?", [decision.transactionId])).toEqual([]);
        expect(await eventTypes(decision.transactionId)).toEqual(["WagerTransactionRejected"]);
      }
    }
    expect((await submit(input(target, "WIN", "1.00"))).status).toBe(200);
    expect(await (await submit(body, 2)).json()).toEqual({ ...original, idempotentReplay: true });
    for (let index = 0; index < competitors.length; index++) {
      expect(await (await submit(competitors[index]!, index % 3)).json()).toEqual({ ...decisions[index], idempotentReplay: true });
    }
    const before = await snapshot(target.id);
    expect(before.wallet).toEqual([expect.objectContaining({ balance: "101.00", version: 6 })]);
    expect(before.ledger).toHaveLength(6);
    expect((await submit({ ...body, money: { amount: "24.00", currency: "BRL" } })).status).toBe(409);
    expect((await request("/wagering/transactions", body, 1, crypto.randomUUID())).status).toBe(409);
    await send(message);
    await drained();
    expect(await snapshot(target.id)).toEqual(before);
  }, 30_000);

  test("invalid references become durable rejections and malformed reversals are not persisted", async () => {
    const target = await wallet();
    const other = await wallet();
    const bet = input(target, "BET");
    const otherBet = input(other, "BET");
    const loss = { ...input(target, "LOSS"), roundId: bet.roundId };
    const rejected = { ...input(target, "BET", "1000.00"), roundId: bet.roundId };
    const pending = { ...input(target, "WIN"), roundId: bet.roundId, referenceExternalTransactionId: crypto.randomUUID() };
    for (const reference of [bet, otherBet, loss]) expect((await submit(reference)).status).toBe(200);
    expect((await submit(rejected)).status).toBe(422);
    expect((await submit(pending)).status).toBe(202);
    const previousRollback = rollback(target, bet);
    expect((await submit(previousRollback)).status).toBe(200);
    const before = await snapshot(target.id);
    const cases: Array<[Input, string]> = [
      [{ ...rollback(target, loss), money: { amount: "1.00", currency: "BRL" } }, "REFERENCE_KIND_MISMATCH"],
      [rollback(target, previousRollback), "REFERENCE_KIND_MISMATCH"],
      [rollback(target, rejected), "REFERENCE_NOT_PROCESSED"],
      [rollback(target, pending), "REFERENCE_NOT_PROCESSED"],
      [rollback(target, otherBet), "REFERENCE_MISMATCH"],
      [{ ...rollback(target, bet), roundId: "another-round" }, "REFERENCE_MISMATCH"],
      [{ ...rollback(target, bet), money: { amount: "24.99", currency: "BRL" } }, "REFERENCE_AMOUNT_MISMATCH"],
    ];
    for (const [body, failureCode] of cases) {
      const response = await submit(body);
      expect(response.status).toBe(422);
      const result = await response.json() as Result;
      expect(result).toMatchObject({ status: "REJECTED", failureCode, balance: { amount: "100.00" } });
      expect(await eventTypes(result.transactionId)).toEqual(["WagerTransactionRejected"]);
      expect(await rows("select id from wallet_ledger where transaction_id = ?", [result.transactionId])).toEqual([]);
      expect(await (await submit(body, 1)).json()).toEqual({ ...result, idempotentReplay: true });
    }
    const after = await snapshot(target.id);
    expect(after.wallet).toEqual(before.wallet);
    expect(after.ledger).toEqual(before.ledger);
    const valid = rollback(target, bet);
    const missing = input(target, "ROLLBACK");
    for (const invalid of [missing, { ...valid, referenceExternalTransactionId: null },
      { ...valid, referenceExternalTransactionId: "" }, { ...valid, referenceExternalTransactionId: "invalid reference" },
      { ...valid, referenceExternalTransactionId: valid.externalTransactionId },
      ...["0.00", "-0.01", "1.001", 25].map((amount) => ({ ...valid, money: { amount, currency: "BRL" } })),
    ]) expect((await request("/wagering/transactions", invalid, 0, crypto.randomUUID())).status).toBe(400);
    expect(await snapshot(target.id)).toEqual(after);
  });

  test("insufficient reversal funds and credit overflow persist without reserving the reference", async () => {
    const target = await wallet("0.00");
    const win = input(target, "WIN");
    expect((await submit(win)).status).toBe(200);
    expect((await submit(input(target, "BET"))).status).toBe(200);
    const before = await snapshot(target.id);
    const body = rollback(target, win);
    const response = await submit(body);
    expect(response.status).toBe(422);
    const rejected = await response.json() as Result;
    expect(rejected).toMatchObject({ failureCode: "REVERSAL_INSUFFICIENT_FUNDS", balance: { amount: "0.00" } });
    expect((await snapshot(target.id)).wallet).toEqual(before.wallet);
    expect((await snapshot(target.id)).ledger).toEqual(before.ledger);
    expect(await eventTypes(rejected.transactionId)).toEqual(["WagerTransactionRejected"]);
    expect((await submit(input(target, "WIN"))).status).toBe(200);
    expect(await (await submit(body, 1)).json()).toEqual({ ...rejected, idempotentReplay: true });
    expect(await (await submit(rollback(target, win), 2)).json()).toMatchObject({ status: "PROCESSED", balance: { amount: "0.00" } });

    const maximum = await wallet("999999999999999999.99");
    const bet = input(maximum, "BET", "0.01");
    expect((await submit(bet)).status).toBe(200);
    expect((await submit(input(maximum, "WIN", "0.01"))).status).toBe(200);
    const overflowing = rollback(maximum, bet);
    const overflowResponse = await submit(overflowing);
    expect(overflowResponse.status).toBe(422);
    const overflow = await overflowResponse.json() as Result;
    expect(overflow).toMatchObject({ failureCode: "BALANCE_LIMIT_EXCEEDED", balance: { amount: "999999999999999999.99" } });
    expect(await rows("select id from wallet_ledger where transaction_id = ?", [overflow.transactionId])).toEqual([]);
    expect((await submit(input(maximum, "BET", "0.01"))).status).toBe(200);
    expect(await (await submit(overflowing, 1)).json()).toEqual({ ...overflow, idempotentReplay: true });
    expect(await (await submit(rollback(maximum, bet), 2)).json())
      .toMatchObject({ status: "PROCESSED", balance: { amount: "999999999999999999.99" } });
  });

  test("REFUND and ROLLBACK have independent reversal slots and rolling back a refund does not free its BET", async () => {
    const target = await wallet();
    const bet = input(target, "BET");
    expect((await submit(bet)).status).toBe(200);
    const refundBody = refund(target, bet);
    const rollbackBody = rollback(target, bet);
    const race = await Promise.all([submit(refundBody, 0), submit(rollbackBody, 1)]);
    expect(race.map((response) => response.status)).toEqual([200, 200]);
    expect(await rows("select balance, version from wallets where id = ?", [target.id]))
      .toEqual([{ balance: "125.00", version: 4 }]);
    expect(await (await submit(rollback(target, refundBody), 2)).json())
      .toMatchObject({ status: "PROCESSED", balance: { amount: "100.00" } });
    const before = await snapshot(target.id);
    for (const [body, failureCode] of [[refund(target, bet), "REFERENCE_ALREADY_REFUNDED"],
      [rollback(target, bet), "REFERENCE_ALREADY_ROLLED_BACK"],
      [rollback(target, refundBody), "REFERENCE_ALREADY_ROLLED_BACK"]] as const) {
      const response = await submit(body);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ failureCode });
    }
    const after = await snapshot(target.id);
    expect(after.wallet).toEqual(before.wallet);
    expect(after.ledger).toEqual(before.ledger);
  });

  test("SQS reversals arriving before BET, WIN and REFUND recover once after three process restarts", async () => {
    const cases: Array<{ target: WalletResponse; messages: Array<ReturnType<typeof envelope>>;
      pendingBalance: string; finalBalance: string; finalVersion: number }> = [];
    for (const kind of ["BET", "WIN", "REFUND"] as const) {
      const target = await wallet();
      const bet = input(target, "BET");
      if (kind === "REFUND") expect((await submit(bet)).status).toBe(200);
      const reference = kind === "REFUND" ? refund(target, bet) : input(target, kind);
      const messages = [envelope(rollback(target, reference)), envelope(rollback(target, reference))];
      for (const message of messages) await send(message);
      await send(messages[0]!);
      await send(envelope(reference));
      cases.push({ target, messages, pendingBalance: kind === "BET" ? "75.00" : kind === "WIN" ? "125.00" : "100.00",
        finalBalance: kind === "REFUND" ? "75.00" : "100.00", finalVersion: kind === "REFUND" ? 4 : 3 });
    }
    await drained();
    for (const { target, pendingBalance } of cases) {
      const before = await snapshot(target.id);
      expect(before.inbox).toHaveLength(3);
      expect(before.inbox.every((record) => record.processed_at !== null)).toBe(true);
      expect(before.transactions.filter((record) => record.status === "PENDING_REFERENCE")).toHaveLength(2);
      expect(before.wallet).toEqual([expect.objectContaining({ balance: pendingBalance })]);
    }
    for (const application of applications) application.child.kill("SIGKILL");
    await Promise.all(applications.map(({ child }) => deadline(child.exited, 5_000, "Application did not stop")));
    applications = [];
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
      for (let index = 0; index < 3; index++) {
        applications.push(await startApplication(children, { ...environment(), REFERENCE_WORKER_ENABLED: "true" }));
      }
      expect(new Set(applications.map(({ child }) => child.pid)).size).toBe(3);
      expect(await rows("select id from wager_transactions where status = 'PENDING_REFERENCE'")).toHaveLength(6);
    } finally { release(); await holder; }
    await eventually(() => rows("select id from wager_transactions where status = 'PENDING_REFERENCE'"), (records) => records.length === 0);
    for (const { target, messages, finalBalance, finalVersion } of cases) {
      const after = await snapshot(target.id);
      expect(after.wallet).toEqual([expect.objectContaining({ balance: finalBalance, version: finalVersion })]);
      expect(after.ledger).toHaveLength(finalVersion);
      const reversals = after.transactions.filter((record) => record.kind === "ROLLBACK");
      expect(reversals.filter((record) => record.status === "PROCESSED")).toHaveLength(1);
      expect(reversals.filter((record) => record.failure_code === "REFERENCE_ALREADY_ROLLED_BACK")).toHaveLength(1);
      for (const transaction of reversals) {
        expect(await eventTypes(transaction.id as string)).toEqual(transaction.status === "PROCESSED"
          ? ["WagerTransactionPendingReference", "WagerTransactionProcessed", "WalletBalanceChanged"]
          : ["WagerTransactionPendingReference", "WagerTransactionRejected"]);
      }
      for (const message of messages) await send(message);
      await drained();
      expect(await snapshot(target.id)).toEqual(after);
    }
  }, 45_000);

  test("missing provider-scoped references expire after ten checks without changing balance or ledger", async () => {
    const target = await wallet();
    const anotherProvider = { ...input(target, "WIN"), providerId: "provider-b" };
    expect((await submit(anotherProvider)).status).toBe(200);
    const body = rollback(target, anotherProvider);
    const response = await submit(body);
    expect(response.status).toBe(202);
    const accepted = await response.json() as Result;
    const before = await snapshot(target.id);
    for (let attempt = 1; attempt <= 10; attempt++) {
      const next = await due(accepted.transactionId);
      expect(await processWager.reprocessNext(new Date(next.getTime() - 1))).toBeNull();
      await processWager.reprocessNext(next);
      const record = (await rows<{ status: string; reference_attempts: number; next_reference_attempt_at: string | null }>(
        "select status, reference_attempts, next_reference_attempt_at from wager_transactions where id = ?", [accepted.transactionId]))[0]!;
      expect(record.reference_attempts).toBe(attempt);
      expect(record.status).toBe(attempt === 10 ? "REJECTED" : "PENDING_REFERENCE");
      if (attempt < 10) expect(new Date(record.next_reference_attempt_at!).getTime() - next.getTime()).toBe(Math.min(60, 2 ** attempt) * 1_000);
    }
    const expired = await snapshot(target.id);
    expect(expired.wallet).toEqual(before.wallet);
    expect(expired.ledger).toEqual(before.ledger);
    expect(await eventTypes(accepted.transactionId)).toEqual(["WagerTransactionPendingReference", "WagerTransactionRejected"]);
    const replay = await submit(body, 2);
    expect(replay.status).toBe(422);
    expect(await replay.json()).toMatchObject({ failureCode: "REFERENCE_NOT_FOUND", balance: { amount: "125.00" }, idempotentReplay: true });
  });

  test("outbox failures roll back pending acceptance, debit finalization and rejected inbox decisions atomically", async () => {
    const target = await wallet("0.00");
    const win = input(target, "WIN");
    const body = rollback(target, win);
    const delivery = { messageId: crypto.randomUUID(), consumerName: "wager-transactions", receivedAt: new Date(), correlationId: crypto.randomUUID() };
    async function failOutbox(): Promise<void> {
      await rows(`create function test_rollback_outbox_failure() returns trigger language plpgsql as $$
        begin raise exception 'injected serialization failure' using errcode = '40001'; end $$`);
      await rows("create trigger test_rollback_outbox_failure before insert on outbox_messages for each row execute function test_rollback_outbox_failure()");
    }
    async function restoreOutbox(): Promise<void> {
      await rows("drop trigger test_rollback_outbox_failure on outbox_messages");
      await rows("drop function test_rollback_outbox_failure()");
    }
    const before = await snapshot(target.id);
    await failOutbox();
    try {
      await expect(processWager.execute(body, key(body), delivery)).rejects.toMatchObject({ retryable: true });
      expect(await snapshot(target.id)).toEqual(before);
      expect(await rows("select * from inbox_messages where message_id = ?", [delivery.messageId])).toEqual([]);
    } finally { await restoreOutbox(); }
    const accepted = await processWager.execute(body, key(body), delivery);
    expect(accepted.status).toBe("PENDING_REFERENCE");
    expect((await submit(win)).status).toBe(200);
    const committed = await snapshot(target.id);
    const next = await due(accepted.transactionId);
    await failOutbox();
    try {
      await expect(processWager.reprocessNext(next)).rejects.toMatchObject({ retryable: true });
      expect(await snapshot(target.id)).toEqual(committed);
    } finally { await restoreOutbox(); }
    await processWager.reprocessNext(next);
    const finalized = await snapshot(target.id);
    expect(finalized.inbox).toEqual(committed.inbox);
    expect(finalized.wallet).toEqual([expect.objectContaining({ balance: "0.00", version: 3 })]);
    expect(finalized.ledger).toHaveLength(2);
    expect(await processWager.execute(body, key(body), delivery)).toMatchObject({ status: "PROCESSED", idempotentReplay: true });

    const secondWin = input(target, "WIN");
    expect((await submit(secondWin)).status).toBe(200);
    expect((await submit(input(target, "BET"))).status).toBe(200);
    const rejectedBody = rollback(target, secondWin);
    const rejectedDelivery = { ...delivery, messageId: crypto.randomUUID() };
    const beforeRejection = await snapshot(target.id);
    await failOutbox();
    try {
      await expect(processWager.execute(rejectedBody, key(rejectedBody), rejectedDelivery)).rejects.toMatchObject({ retryable: true });
      expect(await snapshot(target.id)).toEqual(beforeRejection);
      expect(await rows("select * from inbox_messages where message_id = ?", [rejectedDelivery.messageId])).toEqual([]);
    } finally { await restoreOutbox(); }
    const rejected = await processWager.execute(rejectedBody, key(rejectedBody), rejectedDelivery);
    expect(rejected).toMatchObject({ status: "REJECTED", failureCode: "REVERSAL_INSUFFICIENT_FUNDS" });
    expect(await rows("select processed_at from inbox_messages where message_id = ?", [rejectedDelivery.messageId]))
      .toEqual([expect.objectContaining({ processed_at: expect.anything() })]);
    expect(await rows("select id from wallet_ledger where transaction_id = ?", [rejected.transactionId])).toEqual([]);
    expect(await eventTypes(rejected.transactionId)).toEqual(["WagerTransactionRejected"]);
    expect((await submit(input(target, "WIN"))).status).toBe(200);
    expect((await submit(rollback(target, secondWin))).status).toBe(200);
  });

  test("migration 007 preserves earlier referenced history on downgrade and refuses pending rollback history", async () => {
    const target = await wallet();
    const bet = input(target, "BET");
    await send(envelope(bet));
    await drained();
    await send(envelope({ ...input(target, "WIN", "1.00"), roundId: bet.roundId,
      referenceExternalTransactionId: bet.externalTransactionId }));
    await send(envelope(refund(target, bet)));
    await drained();
    const missingBet = input(target, "BET");
    expect((await submit({ ...input(target, "WIN"), referenceExternalTransactionId: missingBet.externalTransactionId })).status).toBe(202);
    expect((await submit(refund(target, missingBet))).status).toBe(202);
    const before = await snapshot(target.id);
    await orm.getMigrator().down({ to: "Migration202610100007" });
    expect((await orm.getMigrator().getPendingMigrations()).map(({ name }) => name)).toEqual(["Migration202610100007", "Migration202610100008", "Migration202610120001"]);
    expect(await snapshot(target.id)).toEqual(before);
    await orm.getMigrator().up();
    expect(await snapshot(target.id)).toEqual(before);
    expect((await submit(rollback(target, missingBet))).status).toBe(202);
    const withRollback = await snapshot(target.id);
    await expect(orm.getMigrator().down({ to: "Migration202610100007" })).rejects.toThrow();
    expect(await snapshot(target.id)).toEqual(withRollback);
    expect(await orm.getMigrator().getPendingMigrations()).toHaveLength(0);
  });

  test("SQL guards enforce rollback references, amounts, uniqueness and the inverse ledger direction", async () => {
    const target = await wallet();
    const bet = input(target, "BET");
    const betResult = await (await submit(bet)).json() as Result;
    const win = input(target, "WIN");
    const winResult = await (await submit(win)).json() as Result;
    const refunded = refund(target, bet);
    const refundResult = await (await submit(refunded)).json() as Result;
    const lossResult = await (await submit(input(target, "LOSS"))).json() as Result;
    const pending = await (await submit(rollback(target, input(target, "BET")))).json() as Result;
    const before = await snapshot(target.id);
    const columns = `id, wallet_id, player_id, currency, amount, idempotency_key, kind, status, created_at, processed_at,
      provider_id, external_transaction_id, round_id, game_id, payload_hash, result_balance, failure_code,
      reference_external_transaction_id, reference_transaction_id, reference_attempts, next_reference_attempt_at, processing_correlation_id`;
    for (const [amount, reference, status, next] of [
      ["amount", "null", "'PROCESSED'", "null"],
      ["'0.00'", "reference_external_transaction_id", "status", "next_reference_attempt_at"],
    ]) {
      await expect(rows(`insert into wager_transactions (${columns})
        select ?, wallet_id, player_id, currency, ${amount}, ?, kind, ${status}, created_at,
          ${status === "status" ? "processed_at" : "now()"}, provider_id, ?, round_id, game_id, payload_hash, result_balance,
          failure_code, ${reference}, reference_transaction_id, reference_attempts, ${next}, processing_correlation_id
        from wager_transactions where id = ?`,
      [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), pending.transactionId])).rejects.toMatchObject({ code: "23514" });
    }
    async function insertRollback(em: Orm["em"], id: string, referenceId: string, amount = "25.00", round?: string): Promise<void> {
      await em.execute(`insert into wager_transactions (${columns})
        select ?, wallet_id, player_id, currency, ?, ?, 'ROLLBACK', 'PROCESSED', now(), now(), provider_id, ?,
          ${round === undefined ? "round_id" : "?"}, game_id, payload_hash, '100.00', null, external_transaction_id, id, 0, null, ?
        from wager_transactions where id = ?`,
      [id, amount, crypto.randomUUID(), crypto.randomUUID(), ...(round === undefined ? [] : [round]), crypto.randomUUID(), referenceId]);
    }
    for (const referenceId of [betResult.transactionId, winResult.transactionId, refundResult.transactionId]) {
      await expect(orm.em.fork().transactional((em) => insertRollback(em, crypto.randomUUID(), referenceId, "24.99")))
        .rejects.toMatchObject({ code: "23514", message: expect.stringContaining("amount must equal") });
      const wrongDirectionId = crypto.randomUUID();
      const wrongDirection = referenceId === betResult.transactionId ? "DEBIT" : "CREDIT";
      await expect(orm.em.fork().transactional(async (em) => {
        await insertRollback(em, wrongDirectionId, referenceId);
        await em.execute(`insert into wallet_ledger
          (id, wallet_id, transaction_id, direction, currency, amount, balance_before, balance_after, created_at)
          select ?, wallet_id, id, ?, currency, amount, '125.00', ?, now()
          from wager_transactions where id = ?`,
        [crypto.randomUUID(), wrongDirection, wrongDirection === "CREDIT" ? "150.00" : "100.00", wrongDirectionId]);
      })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("Ledger direction") });
    }
    await expect(orm.em.fork().transactional((em) => insertRollback(em, crypto.randomUUID(), betResult.transactionId, "25.00", "another-round")))
      .rejects.toMatchObject({ code: "23514" });
    for (const referenceId of [lossResult.transactionId, pending.transactionId]) {
      await expect(orm.em.fork().transactional((em) => insertRollback(em, crypto.randomUUID(), referenceId)))
        .rejects.toMatchObject({ code: "23514" });
    }
    expect(await snapshot(target.id)).toEqual(before);
    const processed = await (await submit(rollback(target, bet))).json() as Result;
    expect(processed.status).toBe("PROCESSED");
    await expect(orm.em.fork().transactional((em) => insertRollback(em, crypto.randomUUID(), betResult.transactionId)))
      .rejects.toMatchObject({ code: "23505", message: expect.stringContaining("wager_transactions_rollback_reference_unique") });
    const finalized = await snapshot(target.id);
    for (const assignment of ["amount = '24.99'", "reference_transaction_id = null", "status = 'PENDING_REFERENCE'"]) {
      await expect(rows(`update wager_transactions set ${assignment} where id = ?`, [processed.transactionId])).rejects.toThrow();
    }
    await expect(rows("delete from wager_transactions where id = ?", [processed.transactionId])).rejects.toThrow();
    await expect(orm.getMigrator().down({ to: "Migration202610100007" })).rejects.toThrow();
    expect(await snapshot(target.id)).toEqual(finalized);
  });
});
