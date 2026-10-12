import { assertAccountingConsistent } from "./accounting-audit.js";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ProcessWager } from "../../src/application/process-wager.js";
import type { ReconciliationResult } from "../../src/application/reconciliation-reader.js";
import { PostgresWageringStore } from "../../src/infrastructure/database/postgres-wagering-store.js";
import {
  deadline, resetTestDatabase, startApplication, stop,
  type Application, type Child, type Orm, type WalletResponse,
} from "./helpers.js";

const integration = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;

integration("wallet reconciliation with PostgreSQL and three application processes", () => {
  let orm: Orm;
  const applications: Application[] = [];
  const children: Child[] = [];

  function rows<T = Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    return orm.em.getConnection().execute<T[]>(sql, parameters);
  }

  function request(path: string, body?: unknown, instance = 0, key?: string): Promise<Response> {
    return fetch(`${applications[instance]!.url}${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
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

  function input(target: WalletResponse, kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK", amount: string) {
    return { providerId: "provider-a", externalTransactionId: crypto.randomUUID(), walletId: target.id,
      playerId: target.playerId, roundId: "round-reconciliation", gameId: "fortune-chimp", kind,
      money: { amount, currency: "BRL" } };
  }

  async function reconcile(walletId: string, instance = 0): Promise<ReconciliationResult> {
    const response = await request(`/wallets/${walletId}/reconciliation`, undefined, instance);
    expect(response.status, response.ok ? undefined : await response.clone().text()).toBe(200);
    return response.json() as Promise<ReconciliationResult>;
  }

  async function submit(body: ReturnType<typeof input> & { referenceExternalTransactionId?: string }, instance = 0): Promise<Response> {
    return request("/wagering/transactions", body, instance, `${body.providerId}:${body.externalTransactionId}`);
  }

  beforeAll(async () => {
    orm = await resetTestDatabase();
    for (let index = 0; index < 3; index++) applications.push(await startApplication(children));
    expect(new Set(applications.map(({ child }) => child.pid)).size).toBe(3);
  }, 60_000);

  afterEach(async () => {
    expect(await rows(`select w.id from wallets w left join wallet_ledger l on l.wallet_id = w.id
      group by w.id having w.balance <> coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)`))
      .toEqual([]);
  });

  afterAll(async () => {
    await Promise.all(children.map(stop));
    if (orm) { try { await assertAccountingConsistent(orm); } finally { await orm.close(true); } }
  });

  test.each(["0.00", "999999999999999999.99"])("reconciles exact opening %s including an empty ledger", async (amount) => {
    const target = await wallet(amount);
    expect(await reconcile(target.id)).toEqual({ walletId: target.id,
      storedBalance: { amount, currency: "BRL" }, calculatedBalance: { amount, currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" }, consistent: true, checkedEntries: amount === "0.00" ? 0 : 1 });
  });

  test("includes every financial kind and excludes LOSS, rejected and pending operations from the ledger count", async () => {
    const target = await wallet();
    const bet = input(target, "BET", "25.00");
    const win = input(target, "WIN", "10.00");
    const refund = { ...input(target, "REFUND", "25.00"), referenceExternalTransactionId: bet.externalTransactionId };
    const rollback = { ...input(target, "ROLLBACK", "10.00"), referenceExternalTransactionId: win.externalTransactionId };
    for (const body of [bet, win, input(target, "LOSS", "0.00"), refund, rollback]) {
      expect((await submit(body)).status).toBe(200);
    }
    expect((await submit(input(target, "BET", "101.00"))).status).toBe(422);
    expect((await submit({ ...input(target, "WIN", "5.00"),
      referenceExternalTransactionId: crypto.randomUUID() })).status).toBe(202);
    expect(await reconcile(target.id)).toEqual({ walletId: target.id,
      storedBalance: { amount: "100.00", currency: "BRL" }, calculatedBalance: { amount: "100.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" }, consistent: true, checkedEntries: 5 });
  });

  test("reports signed divergence without repairing the balance or rewriting the ledger", async () => {
    const target = await wallet();
    const original = await rows("select * from wallet_ledger where wallet_id = ?", [target.id]);
    try {
      // Deliberate corruption is restricted by resetTestDatabase to the disposable test container.
      for (const [amount, difference] of [["100.01", "0.01"], ["99.99", "-0.01"]] as const) {
        await rows("update wallets set balance = ? where id = ?", [amount, target.id]);
        const before = await rows("select * from wallets where id = ?", [target.id]);
        expect(await reconcile(target.id)).toEqual({ walletId: target.id,
          storedBalance: { amount, currency: "BRL" }, calculatedBalance: { amount: "100.00", currency: "BRL" },
          difference: { amount: difference, currency: "BRL" }, consistent: false, checkedEntries: 1 });
        expect(await rows("select * from wallets where id = ?", [target.id])).toEqual(before);
        expect(await rows("select * from wallet_ledger where wallet_id = ?", [target.id])).toEqual(original);
      }
    } finally {
      await rows("update wallets set balance = ? where id = ?", [target.balance.amount, target.id]);
    }
    expect((await reconcile(target.id)).consistent).toBe(true);
  });

  test("distinguishes invalid and unknown wallet identifiers", async () => {
    const invalid = await request("/wallets/invalid/reconciliation");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "INVALID_INPUT" });
    const unknown = await request(`/wallets/${crypto.randomUUID()}/reconciliation`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "WALLET_NOT_FOUND" });
  });

  test("keeps snapshots consistent while three independent processes submit concurrent debits", async () => {
    const target = await wallet();
    let retries = 0;
    async function retryTransient(send: () => Promise<Response>): Promise<Response> {
      for (let attempt = 0; ; attempt++) {
        const response = await send();
        if (response.status !== 503) return response;
        const error = await response.json();
        expect(error).toMatchObject({ code: "DATABASE_UNAVAILABLE" });
        if (attempt === 2) throw new Error(`Database remained unavailable after three attempts: ${JSON.stringify(error)}`);
        retries++;
        await Bun.sleep(50 * (attempt + 1));
      }
    }
    // A busy connection pool may reject a request transiently; retries must keep the original financial identity.
    const outcomes = await Promise.allSettled(Array.from({ length: 60 }, (_, index) => {
      const body = input(target, "BET", "1.00");
      return [
        (async () => {
          const response = await retryTransient(() => submit(body, index % 3));
          expect(response.status, response.ok ? undefined : await response.clone().text()).toBe(200);
          expect(await response.json()).toMatchObject({ status: "PROCESSED" });
        })(),
        (async () => {
          const response = await retryTransient(() => request(`/wallets/${target.id}/reconciliation`, undefined, (index + 1) % 3));
          expect(response.status, response.ok ? undefined : await response.clone().text()).toBe(200);
          const report = await response.json() as ReconciliationResult;
          expect(report.consistent).toBe(true);
          expect(report.difference.amount).toBe("0.00");
          expect(report.calculatedBalance).toEqual(report.storedBalance);
        })(),
      ];
    }).flat());
    // Drain every request before propagating failures so teardown cannot race unfinished database work.
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
    console.log(JSON.stringify({ event: "reconciliation_concurrency_completed", requests: 120, retries }));
    expect(await reconcile(target.id, 2)).toEqual({ walletId: target.id,
      storedBalance: { amount: "40.00", currency: "BRL" }, calculatedBalance: { amount: "40.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" }, consistent: true, checkedEntries: 61 });
    expect(await rows(`select status, count(*)::int as count, count(distinct external_transaction_id)::int as identities
      from wager_transactions where wallet_id = ? and kind = 'BET' group by status`, [target.id]))
      .toEqual([{ status: "PROCESSED", count: 60, identities: 60 }]);
    expect(await rows(`select direction, count(*)::int as count from wallet_ledger
      where wallet_id = ? group by direction order by direction`, [target.id]))
      .toEqual([{ direction: "CREDIT", count: 1 }, { direction: "DEBIT", count: 60 }]);
    expect(await rows("select balance::text, version from wallets where id = ?", [target.id]))
      .toEqual([{ balance: "40.00", version: 61 }]);
  }, 30_000);

  test("waits for a wallet writer to commit before comparing its balance with the ledger", async () => {
    const target = await wallet();
    const store = new PostgresWageringStore(orm);
    const transaction = store.transaction.bind(store);
    let announce: () => void = () => {};
    let release: () => void = () => {};
    const written = new Promise<void>((resolve) => { announce = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    store.transaction = (work) => transaction(async (unit) => {
      const save = unit.saveDecision.bind(unit);
      unit.saveDecision = async (decision) => { await save(decision); announce(); await released; };
      return work(unit);
    });
    const bet = input(target, "BET", "25.00");
    const pending = new ProcessWager(store).execute(bet, `${bet.providerId}:${bet.externalTransactionId}`);
    let reports: Promise<ReconciliationResult[]> | undefined;
    try {
      await deadline(Promise.race([written, pending.then(() => {
        throw new Error("Writer finished without reaching the commit barrier");
      })]), 5_000, "Writer did not reach the commit barrier");
      reports = Promise.all(applications.map((_, index) => reconcile(target.id, index)));
      const expires = Date.now() + 5_000;
      let waiting: unknown[];
      do {
        waiting = await rows("select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
        if (waiting.length >= 3) break;
        await Bun.sleep(20);
      } while (Date.now() < expires);
      expect(waiting.length).toBeGreaterThanOrEqual(3);
      release();
      expect((await pending).status).toBe("PROCESSED");
      for (const report of await reports) {
        expect(report).toEqual({ walletId: target.id,
          storedBalance: { amount: "75.00", currency: "BRL" }, calculatedBalance: { amount: "75.00", currency: "BRL" },
          difference: { amount: "0.00", currency: "BRL" }, consistent: true, checkedEntries: 2 });
      }
    } finally {
      release();
      await Promise.allSettled([pending, ...(reports ? [reports] : [])]);
    }
  }, 15_000);
});
