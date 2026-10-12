# Architecture and decisions

## Scope and acceptance contract

The original [README](README.md) remains unchanged and is the acceptance contract.
This document records decisions and limitations, not replacements for its requirements.
See [SETUP.md](SETUP.md) for commands and measured validation results.

Increment 1 introduced the project setup and immutable Money value object.
Increment 2 introduced wallet opening and wallet/ledger reads through HTTP, backed
by PostgreSQL. Increment 3 added idempotent HTTP BET and transaction reads.
Increment 4 publishes the transactional outbox to MiniStack SQS. Increment 5 consumes
BET requests from SQS through the same financial workflow as HTTP, with a transactional
inbox, bounded input retries and a DLQ. Increment 6 adds unreferenced WIN credits and
zero-amount LOSS results to that shared workflow. Increment 7 adds referenced WIN and
durable pending-reference recovery. Increment 8 adds full BET refunds, including
duplicate-reversal protection and recovery when the REFUND arrives before its BET.
Increment 9 adds full ROLLBACK reversals of processed BET, WIN and REFUND transactions.
Increments 10–12 add durable FAILED decisions, read-only reconciliation,
correlated operational telemetry, health checks and real network recovery tests.

| Requirement group | Current status |
| --- | --- |
| Bun 1.x, strict TypeScript, NestJS | Implemented; dependencies and runtime pinned |
| Money, Wallet opening/debit/credit invariants, immutable ledger | Implemented and unit tested |
| PostgreSQL, MikroORM, Docker Compose | Implemented; development and isolated test services |
| Versioned, reversible migrations and database constraints | Original financial history through migration 008; migration 202610120001 adds balanced accounting and a lossless downgrade |
| POST wallet, GET wallet, cursor-based ledger reads | Implemented |
| Atomic wallet, transaction, ledger and outbox | Implemented for positive openings, BET, WIN, REFUND and ROLLBACK; LOSS/rejections persist their transaction and one event without a ledger entry |
| Persistent duplicate protection across application processes | Implemented for opening, BET, WIN, LOSS, REFUND and ROLLBACK |
| Idempotent HTTP wagers and persisted original response | BET, WIN, LOSS, REFUND and ROLLBACK implemented; pending wagers replay their latest decision, while terminal results remain immutable |
| Transaction reads by internal/provider identity | Implemented for OPENING/BET/WIN/LOSS/REFUND/ROLLBACK |
| WIN references, REFUND, ROLLBACK | Implemented; reversals require the full referenced amount and uniqueness per reversal kind |
| MiniStack/SQS | Event output and BET/WIN/LOSS/REFUND/ROLLBACK input implemented, using separate development/test containers |
| Shared HTTP/SQS financial use case, inbox, ack after commit | Implemented for BET/WIN/LOSS/REFUND/ROLLBACK; inbox and financial records share the SQL transaction |
| Concurrent outbox publishers, publish after financial commit | Implemented with SKIP LOCKED and persisted publication state |
| Retry/backoff, DLQ, pending references and worker recovery | Implemented, including durable FAILED decisions for known permanent SQL failures; unavailable/ambiguous outcomes remain retryable |
| Reconciliation endpoint, metrics, correlated logs, health endpoints | Implemented; exact read-only reconciliation, bounded-label metrics, sanitized JSON logs and dependency readiness |
| Three-process financial concurrency/recovery tests | Opening, BET/WIN/LOSS/REFUND/ROLLBACK, concurrent publishers and SQS input tested; native SIGTERM verified in Linux; measured results and platform limits are recorded in SETUP.md |

Authentication implementation, double-entry bookkeeping, OpenTelemetry, dashboards
and load testing are optional in the README. After the mandatory increments, the
candidate requested external authentication, tracing, a local dashboard, a load
experiment and an interactive presentation UI. The candidate then explicitly approved
double-entry bookkeeping, using one account per wallet and shared counterparty
accounts per currency. These additions are described below; they preserve the original
financial behavior. Custom authentication, Redis, Kubernetes and event sourcing remain excluded.

## Optional double-entry bookkeeping

Each financial movement now creates an immutable `AccountingTransfer` in the same
transaction as the wallet, wager, wallet ledger, inbox completion (for SQS), and outbox.
HTTP, SQS and pending-reference recovery retain the same application workflow.
Publishing and acknowledgment still happen only after their existing commit boundaries.
There are no new event types or changed replay responses.

| Account | Meaning | Scope |
| --- | --- | --- |
| `wallet:<walletId>` (`WALLET_LIABILITY`) | Amount owed to one player; credits increase that obligation | One per wallet, including zero-balance openings |
| `house:BRL` (`HOUSE_SETTLEMENT`) | Counterparty of bets, wins and reversals | One logical account per enabled currency |
| `opening-clearing:BRL` (`OPENING_CLEARING`) | Counterparty of the challenge's synthetic initial funding | One per enabled currency |

The house account is not another player wallet. It has no mutable balance row,
spending limit or per-operation update. Journal inserts reference it without taking
a shared exclusive lock, so independent wallets still process concurrently. Its net
position may be negative after winnings; it represents settlement, not cash,
liquidity or audited profit. A real deposit/withdrawal and treasury model is outside
this challenge. Separate house accounts per player would add no required behavior;
each transfer already identifies its player-side account and transaction.

| Movement | Debit | Credit |
| --- | --- | --- |
| Positive OPENING | Opening clearing | Wallet liability |
| BET | Wallet liability | House settlement |
| WIN / REFUND | House settlement | Wallet liability |
| ROLLBACK | Inverse of the referenced BET, WIN or REFUND | Corresponding opposite account |
| Zero opening, LOSS, pending, rejected or failed wager | No transfer | No transfer |

`accounting_journal` stores the two account IDs and **one shared exact amount** in
one row, keyed by the existing ledger entry ID. This deliberately supports only the
two-leg movements required here: unequal amounts or a missing leg cannot be represented.
The read-only `accounting_postings` view expands that row into a debit and a credit.
An arbitrary multi-posting journal engine would introduce rules this project does not need.

Database guards require the amount, currency, transaction, timestamp and account
direction to match the immutable wallet ledger. Foreign keys bind account currencies.
Reciprocal, initially deferred foreign keys require an account for every wallet and
a journal transfer for every ledger entry **at commit**. The journal's primary key
prevents duplicate pairs. Statement triggers forbid UPDATE, DELETE and TRUNCATE of
accounts and journal rows. Existing wallet non-negative and ledger arithmetic guards
remain in force. Database administrators can still disable guards; this is not a
tamper-proof storage system.

`GET /wallets/:walletId/journal` is operator-only and uses the ledger's limit (1–100),
ordering and wallet-bound opaque cursor. Each item exposes a decimal-string `money`,
`debitAccountId`, `creditAccountId`, ledger/transaction IDs and original timestamp.
The shared amount applies to both legs. Existing wallet reconciliation retains its
documented stored-balance versus ledger comparison. Integration audits additionally
check that wallet accounting credits minus debits equal both balances, and that
global debits equal credits per currency. No automatic balance repair is introduced.

Migration `Migration202610120001` is the ninth migration. It leaves migrations
001–008 unchanged and backfills every existing wallet and movement while preserving
their original IDs, amounts and timestamps. Its downgrade locks the source and
accounting tables and compares both directions of the deterministic reconstruction.
It refuses differences; otherwise it removes only the reconstructible accounting
extension. Reapplying restores exactly the same accounting rows without changing
financial, inbox or outbox history. Stop all old application instances before upgrading:
their writes cannot satisfy the new deferred constraints. Database reset is unnecessary.

## Money and exact persistence

`Money` has a private constructor, static factories, a private Decimal value and a
frozen instance. Arithmetic returns new instances. Domain classes have no NestJS
decorators, ORM types or transport imports. Returned DTOs and dates cannot mutate
the original domain state.

| Ambiguity | Decision and reason |
| --- | --- |
| Fixed scale versus rejection of excess precision | Require exactly two places: `"1.00"` is valid; `"1"`, `"1.0"`, `"1.000"` and `"1.005"` are invalid. Never round input. |
| Canonical syntax | Reject whitespace, leading zeroes, plus signs, exponents, separators, hexadecimal notation and numeric JavaScript values. |
| Negative input versus internal calculations | `Money.from()` rejects negatives, including `"-0.00"`. Subtraction and negation can produce signed internal results. Wallet opening separately rejects a negative balance; reconciliation uses exact SQL aggregates, including signed diagnostic differences. |
| Negative zero | Serialize every zero as `"0.00"`; zero is neither positive nor negative. |
| Maximum amount unspecified | Bound absolute magnitude at `999999999999999999.99`, matching PostgreSQL `numeric(20,2)`. Reject input and arithmetic overflow. This is an implementation limit. |
| Decimal configuration | Use a private `Decimal.clone({ defaults: true, precision: 21 })`. The extra digit preserves a carry before range checking; other Decimal users cannot change this configuration. |
| One enabled currency, currency-aware model | Money accepts a three-uppercase-letter code and rejects mixed-currency operations, including equality. Operational validation and the database enable only BRL. Tests also exercise USD conflicts. |
| ISO currency catalogue | Money validates syntax rather than a complete ISO catalogue. All values use two decimal places; other currencies and currency-specific scales are not enabled. |
| `toString()` | Return only the fixed-scale amount. `toJSON()` returns `{ amount, currency }`. |
| Rehydration | Aggregate and ledger `rehydrate` factories reconstruct persisted state without replaying transitions. The adapter reconstructs Money from exact amount strings and currency. |

