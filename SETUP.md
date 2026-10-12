# Setup, browser walkthrough and testing

This is the practical guide for installation, browser exercises, HTTP/SQS examples,
automated tests and the optional load experiment. The original [README](README.md)
remains the challenge specification; [ARCHITECTURE.md](ARCHITECTURE.md) explains
the design, acceptance decisions and limitations.

Run `bun run start` and open `http://127.0.0.1:3000/demo`. The same Nest process
serves the frontend and API, with Keycloak authentication enabled by default.
The browser covers financial operations and their records; complex multi-process,
queue and crash-recovery checks run from the terminal.

- [Prerequisites and startup](#prerequisites-and-startup)
- [Browser walkthrough](#browser-walkthrough)
- [Manual HTTP and SQS examples](#manual-http-and-sqs-examples)
- [Additional application processes](#additional-application-processes-when-needed)
- [Tests and checks](#tests-and-checks)
- [Load testing](#load-testing)
- [Database lifecycle](#database-lifecycle)
- [Validation results](#validation-results)

Optional dashboards and traces have their [infrastructure instructions](observability/README.md).
Use `bun run obs:up` and `bun run obs:check` with the normal API on port 3000;
[Grafana](http://127.0.0.1:3001/d/wagering-overview/wagering-processor) uses port 3001.

## Prerequisites and startup

Use Bun **1.4.3**, Docker Engine and Docker Compose. Docker is required for PostgreSQL,
MiniStack and integration tests; unit tests do not require it. The project pins dependency
versions in `package.json` and `bun.lock`.

In PowerShell, from the repository:

```powershell
cd "E:\Dev\Jungle Gaming"
$env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
bun --version
docker info
bun install --frozen-lockfile
bun run db:up
bun run db:migrate
bun run sqs:up
bun run auth:up
bun run start
```

`db:up` starts the development PostgreSQL container and waits for its healthcheck.
`db:migrate` applies pending versioned migrations. `start` builds TypeScript and
runs the compiled NestJS application with Bun at `http://127.0.0.1:3000`.
`sqs:up` downloads/starts the pinned upstream MiniStack image, waits for its healthcheck,
and creates the event output, wager input FIFO and DLQ queues idempotently. No separate MiniStack installation,
AWS account, AWS CLI or manual download is required.
Keep that terminal open; use a second terminal for HTTP requests. Stop the application
with Ctrl+C. The root `/` route returns 404; use `/demo` or the API routes below.
For the interactive presentation, open `http://127.0.0.1:3000/demo` and sign in through
Keycloak with the local demonstration account `presenter` / `presenter_local`.
These credentials belong to the external development IdP and are not a production setup.
Use `127.0.0.1`, as registered in the Keycloak login callback.

If dependencies are already running and migrations are current, only `bun run start`
is needed. Restart after source changes: this command builds and runs the application
but does not watch files or reload automatically.

Apply all pending migrations before starting application instances. Stop every
instance before changing the schema, run `bun run db:migrate`, then restart with
`bun run start` so the application build and database constraints match. Migrations
do not seed player wallets. If MiniStack is already running, `bun run sqs:setup`
ensures all three queues exist.

Configuration defaults match `.env.example`: PostgreSQL is bound to localhost on
port **55432**, database `wagering`. No `.env` file is required for the default setup.
If customization is needed, copy `.env.example` to `.env` only when no existing `.env`
would be overwritten, then edit it. Bun loads the file. Existing environment variables
can also set `DATABASE_URL` and `PORT`, for example `$env:PORT = '3002'` before startup.
The example credentials are for these local containers.

Keycloak imports `config/keycloak/wagering-realm.json` only when that realm does not
already exist. `auth:up` does not overwrite an existing realm. If you intentionally
want to replace this disposable demonstration realm after editing its fixture, stop
Keycloak and use its official offline import (this replaces demo identity settings
and invalidates sessions; it does not modify the financial PostgreSQL database):

```powershell
docker compose stop keycloak
docker compose --profile auth run --rm --no-deps keycloak import --file /opt/keycloak/data/import/wagering-realm.json --override true
bun run auth:up
```

Sign in again afterward. The public `demo-ui` client uses Keycloak's `basic` scope
so user access tokens include `sub`, which the API requires. The auth test runner
recreates only its disposable `keycloak-test` container to apply the current fixture.

If Bun is missing, install it using the [official Windows instructions](https://bun.sh/docs/installation):

```powershell
Invoke-WebRequest https://bun.sh/install.ps1 -OutFile "$env:TEMP\bun-install.ps1"
& "$env:TEMP\bun-install.ps1" -Version 1.4.3
```

Open a new terminal afterward or use the PATH line above.

## Browser walkthrough

After [startup](#prerequisites-and-startup), open
[Wagering Lab](http://127.0.0.1:3000/demo) and sign in with the local presenter
credentials above. Keycloak handles login and the browser refreshes its token,
kept in memory. Browser and terminal requests use the same development data.
Startup preserves financial history; there is no automatic seed or browser reset.
Choose **New player** to prepare a fresh example without deleting earlier records.

### Create a wallet and place a bet

1. Set **Initial balance** to `100.00` and select **Create wallet**. Expect HTTP 201,
   a wallet ID, balance `100.00` and version 1. **Read ledger** shows the opening credit.
2. Choose **BET**, amount `25.00`, and **Submit BET**. Expect `PROCESSED`, balance
   `75.00`, version 2 and `idempotentReplay: false`.
3. Select **Replay last request**. Expect the same transaction ID and historical
   balance with `idempotentReplay: true`. No second debit occurs.
4. Change **Amount** to `26.00` and select **Send amount conflict**. Expect HTTP 409
   with `IDEMPOTENCY_CONFLICT`. The original request and balance remain unchanged.
5. Set **Amount** to `80.00` and select **Submit BET**. This uses a new identity.
   Expect HTTP 422, `REJECTED` and `INSUFFICIENT_FUNDS`. The rejection is persisted.
6. Select **Read ledger**, then **Reconcile**. Expect two ledger entries, stored and
   calculated balances of `75.00`, and difference `0.00`.

The challenge has no `DEPOSIT` operation. Choose the test funds in **Initial balance**
when creating the wallet. A positive opening is a real recorded movement: it creates
the internal `OPENING` transaction, ledger credit, accounting pair and outbox events
atomically. To begin a new funded example, create a new player and wallet. `WIN` is a
game payout, not a substitute for depositing money.

### Choose the result explicitly

The UI is a financial test client, not a game engine. Submitting a BET does not
automatically choose a result. Send a second request to record the desired outcome:

| Operation | Input | Expected effect |
| --- | --- | --- |
| WIN | Positive payout amount; optionally select the processed BET | Credits the wallet; after a `25.00` BET from `100.00`, a `40.00` WIN leaves `115.00` |
| LOSS | Amount `0.00`; no reference | Records the result without another debit; after that BET the balance stays `75.00` |
| REFUND | Select a processed BET from this session | Credits its full amount once per reference |
| ROLLBACK | Select a processed BET, WIN or REFUND | Reverses its full amount once per reference and reversal kind |

Use a separate round/example for each intended outcome. The API does not implement
a game engine that enforces exactly one WIN or LOSS for every round. A new transaction
identity is a separate financial request; replaying an existing identity is a retry.

Selecting a reference fills its external ID, round and game. Reversals also copy the
full amount: partial reversals are unsupported. A reversal that would make the wallet
negative is rejected. Original ledger entries stay immutable; reversals add new entries.

### Read and explain the records

The command panel shows the equivalent PowerShell call. The response panel shows
the actual API status, JSON, elapsed time and correlation ID. The browser sends HTTP
directly; these panels do not execute a terminal. Authorization is redacted.

- **Read wallet** refreshes the current balance. A replay response can contain an
  older balance because it returns the original result.
- **Read ledger** lists movements that changed the balance. LOSS, rejected requests
  and duplicate replays add no entry.
- **Read accounting journal** shows the two sides of each movement. Opening debits
  `opening-clearing:BRL` and credits the wallet; a BET debits the wallet and credits
  `house:BRL`. One shared `money` amount applies to both sides.
- **Reconcile** compares the stored wallet balance with the balance reconstructed
  from its PostgreSQL ledger. It does not compare against browser memory or modify funds.
- **Read persisted transaction** reads the transaction through the API. Browser
  history lasts only for the session; database records survive reloads and restarts.

Save a wallet ID to return later: paste it and choose **Read wallet**. Decimal amounts
are strings with exactly two decimal places. If a request times out, its outcome is
unknown; replay its identity rather than inventing a new request that might move money twice.

To run a displayed command in PowerShell, first set the appropriate credential:

```powershell
# Wallet creation, reads, journal and reconciliation:
$accessToken = bun run auth:token wallet-operator

# Wager submission and provider A transaction reads:
$accessToken = bun run auth:token provider-a
```

Run only the applicable assignment, then paste the command. Terminal tokens expire
after five minutes; obtain a fresh token after HTTP 401 and retain the original
financial identity when retrying. The browser handles its own token refresh.

### Two reversal exercises

1. **Return a bet:** choose **New player**, create a wallet with `100.00`, then
   submit a `25.00` BET in round `refund-test` (balance `75.00`). Choose REFUND
   and select that BET under **Transaction details & references → Use a transaction
   from this session**. Submit the filled request; balance returns to `100.00`.
2. **Reverse a payout:** create another player/wallet with `100.00`, submit a
   `25.00` BET in round `rollback-test` (`75.00`), then a `50.00` WIN referencing
   that BET (`125.00`). Choose ROLLBACK and select the **WIN**, then submit the filled
   request; balance returns to `75.00`. Inspect the ledger and reconcile after each exercise.

The UI prepares a new external transaction ID after a completed operation; **New ID**
is not needed in these sequences. Round IDs need not be sequential. A reversal must
keep the referenced transaction's round; selecting a reference fills it automatically.
Replay retains the original identity, while a new WIN identity is a separate credit.
Input such as `25` is rejected locally; use `25.00`. Local validation messages
appear in the notice at the top of the page, and no HTTP request is sent for that error.

## Manual HTTP and SQS examples

Follow these examples in order in the same PowerShell session; later examples reuse
wallet and authentication variables from earlier steps.

### Try the HTTP flow

With the application running, first obtain the two service credentials in a second
PowerShell terminal. The operator manages
wallets and can read transactions; provider A can submit and read only its own wagers.
Health and metrics remain public; SQS remains an internal channel.

```powershell
$operatorToken = bun run auth:token wallet-operator
$providerToken = bun run auth:token provider-a
$operatorHeaders = @{ Authorization = "Bearer $operatorToken" }
```

The examples below use these variables. Access tokens expire; if an example returns
401, obtain fresh tokens and recreate its header variables before retrying. A new
token does not change the financial idempotency key or justify a new wager identity.
The UI refreshes its own token through the external IdP.

```powershell
$baseUrl = 'http://127.0.0.1:3000'
$playerId = [guid]::NewGuid().ToString()
$body = @{
    playerId = $playerId
    initialBalance = @{ amount = '100.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 5

$wallet = Invoke-RestMethod -Method Post -Headers $operatorHeaders -Uri "$baseUrl/wallets" -ContentType 'application/json' -Body $body
$wallet | ConvertTo-Json -Depth 5

Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wallets/$($wallet.id)" | ConvertTo-Json -Depth 5
Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wallets/$($wallet.id)/ledger?limit=50" | ConvertTo-Json -Depth 5
Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wallets/$($wallet.id)/journal?limit=50" | ConvertTo-Json -Depth 5
```

Expect balance `{ "amount": "100.00", "currency": "BRL" }`, version `1` and one
`CREDIT` ledger entry from `0.00` to `100.00`. The positive opening also saves one
internal `OPENING` transaction and two events in the outbox. The background publisher
sends them to SQS after the financial commit and then records `published_at`.
The accounting journal also contains one immutable pair: debit `opening-clearing:BRL`
and credit `wallet:<walletId>`, sharing amount `100.00`. The shared amount applies to
both sides. A zero opening still creates its accounting account but has no transfer.

Repeat the same creation to verify conflict handling:

```powershell
try {
    Invoke-RestMethod -Method Post -Headers $operatorHeaders -Uri "$baseUrl/wallets" -ContentType 'application/json' -Body $body
} catch {
    "Duplicate request returned HTTP $([int]$_.Exception.Response.StatusCode); expected 409."
}
```

The balance and ledger remain unchanged. Creating a fresh player with `0.00` instead
returns version `1` and an empty ledger. Decimal amounts must be strings with exactly
two places; only BRL is enabled. The guard validates Keycloak access tokens and route
permissions; the identity and authorization decisions are documented in architecture.

The README defines initial wallet funding through `initialBalance`, not a public
`DEPOSIT` operation. Choose the starting funds when creating the wallet. To start
another funded example, create a fresh player/wallet. A `WIN` is a game payout and
must not be presented as a deposit. BET and its WIN/LOSS result are separate explicit
requests; this processor does not randomly decide game outcomes.

### Place a BET and replay it

After creating the wallet above, use the same second PowerShell terminal.
No application restart is needed between these examples:

```powershell
$externalId = [guid]::NewGuid().ToString()
$headers = @{ Authorization = "Bearer $providerToken"; 'Idempotency-Key' = "provider-a:$externalId" }
$betBody = @{
    providerId = 'provider-a'
    externalTransactionId = $externalId
    playerId = $wallet.playerId
    walletId = $wallet.id
    roundId = 'round-1'
    gameId = 'fortune-chimp'
    kind = 'BET'
    money = @{ amount = '25.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 5

$bet = Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -Headers $headers -ContentType 'application/json' -Body $betBody
$bet | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -Headers $headers -ContentType 'application/json' -Body $betBody | ConvertTo-Json -Depth 5
Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wagering/transactions/$($bet.transactionId)" | ConvertTo-Json -Depth 5
Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/providers/provider-a/wagering/transactions/$externalId" | ConvertTo-Json -Depth 5
Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wallets/$($wallet.id)" | ConvertTo-Json -Depth 5
Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wallets/$($wallet.id)/ledger?limit=50" | ConvertTo-Json -Depth 5
```

The first request returns HTTP 200, `PROCESSED`, balance `75.00 BRL`, and
`idempotentReplay: false`. The repeat returns the same transaction ID and original
balance with `idempotentReplay: true`. The wallet stays at version `2`; the ledger
has one opening CREDIT and one BET DEBIT. Both transaction query routes return the
same historical result. Later wagers do not change the result returned for this BET.

Changing the payload while reusing the key returns 409 `IDEMPOTENCY_CONFLICT`.
Changing only the key for the same provider/external ID returns 409
`EXTERNAL_TRANSACTION_CONFLICT`. Missing keys and zero bets return 400.

To see a persisted business rejection, submit a new identity for more than the balance:

```powershell
$rejectedId = [guid]::NewGuid().ToString()
$rejectedHeaders = @{ Authorization = "Bearer $providerToken"; 'Idempotency-Key' = "provider-a:$rejectedId" }
$rejectedBody = @{
    providerId = 'provider-a'
    externalTransactionId = $rejectedId
    playerId = $wallet.playerId
    walletId = $wallet.id
    roundId = 'round-2'
    gameId = 'fortune-chimp'
    kind = 'BET'
    money = @{ amount = '80.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 5

try {
    Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -Headers $rejectedHeaders -ContentType 'application/json' -Body $rejectedBody
} catch {
    "Request returned HTTP $([int]$_.Exception.Response.StatusCode); expected 422."
    $_.ErrorDetails.Message
}
Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/providers/provider-a/wagering/transactions/$rejectedId" | ConvertTo-Json -Depth 5
```

Expect `REJECTED` and `failureCode: INSUFFICIENT_FUNDS`; balance stays `75.00`, version
stays `2`, and no new ledger entry appears. Repeating this rejection returns the same
historical result and HTTP 422. Its rejection event is also delivered through the outbox.

### Record a WIN and LOSS

With the application running, use this independent example in a second
PowerShell terminal. It creates a fresh wallet, so the earlier BET/SQS examples
and their expected balances are unaffected.

```powershell
$baseUrl = 'http://127.0.0.1:3000'
$settlementOpening = @{
    playerId = [guid]::NewGuid().ToString()
    initialBalance = @{ amount = '10.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 5
$settlementWallet = Invoke-RestMethod -Method Post -Headers $operatorHeaders -Uri "$baseUrl/wallets" -ContentType 'application/json' -Body $settlementOpening

$winId = [guid]::NewGuid().ToString()
$winHeaders = @{ Authorization = "Bearer $providerToken"; 'Idempotency-Key' = "provider-a:$winId" }
$winRequest = @{
    providerId = 'provider-a'
    externalTransactionId = $winId
    playerId = $settlementWallet.playerId
    walletId = $settlementWallet.id
    roundId = 'round-win-loss'
    gameId = 'fortune-chimp'
    kind = 'WIN'
    money = @{ amount = '2.50'; currency = 'BRL' }
}
$winBody = $winRequest | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -Headers $winHeaders -ContentType 'application/json' -Body $winBody | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -Headers $winHeaders -ContentType 'application/json' -Body $winBody | ConvertTo-Json -Depth 5

$lossId = [guid]::NewGuid().ToString()
$lossHeaders = @{ Authorization = "Bearer $providerToken"; 'Idempotency-Key' = "provider-a:$lossId" }
$lossRequest = $winRequest.Clone()
$lossRequest.externalTransactionId = $lossId
$lossRequest.kind = 'LOSS'
$lossRequest.money = @{ amount = '0.00'; currency = 'BRL' }
$lossBody = $lossRequest | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -Headers $lossHeaders -ContentType 'application/json' -Body $lossBody | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -Headers $lossHeaders -ContentType 'application/json' -Body $lossBody | ConvertTo-Json -Depth 5

Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wallets/$($settlementWallet.id)" | ConvertTo-Json -Depth 5
Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wallets/$($settlementWallet.id)/ledger?limit=50" | ConvertTo-Json -Depth 5
```

Both results are PROCESSED. Their repeats have `idempotentReplay: true` and the
original transaction IDs. Final balance is `12.50`, version `2`, with two CREDIT
entries: opening and WIN. LOSS creates no ledger entry or balance event; its
WagerTransactionProcessed event still records the result. Replays retain their
original balances even after later wagers.

WIN requires a positive amount; LOSS requires exactly `0.00`. A credit exceeding
the supported wallet balance is a persisted REJECTED result with HTTP 422 and
`BALANCE_LIMIT_EXCEEDED`. WIN also accepts an optional reference as demonstrated below;
BET and LOSS reject reference fields. These rules and the lack of a round closure
rule are documented in ARCHITECTURE.md.

### Send a WIN before its BET

This independent example creates a fresh wallet and uses the default enabled
reference worker. Run the whole block with the application running. The
first request returns HTTP 202 because its BET does not exist yet. After submitting
that BET, polling waits for the background decision rather than assuming a fixed delay.

```powershell
$baseUrl = 'http://127.0.0.1:3000'
$referenceOpening = @{
    playerId = [guid]::NewGuid().ToString()
    initialBalance = @{ amount = '100.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 5
$referenceWallet = Invoke-RestMethod -Method Post -Headers $operatorHeaders -Uri "$baseUrl/wallets" -ContentType 'application/json' -Body $referenceOpening
$referenceBetId = [guid]::NewGuid().ToString()
$referenceWinId = [guid]::NewGuid().ToString()
$referenceRoundId = [guid]::NewGuid().ToString()
$referenceWinHeaders = @{ Authorization = "Bearer $providerToken"; 'Idempotency-Key' = "provider-a:$referenceWinId" }
$referenceWinBody = @{
    providerId = 'provider-a'
    externalTransactionId = $referenceWinId
    referenceExternalTransactionId = $referenceBetId
    playerId = $referenceWallet.playerId
    walletId = $referenceWallet.id
    roundId = $referenceRoundId
    gameId = 'fortune-chimp'
    kind = 'WIN'
    money = @{ amount = '25.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 5

$pendingHttp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$baseUrl/wagering/transactions" -Headers $referenceWinHeaders -ContentType 'application/json' -Body $referenceWinBody
$pendingWin = $pendingHttp.Content | ConvertFrom-Json
"HTTP $($pendingHttp.StatusCode); expected 202."
$pendingWin | ConvertTo-Json -Depth 5

$referenceBetBody = @{
    providerId = 'provider-a'
    externalTransactionId = $referenceBetId
    playerId = $referenceWallet.playerId
    walletId = $referenceWallet.id
    roundId = $referenceRoundId
    gameId = 'fortune-chimp'
    kind = 'BET'
    money = @{ amount = '10.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 5
$referenceBetHeaders = @{ Authorization = "Bearer $providerToken"; 'Idempotency-Key' = "provider-a:$referenceBetId" }
Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -Headers $referenceBetHeaders -ContentType 'application/json' -Body $referenceBetBody | ConvertTo-Json -Depth 5

$referenceDeadline = [DateTime]::UtcNow.AddSeconds(20)
do {
    $resolvedWin = Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wagering/transactions/$($pendingWin.transactionId)"
    if ($resolvedWin.status -ne 'PENDING_REFERENCE') { break }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $referenceDeadline)
if ($resolvedWin.status -ne 'PROCESSED') {
    throw "WIN did not complete: $($resolvedWin.status), $($resolvedWin.failureCode). Check the reference worker logs and configuration."
}
$resolvedWin | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -Headers $referenceWinHeaders -ContentType 'application/json' -Body $referenceWinBody | ConvertTo-Json -Depth 5
$completedReferenceWallet = Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wallets/$($referenceWallet.id)"
$referenceLedger = Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wallets/$($referenceWallet.id)/ledger?limit=50"
$completedReferenceWallet | ConvertTo-Json -Depth 5
$referenceLedger | ConvertTo-Json -Depth 5
"Expected balance 115.00, version 3, ledger entries 3."
"Actual balance $($completedReferenceWallet.balance.amount), version $($completedReferenceWallet.version), ledger entries $($referenceLedger.items.Count)."
```

The wallet receives no credit while the WIN is pending. The BET debits `10.00`, then
the worker credits `25.00` exactly once. Final balance is `115.00`, version `3`, with
opening CREDIT, BET DEBIT and WIN CREDIT. Repeating the WIN returns HTTP 200 with
the same transaction ID and `idempotentReplay: true`; it does not create another credit.

WIN accepts an optional `referenceExternalTransactionId`. Resolution is scoped to the
provider and requires a processed BET with the same player, wallet, currency and
round. Different game IDs and payout amounts are allowed. A present but invalid
reference produces a persisted rejection; the stable codes and matching order are
documented in ARCHITECTURE.md.

If the BET never arrives, ten missing worker checks eventually reject the WIN with
`REFERENCE_NOT_FOUND`. The initial lookup is not counted. Waits are 1, 2, 4, 8, 16,
32, 60, 60, 60 and 60 seconds, approximately 303 seconds without congestion or outage.
Repeating the request does not consume attempts. Infrastructure failures roll back
the attempt; a valid reference arriving before the tenth check can still complete.
The transaction query shows `referenceAttempts` and `nextReferenceAttemptAt` while
pending. `REFERENCE_WORKER_ENABLED=false` disables automatic resolution; leave its
default `true` for this example. Restart the application after changing that setting.

### Refund a BET, including out-of-order delivery

This standalone example creates another wallet. Submit the REFUND first to see
HTTP 202, then submit its BET for the same `25.00`. The background worker returns
the wallet to its opening balance. Keep `REFERENCE_WORKER_ENABLED` at its default
`true`, and run this whole block after completing the startup steps.

```powershell
$baseUrl = 'http://127.0.0.1:3000'
$refundOpening = @{
    playerId = [guid]::NewGuid().ToString()
    initialBalance = @{ amount = '100.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 5
$refundWallet = Invoke-RestMethod -Method Post -Headers $operatorHeaders -Uri "$baseUrl/wallets" -ContentType 'application/json' -Body $refundOpening
$refundableBetId = [guid]::NewGuid().ToString()
$refundId = [guid]::NewGuid().ToString()
$refundRoundId = [guid]::NewGuid().ToString()
$refundHeaders = @{ Authorization = "Bearer $providerToken"; 'Idempotency-Key' = "provider-a:$refundId" }
$refundPayload = @{
    providerId = 'provider-a'
    externalTransactionId = $refundId
    referenceExternalTransactionId = $refundableBetId
    playerId = $refundWallet.playerId
    walletId = $refundWallet.id
    roundId = $refundRoundId
    gameId = 'fortune-chimp'
    kind = 'REFUND'
    money = @{ amount = '25.00'; currency = 'BRL' }
}
$refundBody = $refundPayload | ConvertTo-Json -Depth 5
$pendingRefundHttp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$baseUrl/wagering/transactions" -Headers $refundHeaders -ContentType 'application/json' -Body $refundBody
$pendingRefund = $pendingRefundHttp.Content | ConvertFrom-Json
"HTTP $($pendingRefundHttp.StatusCode); expected 202."
$pendingRefund | ConvertTo-Json -Depth 5

$refundableBetBody = @{
    providerId = 'provider-a'
    externalTransactionId = $refundableBetId
    playerId = $refundWallet.playerId
    walletId = $refundWallet.id
    roundId = $refundRoundId
    gameId = 'fortune-chimp'
    kind = 'BET'
    money = @{ amount = '25.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 5
$refundableBetHeaders = @{ Authorization = "Bearer $providerToken"; 'Idempotency-Key' = "provider-a:$refundableBetId" }
Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -Headers $refundableBetHeaders -ContentType 'application/json' -Body $refundableBetBody | ConvertTo-Json -Depth 5

$refundDeadline = [DateTime]::UtcNow.AddSeconds(20)
do {
    $resolvedRefund = Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wagering/transactions/$($pendingRefund.transactionId)"
    if ($resolvedRefund.status -ne 'PENDING_REFERENCE') { break }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $refundDeadline)
if ($resolvedRefund.status -ne 'PROCESSED') {
    throw "REFUND did not complete: $($resolvedRefund.status), $($resolvedRefund.failureCode). Check the reference worker logs and configuration."
}
$resolvedRefund | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -Headers $refundHeaders -ContentType 'application/json' -Body $refundBody | ConvertTo-Json -Depth 5

$otherRefundId = [guid]::NewGuid().ToString()
$otherRefundPayload = $refundPayload.Clone()
$otherRefundPayload.externalTransactionId = $otherRefundId
$otherRefundBody = $otherRefundPayload | ConvertTo-Json -Depth 5
$otherRefundHeaders = @{ Authorization = "Bearer $providerToken"; 'Idempotency-Key' = "provider-a:$otherRefundId" }
try {
    Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -Headers $otherRefundHeaders -ContentType 'application/json' -Body $otherRefundBody
    throw 'Expected the second refund identity to be rejected.'
} catch {
    if ([int]$_.Exception.Response.StatusCode -ne 422) { throw }
    "HTTP 422; expected REFERENCE_ALREADY_REFUNDED."
    $_.ErrorDetails.Message
}

$completedRefundWallet = Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wallets/$($refundWallet.id)"
$refundLedger = Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wallets/$($refundWallet.id)/ledger?limit=50"
$completedRefundWallet | ConvertTo-Json -Depth 5
$refundLedger | ConvertTo-Json -Depth 5
"Expected balance 100.00, version 3, ledger entries 3."
"Actual balance $($completedRefundWallet.balance.amount), version $($completedRefundWallet.version), ledger entries $($refundLedger.items.Count)."
```

While pending, the refund does not credit the wallet. The BET debits `25.00` and
the refund later credits exactly `25.00` once. The ledger retains opening CREDIT,
BET DEBIT and REFUND CREDIT; the original BET is never changed or removed.
Repeating the successful refund with its same key and payload returns its original
transaction and balance with `idempotentReplay: true`, without another credit.
A separate refund identity for that BET is persisted as REJECTED with HTTP 422
and `REFERENCE_ALREADY_REFUNDED`; it adds no ledger entry.

REFUND requires a reference and positive amount. The reference must be a processed
BET from the same provider, player, wallet, currency and round. Different game IDs
are permitted, but unequal amounts produce `REFERENCE_AMOUNT_MISMATCH`; partial
refunds are unsupported. Missing references use the same ten-check schedule as
WIN. Pending and rejected refunds do not prevent a different valid refund from
succeeding; terminal rejected requests themselves never change.

### Roll back a WIN and replay the result

This standalone example creates a wallet with `100.00`, credits a WIN of `25.00`,
then debits that same `25.00` through ROLLBACK. Run the whole block with the application
started as described above and the operator/provider token variables defined.

```powershell
$baseUrl = 'http://127.0.0.1:3000'
$rollbackOpening = @{
    playerId = [guid]::NewGuid().ToString()
    initialBalance = @{ amount = '100.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 5
$rollbackWallet = Invoke-RestMethod -Method Post -Headers $operatorHeaders -Uri "$baseUrl/wallets" -ContentType 'application/json' -Body $rollbackOpening
$reversibleWinId = [guid]::NewGuid().ToString()
$rollbackRoundId = [guid]::NewGuid().ToString()
$reversibleWinBody = @{
    providerId = 'provider-a'
    externalTransactionId = $reversibleWinId
    playerId = $rollbackWallet.playerId
    walletId = $rollbackWallet.id
    roundId = $rollbackRoundId
    gameId = 'fortune-chimp'
    kind = 'WIN'
    money = @{ amount = '25.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 5
$reversibleWinHeaders = @{ Authorization = "Bearer $providerToken"; 'Idempotency-Key' = "provider-a:$reversibleWinId" }
Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -Headers $reversibleWinHeaders -ContentType 'application/json' -Body $reversibleWinBody | ConvertTo-Json -Depth 5

$rollbackId = [guid]::NewGuid().ToString()
$rollbackHeaders = @{ Authorization = "Bearer $providerToken"; 'Idempotency-Key' = "provider-a:$rollbackId" }
$rollbackPayload = @{
    providerId = 'provider-a'
    externalTransactionId = $rollbackId
    referenceExternalTransactionId = $reversibleWinId
    playerId = $rollbackWallet.playerId
    walletId = $rollbackWallet.id
    roundId = $rollbackRoundId
    gameId = 'fortune-chimp'
    kind = 'ROLLBACK'
    money = @{ amount = '25.00'; currency = 'BRL' }
}
$rollbackBody = $rollbackPayload | ConvertTo-Json -Depth 5
$rollbackResult = Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -Headers $rollbackHeaders -ContentType 'application/json' -Body $rollbackBody
$rollbackResult | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -Headers $rollbackHeaders -ContentType 'application/json' -Body $rollbackBody | ConvertTo-Json -Depth 5

$otherRollbackId = [guid]::NewGuid().ToString()
$otherRollbackPayload = $rollbackPayload.Clone()
$otherRollbackPayload.externalTransactionId = $otherRollbackId
$otherRollbackBody = $otherRollbackPayload | ConvertTo-Json -Depth 5
$otherRollbackHeaders = @{ Authorization = "Bearer $providerToken"; 'Idempotency-Key' = "provider-a:$otherRollbackId" }
try {
    Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -Headers $otherRollbackHeaders -ContentType 'application/json' -Body $otherRollbackBody
    throw 'Expected the second rollback identity to be rejected.'
} catch {
    if ([int]$_.Exception.Response.StatusCode -ne 422) { throw }
    "HTTP 422; expected REFERENCE_ALREADY_ROLLED_BACK."
    $_.ErrorDetails.Message
}

Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wagering/transactions/$($rollbackResult.transactionId)" | ConvertTo-Json -Depth 5
$completedRollbackWallet = Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wallets/$($rollbackWallet.id)"
$rollbackLedger = Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wallets/$($rollbackWallet.id)/ledger?limit=50"
$completedRollbackWallet | ConvertTo-Json -Depth 5
$rollbackLedger | ConvertTo-Json -Depth 5
"Expected balance 100.00, version 3, ledger entries 3."
"Actual balance $($completedRollbackWallet.balance.amount), version $($completedRollbackWallet.version), ledger entries $($rollbackLedger.items.Count)."
```

The balance follows `100.00 -> 125.00 -> 100.00`. The ledger retains opening CREDIT,
WIN CREDIT and ROLLBACK DEBIT. Replaying the same key and payload returns the original
rollback result with `idempotentReplay: true`; a new rollback identity for that WIN
receives HTTP 422 and `REFERENCE_ALREADY_ROLLED_BACK`, without another debit.

ROLLBACK also credits a referenced BET or debits a referenced REFUND. It requires
the same provider, player, wallet, currency, round and full amount; game IDs may
differ. OPENING, LOSS and ROLLBACK cannot be reversed. To exercise insufficient
funds separately, use a fresh wallet with `0.00`, credit a WIN of `25.00`, spend it
through BET, then roll back that WIN: expect `REVERSAL_INSUFFICIENT_FUNDS`, a
terminal rejection with balance `0.00` and no additional ledger entry.

An absent reference returns HTTP 202 and uses the same ten-check recovery schedule
as WIN/REFUND. An existing reference that is still PENDING_REFERENCE instead returns
terminal `REFERENCE_NOT_PROCESSED`. Later funds or reference completion do not change
that rejected request; another attempt needs a new external ID and idempotency key.
The README's uniqueness rule is per reversal kind: one REFUND and one ROLLBACK may
both target the same BET. Rolling back a REFUND does not permit a second REFUND for
its original BET, because the earlier successful refund remains immutable.

### Reconcile a wallet and inspect operations

With the application running, this standalone example creates a fresh wallet and
compares its stored balance with the ledger. The request correlation is echoed in
the response headers and carried into the opening's outbox events.

```powershell
$baseUrl = 'http://127.0.0.1:3000'
$inspectionBody = @{
    playerId = [guid]::NewGuid().ToString()
    initialBalance = @{ amount = '100.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 5
$inspectionHeaders = @{ Authorization = "Bearer $operatorToken"; 'X-Correlation-Id' = [guid]::NewGuid().ToString() }
$inspectionResponse = Invoke-WebRequest -Method Post -Uri "$baseUrl/wallets" -Headers $inspectionHeaders -ContentType 'application/json' -Body $inspectionBody
$inspectionWallet = $inspectionResponse.Content | ConvertFrom-Json
$inspectionResponse.Headers['X-Correlation-Id']
Invoke-RestMethod -Method Post -Headers $operatorHeaders -Uri "$baseUrl/wallets/$($inspectionWallet.id)/reconciliation" | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri "$baseUrl/health/live" | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri "$baseUrl/health/ready" | ConvertTo-Json -Depth 5
(Invoke-WebRequest -Uri "$baseUrl/metrics").Content
```

Expected reconciliation: both balances `100.00 BRL`, difference `0.00 BRL`,
`consistent: true`, and `checkedEntries: 1`. Difference means stored minus
calculated. The endpoint never changes a balance or ledger entry. A detected
divergence returns `consistent: false` with the signed difference, logs a sanitized
warning and increments `wagering_reconciliation_divergences_total`.

Liveness responds 200 while the application is alive. Readiness responds 200 only
when PostgreSQL and all three SQS queues are reachable; it responds 503 when a
dependency or configured queue is unavailable. `/metrics` returns Prometheus text,
including transaction decisions, duplicates, retries, DLQ settlement, lock conflicts,
latency, reconciliation and outbox backlog/lag. These endpoints need no extra service
or dashboard. Counters belong to this process and reset at restart; outbox gauges
describe shared database state. Do not sum those shared gauges across instances.

The integration suite injects divergence only into its isolated test database,
restores it afterward, and tests connection loss through local forwarding sockets.
It does not stop or corrupt the development services. Run `bun run test:integration`
to exercise those cases; no manual database damage is needed.

### Understand permanent failures

A known permanent SQL processing error is audited as `FAILED`, with
`failureCode: DATABASE_OPERATION_FAILED`, an unchanged balance and no ledger entry.
HTTP returns status 500 with the saved transaction-result envelope, including its
transaction ID. Either transaction GET route returns 200 and that stored FAILED
status. Repeating its exact identity replays the failure, even after the underlying
problem is repaired. It does not silently attempt the financial operation again.

For SQS, FAILED transaction, inbox and failure outbox event commit before DLQ send
and source deletion. Connection failures and ambiguous commits are retryable and
do not create a false FAILED result. If even the failure audit cannot be saved,
HTTP returns 503 `FAILURE_AUDIT_UNAVAILABLE`; SQS uses bounded retries and eventual
DLQ retention. The original DLQ envelope may be resubmitted after infrastructure
repair using `sqs:send`; keep its message ID and business identity for safe replay.
An already terminal FAILED transaction requires a new business identity for a new
attempt, not repeated redrive of the same failed decision.

Migration 008's downgrade refuses to remove FAILED records. The automated failure suite verifies this behavior
using controlled SQL faults, including failure of the audit itself and process
termination between audit commit and DLQ settlement.

### Submit the same BET through SQS

Use the same PowerShell terminal and `$wallet` from the HTTP examples. This creates
a new BET for `10.00 BRL`; its envelope identity and business idempotency key stay
unchanged when you send the file again.

```powershell
$queuedExternalId = [guid]::NewGuid().ToString()
$message = @{
    messageId = "message-$queuedExternalId"
    type = 'WagerTransactionRequested'
    occurredAt = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
    data = @{
        providerId = 'provider-a'
        externalTransactionId = $queuedExternalId
        idempotencyKey = "provider-a:$queuedExternalId"
        playerId = $wallet.playerId
        walletId = $wallet.id
        roundId = 'round-sqs-1'
        gameId = 'fortune-chimp'
        kind = 'BET'
        money = @{ amount = '10.00'; currency = 'BRL' }
    }
}
$messageFile = Join-Path $env:TEMP ("wager-" + [guid]::NewGuid().ToString() + '.json')
[IO.File]::WriteAllText($messageFile, ($message | ConvertTo-Json -Depth 6))
bun run sqs:send "$messageFile"

Start-Sleep -Seconds 2
Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/providers/provider-a/wagering/transactions/$queuedExternalId" | ConvertTo-Json -Depth 5
$afterFirstDelivery = Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wallets/$($wallet.id)"
$afterFirstDelivery | ConvertTo-Json -Depth 5

bun run sqs:send "$messageFile"
Start-Sleep -Seconds 2
$afterRepeatedDelivery = Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wallets/$($wallet.id)"
$afterRepeatedDelivery | ConvertTo-Json -Depth 5
"Balance unchanged: $($afterRepeatedDelivery.balance.amount -eq $afterFirstDelivery.balance.amount)"
"Version unchanged: $($afterRepeatedDelivery.version -eq $afterFirstDelivery.version)"
Invoke-RestMethod -Headers $operatorHeaders -Uri "$baseUrl/wallets/$($wallet.id)/ledger?limit=50" | ConvertTo-Json -Depth 5
```

The send command confirms that SQS accepted the message; financial processing is
asynchronous. If the query returns 404 while the worker is still processing, repeat
the query shortly afterward. After the preceding HTTP examples, the first queue
delivery produces balance `65.00`, version `3`, and one additional DEBIT. If you ran
only wallet opening, expect `90.00` and version `2` instead. Sending the same file
again must preserve both the current balance and version.

`sqs:send` validates the envelope and business fields, chooses the canonical wallet
UUID as `MessageGroupId`, and creates a fresh broker deduplication ID for every send.
This deliberately lets repeated submissions reach PostgreSQL, demonstrating durable
inbox/idempotency protection independently of FIFO's temporary deduplication window.
The JSON file remains in your temporary directory for further replay experiments.
The same envelope and `sqs:send` command accept WIN, LOSS, REFUND and ROLLBACK: set `data.kind` and
the corresponding amount, using a new business identity for a new operation.
For referenced WIN and every REFUND/ROLLBACK, also set `data.referenceExternalTransactionId`;
a REFUND or ROLLBACK amount must equal its reference. The same matching rules and shared validation
apply. A pending WIN, REFUND or ROLLBACK is acknowledged after its schedule,
transaction, pending event and inbox commit. Its completed inbox means durable
acceptance; the SQL worker owns completion, allowing a later reference through the same
FIFO wallet group. Repeating that envelope after completion returns the final result
without another financial effect. No additional CLI or queue is required.
To replay an HTTP result through SQS, preserve all its business fields and its
idempotency key; the consumer adds an inbox record without another financial effect.

Look for `sqs_acknowledged` logs with the envelope message ID, transaction ID and
`idempotentReplay`. An insufficient-funds BET is persisted as REJECTED and acknowledged;
it is not sent to DLQ. Invalid/conflicting requests and permanent database failures
go to DLQ immediately. Transient failures retry after 1, 2, 4 and 8 seconds, then
go to DLQ at the fifth receive with `RETRY_EXHAUSTED`.

The consumer defaults to enabled. `SQS_CONSUMER_ENABLED=false` disables it for
diagnostics; `SQS_VISIBILITY_TIMEOUT_SECONDS` defaults to 30 and accepts integers
from 2 through 43200. Visibility is renewed during processing. Ordinary setup
discovers `wager-transactions.fifo` and `wager-transactions-dlq.fifo`; isolated tests
can override `SQS_WAGER_QUEUE_URL` and `SQS_WAGER_DLQ_URL`.

Inspect completed inbox records without modifying them:

```powershell
docker compose exec postgres psql -U wagering -d wagering -c "select consumer_name, message_id, transaction_id, processed_at from inbox_messages order by received_at desc limit 10;"
```

### Try outbox publication manually

Keep Docker and the application running. The outbox publisher sends committed
pending events, including records retained across application restarts.

Create a wallet or BET with the examples above and look for `outbox_published` JSON
logs in the application terminal. Inspect the persisted delivery state from a second
PowerShell terminal:

```powershell
docker compose ps
docker compose exec postgres psql -U wagering -d wagering -c "select event_type, attempts, next_attempt_at, published_at from outbox_messages order by occurred_at desc limit 10;"
```

A non-null `published_at` means SQS accepted the event and that acknowledgment was
recorded in PostgreSQL. It does not mean a downstream business consumer processed it.
`attempts` counts failed sends; retries keep the original `eventId` and envelope.
`outbox_retry_scheduled` logs indicate a failed attempt retained for retry.

Development MiniStack is at `http://127.0.0.1:4566`; the separate test instance is at
port 4567. `SQS_ENDPOINT` overrides the local endpoint. The SDK always uses dummy
local credentials. `OUTBOX_PUBLISHER_ENABLED=false` disables the worker when needed;
leave it at its default `true` for this manual flow. Advanced tests can supply a
specific `SQS_EVENTS_QUEUE_URL`; ordinary setup discovers `wager-events` automatically.

If MiniStack was recreated, `bun run sqs:setup` safely ensures all queues exist.
Its development volume saves emulator snapshots on clean shutdown; abrupt broker
loss/reset is not a durability guarantee. Pending PostgreSQL outbox records survive
publisher crashes; already-published messages cannot be recovered automatically from
an empty/reset broker. Input FIFO retention is four days; DLQ and output event
retention are fourteen days. The input queue's broker redrive limit is five receives.

## Additional application processes, when needed

Ordinary browser use needs only the process on port 3000. To manually run three
independent instances, first build once with `bun run build`, then run one of the
following commands in each of three terminals, from the repository directory:

```powershell
# Terminal 1: the frontend and first API instance.
$env:PORT = '3000'; bun dist/main.js

# Terminal 2: another API instance using the same PostgreSQL and SQS resources.
$env:PORT = '3002'; bun dist/main.js

# Terminal 3: another API instance using the same PostgreSQL and SQS resources.
$env:PORT = '3003'; bun dist/main.js
```

Each instance needs its own listening port; three independent servers cannot all
bind the same local address and port. Port 3001 is reserved for optional Grafana.
Keep the browser at `http://127.0.0.1:3000/demo`, whose callback is registered with
Keycloak. Use terminal API requests for the additional ports, with the same valid
tokens. There is no browser process selector or load balancer. Stop an instance with
Ctrl+C and run its command again to restart it. Automated integration tests already
start independent processes and coordinate the precise fault boundaries required
by the README; no manual multi-process setup is needed before running those tests.

## Tests and checks

Run unit tests and static checks without starting the API:

```powershell
bun run test:unit
bun run typecheck
bun run build
```

Run the external authentication checks separately:

```powershell
bun run test:auth
```

This runner starts disposable Keycloak/PostgreSQL/SQS services and obtains real
tokens automatically. The financial integration suites disable authentication only
in their isolated processes; the ordinary application keeps it enabled. Run
integration, authentication and load suites one at a time because they share the
test database and broker. They do not reset development data. The optional
[load experiment](#load-testing) documents its own parameters and measurements.

For the Money suite alone, use `bun test src/domain/money.test.ts`.
Plain `bun test` runs the unit suites and reports integration tests as skipped unless
explicitly enabled; a skipped suite is not evidence of PostgreSQL integration passing.
There is no linter configured.

Run real PostgreSQL and MiniStack SQS integration tests with:

```powershell
bun run test:integration
```

The runner starts the separate `postgres-test` and `ministack-test` Compose services,
initializes the test output queue, builds the application
and launches **three independent Bun application processes** on temporary localhost
ports. It supplies the explicit test environment and closes its application processes
afterward. No manually started API is needed.

To run the same integration suites in Linux, including the native SIGTERM test,
use Docker from the same PowerShell terminal:

```powershell
bun run test:integration:linux
```

This builds a test image with official Bun 1.4.3 and installs Linux dependencies
from the frozen lockfile. The first run downloads the image and dependencies;
later runs reuse Docker's build cache. No separate Linux installation is required.
Application instances remain independent OS processes inside the runner container.
The container is removed after the run; the isolated PostgreSQL/SQS services remain
available. The Windows command skips native SIGTERM; the Linux command runs it.
Choose either integration command for a full run, and never run them concurrently:
both use the same disposable test database and test broker.

Integration tests intentionally reverse/reapply migrations and reset only database
`wagering_test` on localhost port **55433**. The runner fixes that isolated URL and the
test suite checks it before any reset. The test service uses tmpfs: its data is
disposable and separate from the development volume. Do not run two copies of the
integration suite at the same time against that shared test database.
SQS tests use guarded localhost port 4567 and create/delete their own uniquely named
queues. Financial suites disable background messaging/reference workers so
assertions about newly enqueued events remain deterministic. Outbox, input and
reference suites enable the workers required by each scenario explicitly.

| File | Purpose |
| --- | --- |
| `tests/integration/wallet.test.ts` | Real HTTP/database opening, balance, ledger, constraints and duplicate creation across processes. |
| `tests/integration/bet.test.ts` | Idempotency, competing balances, historical results, rollback and restart recovery. |
| `tests/integration/win-loss.test.ts` | WIN credits, LOSS without movement, historical results, concurrency, exact limits, SQL constraints and shared HTTP/SQS processing. |
| `tests/integration/referenced-win.test.ts` | Referenced WIN matching, durable pending/replay, bounded retry, atomic recovery, concurrent workers and migration 005 guards. |
| `tests/integration/refund.test.ts` | Full BET refunds, competing identities, duplicate HTTP/SQS input, pending recovery, amount/identity guards and migration 006 preservation/refusal. |
| `tests/integration/rollback.test.ts` | Inverse BET/WIN/REFUND movements, competing reversals, insufficient funds, shared HTTP/SQS processing, pending recovery and migration 007 guards. |
| `tests/integration/failed.test.ts` | Durable permanent failures, 50 duplicates, audit rollback, pending failure, crash before DLQ settlement and migration 008 guards. |
| `tests/integration/reconciliation.test.ts` | Exact aggregate balances, signed divergence without repair, concurrent writers and consistent snapshots across three processes. |
| `tests/integration/double-entry.test.ts` | Exact accounting pairs, posting directions, concurrent HTTP/SQS operations, immutable records, atomic rollback and reversible journal reconstruction. |
| `tests/integration/tracing.test.ts` | Trace propagation through real HTTP, PostgreSQL outbox and SQS processing. |
| `tests/integration/telemetry-health.test.ts` | Correlation into outbox, metrics, real lock timeout, DLQ, reconciliation divergence and dependency readiness. |
| `tests/integration/recovery.test.ts` | Real PostgreSQL/SQS network disconnect and reconnection through test-local forwarding sockets, with three processes. |
| `tests/integration/database-outage.test.ts` | Real refused database connection and sanitized HTTP 503 response. |
| `tests/integration/outbox.test.ts` | Real SQS delivery after commit, multiple publishers, retry and crash recovery. |
| `tests/integration/sqs-wager.test.ts` | Real input delivery, inbox idempotency, concurrent consumers, retry/DLQ and recovery before acknowledgment. |
| `tests/integration/accounting-audit.ts` | Shared accounting consistency assertions; it is not a test suite. |
| `tests/integration/helpers.ts` | Shared database guards and process startup/cleanup helpers; it is not a test suite. |
| `tests/fixtures/pause-after-sqs-send.ts` | Test-only process paused after a real SQS send so its parent can kill it before publication commit. |
| `tests/fixtures/pause-before-sqs-ack.ts` | Test-only consumer paused after its financial commit, before deleting the input message. |
| `scripts/test-integration.ts` | Runs the containers, queue setup, build and integration suites in the isolated environment. |
| `scripts/test-linux-container.ts` | Connects container-local loopback ports to the Compose test services, sets up queues and runs the same integration suites on Linux. |
| `Dockerfile.test` | Installs Linux dependencies and compiles the application in a reproducible test image. |

You normally run `bun run test:integration` or `bun run test:integration:linux`,
not individual helper files. Unit tests live alongside their production code in `src/**/*.test.ts`.

The suite covers exact opening amounts, zero opening, duplicate/conflicting creation,
50 competing creates across three processes, 12 parallel distinct wallets, database
constraints, immutable ledger, atomic rollback on injected outbox failure, cursor
validation, and persistence after abrupt application termination and restart. Final
wallet balances must equal their ledger sums. The large-value ORM comparison test
rolls its diagnostic update back and leaves no inconsistent financial state. BET tests
also verify 50 duplicates across three processes, two bets of 80.00 against 100.00,
parallel wallets, wallet-lock independence, conflicting identities, immutable historical
results, a committed cent debit at the maximum amount, and processed/rejected outbox
failure rollback. Migration round trips preserve openings and refuse to erase BET history.

The HTTP recovery test discards a committed response body, kills the application,
restarts it, processes another wager and verifies the original replay. It is not an
SQS input acknowledgment test. Outbox tests separately force a real send followed
by publisher termination before its publication commit, then verify duplicate-safe
event identity and recovery. They also hold one publisher's claim while another
publishes other events and HTTP continues accepting bets. Input consumer tests cover
redelivery, death after commit before acknowledgment, and retry/DLQ handling. Reference
and reversal tests cover pending WIN, REFUND-before-BET, ROLLBACK inverse movements,
competing reversals and recovery across three independent processes. Accounting
audits verify journal coverage and exact posting totals alongside the wallet ledger.

## Load testing

The optional README experiment is available as:

```powershell
bun run test:load
```

It starts the existing isolated PostgreSQL and MiniStack services, builds the app,
resets only `wagering_test` on localhost port 55433, and starts three independent
application processes. Do not run it alongside integration tests, another load run,
or an authentication integration run: they share that disposable database.
Development wallets and queues are not reset. Every run creates its own SQS queues
and removes them after stopping its processes. Runs are repeatable.

Options are explicit and bounded:

```powershell
bun run test:load --requests 600 --concurrency 12
bun run test:load --requests 60 --concurrency 6
bun test tests/load/report.test.ts
```

`--requests` is per measured scenario (30–5000, default 600), and `--concurrency`
is the number of client workers (1–100, default 12). Arguments are validated before
starting containers or resetting the database. There is no RPS pass threshold.

### Methodology

After 30 warmup requests, two scenarios run sequentially:

1. **Hot wallet:** all distinct BETs debit the same wallet.
2. **Distributed wallets:** distinct BETs rotate across 20 wallets.

Every wager is exactly `"1.00" BRL`; every wallet opens with `"10000.00" BRL`,
enough for the maximum configured workload. HTTP requests rotate across the three
application processes. All three outbox publishers send events to real MiniStack SQS.
Input consumers and reference workers are disabled: this measures HTTP input with
SQS event output, not SQS input throughput. HTTP authentication and OpenTelemetry
are disabled only in these isolated benchmark processes to measure the financial
baseline; their overhead and Keycloak capacity are not included.

The workload is closed-loop: each client worker sends its next request after the
previous one completes. This does not model a fixed external arrival rate. Timings
use a monotonic clock and include complete HTTP responses, including errors and
the 15-second transport deadline. The client does not retry requests. Startup,
migrations, wallet creation, warmup, outbox drain and audit queries are outside the
request measurement window. p50/p95/p99 use the nearest-rank method, without dropping
slow requests or interpolating away a small sample's tail.

The report separates successful HTTP responses from committed database identities.
A transport failure does not imply the transaction rolled back. It records error
rate and codes, attempts/second, successful responses/second and committed
transactions/second. The financial audit checks every acknowledged identity, wallet
amount and version, ledger counts, exact reconstructed balances, and both published
events for every committed BET. It also checks a
matching journal pair per ledger entry, wallet posting totals and balanced global
debits/credits per currency. Unexpected terminal failures, invariant violations,
absence of successful operations, or an outbox drain exceeding 60 seconds fail the run.

A transport timeout or response-body parsing failure also makes the run fail:
ending a client request does not cancel work already executing on the server.
The harness still records available metrics and database audit snapshots for
diagnosis, but cannot certify final financial consistency after an ambiguous
response. Such reports include `ambiguousResponses`, omit a positive
`financialInvariantsPassed`, and set committed transactions/second to `null`:
a late commit could occur outside the HTTP measurement window. HTTP errors whose
response bodies were received and parsed remain measured errors, not ambiguous
transport failures. There are no automatic client retries.

Lock-error counters are summed as deltas across processes. They cover deadlocks,
serialization failures and lock timeouts, not normal waiting for a wallet lock or
connection-pool timeouts. Zero lock errors does not mean zero contention.

The outbox is a shared database gauge, so it is sampled from one process rather than
summed across replicas. The sampler waits 500 ms between completed metric requests
and records sample failures and maximum **observed** backlog/age during load and drain.
It may miss shorter peaks. A separate SQL query measures each event's persisted
`published_at - occurred_at` after publication. Sampling adds some overhead.

### Reports and measured results

Each run writes `reports/load/<timestamp>-<run-id>.json` plus `reports/load/latest.json`,
including environment, parameters, distinct PIDs, results and cleanup errors.
Reports are local generated files, excluded from Git. A failed run retains a partial
diagnostic report when possible and exits nonzero; inspect `passed`, `error` and
`cleanupErrors` before interpreting performance values.

The measured run below used `bun run test:load --requests 60 --concurrency 6` on
2026-10-12, 03:26:52–03:27:09 UTC. Environment: Bun 1.4.3, Windows 10 x64, AMD Ryzen
5 5500 with 12 logical CPUs and approximately 32 GiB host RAM. Docker Engine 29.7.2
ran Linux containers with 12 CPUs and approximately 15.6 GiB RAM, PostgreSQL 17.6
and MiniStack 1.5.24. Independent application PIDs were 41328, 41316 and 35008.

All 120 measured requests and 30 excluded warmup requests returned HTTP 200. Audits
verified wallet balances, ledger entries, journal coverage, balanced accounting
postings and published outbox events. No ambiguous responses, lock errors, outbox
retries, metric-sampling failures or cleanup errors occurred.

| Measure | Hot wallet | 20 wallets |
| --- | ---: | ---: |
| Requests / committed BETs | 60 / 60 | 60 / 60 |
| Requests per second | 18.31 | 55.77 |
| p50 / p95 / p99 | 287.66 / 580.17 / 712.82 ms | 106.80 / 141.23 / 160.15 ms |
| HTTP error rate | 0% | 0% |
| Lock errors / outbox retries | 0 / 0 | 0 / 0 |
| Maximum observed pending events | 12 | 59 |
| Maximum observed oldest pending age | 0.27 s | 0.63 s |
| Event publication p50 / p95 / p99 | 167 / 281 / 303 ms | 613 / 676 / 760 ms |
| Drain after HTTP requests | 0.11 s | 0.78 s |
| Financial invariants | Passed | Passed |

This short local run demonstrates financial consistency under concurrent load;
it is not a production capacity estimate. Other local presentation and monitoring
services shared the host. Authentication and tracing were disabled in the three
isolated load processes, so these measurements do not include their overhead.
The machine-readable report is saved under `reports/load/` (ignored by Git), with
run ID `5c74e7ea-085b-494c-8523-8d64fa6d50b5`.

## Database lifecycle

```powershell
bun run db:status
docker compose stop postgres
docker compose stop ministack
```

Stopping the container preserves development data. Start again with `bun run db:up`.
`docker compose down` also preserves the named development volume by default; the
optional test service's tmpfs data does not persist through container removal.

`bun run db:migrate` applies pending versioned migrations; `bun run db:rollback`
reverses the latest one. Downgrade guards refuse to discard financial decisions or
inbox identities that the target schema cannot represent. The accounting migration
permits reversal only when its journal can be reconstructed exactly from the retained
wallet ledger. See [versioned migrations](ARCHITECTURE.md#versioned-migrations) for
the conditions for each migration.

Migration 001's reverse operation drops application tables and their data, so
`db:rollback` is not a shutdown command. Both directions and their refusal conditions
are tested in the disposable integration database. Application startup never resets
the schema or applies migrations automatically.

## Validation results

Most recent recorded result for each check. The checks were run independently;
this table does not represent a single validation run.

| Check | Actual result |
| --- | --- |
| `bun run typecheck` | Passed |
| `bun run test:unit` | 698 passed, 0 failed; 2,433 assertions, 27 files, 3.29 s |
| `bun run test:auth` | 8 passed, 0 failed; 61 assertions, 2 files, 5.55 s, excluding startup/build |
| `bun run test:integration:linux` | 127 passed, 0 skipped, 0 failed; 2,988 assertions, 545.56 s |
| `bun run test:load --requests 60 --concurrency 6` | 120 measured requests and 30 warmup requests returned HTTP 200; wallet, ledger, accounting and outbox audits passed |
| `bun run start` | Built and started the Nest API and frontend on port 3000 |
| `bun run obs:check` | Grafana healthy, ten panels provisioned, real metrics available, exported trace stored in Tempo and queried through Grafana |
| Docker Compose configuration | Validation passed |

Browser verification used Keycloak PKCE login as `presenter`. Opening `100.00`
returned HTTP 201/version 1; BET `25.00` produced `75.00`/version 2; replay retained
that balance, version and transaction ID with `idempotentReplay: true`. WIN `50.00`
produced `125.00`/version 3, and LOSS `0.00` retained both. Reconciliation checked
three ledger entries, stored/calculated balances `125.00`, and difference `0.00`.

The Linux integration result includes native SIGTERM, three-process concurrency,
crash recovery, dependency outages, pending references and accounting consistency.
Native Windows integration skips the SIGTERM scenario; run the Linux command for
that check. Authentication and tracing are enabled in their dedicated suites;
financial integration and load processes use isolated test configuration.
Load parameters and measurement limits are described in [Load testing](#load-testing).
These local checks do not establish production capacity or broker durability after
an abrupt emulator failure. Rerun the listed commands to validate your checkout and
environment.
