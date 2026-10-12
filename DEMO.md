# Presentation walkthrough

This page describes the optional presentation UI. The original [README](README.md)
remains the challenge contract; [SETUP.md](SETUP.md) contains the complete CLI examples.

## Start the isolated presentation

From PowerShell in the repository, with Docker running:

```powershell
bun install --frozen-lockfile
bun run demo
```

Keep that terminal open. This command builds the app, starts Keycloak and the dedicated
demonstration containers, applies the nine migrations, creates a `100.00` seed wallet
if absent, and starts three independent Nest processes behind port **3100**. Reopening
the demo preserves its existing wallets; only **Reset demonstration** clears them.
Stop an older application on port 3100 before running this command. Restart after
source changes; the compiled application does not reload itself.

Open [Wagering Lab](http://127.0.0.1:3100/demo), choose **Sign in**, and use the local
Keycloak account `presenter` with password `presenter_local`. Keycloak handles login;
the application has no password database. The account combines operator permissions
with provider A permissions for this presentation. Tokens remain in browser memory.
These are local demonstration credentials, not production credentials.

Open **Demo controls** and choose **Use seed wallet**, or create a new player normally.
The demo uses PostgreSQL **55434** (`wagering_demo`) and MiniStack **4568**. It does
not share financial data with development (**55432/4566**) or integration tests
(**55433/4567**). Keycloak login is shared with development and survives reset.
`bun run start` still provides the ordinary app at **3000**, without reset/process controls.

## A five-minute route

1. Leave **Initial balance** at `100.00` and select **Create wallet**. Expect HTTP 201,
   balance `100.00`, version 1. **Read ledger** shows the opening credit.
2. Choose **BET**, amount `25.00`, and **Submit BET**. Expect `PROCESSED`, balance
   `75.00`, version 2, and `idempotentReplay: false`.
3. Select **Replay last request**. Expect the same transaction ID and historical
   balance, now with `idempotentReplay: true`. There is no second debit.
4. Change **Amount** to `26.00` and select **Send amount conflict**. Expect HTTP 409
   with `IDEMPOTENCY_CONFLICT`. The original request and balance remain unchanged.
5. Change **Amount** to `80.00` and select **Submit BET**, which creates a new identity.
   Expect HTTP 422, `REJECTED`, and `INSUFFICIENT_FUNDS`. The rejection is persisted.
6. Select **Read ledger**, then **Reconcile**. Expect two entries (opening and the
   successful BET), stored/calculated balance `75.00`, and difference `0.00`.
7. Select **Read accounting journal**. The opening debits `opening-clearing:BRL`
   and credits the wallet for `100.00`. The BET debits the wallet and credits
   `house:BRL` for `25.00`. Each shared `money` amount applies to both accounts.
   Replays and rejections added no accounting transfer.

The left side contains inputs and transaction history. The right side shows the
equivalent PowerShell command and the real API response, including status, elapsed
time and correlation ID. The expandable request view redacts Authorization.
The browser sends HTTP directly: these terminal-style panels do not execute a shell.

## Credits, results and reversals

Continue with the same wallet and round, or choose **New player** to begin again:

| Operation | Input | Expected effect |
| --- | --- | --- |
| WIN | Positive amount; optional processed BET reference | Credits the wallet |
| LOSS | Amount becomes `0.00`; no reference | Records a result without changing balance/version or adding a ledger entry |
| REFUND | Select the processed BET in **Use a transaction from this session** | Credits the full BET amount, once per reference |
| ROLLBACK | Select a processed BET, WIN or REFUND | Reverses the full referenced amount, once per reference and reversal kind |

Selecting a reference fills its external ID, round and game. Reversals also copy the
full amount: partial reversals are not supported. A reversal that would make the
wallet negative is rejected and remains auditable. The ledger retains the original
entry and records a new inverse entry; it never edits or deletes the original.

**Read persisted transaction** queries PostgreSQL through the API. The UI history is
limited to this browser session; reloading does not delete database records. Paste a
saved wallet ID and choose **Read wallet** to continue with an existing wallet.

## Repeatability and failures

- **New player** generates a new player UUID. You can repeat the route without resetting
  the database. Creating the same player/currency twice returns HTTP 409.
- **External transaction ID** is editable. After a completed submission the form
  advances to a new ID. **Replay** deliberately reuses the last
  identity and payload. Editing the input does not modify that saved replay payload.
- A historical replay response can show an older balance. The summary separately reads
  the current wallet so it does not replace today's balance with that older result.
- A timeout is an unknown result, not proof of rollback. Replay the same identity to
  resolve a wager; do not create a new identity to retry an uncertain operation.
- Decimal amounts must use strings with exactly two decimal places, for example `25.00`.
  There are no real deposits, withdrawals or connections to a payment processor.

## Individual controls for complex scenarios

These controls act on real containers and processes. They do not replace the financial
use case with mocked balances. **Refresh state** shows current PIDs, worker flags,
approximate queue counts and recent process logs. Reads are on demand, not live polling.

| Control | Purpose |
| --- | --- |
| Request target | Route HTTP automatically across live processes, or select process 1, 2 or 3 |
| Parallel HTTP send | Send 2–50 requests together, using the same identity or distinct identities |
| Process Start / Stop / Crash / Apply and restart | Control one actual child process; Crash terminates abruptly |
| Consumer / Publisher / References | Enable each background responsibility independently on a process |
| Pause before ACK | Hold a valid SQS delivery after its SQL commit and before deletion; restart without the flag to remove the barrier |
| Disconnect / Restore PostgreSQL or SQS | Break application connections to that dependency while preserving container data |
| Send through SQS | Submit the current wager, with 1–50 delivery copies |
| Repeat message ID / New message ID, same wager | Reuse both identities, or change only the envelope message ID while retaining the financial identity; each send has a fresh transport timestamp |
| Invalid message / Inspect DLQ / Redrive | Demonstrate permanent validation failure and return an inspected message to input |
| Inspect events / Audit | Inspect output messages or one consistent SQL snapshot of wallet, ledger, accounting, inbox and outbox |

The supervisor's administrative connection remains available during simulated network
outages, so you can enqueue messages and inspect persisted data while application
connections are broken. This is an application connectivity failure, not destruction
or shutdown of PostgreSQL/MiniStack. Queue inspection receives up to ten available
messages with zero visibility and no deletion; **it increments their receive counts**.
Redrive sends before deleting its DLQ copy and can itself produce duplicate delivery.
Redriving the fixed malformed message sends it back to the DLQ: it does not repair it.

Useful sequences you can assemble yourself:

1. **Concurrency:** select automatic HTTP routing, BET `25.00`, 50 copies and the same
   identity. Expect one debit and historical replays. With a fresh `100.00` wallet,
   select BET `80.00`, two copies and distinct identities: one applies, one rejects,
   balance `20.00`. The parallel response preserves every submitted identity and result.
   A transport failure has an unknown outcome; retry that exact identity. SQS copies
   separately test inbox deduplication; one wallet's FIFO group serializes delivery.
2. **Pending reference:** submit REFUND `25.00` referencing an external ID you chose,
   for example `future-bet-1`. It returns `PENDING_REFERENCE`. Then submit BET `25.00`
   with external ID `future-bet-1`, on the same player/wallet/round. A reference worker
   later completes the refund. Read the persisted transaction and reconcile.
3. **Unpublished events:** disable publishers and apply/restart all three processes.
   Submit a BET, then inspect Audit: its outbox rows remain pending. Crash the process
   that handled HTTP, enable publishers on two surviving processes and restart them.
   Refresh Audit until the pending rows are published; inspect events and reconcile.
4. **Death between commit and ACK:** disable consumers on processes 2 and 3 and
   apply/restart them. Enable consumer and Pause before ACK on process 1, then restart
   it. Send one valid SQS wager. Refresh until process 1 reports **COMMITTED, ACK PAUSED**;
   inspect the persisted transaction/inbox. Crash process 1, enable consumer on process 2
   and restart it. After visibility expires (five seconds), it acknowledges redelivery
   without a second balance change. Audit/reconcile must still agree.
5. **Recovery:** disconnect SQS, submit HTTP, and inspect pending outbox attempts; restore
   SQS and refresh until publication catches up. Disconnect PostgreSQL and send through
   SQS to observe retries. Restore promptly for automatic retry, or inspect/redrive the
   DLQ after the bounded retry budget is exhausted. Keep the original financial identity.

**Stop** asks the runtime to terminate normally, with a forced-stop fallback. Native
Windows cannot reproduce Unix SIGTERM draining; **Crash** recovery is usable on Windows.
Use the Linux integration suite for the required graceful shutdown proof. Keep the ACK
barrier off for ordinary work; it deliberately holds the consumer until termination.

## Reset and seed

In **Reset demonstration**, type `RESET DEMO` and press its reset button. Reset:

1. Blocks new financial requests and stops/awaits all three child processes.
2. Rebuilds only `wagering_demo` and recreates only its dedicated broker, including
   invisible deliveries and FIFO deduplication state.
3. Applies the existing nine versioned migrations and opens a fresh `100.00` seed wallet
   through `OpenWallet`: version 1, one opening ledger entry, one balanced accounting
   transfer and two outbox events.
4. Restarts three workers, clears browser transaction history/replay selections and
   selects the new seed wallet. Publishers may already have published its two events.

Reset deletes demonstration players/wallets/transactions/ledger/accounting/inbox/outbox
and queue messages. It preserves Keycloak users, login, development/test data and source
files. The seed is separate from migrations; shared accounting accounts are structural
data created by the accounting migration. No migration or normal API deletes financial
history. A failed reset leaves financial forwarding unavailable; fix the dependency and
retry reset. Concurrent control mutations return HTTP 409 rather than overlap.

## Run a displayed PowerShell command

The command deliberately contains `$accessToken` instead of exposing the browser token.
In a second terminal, obtain the credential appropriate for the command:

```powershell
# Wallet creation, wallet/ledger reads and reconciliation:
$accessToken = bun run auth:token wallet-operator

# Wager submission and provider A transaction reads:
$accessToken = bun run auth:token provider-a
```

Run only the applicable assignment, then paste the displayed command. Tokens expire
after five minutes; obtain a fresh token after HTTP 401. Preserve the same wager
identity when retrying. The presentation UI refreshes its token automatically.

Demo control commands also include the required same-origin `Origin` header. They
require an operator token; valid SQS submission additionally requires the matching
provider identity (the browser's presenter has both roles). The two separate service
tokens above each have only their designated role. Parallel HTTP examples use PowerShell
`Start-Job`; their shell startup overhead differs from the browser's simultaneous dispatch.

## Graphs, traces and automated scenarios

In a second terminal:

```powershell
bun run obs:up
bun run obs:check
```

Open [the Grafana dashboard](http://127.0.0.1:3001/d/wagering-overview/wagering-processor).
It scrapes the API on port 3000 every five seconds. An idle period can legitimately show
zero activity or no latency observations. To include application traces, set
`$env:OTEL_ENABLED = 'true'` before starting/restarting the API. See
[observability/README.md](observability/README.md) for trace exploration and limitations.
The isolated demo children have tracing disabled and are not targets of that dashboard.
Their logs, Audit and queue controls expose the presentation's own state.

The UI exposes individual HTTP/SQS operations and failure controls. Automated assertions
for database constraints, migration reversibility, Money/domain edge cases, atomic rollback,
and exact fault boundaries remain in the suites. Manual clicking is not a substitute
for those checks. Do not run these suites simultaneously because they intentionally
rebuild the same isolated test database:

```powershell
bun run test:unit
bun run test:auth
bun run test:integration:linux
bun run test:load --requests 60 --concurrency 6
```

The Linux integration command also exercises graceful SIGTERM shutdown, which native
Windows cannot emulate faithfully. The load command uses three processes and reports
measured performance plus ledger/outbox checks; it is a financial baseline with auth
and tracing disabled in isolated test processes. See [LOAD_TESTING.md](LOAD_TESTING.md).
The test database uses port 55433; the development wallet database uses port 55432.

To verify the new supervisor/reset controls, stop `bun run demo` with Ctrl+C first,
then run `bun run test:demo`. This suite owns port 3100 and resets **only** the isolated
demo environment. It uses the disposable Keycloak test service on 58081. Start
`bun run demo` again afterward; use reset for a clean presentation wallet.

The optional accounting journal preserves the existing wallet ledger. A wallet is
an obligation to its player; its accounting credits minus debits equal the spendable
balance. House settlement is a shared logical counterparty, not a second player
wallet or a real bank balance. See [ARCHITECTURE.md](ARCHITECTURE.md) for the mapping
and the reversible historical backfill in migration `Migration202610120001`.