`MoneyError` codes are `INVALID_MONEY_AMOUNT`, `INVALID_MONEY_CURRENCY`,
`MONEY_CURRENCY_MISMATCH` and `MONEY_OUT_OF_RANGE`. HTTP maps these to invalid input.

Persistence uses separate `EntitySchema` records, amount strings and `numeric(20,2)`
columns. `ExactDecimalType` explicitly selects string hydration and overrides
MikroORM 6.6.17's decimal comparison: the default comparison converts to JavaScript
numbers internally. Exact equality of canonical strings prevents a one-cent change
at a large balance from disappearing during dirty checking. An integration test
persists `.99` to `.98` at the supported maximum magnitude, then rolls that diagnostic
transaction back. A separate HTTP BET test debits one cent at that magnitude and
checks the committed wallet against its ledger. Monetary values never pass through
JavaScript `number` in our mapping.
PostgreSQL numeric coercion is not a substitute for rejecting fractional cents at input.

## Responsibilities and transaction boundary

- **Domain:** `Wallet`, `OpeningTransaction`, `WagerTransaction`, `WalletLedgerEntry`
  and integration event classes encapsulate financial invariants. Private constructors and factories
  keep creation explicit; ledger entries and event snapshots are immutable.
- **Application:** `OpenWallet` validates input, creates the opening state and calls
  `WalletStore.saveOpening`. `ProcessWager` handles validation, idempotency decisions,
  debit/credit/no-movement decisions, reference resolution and events inside
  `WageringStore.transaction`. Its unit of work exposes reads, a wallet lock, a due
  reference claim and atomic decision persistence without ORM types.
  `ReadWallet` and `ReadWager` handle read responses and pagination. `ConsumeWager`
  validates the message envelope, calls `ProcessWager`, and settles its broker delivery.
- **Infrastructure:** the PostgreSQL adapter maps records and owns the SQL transaction.
  HTTP controllers call application workflows and serialize responses. The SQS adapter
  owns receive, visibility changes, send-to-DLQ and delete calls. Both transports use
  the same financial validation functions and `ProcessWager` instance.

Positive opening writes, in order, the wallet, its accounting account, internal
transaction, ledger entry, balanced accounting transfer and two outbox records inside
one forked `EntityManager.transactional()` callback.
Explicit sequential flushes respect foreign keys between scalar persistence records;
flush does not commit the surrounding transaction. Any failure rolls everything back,
including a failure on the last outbox insert. The HTTP success response follows commit.
Each operation uses a fresh EntityManager; the global identity map is not used.

Source code remains under `src/`, grouped by responsibility: `domain/`,
`application/`, `http/` and `infrastructure/database/`. Nest modules wire these
objects together. Unit tests live beside the code they exercise (`*.test.ts`);
real database/process tests and their shared startup helper live under
`tests/integration/`. `scripts/` contains the isolated integration runner.
This small application does not need an extra repository hierarchy per entity.
`tests/fixtures/` contains processes paused at publication and input acknowledgment
boundaries; it is excluded from the production build. Messaging adapters and the
messaging workers are under `src/infrastructure/messaging/`; the SQL-backed reference
worker is `src/infrastructure/reference-worker.ts`.

The start command compiles TypeScript and runs emitted JavaScript with Bun, preserving
NestJS decorator metadata. ORM connections close through NestJS shutdown hooks.
There is no automatic schema synchronization or migration on application startup.

## Opening decisions and database guarantees

| Question | Decision and behavior |
| --- | --- |
| Initial balance greater than zero | Create version `1`, one internal `OPENING` transaction, one `CREDIT` from zero, and two pending outbox events in the same transaction. |
| Initial balance zero | Create version `1` without an opening transaction, ledger entry or event: no balance change occurred. |
| Internal transaction fields | `OpeningTransaction` represents an already-applied internal opening. It has no fabricated provider, game or round. Its original result balance equals its opening amount; the read adapter supports existing records without a new result column value. |
| Duplicate creation | The unique `(player_id, currency)` constraint returns HTTP 409, whether the repeated amount matches or differs. The opening key `opening:{walletId}` and one-opening-per-wallet uniqueness persist in PostgreSQL. |
| Idempotency header on wallet creation | The README defines header-based replay for wagering, not wallet creation. `POST /wallets` does not promise replay or accept a special opening idempotency contract; repeat requests conflict without duplicating credit. |
| Concurrent opening | A unique index arbitrates competing inserts across processes. There is no existing wallet row to lock, so `SELECT FOR UPDATE` is unnecessary here. BET takes a pessimistic row lock per wallet. |
| Required events for opening | Persist `WagerTransactionProcessed` and `WalletBalanceChanged`, each as a concrete subclass of the abstract event envelope. They share a correlation ID and use the opening transaction as causation ID. |

The migration enforces non-negative finite wallet balances, positive versions,
positive financial amounts, BRL, unique player/currency and opening/idempotency
identities. Numeric upper bounds reject PostgreSQL `NaN` as well as out-of-range
values. Composite foreign keys bind transaction player/currency to the wallet and
ledger wallet/currency/amount to its transaction. Ledger checks enforce balanced
arithmetic and non-negative before/after balances. A transaction has at most one
ledger entry per wallet.

Statement triggers reject ledger `UPDATE`, `DELETE` and `TRUNCATE`, including ordinary
SQL executed as the table owner. Outbox checks require the serialized envelope and
matching event identity, aggregate and type. The event ID has database uniqueness.
These constraints complement the application transaction; they do not recompute the
entire ledger or prevent a database administrator from disabling protections.
The local Compose account also runs migrations. Separate restricted runtime and
migration database roles are a future deployment hardening step.

`Migration202610100001` is versioned, transactional and reversible. Its down migration
drops the opening schema and its data, including trigger functions. Down is tested
only on the isolated disposable test database. Future changes must add new reversible
migrations; no destructive startup reset is used for development.

## Wager idempotency and concurrency decisions

`ProcessWager.execute(body, idempotencyKey, delivery?)` is transport-independent. HTTP
calls it without delivery metadata. `ConsumeWager` supplies the SQS message identity
and correlation context, enabling inbox persistence in the same SQL transaction.

The workflow validates input, checks existing transaction identities, locks the
wallet with `LockMode.PESSIMISTIC_WRITE`, and checks identities again after acquiring
the lock. Explicit `READ COMMITTED` isolation lets that second check see a request
committed while this request waited. Under the lock, `Wallet.debit` or `Wallet.credit`
returns a new wallet and its balanced ledger entry; LOSS preserves the wallet.
Insufficient funds or credit overflow transitions the transaction to `REJECTED`;
success transitions it to `PROCESSED`. A missing WIN, REFUND or ROLLBACK reference transitions it to
`PENDING_REFERENCE`. The adapter saves the decision, optional wallet/ledger changes,
and required outbox events together.
The response is returned only after commit.

Different wallets do not share a lock. Global idempotency-key and provider/external-ID
unique indexes arbitrate collisions between them. On an identity constraint violation,
the SQL transaction rolls back before the application opens a fresh transaction to
resolve replay/conflict. That fresh transaction also completes the inbox for an SQS
replay. No in-memory cache, process-local mutex or global wallet lock is used.
The identity reads also handle a winner becoming visible between the key lookup and
the external-ID lookup; the latter can represent the same key and must be replayed.

