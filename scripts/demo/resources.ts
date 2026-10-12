import { IsolationLevel } from "@mikro-orm/core";
import { CreateQueueCommand, DeleteMessageCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand,
  type SQSClient } from "@aws-sdk/client-sqs";
import { fileURLToPath } from "node:url";
import { OpenWallet } from "../../src/application/open-wallet.js";
import { invalidInput, uuidInput } from "../../src/application/input-validation.js";
import { sqsWagerInput } from "../../src/application/sqs-wager-input.js";
import { wagerInput } from "../../src/application/wager-input.js";
import { WalletSchema } from "../../src/infrastructure/database/entities.js";
import { createOrm } from "../../src/infrastructure/database/orm.js";
import { PostgresWalletStore } from "../../src/infrastructure/database/postgres-wallet-store.js";
import { createSqsClient, eventsQueueName, wagerDlqName, wagerQueueName } from "../../src/infrastructure/messaging/sqs-client.js";

export const demoDatabaseUrl = "postgresql://wagering:wagering_demo@127.0.0.1:55434/wagering_demo";
export const demoSqsEndpoint = "http://127.0.0.1:4568";
export const seedPlayerId = "11111111-1111-4111-8111-111111111111";
const root = fileURLToPath(new URL("../../", import.meta.url));
type Orm = Awaited<ReturnType<typeof createOrm>>;
type QueueName = "input" | "dlq" | "events";
export interface SeedWallet { id: string; playerId: string; balance: { amount: string; currency: string }; version: number }
export interface QueueCounts { visible: number | null; inFlight: number | null }

export class DemoResources {
  private orm: Orm | undefined;
  private client: SQSClient | undefined;
  private queues: Record<QueueName, string> | undefined;
  private seed: SeedWallet | null = null;

  constructor(private readonly log: (line: string) => void) {}