| Ambiguity | Decision and reason |
| --- | --- |
| BET of zero | Reject as invalid input (400); an implemented BET always represents a positive debit. |
| Accepted kinds | BET, WIN, LOSS, REFUND and ROLLBACK. WIN accepts an optional `referenceExternalTransactionId`; REFUND and ROLLBACK require it. OPENING remains internal. |
| Business identifiers | Provider, external transaction, round and game IDs are case-sensitive, 1–255 printable ASCII characters, without whitespace. Player/wallet UUIDs normalize to lowercase. This is a documented input restriction. |
| Idempotency scope | The required header is globally unique, case-sensitive, and uses the same syntax/length restriction. Reserve the `opening:` prefix for internal transactions. Do not synthesize a missing header. |
| Same key and same business payload | Return the stored transaction ID, status, balance and failure code, with `idempotentReplay: true`; never read the current wallet balance for the replay. Pending WIN/REFUND/ROLLBACK reflects its latest persisted decision; terminal results never change. |
| Same key and different payload | Return 409 `IDEMPOTENCY_CONFLICT`; do not save a second decision or event. |
| Same provider/external ID under a different key | Return 409 `EXTERNAL_TRANSACTION_CONFLICT`, even if the remaining payload matches. This prevents changing the header to charge twice. Distinct providers may reuse an external ID. |
| Unknown wallet or wrong wallet owner | Unknown wallet returns 404; mismatched player/currency returns 400. These are invalid preconditions, not accepted financial decisions, and save no transaction. The composite wallet/player/currency FK remains intact. |
| Insufficient funds | Persist terminal `REJECTED`, `failureCode: INSUFFICIENT_FUNDS`, original observed balance and one `WagerTransactionRejected` outbox event. Return 422. No ledger, wallet balance or version change. The rejected result is idempotent too. |
| Successful BET | Persist terminal `PROCESSED`, original resulting balance, one DEBIT, and `WagerTransactionProcessed` plus `WalletBalanceChanged` outbox events. Increment wallet version once and return 200. |
| Pending state | A new domain wager starts PENDING in memory. It is persisted as PROCESSED, REJECTED, FAILED, or PENDING_REFERENCE for an absent WIN/REFUND/ROLLBACK reference. The reference worker may reschedule or resolve that pending decision; terminal states cannot transition. |
| Infrastructure failure | Roll back the attempt. Known permanent SQL failures can become durable FAILED decisions in a new transaction; transient or ambiguous outcomes remain retryable. A lost commit response is resolved by persisted idempotency. See the failure policy below. |