  private async compose(args: string[]): Promise<void> {
    const child = Bun.spawn(["docker", "compose", "--file", "compose.yaml", "--project-name", "jungle-wagering", "--profile", "demo", ...args], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Demonstration container command failed (${code}): ${(output + errors).slice(-2_000)}`);
  }

  async initialize(): Promise<void> {
    await this.compose(["up", "-d", "--wait", "postgres-demo", "ministack-demo"]);
    this.orm = await createOrm(demoDatabaseUrl);
    await this.orm.getMigrator().up();
    await this.setupQueues();
    await this.ensureSeed();
  }

  async reset(): Promise<void> {
    await this.close();
    this.seed = null;
    // This exact, separate database is disposable. Financial APIs and migrations
    // never disable immutable-history guards to implement a "delete everything".
    this.orm = await createOrm(demoDatabaseUrl);
    const [database] = await this.orm.em.getConnection().execute<Array<{ name: string }>>("select current_database() as name");
    if (database?.name !== "wagering_demo") throw new Error("Refusing to reset a database outside the demonstration");
    await this.orm.em.getConnection().execute("drop schema public cascade");
    await this.orm.em.getConnection().execute("create schema public");
    // A fresh broker removes invisible deliveries and FIFO deduplication history;
    // merely purging a queue would not establish this clean starting point.
    await this.compose(["up", "-d", "--wait", "--force-recreate", "ministack-demo"]);
    await this.setupQueues();
    await this.orm.getMigrator().up();
    await this.ensureSeed();
    this.log("Demonstration financial data and queues reset; a fresh BRL 100.00 wallet was created");
  }

  async close(): Promise<void> {
    this.client?.destroy(); this.client = undefined; this.queues = undefined;
    const orm = this.orm; this.orm = undefined;
    if (orm) await orm.close(true);
  }

  private database(): Orm {
    if (!this.orm) throw new Error("Demonstration database is unavailable");
    return this.orm;
  }

  private broker(): { client: SQSClient; queues: Record<QueueName, string> } {
    if (!this.client || !this.queues) throw new Error("Demonstration queues are unavailable");
    return { client: this.client, queues: this.queues };
  }

  private async setupQueues(): Promise<void> {
    this.client?.destroy();
    const client = this.client = createSqsClient(demoSqsEndpoint);
    const events = await client.send(new CreateQueueCommand({ QueueName: eventsQueueName,
      Attributes: { MessageRetentionPeriod: "1209600", VisibilityTimeout: "30" } }));
    const dlq = await client.send(new CreateQueueCommand({ QueueName: wagerDlqName,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false", MessageRetentionPeriod: "1209600", VisibilityTimeout: "30" } }));
    if (!events.QueueUrl || !dlq.QueueUrl) throw new Error("MiniStack did not return demonstration queue URLs");
    const attributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ["QueueArn"] }));
    if (!attributes.Attributes?.QueueArn) throw new Error("MiniStack did not return the demonstration DLQ ARN");
    const input = await client.send(new CreateQueueCommand({ QueueName: wagerQueueName, Attributes: {
      FifoQueue: "true", ContentBasedDeduplication: "false", MessageRetentionPeriod: "345600", VisibilityTimeout: "5",
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: attributes.Attributes.QueueArn, maxReceiveCount: 5 }),
    } }));
    if (!input.QueueUrl) throw new Error("MiniStack did not return the demonstration input queue URL");
    this.queues = { input: input.QueueUrl, dlq: dlq.QueueUrl, events: events.QueueUrl };
  }

  private async ensureSeed(): Promise<void> {
    const orm = this.database();
    const existing = await orm.em.fork().findOne(WalletSchema, { playerId: seedPlayerId, currency: "BRL" });
    if (!existing) await new OpenWallet(new PostgresWalletStore(orm)).execute({
      playerId: seedPlayerId, initialBalance: { amount: "100.00", currency: "BRL" },
    });
    await this.seedWallet();
  }

  async seedWallet(): Promise<SeedWallet | null> {
    if (!this.orm) return this.seed;
    const wallet = await this.orm.em.fork().findOne(WalletSchema, { playerId: seedPlayerId, currency: "BRL" });
    this.seed = wallet ? { id: wallet.id, playerId: wallet.playerId, balance: { amount: wallet.balance, currency: wallet.currency }, version: wallet.version } : null;
    return this.seed;
  }

  async counts(): Promise<Record<QueueName, QueueCounts>> {
    const result: Record<QueueName, QueueCounts> = {
      input: { visible: null, inFlight: null }, dlq: { visible: null, inFlight: null }, events: { visible: null, inFlight: null },
    };
    if (!this.client || !this.queues) return result;
    const { client, queues } = this.broker();
    await Promise.all((Object.keys(queues) as QueueName[]).map(async (name) => {
      try {
        const response = await client.send(new GetQueueAttributesCommand({ QueueUrl: queues[name],
          AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }));
        const count = (value: string | undefined): number | null => {
          const parsed = value === undefined ? NaN : Number(value);
          return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
        };
        result[name] = { visible: count(response.Attributes?.ApproximateNumberOfMessages),
          inFlight: count(response.Attributes?.ApproximateNumberOfMessagesNotVisible) };
      } catch { /* Unknown counts remain null; an unavailable broker is not an empty broker. */ }
    }));
    return result;
  }

  async send(input: { data: unknown; copies?: number; messageId?: string }) {
    const copies = input.copies ?? 1;
    if (!Number.isInteger(copies) || copies < 1 || copies > 50) return invalidInput("Copies must be an integer from 1 through 50");
    const messageId = input.messageId ?? crypto.randomUUID();
    const envelope = { messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(), data: input.data };
    const walletId = uuidInput((input.data as { walletId?: unknown } | null)?.walletId);
    const body = JSON.stringify(envelope);
    const request = sqsWagerInput(body, walletId);
    wagerInput(request.body);
    const { client, queues } = this.broker();
    const responses = await Promise.all(Array.from({ length: copies }, () => client.send(new SendMessageCommand({
      QueueUrl: queues.input, MessageBody: body, MessageGroupId: walletId, MessageDeduplicationId: crypto.randomUUID(),
    }))));
    this.log(`Enqueued ${copies} delivery copies for financial message ${messageId}`);
    return { messageId, copies, brokerMessageIds: responses.map((response) => response.MessageId ?? null) };
  }

  async sendInvalid() {
    const { client, queues } = this.broker();
    const response = await client.send(new SendMessageCommand({ QueueUrl: queues.input, MessageBody: "{",
      MessageGroupId: "demo-invalid", MessageDeduplicationId: crypto.randomUUID() }));
    this.log("Enqueued the fixed malformed JSON example for DLQ handling");
    return { brokerMessageId: response.MessageId ?? null, body: "{", expected: "INVALID_INPUT in the DLQ" };
  }

  async inspect(queue: "dlq" | "events") {
    if (queue !== "dlq" && queue !== "events") return invalidInput("Only DLQ and event queues support inspection");
    const { client, queues } = this.broker();
    const response = await client.send(new ReceiveMessageCommand({ QueueUrl: queues[queue], MaxNumberOfMessages: 10,
      WaitTimeSeconds: 0, VisibilityTimeout: 0, MessageSystemAttributeNames: ["All"], MessageAttributeNames: ["All"] }));
    return { queue, messages: (response.Messages ?? []).map((message) => ({
      messageId: message.MessageId, body: message.Body, attributes: message.MessageAttributes, systemAttributes: message.Attributes,
    })), note: "Up to 10 messages, without deletion. SQS inspection increments receive counts; zero visibility keeps messages available." };
  }

  async redrive(messageId: string) {
    if (typeof messageId !== "string" || !messageId || messageId.length > 255) return invalidInput("A DLQ broker message ID is required");
    const { client, queues } = this.broker();
    const response = await client.send(new ReceiveMessageCommand({ QueueUrl: queues.dlq, MaxNumberOfMessages: 10,
      WaitTimeSeconds: 0, VisibilityTimeout: 0, MessageSystemAttributeNames: ["MessageGroupId"] }));
    const message = response.Messages?.find((item) => item.MessageId === messageId);
    if (!message?.ReceiptHandle || message.Body === undefined) throw new Error("The selected DLQ message is not in the currently available batch; inspect again");
    const sent = await client.send(new SendMessageCommand({ QueueUrl: queues.input, MessageBody: message.Body,
      MessageGroupId: message.Attributes?.MessageGroupId ?? "demo-invalid", MessageDeduplicationId: crypto.randomUUID() }));
    // Retain the DLQ copy if publishing fails. A failed delete after a successful
    // send can duplicate delivery, which the persistent inbox must tolerate.
    await client.send(new DeleteMessageCommand({ QueueUrl: queues.dlq, ReceiptHandle: message.ReceiptHandle }));
    this.log(`Redrove DLQ message ${messageId}; its business identity was preserved`);
    return { messageId, brokerMessageId: sent.MessageId ?? null };
  }

  async audit() {
    return this.database().em.fork().transactional(async (em) => {
      const rows = <T>(sql: string) => em.getConnection().execute<T[]>(sql, [], "all", em.getTransactionContext());
      const [counts] = await rows<Record<string, number>>(`select
        (select count(*)::int from wallets) as wallets,
        (select count(*)::int from wager_transactions) as transactions,
        (select count(*)::int from wallet_ledger) as ledger,
        (select count(*)::int from accounting_journal) as journal,
        (select count(*)::int from accounting_postings) as postings,
        (select count(*)::int from inbox_messages) as inbox,
        (select count(*)::int from outbox_messages) as outbox,
        (select count(*)::int from outbox_messages where published_at is null) as "pendingOutbox"`);
      const balances = await rows<{ walletId: string; balance: string; ledger: string; accounting: string; consistent: boolean }>(`
        with ledger_totals as (
          select wallet_id, sum(case when direction = 'CREDIT' then amount else -amount end) as total
          from wallet_ledger group by wallet_id
        ), posting_totals as (
          select account_id, sum(case when direction = 'CREDIT' then amount else -amount end) as total
          from accounting_postings group by account_id
        ) select w.id as "walletId", w.balance::text as balance,
          coalesce(l.total, 0.00)::text as ledger, coalesce(p.total, 0.00)::text as accounting,
          w.balance = coalesce(l.total, 0) and w.balance = coalesce(p.total, 0) as consistent
        from wallets w left join ledger_totals l on l.wallet_id = w.id
        left join posting_totals p on p.account_id = 'wallet:' || w.id::text order by w.created_at, w.id`);
      const currencies = await rows<{ currency: string; debit: string; credit: string; consistent: boolean }>(`
        select currency, coalesce(sum(amount) filter (where direction = 'DEBIT'), 0.00)::text as debit,
          coalesce(sum(amount) filter (where direction = 'CREDIT'), 0.00)::text as credit,
          sum(case when direction = 'CREDIT' then amount else -amount end) = 0 as consistent
        from accounting_postings group by currency order by currency`);
      const statuses = await rows<{ status: string; count: number }>("select status, count(*)::int as count from wager_transactions group by status order by status");
      const inbox = await rows<Record<string, unknown>>("select consumer_name, message_id, transaction_id, processed_at from inbox_messages order by received_at desc limit 20");
      const outbox = await rows<Record<string, unknown>>("select id, event_type, attempts, next_attempt_at, published_at from outbox_messages order by occurred_at desc, id desc limit 20");
      return { consistent: balances.every((wallet) => wallet.consistent) && currencies.every((currency) => currency.consistent)
        && counts?.ledger === counts?.journal && counts?.postings === 2 * (counts?.journal ?? -1),
        counts, wallets: balances, currencies, statuses, inbox, outbox,
        note: "One consistent PostgreSQL snapshot. Amounts are exact decimal strings; this audit does not modify data." };
    }, { isolationLevel: IsolationLevel.REPEATABLE_READ });
  }
}