Payload hashing uses SHA-256 over UTF-8 JSON with keys sorted lexicographically at
every object level. The exact subset is `providerId`, `externalTransactionId`,
`playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (amount and currency), and
`referenceExternalTransactionId` when supplied. Omitting the reference preserves
the existing hashes for unreferenced operations.
Hashing follows validation/UUID normalization; amounts remain canonical decimal
strings. The header, correlation IDs and other transport metadata are excluded.
Unknown fields are rejected, rather than silently excluded. Tests include a fixed
canonical JSON/hash fixture and differently ordered nested keys.

`Migration202610100002` extends the schema without editing migration 001. BET metadata,
result balance and final status/failure/timestamp combinations have database checks.
The ledger FK includes transaction status so rejected transactions cannot receive
entries. A trigger binds direction to kind, and triggers reject terminal transaction
updates, deletes and truncation. One-opening-per-wallet becomes a partial unique index.

Migration 002's `down()` takes an exclusive lock and refuses to proceed if BET history
exists: the older schema cannot represent those records. Before accepting BETs, down/up
is reversible and preserves all openings. After accepting BETs, keeping financial
history requires retaining this schema and using a forward migration. This restriction
is deliberate; unconditional downgrade with BET data is not supported. Tests verify
both the opening-only round trip and refusal without data changes. The disposable test
database is reset explicitly by a guarded test helper, never by application startup.

## WIN and LOSS decisions

Both operations reuse the existing transaction, wallet lock, idempotency and inbox
workflow. Identity uniqueness spans all external kinds: changing BET to WIN under
the same key is a payload conflict, and changing only its key does not bypass the
provider/external-ID constraint. Existing BET payload hashes and event envelopes
remain unchanged. There is no new endpoint or separate credit processor.

| Ambiguity | Decision and behavior |
| --- | --- |
| WIN amount | Require a positive decimal amount. A processed WIN creates one CREDIT and two events: WagerTransactionProcessed and WalletBalanceChanged. Balance and version increase once. Zero WIN is invalid input; a no-payout result uses LOSS. |
| LOSS amount | Require `0.00`, since LOSS has no financial effect. It still validates wallet ownership, currency and identifiers. A nonzero amount is rejected instead of being silently ignored. |
| LOSS persistence | Save terminal PROCESSED, timestamp, original balance and one WagerTransactionProcessed event. Do not write a ledger entry, update wallet timestamps, change version or emit WalletBalanceChanged. |
| WIN credit overflow | A valid amount may exceed the wallet limit when added to its balance. Persist terminal REJECTED with BALANCE_LIMIT_EXCEEDED, original balance and one rejection event; HTTP returns 422 and SQS acknowledges after commit. Replays remain rejected even if a later debit makes room. |
| Optional WIN reference | A supplied reference must resolve to a matching processed BET. An absent reference is persisted for retry; a present but invalid reference causes a persisted rejection. Unreferenced WIN remains valid. See the reference decisions below. |
| Round closure and payout count | The README does not prescribe one WIN/LOSS per round or disallow both. Distinct business identities may record multiple results in the same round; identity uniqueness, not a fabricated round-finalization rule, controls replay. |
| LOSS concurrency | Take the same wallet row lock even without a balance update, so its stored original balance describes a serialized point relative to concurrent credits/debits. |

`WagerTransaction.kind` is explicit. Event factories use `wager` for BET/WIN/LOSS/REFUND/ROLLBACK
and retain `opening` for the internal opening. A processed status no longer implies
that a ledger entry exists: LOSS is successful with no movement. Domain guards bind
each event to the matching transaction, wallet, direction and amount.

`Migration202610100004` extends the kind, amount, status, metadata and rejection-code
checks; provider/external uniqueness now includes all three external kinds. LOSS must
be zero and processed; a trigger rejects any LOSS ledger entry or incorrect WIN/BET
direction. Positive ledger amounts, exact numeric storage, status-aware foreign keys
and terminal immutability remain in force. Its down migration locks transactions and
refuses any WIN/LOSS history; otherwise it restores the previous schema while preserving
OPENING, BET and inbox records. No earlier migration was edited.

## WIN references and durable pending work

References resolve by `(providerId, referenceExternalTransactionId)`, never by a
global external ID. A valid reference is a PROCESSED BET belonging to the same
provider, player, wallet, currency and round. The README requires these matches;
it does not require equal game IDs or amounts for WIN. A payout can therefore
exceed its BET amount, subject to the wallet's numeric limit. Supplying a reference
for BET/LOSS, a malformed reference, or a self-reference is invalid input (400).
For a found reference, rejection precedence is identity mismatch, then kind mismatch,
then non-processed status, so the same persisted input has one stable failure code.

| Situation or ambiguity | Decision and behavior |
| --- | --- |
| Matching processed BET exists | Apply the WIN immediately and save the resolved internal transaction ID with its credit, result and events. |
| No reference exists for this provider | Save PENDING_REFERENCE, its original accepted balance, retry schedule, correlation and one WagerTransactionPendingReference event. Return HTTP 202 without changing the wallet or ledger. An external ID belonging only to another provider remains absent in this lookup. |
| Existing reference has a different player, wallet, currency or round | Persist REJECTED with REFERENCE_MISMATCH; no credit or ledger. |
| Matching identity belongs to a kind other than BET | Persist REJECTED with REFERENCE_KIND_MISMATCH. |
| Matching BET is not PROCESSED | Persist REJECTED with REFERENCE_NOT_PROCESSED. Do not wait for a terminal rejected BET to change. |
| Reference is still missing at the retry limit | Persist REJECTED with REFERENCE_NOT_FOUND and one rejection event. A later BET cannot revive that terminal result. |
| Valid reference but credit exceeds the balance limit | Persist REJECTED with BALANCE_LIMIT_EXCEEDED. A resolved ID is required for successful referenced WIN; this rejection retains the external reference without a credited internal reference. |
| Repeating a pending request | Return the latest persisted decision with idempotentReplay true. While pending, return its original acceptance balance and do not advance attempts or enqueue another pending event. Once resolved, return its immutable terminal result. |

The initial missing lookup is not a retry. Ten subsequent missing checks are allowed,
with persisted waits of **1, 2, 4, 8, 16, 32, 60, 60, 60 and 60 seconds**: approximately
303 seconds before rejection in a healthy, uncongested system. Scheduling and
outages can make this longer; it is a bounded missing-check count, not a wall-clock
deadline. Each worker claim checks for the reference before consuming an attempt,
so a valid BET visible on the tenth check can still succeed. Infrastructure errors
roll back the claim and attempt count; they do not count as a missing reference.

`ProcessWager.reprocessNext()` uses the same financial decision method as initial
HTTP/SQS processing. The PostgreSQL claim first locks one eligible wallet with
`FOR UPDATE OF w SKIP LOCKED`, then locks and rechecks one due pending transaction.
Wallet-first ordering matches initial processing, avoids reversing the lock order,
and lets other workers skip a busy wallet. The worker never holds a global lock.
Retry count, next attempt, final decision, wallet/ledger changes and outbox events
remain inside one SQL transaction. Failed work rolls back; process death releases
its locks so another application process can claim it after restart.

`ReferenceWorker` runs in the Nest application and polls idle/failed cycles every
250 ms. It is enabled by default (`REFERENCE_WORKER_ENABLED=true`); `false` disables
polling. It logs completed checks only after commit, with transaction, wallet,
provider and the original correlation ID, without monetary payloads. Shutdown
awaits active work before the database connection is closed. The existing native
Windows SIGTERM limitation still applies; graceful Nest closure is tested separately.

Only the initial acceptance emits WagerTransactionPendingReference. A missing-check
reschedule emits no event. Successful resolution emits WagerTransactionProcessed
and WalletBalanceChanged atomically with one credit; rejection emits only
WagerTransactionRejected. The initial correlation ID is retained across restarts.
Output delivery order is not guaranteed; consumers must use transaction/event
identity and deduplicate events rather than assume broker ordering.

`Migration202610100005` adds the external/resolved reference, attempt counter, next
attempt and processing correlation columns. Constraints bind status, timestamps,
failure codes, counters and reference shape. A self foreign key and a trigger verify
that a resolved reference is a processed BET with the required matching identity.
Pending identity and correlation cannot change or be deleted; rescheduling must
increment the counter once, move the retry date forward and preserve acceptance
balance. Terminal records remain immutable. A partial due index supports worker
claims. The downgrade locks the table and refuses any reference history; otherwise
it restores migration 004's behavior while preserving unreferenced financial and
inbox records. Earlier migrations remain unchanged. Use a forward migration once
reference history has been accepted.

## Full BET refunds

REFUND requires `referenceExternalTransactionId` and a positive amount. An omitted
reference field, malformed identifier or self-reference is invalid input (400),
with no persisted decision.
A valid reference is a processed BET with the same provider, player, wallet,
currency and round. The refund amount must equal the BET amount exactly through
`Money.equals`; partial or excessive refunds are rejected. The README does not
require equal game IDs, so a different game ID is permitted.

For a found reference, rejection precedence is identity, kind, status, amount,
already-refunded status, then credit overflow. The first applicable failure wins:
`REFERENCE_MISMATCH`, `REFERENCE_KIND_MISMATCH`, `REFERENCE_NOT_PROCESSED`,
`REFERENCE_AMOUNT_MISMATCH`, `REFERENCE_ALREADY_REFUNDED`, or
`BALANCE_LIMIT_EXCEEDED`. Each becomes a terminal, replayable REJECTED decision
with its observed balance and one rejection event, without a wallet or ledger change.

While holding the wallet row lock, `ProcessWager` checks for an existing processed
refund through `hasProcessedReversal("REFUND", referenceTransactionId)`. Distinct requests
against the same BET serialize under that lock. PostgreSQL independently enforces
one processed REFUND per resolved BET with the partial unique index
`wager_transactions_refund_reference_unique`; changing the idempotency key or external
transaction ID cannot create another refund credit. A successful refund creates
its own transaction, one CREDIT and two outbox events atomically. The original BET
and its DEBIT remain unchanged.

Repeating the same successful request returns its original immutable result, even
after later wallet movements. A different refund identity for the already-refunded
BET receives HTTP 422 with `REFERENCE_ALREADY_REFUNDED`. Rejected and pending refunds
do not consume eligibility: only a processed refund does. This does not revive a
rejected request; correcting its payload requires a new external ID and idempotency
key. ROLLBACK has independent eligibility, as described below.

An absent BET reuses the WIN pending-reference workflow: initial HTTP 202, one
pending event, no financial effect, ten persisted missing checks and the same
backoff schedule. The shared SQL worker can later process or reject the refund.
SQS acknowledges after the pending decision, schedule, inbox and event commit,
so the BET can arrive later in the same FIFO wallet group. Refund eligibility is
checked again during resolution under the wallet lock. Infrastructure failures
roll back all decision records and do not consume a missing-reference attempt.

`Migration202610100006` extends the existing kind, amount, status, result, metadata,
reference and provider/external-identity constraints. A processed refund requires
its resolved reference; the reference trigger also checks exact numeric equality
with the BET, and the ledger trigger requires CREDIT. Existing immutable ledger,
terminal-state and pending-transition protections remain in force. The downgrade
takes an exclusive table lock and refuses any REFUND history, including pending or
rejected requests. Without REFUND history it restores migration 005's schema while
preserving referenced WIN, financial records and inbox history. Earlier migrations
are unchanged; accepted refund history requires a forward migration.

## Full transaction rollbacks

ROLLBACK requires a positive amount and `referenceExternalTransactionId`. It resolves
that external ID within the supplied provider, then requires the same player, wallet,
currency and round. The reference must be a PROCESSED BET, WIN or REFUND, and its
amount must equal the rollback's amount exactly through `Money.equals`. Game IDs
may differ; partial reversals are unsupported. OPENING, LOSS and ROLLBACK references
are rejected. Input validation and financial processing remain shared by HTTP and SQS.

| Reference | Financial result of one successful ROLLBACK |
| --- | --- |
| BET | CREDIT for its full amount, reversing the original debit |
| WIN | DEBIT for its full amount, reversing the original credit |
| REFUND | DEBIT for its full amount, reversing the refund credit |

The domain's `ledgerDirectionFor(reference)` determines this inverse direction.
Event factories receive the same reference context and validate the resulting
ledger entry. The original transaction and ledger remain immutable; a successful
rollback creates a separate transaction, one ledger entry and the two required
outbox events, with one wallet version increment in the same SQL transaction.

For an existing reference, rejection precedence is identity, kind, status, amount,
already-rolled-back status, then the balance rule. Existing reference failure codes
are reused. `REFERENCE_ALREADY_ROLLED_BACK` identifies a distinct request against a
reference that already has a processed ROLLBACK. `REVERSAL_INSUFFICIENT_FUNDS`
identifies a debit reversal that would make the wallet negative; it is distinct
from a BET's `INSUFFICIENT_FUNDS`. A credit reversal exceeding the numeric limit
uses `BALANCE_LIMIT_EXCEEDED`. Each rejection saves its original observed balance
and one rejection event without changing the wallet, version or ledger.

| Ambiguity | Decision and reason |
| --- | --- |
| Missing reference versus an existing pending reference | Only an absent reference enters PENDING_REFERENCE and the existing ten-check schedule. An existing WIN/REFUND that is still pending receives terminal REFERENCE_NOT_PROCESSED. The README requires a processed reference and explicitly defers absent references. |
| Reference later becomes processed or funds become available | An earlier REJECTED rollback remains terminal and replays its original result. A new attempt under corrected conditions needs both a new external transaction ID and idempotency key. |
| REFUND and ROLLBACK targeting the same BET | The README defines uniqueness per operation type. One REFUND and one ROLLBACK may independently target that BET, resulting in two distinct credits. No cross-kind prohibition is inferred. |
| ROLLBACK of a REFUND | The rollback debits the refund amount but does not free that BET's refund eligibility. The earlier processed REFUND stays immutable and continues to occupy its unique refund slot. |
| Rejected or pending ROLLBACK | Neither reserves successful reversal eligibility. Only PROCESSED ROLLBACK records count, without reviving any rejected request. |

Under the matching wallet's row lock, `hasProcessedReversal("ROLLBACK", referenceId)`
checks prior successful reversals. Separate partial unique indexes enforce one
processed REFUND and one processed ROLLBACK per reference in PostgreSQL. Requests
with different identities and workers recovering pending requests use that same
wallet lock and decision path. A repeated identical request instead replays its
stored result, including its original balance after later wallet movements.

Missing references reuse durable pending acceptance, backoff, expiry and recovery.
SQS acknowledges after the pending transaction, inbox, schedule and event commit;
the SQL reference worker later applies or rejects the operation. Infrastructure
failures roll back the whole decision and do not consume missing-reference attempts.

`Migration202610100007` extends kind, amount, status, rejection, metadata, reference
and provider/external-identity constraints. Its reference trigger validates processed
BET/WIN/REFUND identity and exact numeric amount. The ledger direction trigger joins
the reference and requires CREDIT for BET reversal or DEBIT for WIN/REFUND reversal.
The new `wager_transactions_rollback_reference_unique` index leaves the REFUND index
intact. Existing non-negative balances, immutable records, pending transitions and
status-aware ledger foreign keys remain in force. The downgrade locks transactions
and refuses any ROLLBACK history, including pending and rejected decisions. Otherwise
it restores migration 006 while preserving REFUND, referenced WIN and inbox/outbox
history. Earlier migrations remain unchanged.

## SQS input, inbox and acknowledgment

The input queue is `wager-transactions.fifo`; its DLQ is
`wager-transactions-dlq.fifo`. Both use explicit deduplication IDs rather than
content-based deduplication. Input retention is four days, DLQ retention is fourteen
days, and the broker redrive policy has `maxReceiveCount: 5`. Queue setup is repeatable.
FIFO ordering and its temporary deduplication window are broker optimizations;
PostgreSQL remains responsible for persistent financial correctness.

`sqsWagerInput` validates the envelope fields `messageId`, `type`, `occurredAt` and
`data`, rejecting unknown fields. Type must be `WagerTransactionRequested`;
`occurredAt` must be a canonical ISO UTC timestamp with milliseconds. Message IDs use
the same 1–255 printable ASCII restriction as business identifiers. `data.idempotencyKey`
is required, follows the HTTP header rules, and is extracted before passing the
business body to `ProcessWager`. `MessageGroupId` must equal the lowercase canonical
wallet UUID. An uppercase UUID in the business body still normalizes normally, but
the broker group must already be canonical. Money, provider and remaining business
validation are shared with HTTP; BET, WIN with or without a reference, LOSS, and
REFUND/ROLLBACK with a required reference are supported. OPENING remains invalid.

The consumer name is `wager-transactions`. Its inbox key is
`(consumer_name, message_id)`, using the envelope identity rather than SQS's broker ID.
The business `payloadHash` is unchanged from HTTP. The separate inbox hash is
SHA-256 over UTF-8 `JSON.stringify({ idempotencyKey, payloadHash })`, with that fixed
property order. Binding the key too prevents reuse of a message ID with a different
key from bypassing idempotency validation. Occurrence time and broker delivery
metadata do not enter either hash.

The adapter inserts an inbox claim with `ON CONFLICT DO NOTHING` inside the financial
transaction, then locks that inbox row. A concurrent duplicate waits for the first
transaction's commit or rollback. Matching completed rows replay their recorded
transaction; conflicting hashes raise `INBOX_PAYLOAD_CONFLICT`. Otherwise, the usual
wallet lock, decision, ledger and outbox workflow runs. The inbox is marked processed
with its transaction ID before the same SQL transaction commits. An HTTP result can
therefore be replayed through SQS while adding only the new inbox record. No incomplete
inbox claim is committed by the application, and any persistence failure rolls back
both the claim and financial changes.

For a pending WIN, REFUND or ROLLBACK, inbox completion means **durable acceptance**,
not a completed balance movement. The consumer acknowledges after the pending transaction, schedule, inbox
and pending event commit. The independent SQL worker then owns resolution. Keeping
that SQS delivery invisible until its reference arrived would block later messages in the
same FIFO wallet group, potentially including the required reference. Replaying the same
completed envelope reads the referenced transaction's latest persisted decision;
after resolution it returns the final result without another financial effect.

`Migration202610100003` adds the inbox without rewriting migrations 001 or 002.
Database constraints enforce the composite identity, hash format, ID lengths,
transaction foreign key, and paired completion timestamp/transaction ID. Triggers
protect identity and received time, reject updates/deletes of completed messages,
and reject truncation. Its down migration locks the table and refuses any inbox
history: deleting that history would remove durable duplicate protection. Empty-table
down/up is reversible and preserves financial records; after use, changes require a
forward migration.

| Outcome | Settlement and recovery |
| --- | --- |
| PROCESSED, any persisted REJECTED result, PENDING_REFERENCE, or matching replay | Delete the source message only after the inbox/decision commit. Pending work is durable in PostgreSQL; a business rejection is completed work. |
| Process dies or delete fails after commit | Leave the broker delivery unacknowledged. Its next delivery replays the committed inbox result without another debit or event. Delete failure is never reclassified as a financial failure. |
| Transient database error | Roll back; use persisted broker `ApproximateReceiveCount` to change visibility to 1, 2, 4 or 8 seconds after receives 1–4. Receive 5 goes to DLQ with `RETRY_EXHAUSTED`. |
| Unknown processing error | Use the same bounded retry policy, logging `INTERNAL_ERROR`; do not expose exception messages or SQL payloads. |
| Invalid envelope, group, business precondition or identity conflict | Send directly to DLQ with a stable failure code; no accepted financial decision is invented for invalid input. |
| Durable FAILED decision, including replay | Commit the unchanged balance, transaction, inbox and failure event before sending to DLQ and deleting the source. |
| DLQ send fails | Do not delete the source. A later delivery can retry the send. |
| DLQ send succeeds but source delete fails | Redelivery may repeat the DLQ send. Stable broker-ID deduplication limits duplicates within the FIFO window; duplicate DLQ entries remain possible. |

Application DLQ sends preserve the original body and attach `FailureCode` and
`OriginalMessageId` message attributes. Send and source deletion cannot form one
transaction, so duplicates are preferred to message loss. Broker redrive also catches
repeated process deaths before settlement; messages moved directly by SQS may lack
the application failure attributes. Known permanent SQL failures have the durable
FAILED path below. If PostgreSQL cannot accept even the failure audit, retries and
eventual broker redrive preserve the original message in the DLQ; a database row
cannot be promised while that database is unavailable.

`SqsWagerWorker` is enabled by default (`SQS_CONSUMER_ENABLED=true`), handles one
delivery at a time per process, and uses one-second long polls. Multiple application
processes can consume concurrently. `SQS_VISIBILITY_TIMEOUT_SECONDS` defaults to 30
and accepts integers from 2 through 43200. A heartbeat renews visibility every third
of that interval while processing; failure is logged and database idempotency still
protects overlapping deliveries. Before ack, retry or DLQ settlement, the worker
stops the heartbeat and waits for any in-flight renewal, preventing a late renewal
from overriding the retry delay. Poll/transport failures are logged and polling resumes.

Nest shutdown stops new receives, returns a delivery received during shutdown with
zero visibility, and waits for active processing/settlement before shared resources
close. Unit lifecycle tests exercise this drain explicitly. Native graceful SIGTERM
was verified with the real PostgreSQL/SQS integration test in a Linux container.
Bun's child-process kill path forces termination in the observed Windows environment,
so the native-signal test remains skipped on Windows. The Linux test holds a wallet
row lock, observes the consumer waiting, sends SIGTERM, releases the lock and verifies
the committed debit, completed inbox and acknowledged message before process exit.
Abrupt crash recovery and graceful context shutdown remain separate checks; measured
results are recorded in SETUP.md.

Input logs include the envelope message ID, correlation, receive count, outcome
and available wallet/provider/transaction identity. They omit the complete message
and monetary payload. HTTP correlation and metrics use the same operational
telemetry described below.

## Permanent infrastructure failures

Only recognized permanent SQL errors create a terminal `FAILED` decision. The
allowlist covers SQLSTATE classes 0A, 22, 23 and 42, plus P0001; connection failures,
unknown driver failures and uncertain commit outcomes remain retryable. The stable
business-facing failure code is `DATABASE_OPERATION_FAILED`; driver text is never
included in responses, events or logs. This is intentionally conservative: an
unknown infrastructure error is not evidence that a financial commit failed.

After the failed SQL transaction rolls back, `ProcessWager` starts a new transaction,
rechecks inbox and business identity, takes the wallet lock and rechecks identity
again. A competing committed decision wins and is replayed. Otherwise it saves the
FAILED transaction, its observed original balance, the completed inbox for SQS and
one `WagerTransactionFailed` outbox event atomically. No balance, wallet version or
ledger change occurs. This additional event distinguishes infrastructure failure
from the README's required business-rejection event. No failed financial event is
published before the audit commits.

A pending-reference worker remembers the claimed transaction ID. After a permanent
failure it locks and rechecks that same pending transaction before saving FAILED;
it must not fail a different pending request or overwrite a concurrent terminal
decision. The missing-reference attempt count is preserved and the schedule cleared.

HTTP returns the terminal transaction result with status 500; its ID, `status:
FAILED`, failure code and original balance remain queryable and idempotent after a
repair. Retrying as a new business operation requires a new external ID and key.
SQS sends a FAILED result to the DLQ only after the audit commit. A failed DLQ send
or source deletion can redeliver safely through the completed inbox.

If saving the failure audit also fails, `FAILURE_AUDIT_UNAVAILABLE` is retryable.
There is no successful acknowledgment or fabricated terminal response. SQS still
has a bounded retry/redrive policy: prolonged outages can leave only the original
DLQ message and operational logs, without a transaction row. An operator may replay
that exact message after repairing the dependency; persistent idempotency protects
already committed effects. Invalid envelopes, missing wallets and conflicting
identities remain transport/precondition errors, not FAILED wagers.

`Migration202610100008` permits FAILED for external wager kinds, requires the failure
code and absent processed timestamp/reference/schedule, and extends terminal
immutability and pending transitions. The status-aware ledger foreign key excludes
FAILED records. Downgrade restores migration 007 only when no FAILED history exists;
it never discards accepted audit records or changes earlier migrations.

## Reconciliation

`POST /wallets/:walletId/reconciliation` compares the materialized balance with the
exact signed sum of ledger credits and debits. Difference means **stored minus
calculated**. The reader acquires the same per-wallet row lock as financial writes,
then calculates the aggregate in a second READ COMMITTED statement. A writer that
committed while reconciliation waited is visible to that second statement, and
another writer cannot move the balance until the check finishes. Other wallets
remain independent; no global lock is introduced.

PostgreSQL performs unconstrained NUMERIC aggregation and subtraction and returns
decimal strings. This also represents signed or unusually large totals caused by
corruption without rounding or forcing them through Money's valid-wallet range.
Only the ledger entry count uses a JavaScript number, with a safe-integer check.
Empty ledgers calculate `0.00`. The endpoint returns 200 for both consistency and
divergence, exposes `consistent`, `difference` and `checkedEntries`, and never writes
financial data. A divergence produces a structured operational log and increments
its metric, without logging monetary amounts.

## Outbox publication and MiniStack

`OutboxMessage` owns delivery state: failed-attempt count, next attempt and publication
time. Its identity, envelope snapshot and occurrence time cannot be mutated through
the public API. `PublishOutbox` coordinates `OutboxStore` and `EventPublisher`;
`PostgresOutboxStore` owns row selection/commit, and `SqsEventPublisher` sends the
unchanged persisted JSON envelope. `OutboxWorker` polls this workflow inside the
same Nest application; it never invokes wallet balance mutations.

Each publisher forks an EntityManager, begins a separate READ COMMITTED transaction,
selects one due unpublished row with `FOR UPDATE SKIP LOCKED`, sends it to SQS, then
marks it published and commits. Financial transactions must already have committed
for their outbox rows to be visible. Other publishers skip a held row and continue.
No lease columns or new migration are needed: process/connection loss releases the
row lock, and a missing publication commit leaves the row pending.

This design holds one outbox row lock and one database connection during network I/O.
It is deliberately small and limits each worker to one in-flight event. It does not
hold a wallet lock; wallets continue to accept wagers while publishing is slow.
The trade-off is lower throughput than batched claims with leases, which are not
needed for this increment. SDK requests have a 1-second connection timeout and a
3-second request timeout, with one SDK attempt. Queue discovery is lazy and cached
after success; the send additionally has a 5-second abort deadline.

| Situation | Behavior |
| --- | --- |
| Financial transaction rolls back | No visible outbox row and no event publication. |
| Application dies after financial commit, before sending | Another publisher selects the persisted event. |
| Send succeeds and publication marker commits | Row remains as audit data and is no longer selected. |
| Process dies after SQS accepts, before publication commit | Retry may send a duplicate, with the same eventId and envelope. This is at-least-once delivery, not exactly-once delivery. |
| SQS refuses or times out | Persist a failed-attempt increment and nextAttemptAt; do not mark published or modify financial records. |
| Publisher database operation fails | Its transaction rolls back; the worker logs a sanitized failure and polls again. There is no committed publication claim to recover manually. |
| Prolonged SQS/configuration failure | Backoff is 1, 2, 4, 8, 16, 32, then 60 seconds per event. Retain and retry confirmed events indefinitely; never drop them at an attempt limit. The bounded input retry/DLQ policy is separate. |
| Multiple publishers | SKIP LOCKED prevents simultaneous sends of the same claimed row during normal processing. Crash recovery and SQS delivery can still duplicate events. |
| Shutdown | Stop polling, wake an idle timer and await the current attempt before Nest closes SQS/database resources. Forced termination relies on row-lock release and replay. |

The output queue is standard SQS `wager-events`, with 14-day retention. The README
does not prescribe an output queue name/type; standard delivery makes the duplicate
contract explicit. Events have no promised per-wallet delivery order. Downstream
consumers must deduplicate by `eventId` persistently and atomically with their own
effects. There is no downstream business consumer in this increment, so that end-to-end
consumer guarantee is not claimed. The input FIFO and its DLQ are separate from this
output queue.

The worker is enabled by default; `OUTBOX_PUBLISHER_ENABLED=false` disables polling.
It drains successful work continuously, polls idle/failed cycles every 250 ms, and
logs publication/retry only after the relevant publisher SQL commit. Logs include
event identity, correlation, transaction, wallet and provider when available, never
the full event or monetary payload. Publication retries also update operational
metrics after that commit, as described in the telemetry section.

MiniStack 1.5.24 uses the upstream Docker image pinned by digest, with only SQS enabled.
The SDK has explicit local test credentials and accepts only loopback HTTP endpoints;
it does not load the candidate's AWS profile. No AWS account, AWS CLI, Redis or Docker
socket mount is needed. Development uses port 4566 and a named state volume; tests use
4567, a separate container and unique disposable queues. `sqs:setup` is idempotent.
MiniStack's persistence is a graceful-shutdown snapshot; this emulator setup does not
establish broker durability after SIGKILL. Publisher-process recovery is tested against
a running broker. Already-published messages lost by a broker reset are not automatically
re-enqueued; this differs from the durability expected of managed SQS.

## HTTP, pagination and authentication

Implemented routes are `POST /wallets`, `GET /wallets/:walletId`,
`GET /wallets/:walletId/ledger`, `GET /wallets/:walletId/journal`, `POST /wagering/transactions`,
`GET /wagering/transactions/:transactionId` and
`GET /providers/:providerId/wagering/transactions/:externalTransactionId`,
`POST /wallets/:walletId/reconciliation`, `GET /health/live`, `GET /health/ready`
and `GET /metrics`.
Inputs reject unknown fields, malformed UUIDs,
unsupported currencies and invalid Money. UUIDs are normalized to lowercase.

| HTTP status | Current meaning |
| --- | --- |
| 201 | Wallet opening committed |
| 200 | Read, reconciliation, healthy probe or metrics scrape succeeded; wager processed/replayed |
| 202 | WIN/REFUND/ROLLBACK accepted with PENDING_REFERENCE, including a replay that is still pending |
| 400 | Invalid payload, UUID, Money, currency, limit or cursor |
| 404 | Wallet or transaction does not exist |
| 401 | Missing or invalid external access token |
| 403 | Authenticated identity lacks the required operator/provider permission |
| 409 | Wallet duplicate, idempotency payload conflict, or provider transaction claimed with another key |
| 422 | Persisted BET/WIN/REFUND/ROLLBACK business rejection: insufficient funds, credit overflow, invalid/expired reference or already-applied reversal, including replay |
| 503 | Transient database failure, failed audit persistence, unavailable identity verification, failed readiness or unavailable metrics; no successful financial operation is claimed |
| 500 | Durable FAILED wager result, permanent non-wager database error, or unexpected application failure (`INTERNAL_ERROR`) |

Errors return stable `{ code, message }` objects. Database errors do not expose SQL,
parameters or financial payloads. Business rejections instead return the transaction
result with `failureCode`, making the audit identity available to the caller. Durable
FAILED responses also use that transaction-result envelope, with HTTP 500.
Operational failures have dedicated bodies: readiness returns dependency states,
and a failed metrics scrape returns `{ code: "METRICS_UNAVAILABLE" }`.
Transaction reads return 200 with their stored status, retry count and next attempt
when applicable; posting a matching request uses 202, 200, 422 or 500 for its current decision.

Ledger pagination orders by `(created_at, id)` ascending, with matching database
index and millisecond timestamp precision. The base64url cursor contains a version,
wallet ID and timestamp/ID position. Validation rejects malformed and cross-wallet
cursors. Limits are 1 through 100, default 50; one extra row detects a next page.
Cursors are opaque API values, not encrypted, signed or an authorization mechanism.
Multi-entry pagination is tested with equal timestamps and an append between pages.
It is a live traversal ordered by timestamp/ID, not a frozen snapshot or commit sequence;
an entry inserted behind a consumed cursor requires a fresh traversal to discover.

Authentication was omitted in the mandatory increments, as permitted by README
section 2. The original guard extension point now validates external Keycloak access
tokens by default. There is no local user/password table. Health, metrics and static
presentation assets remain public on the local application binding. SQS is treated as
an internal channel, but every message still passes shared provider/domain validation.

## External identity and presentation UI

`ChallengeAuthGuard` applies to wallet and wagering controllers. `AccessTokenVerifier`
uses JOSE with remote, cached JWKS and a three-second retrieval deadline. It verifies
RS256 signatures, issuer, audience, expiration, issued-at, subject and the Keycloak
Bearer token type. ID tokens and refresh tokens are not API credentials. A five-second
clock tolerance accommodates small clock differences. Invalid credentials return 401;
valid identities without permission return 403. Unavailable key discovery returns 503.
Cached keys allow verification without calling Keycloak for every request; consequently
revocation is not immediate. Local access tokens expire after five minutes.

The signed `wagering-api` client roles distinguish operators from providers. Operators
create/read/reconcile wallets and read transactions. A provider can submit/read only
its signed `provider_id`; that check also applies when a transaction is addressed by
its internal ID. Foreign transaction reads return 404. Operators cannot impersonate
a provider unless they also hold that provider role and identity. The local presenter
holds both roles for demonstration. This is an operator/provider API; a future public
player application would need its own ownership policy before exposing wallet reads.

Authentication is enabled by default. Explicit `AUTH_ENABLED=false` is accepted only
with `NODE_ENV=test` for isolated financial fixtures; it is not a normal startup mode.
`bun run test:auth` separately exercises real Keycloak tokens against the API and the
same isolated PostgreSQL/SQS services, including the browser's Authorization Code +
PKCE flow and token refresh. The public client keeps the `basic` scope: service-account
tokens already had a subject, but human-user tokens without that scope did not.
The verifier continues to require `sub`; the identity fixture supplies it correctly.
Keycloak's imported realm, client secrets and
presenter password are disposable local fixtures. Production would require TLS,
managed secrets, restricted origins and identity-provider operations.

`/demo` serves a small Bun-bundled browser application within the existing Nest app.
The official Keycloak browser SDK uses Authorization Code with PKCE, a public client
and exact local callback origins. Tokens remain in memory and are redacted from the
displayed request. The UI sends real HTTP requests and shows equivalent PowerShell
commands, status, JSON response and correlation ID; it does not run shell commands.
Money input remains an exact decimal string. Replay retains the request identity;
changing an amount under the same key demonstrates a conflict. A current wallet read
refreshes the balance summary because idempotent responses contain historical balances.
The browser's history is temporary; PostgreSQL records remain durable. Automated
assertions remain CLI tests; the separate supervisor below exposes real primitives
for manually assembling complex scenarios.

### Isolated demonstration controls

The candidate requested reset/seed and individual controls for complex scenarios,
rather than a button for every test sequence. `bun run demo` starts a local supervisor
in `scripts/demo`, outside the Nest financial application. It serves the same assets,
verifies control bearer tokens with the existing Keycloak verifier, and forwards financial
HTTP once to one of three independent Nest processes. Each process retains the same
domain/application/adapters and database locking. The supervisor does not retry ambiguous
HTTP outcomes or serialize financial requests. A generic browser parallel sender supports
same/distinct financial identities without adding another financial endpoint.

The supervisor owns loopback port 3100 before touching resources, including in its tests;
shutdown keeps that port until all managed children and connections close. This prevents
two cooperating supervisors from rebuilding the same demo concurrently. Its PostgreSQL
database `wagering_demo` on 55434 and MiniStack on 4568 are fixed local targets. Development
and test targets are not configurable through control requests. Compose commands pin the
file/project/service names. Child environment construction excludes inherited financial
resource overrides. Ordinary `bun run start` has no destructive or process control routes.

Control routes require operator authorization. Valid SQS sends also require the matching
provider claim and reuse the shared envelope/wager validators. Writes require JSON, the
exact local Origin, bounded bodies and allowlisted actions. Fixed malformed-message
injection is an explicit DLQ example. The HTTP proxy accepts only existing financial,
health and metrics paths. No browser input becomes shell commands, SQL, file paths or
network destinations. Lifecycle/control mutations are serialized; overlapping ones return
409. This lock manages demonstration machinery, not wallets or financial processing.

Each child also watches its parent through [Bun IPC](https://bun.sh/docs/runtime/child-process#inter-process-communication-ipc)
and exits if that connection disappears, preventing a killed supervisor from leaving
background writers orphaned. Process exit is tracked from the `exited` promise; on the
tested Windows runtime a signaled child can retain a null `exitCode` after termination.

Reset stops and awaits every managed process before rebuilding the dedicated schema and
recreating its broker. A fresh broker clears in-flight messages and FIFO deduplication
state. Reset reapplies the existing nine migrations, then a separate idempotent seed calls
`OpenWallet` with a fixed demonstration player ID and `100.00`. Its wallet ID is new after
reset, and the opening follows the normal ledger/accounting/outbox transaction. Startup
preserves an existing seed's current balance. Keycloak identities and other environments
are unaffected. Reset is intentionally outside normal financial APIs/immutable-history
rules and is never a production operation. Failure leaves forwarding unavailable until
reset succeeds. No new migration is needed for these controls.

Process controls toggle the existing consumer/publisher/reference-worker settings on
restart. A demo-only child bootstrap can hold `acknowledge` after commit to expose the
crash/redelivery boundary; it does not modify the production queue adapter. TCP gates can
interrupt application PostgreSQL/SQS connections while admin audit/queue connections stay
available for observation. Containers/data remain intact. Native Windows process stopping
does not prove Unix SIGTERM draining; the Linux suite retains that responsibility.

Audit reads wallet/ledger/accounting totals and bounded inbox/outbox details in one
repeatable-read snapshot with exact SQL decimals. Queue inspection is a bounded receive
with visibility zero, which increments receive counts and is not a true read-only peek.
DLQ redrive searches the currently available ten-message batch, sends before deleting,
preserves business identity and accepts possible duplicates. Counts are approximate;
unavailable counts are null rather than zero. Logs are bounded. Demo tracing is disabled;
the existing Grafana target remains the ordinary development API on port 3000.

Manual controls cover HTTP concurrency, SQS duplication, pending references, publication,
DLQ and recovery scenarios. They do not expose arbitrary SQL corruption or test triggers.
Migration/constraint tests, rollback injection, unit edge cases and Linux signal assertions
remain automated evidence. This optional harness is presentation tooling, not a new
production orchestration service.

## Optional tracing, dashboard and load experiment

Manual OpenTelemetry spans cover HTTP, the shared financial workflow, SQS settlement
and outbox publication. Explicit spans avoid assuming Node auto-instrumentation works
unchanged under Bun. `OTEL_ENABLED=false` is the default. W3C trace context is metadata
outside the canonical financial hash and event data. Optional `traceparent`/`tracestate`
fields are committed in the existing outbox JSON, allowing a different publisher
process to continue the trace. Events without these fields still publish normally.
No schema migration is necessary for these optional JSON envelope fields.

Instrumentation is best effort: observer/export failures must not replace a successful
financial result or call its workflow twice. Export buffers and deadlines are bounded;
a crash can lose buffered spans, but not committed financial records. Span/log fields
exclude tokens, money, complete payloads, SQL and exception stacks. Pending-reference
workers retain correlation IDs but do not rejoin the original distributed trace in
this increment. [Observability setup](observability/README.md) documents the limitation.

The optional Compose overlay provisions Prometheus, Tempo and a ten-panel Grafana
dashboard. Published ports remain bound to localhost. Counters aggregate across
scraped processes; shared outbox gauges use `max`, not a sum of the same database
backlog. The default scrape target is the development API on port 3000. Docker Desktop
connectivity was verified without changing the application's localhost bind.

`bun run test:load` runs three independent application processes against isolated real
PostgreSQL and SQS. It measures a hot wallet and twenty distributed wallets, then checks
committed identities, exact balances, ledger counts and published events. It uses no
client retries. Authentication and tracing are explicitly disabled in these isolated
processes, so the results are a financial baseline rather than authenticated end-to-end
capacity. Ambiguous transport outcomes prevent positive invariant certification because
server work may still be in flight. [LOAD_TESTING.md](LOAD_TESTING.md) records methodology,
environment, throughput, percentiles, errors, contention, outbox lag and limitations.

## Operational telemetry and health

Application workflows depend on a small `Telemetry` observer, defaulting to no-op
for standalone use. The infrastructure implementation records only committed
financial outcomes. Logging failures cannot undo a commit or convert it into an
apparent financial failure. Monitoring is not part of idempotency or correctness.

HTTP middleware accepts an `x-correlation-id` matching
`[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}` or generates a UUID, returns it in the response,
and carries it through asynchronous request context into opening/wager events.
The correlation header is excluded from the financial payload hash. SQS uses its
validated envelope message ID as correlation; reference workers and publishers
preserve the original persisted event context.

The JSON logger always emits `correlationId`, `messageId`, `transactionId`,
`walletId` and `providerId`, using null where unavailable. It admits only explicit
operational fields and discards request/event payloads, money, SQL, credentials,
driver exception messages, names and stacks. Framework messages without structured
fields become a generic event; this deliberately favors privacy over detailed
framework startup/error text. Correlated application logs retain stable codes.

`GET /metrics` emits Prometheus text with these bounded series:

| Series | Meaning |
| --- | --- |
| `wagering_transactions_total{status}` | Committed non-replay decisions, including positive OPENING; pending acceptance and its later terminal decision each count under their status |
| `wagering_duplicates_total` | Requests/deliveries replaying a stored decision |
| `wagering_retries_total{source}` | SQS retry settlement, committed outbox retry, or committed reference recheck |
| `wagering_dlq_total` | Application DLQ send and source deletion completed; broker-native redrive is not counted here |
| `wagering_lock_conflicts_total` | Observed SQLSTATE 40001, 40P01 or 55P03, not ordinary wallet lock waits |
| `wagering_processing_seconds` | Histogram for committed financial workflows/replays, including durable FAILED decisions; attempts without a committed result and still-pending reference checks are excluded |
| `wagering_reconciliations_total`, `wagering_reconciliation_divergences_total` | Completed checks and detected inconsistencies |
| `wagering_outbox_pending`, `wagering_outbox_lag_seconds` | Database-derived pending event count and age of the oldest unpublished event |

Counters and histogram are per process and reset on restart; scrape each instance
and aggregate counters externally. They can miss a commit followed immediately by
process death and are not audit totals. Outbox gauges describe shared database state:
do not sum copies across instances. A failed gauge query returns 503 instead of
misleading zeroes. Metrics contain no wallet/provider/transaction identifiers as
labels, keeping cardinality bounded. No monitoring server or dashboard is required.

`GET /health/live` checks only that HTTP can respond. `GET /health/ready` checks
PostgreSQL and all three configured SQS queues, including queue attributes so a
deleted queue cannot appear healthy just because its URL was cached. Probes run
concurrently with a 1.5-second deadline and return only up/down status. SQS requests
are aborted at the deadline. PostgreSQL statements have a one-second cancellation
timeout; a single shared outstanding probe bounds queued pool acquisitions.
The shared ORM pool also bounds acquisition to three seconds; this bounds connection
starvation without imposing a statement or wallet-lock timeout on financial work.
Readiness is 503 when either dependency fails, while liveness remains 200. Metrics
database reads have the same bounded response behavior. These endpoints require
no authentication, as allowed for this local challenge.

## Verified behavior and remaining acceptance work

Real PostgreSQL tests run three independent Bun application processes. They verify
50 concurrent duplicate openings produce one wallet/credit and 49 conflicts, distinct
wallets open in parallel, an outbox failure rolls back all records, and committed
wallet/ledger/outbox state survives application termination and restart. Every final
wallet balance is compared with the exact sum reconstructed from its ledger.
BET tests additionally exercise 50 copies of one wager, two simultaneous bets of
80.00 against 100.00, unrelated wallets under parallel load, and an unrelated wallet
completing while another wallet's row is deliberately locked. They verify persisted
original processed/rejected results, conflicting identities, precise cent debits,
atomic rollback of both processed and rejected decisions on outbox failure, and an
unconsumed HTTP response followed by SIGKILL and successful historical replay after
restart. The latter does not simulate an SQS worker dying before acknowledgment.

Real PostgreSQL/MiniStack tests verify that uncommitted opening events are invisible
to publication, concurrent publishers preserve event envelopes, refused connections
persist retry state, and killing a publisher after a real send but before its SQL
commit redelivers the same eventId. Wallet balances still match their ledger sums.

Increment 5's real PostgreSQL/MiniStack input suite verified delivery duplication,
the shared HTTP/SQS workflow, three-process consumption, atomic inbox rollback, retries,
DLQ and recovery after SIGKILL between commit and acknowledgment. The full integration
run passed 53 tests and skipped the native Windows SIGTERM case; exact measurements
and the remaining validation commands are recorded in SETUP.md.

Increment 6 adds 13 integration scenarios: 50 concurrent WIN copies over three
processes produce one credit; concurrent LOSS copies preserve wallet state; distinct
credits do not lose updates; near-limit credits remain exact and overflow rejection
replays its original result. The suite checks shared HTTP/SQS idempotency, inbox/outbox
rollback, WIN restart recovery, cross-kind identity constraints, invalid ledger
direction, and migration 004 preservation/refusal. Every final wallet is compared
with its ledger sum. Exact full-suite and focused-run results are recorded in SETUP.md.

Increment 7 adds nine reference integration scenarios, including 50 pending copies
across three processes, SQS acknowledgment that permits the later BET through the
same FIFO group, bounded missing checks, atomic failure rollback, and three reference
workers resolving six wallets after restart. Migration 005 round trips and identity,
state and resolved-reference guards are exercised against PostgreSQL. Every final
wallet matches its ledger sum. The full integration run passed 75 tests with one
native Windows SIGTERM skip; exact measurements are recorded in SETUP.md.

Increment 8 adds nine REFUND integration scenarios: 50 duplicate requests across
three processes credit once; 12 distinct refund identities produce one credit and
11 durable rejections. Pending SQS refunds survive SIGKILL and three restarted
workers settle each BET once. Reference/amount rules, overflow recovery, expiry,
atomic inbox/outbox rollback and migration 006 guards are exercised against real
PostgreSQL and MiniStack. Every final wallet matches its ledger sum. The full suite
passed 84 tests with one native Windows SIGTERM skip; exact results are in SETUP.md.

Increment 9 adds ten ROLLBACK integration scenarios: inverse BET/WIN/REFUND movements,
50 concurrent copies, competing reversal identities, exact reference matching,
reversal insufficiency and independent per-kind eligibility. Pending SQS rollbacks
arriving before BET, WIN and REFUND survive termination and resolution after three
process restarts. The suite also checks ten missing-reference attempts, atomic
inbox/outbox failure rollback and migration 007 preservation/refusal and SQL guards.
Every final wallet matches its ledger sum. The full suite passed 94 tests with one
native Windows SIGTERM skip; exact results are recorded in SETUP.md.

The subsequent reliability/operations increments implement FAILED audit decisions,
read-only reconciliation, correlated logs, metrics and liveness/readiness. Their
measured validation and network-outage recovery results are recorded in SETUP.md.
Native graceful SIGTERM on Windows remains a platform-specific validation gap;
the required signal behavior has been verified in Linux through Docker, alongside
the separate graceful Nest context closure and abrupt crash/recovery checks.
MiniStack snapshot durability and per-process monitoring limits described above
remain explicit limitations, not guarantees of a production deployment.

On 2026-10-11 a candidate reported a migration 008 integration failure whose original
exception was absent from the shared log excerpt. The unchanged full suite and ten
targeted reruns passed. The cause remains unconfirmed; passing reruns are not a fix.
The investigation is closed; see SETUP.md's historical record for measured results.

### Linux validation runner

`bun run test:integration:linux` builds the pinned official Bun image and runs the
existing integration tests with Linux child processes. This is a test image, not a
production deployment design. It installs dependencies from `bun.lock`; the build
context excludes host dependencies, build output, Git data and environment files.
Two local TCP forwarders connect `127.0.0.1:55433` to `postgres-test:5432` and
`127.0.0.1:4567` to `ministack-test:4566` on the Compose network. This preserves the
existing destructive-test guards without adding Docker host networking, privileged
access or a Docker socket mount. The runner waits for healthy dependencies, propagates
test failures and closes its forwarding sockets afterward. Windows and Linux runners
share the same disposable test services and must run sequentially.

The reconciliation concurrency test starts 60 distinct BETs and 60 snapshots together
across three independent processes. A saturated connection pool can return the
documented `503 DATABASE_UNAVAILABLE`; the test client retries only that response,
with the same wager body/key, at most three attempts and 50/100 ms backoff. Other
errors fail the test. It drains all requests before teardown and requires 60 distinct
PROCESSED bets, 60 debits, one opening credit, balance `40.00`, version 61 and every
snapshot consistent. This checks financial correctness and bounded recovery under
contention, not a throughput guarantee. Application pool sizes and timeouts are unchanged.

## Primary references

- [Bun installation](https://bun.sh/docs/installation): official Windows installation.
- [Decimal.js API](https://mikemcl.github.io/decimal.js/): independent constructors and precision.
- [MikroORM 6.6 transactions](https://mikro-orm.io/docs/6.6/transactions): explicit transaction boundaries and Unit of Work.
- [MikroORM 6.6 migrations](https://mikro-orm.io/docs/6.6/migrations): versioned migration execution.
- [MiniStack repository](https://github.com/ministackorg/ministack) and [configuration](https://ministack.org/docs/configuration): upstream image and local persistence behavior.
- [MiniStack 1.5.24](https://ministack.org/blog/changelog-v1-5-24): selected release.
- [SQS standard queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues.html): at-least-once delivery and ordering limits.
- [SQS CreateQueue](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_CreateQueue.html): queue attributes and repeat setup behavior.
