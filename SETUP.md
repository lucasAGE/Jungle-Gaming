# Running wallets, HTTP/SQS wagers and outbox publication

The [README](README.md) is the preserved challenge specification.
[ARCHITECTURE.md](ARCHITECTURE.md) distinguishes implemented behavior from remaining
requirements. You can open a wallet, submit idempotent BET, WIN, LOSS, REFUND and ROLLBACK,
read their original results, inspect the balance/ledger, submit them through MiniStack
SQS, and publish committed events. Referenced WIN, REFUND and ROLLBACK can wait
durably for an absent reference and complete in the background.
You can also reconcile balances, inspect durable FAILED decisions and query
correlated operational metrics and dependency health.

The presentation UI is available at `/demo`; see [DEMO.md](DEMO.md) for the guided
walkthrough. HTTP authentication is now enabled by default through Keycloak. The
earlier validation sections below are historical records from their respective
increments. [LOAD_TESTING.md](LOAD_TESTING.md) documents the optional load experiment;
[observability/README.md](observability/README.md) covers the provisioned dashboard
and distributed traces. Use `bun run obs:up` and `bun run obs:check` for those services.

For the presentation with individual SQS/process/failure controls and a reset button,
use `bun run demo` and open `http://127.0.0.1:3100/demo`. It manages three real application
processes, dedicated PostgreSQL/MiniStack services and a BRL `100.00` seed wallet.
See [DEMO.md](DEMO.md) for reset semantics and manual sequences. This environment uses
ports **55434/4568**, separate from the normal development setup below. Stop it before
running `bun run test:demo`, which resets those same disposable demonstration resources.

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
with Ctrl+C. The root `/` route still returns 404; use the wallet routes below.
For the interactive presentation, open `http://127.0.0.1:3000/demo` and sign in through
Keycloak with the local demonstration account `presenter` / `presenter_local`.
These credentials belong to the external development IdP and are not a production setup.

When upgrading an earlier increment, stop all old application instances, run `bun run db:migrate`
to apply pending migrations through `Migration202610120001`, run `bun run sqs:up` to ensure the queues exist, then restart
with `bun run start`. Start Keycloak with `bun run auth:up` before using protected HTTP
routes. If MiniStack is already running, `bun run sqs:setup` alone
ensures all three queues exist. Nothing else needs to be installed manually.
The ninth migration backfills the accounting journal without resetting wallets or
changing their balances. Old application binaries cannot satisfy its new constraints;
restart every instance with the updated build before accepting writes.

Configuration defaults match `.env.example`: PostgreSQL is bound to localhost on
port **55432**, database `wagering`. No `.env` file is required for the default setup.
If customization is needed, copy `.env.example` to `.env` only when no existing `.env`
would be overwritten, then edit it. Bun loads the file. Existing environment variables
can also set `DATABASE_URL` and `PORT`, for example `$env:PORT = '3100'` before startup.
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

Sign in again afterward. The public `demo-ui` client retains Keycloak's `basic` scope
so user access tokens include `sub`, which the API requires. The auth test runner
recreates only its disposable `keycloak-test` container to apply the current fixture.

If Bun is missing, install it using the [official Windows instructions](https://bun.sh/docs/installation):

```powershell
Invoke-WebRequest https://bun.sh/install.ps1 -OutFile "$env:TEMP\bun-install.ps1"
& "$env:TEMP\bun-install.ps1" -Version 1.4.3
```

Open a new terminal afterward or use the PATH line above.

## Try the HTTP flow

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

## Place a BET and replay it

If the application was already running before this increment, stop it with Ctrl+C,
run `bun run db:migrate`, then restart with `bun run start` to load the new code.
After creating the wallet above, use the same second PowerShell terminal:

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

## Record a WIN and LOSS

With the updated application running, use this independent example in a second
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

## Send a WIN before its BET

This independent example creates a fresh wallet and uses the default enabled
reference worker. Run the whole block with the updated application running. The
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

## Refund a BET, including out-of-order delivery

This standalone example creates another wallet. Submit the REFUND first to see
HTTP 202, then submit its BET for the same `25.00`. The background worker returns
the wallet to its opening balance. Keep `REFERENCE_WORKER_ENABLED` at its default
`true`, and run this whole block after upgrading through migration 006.

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

## Roll back a WIN and replay the result

This standalone example creates a wallet with `100.00`, credits a WIN of `25.00`,
then debits that same `25.00` through ROLLBACK. Run the whole block after upgrading
through migration 007 and restarting the application.

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

## Reconcile a wallet and inspect operations

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

## Understand permanent failures

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

Migration 008 adds this status without rewriting earlier migrations. Its downgrade
refuses to remove FAILED history. The automated failure suite verifies this behavior
using controlled SQL faults, including failure of the audit itself and process
termination between audit commit and DLQ settlement.

## Submit the same BET through SQS

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

## Try outbox publication manually

Keep Docker running and use the startup/migration commands above. The restarted
application can publish previously committed pending
outbox records as well as new wallet/BET events.

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

## Tests and checks

Run unit tests and static checks without starting the API:

```powershell
bun run test:unit
bun run typecheck
bun run build
```

For the original Money suite alone, use `bun test src/domain/money.test.ts`.
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
available. The Windows command still skips native SIGTERM; the Linux command runs it.
Choose either integration command for a full run, and never run them concurrently:
both use the same disposable test database and test broker.

Integration tests intentionally reverse/reapply migrations and reset only database
`wagering_test` on localhost port **55433**. The runner fixes that isolated URL and the
test suite checks it before any reset. The test service uses tmpfs: its data is
disposable and separate from the development volume. Do not run two copies of the
integration suite at the same time against that shared test database.
SQS tests use guarded localhost port 4567 and create/delete their own uniquely named
queues. Existing financial suites disable background messaging/reference workers so
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
| `tests/integration/telemetry-health.test.ts` | Correlation into outbox, metrics, real lock timeout, DLQ, reconciliation divergence and dependency readiness. |
| `tests/integration/recovery.test.ts` | Real PostgreSQL/SQS network disconnect and reconnection through test-local forwarding sockets, with three processes. |
| `tests/integration/database-outage.test.ts` | Real refused database connection and sanitized HTTP 503 response. |
| `tests/integration/outbox.test.ts` | Real SQS delivery after commit, multiple publishers, retry and crash recovery. |
| `tests/integration/sqs-wager.test.ts` | Real input delivery, inbox idempotency, concurrent consumers, retry/DLQ and recovery before acknowledgment. |
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
publishes other events and HTTP continues accepting bets. Increment 5 adds input
redelivery, death after commit before acknowledgment, and retry/DLQ scenarios; their
final measured results are recorded below. Increment 7 adds pending WIN reference
scenarios. Increment 8 adds REFUND-before-BET and concurrent refund scenarios.
Increment 9 adds ROLLBACK inverse movements and reversal concurrency/recovery;
their actual validation results are recorded separately below.

## Database lifecycle

```powershell
bun run db:status
docker compose stop postgres
docker compose stop ministack
```

Stopping the container preserves development data. Start again with `bun run db:up`.
`docker compose down` also preserves the named development volume by default; the
optional test service's tmpfs data does not persist through container removal.

`bun run db:rollback` reverses the latest migration. Migration 007 preserves earlier
financial/inbox history, including REFUND and referenced WIN, and can be reversed
before any ROLLBACK has been accepted. It refuses to discard pending, rejected or
processed ROLLBACK history. Migration 006 preserves earlier
financial/inbox history, including referenced WIN, and can be reversed before any
REFUND has been accepted. It refuses to discard pending, rejected or processed
REFUND history. Migration 005 preserves earlier
unreferenced financial/inbox history and can be reversed before any reference history
exists; it refuses to discard pending or terminal references and their retry history.
Migration 004 preserves earlier
financial/inbox records and can be reversed before accepting WIN/LOSS history; it
refuses to discard those accepted results. Migration 003 can be reversed
while its inbox is empty and preserves existing financial records. It refuses to
discard any inbox history, because doing so would remove durable duplicate protection.
Migration 002 preserves opening
records but refuses rollback if any BET has been accepted, because migration 001
cannot represent that financial history. Use forward migrations after accepting BETs.
The initial migration's reverse
operation drops the application tables and their data, so this is not a routine
shutdown command. Both directions are verified in the disposable integration database.
Application startup never resets the schema or applies migrations automatically.

## Validation record

Environment recorded on **2026-10-10**: Windows x64 build 19045, PowerShell,
Bun `1.4.3+c6da4a4d3`, Git `2.56.0.windows.2`, Docker CLI/Engine `29.7.2`,
Docker Compose `v5.4.0`, Linux Engine through `desktop-linux`.

Increment 1 installed Bun from the official source and verified 75 Money tests,
192 assertions, strict type checking, build and the then-empty NestJS shell.
Those results describe the earlier increment, not the current integration scope.

| Increment 2 command / check | Actual result |
| --- | --- |
| `docker compose config --quiet` | Passed |
| Development and test PostgreSQL services | Healthy; official `postgres:17.6-alpine` image |
| Test migration `up`, `status`, `down`, `up` | Passed; down removed application tables and trigger function |
| Development migration up/status | Passed |
| Compiled migration status command | Passed; registration works in source and built JavaScript |
| `bun run test:unit` | 117 passed, 0 failed, 303 assertions |
| `bun test` without integration opt-in | 117 passed, 0 failed; Bun reports 21 skips (19 integration tests and 2 suite hooks) |
| `bun run test:integration` | 19 passed, 0 failed, 225 assertions, across 2 files |
| `bun install --frozen-lockfile` | Passed |
| Concurrent duplicate creation | 50 requests across 3 independent process IDs: 1 created, 49 conflicts, one credit |
| Independent wallet creation | 12 concurrent wallets; final balances match ledger sums |
| Forced outbox insert failure | All opening records rolled back; retry succeeded |
| Application termination/restart | Committed wallet, ledger, outbox and duplicate protection preserved |
| Unwrapped connection failure | Real refused TCP connection during transaction startup returned HTTP 503 with a sanitized error body |
| ORM exactness | Maximum supported amount preserved; one-cent dirty change persisted inside a rolled-back diagnostic transaction |
| `bun run typecheck`, `bun run build` | Passed during increment validation |
| `git diff --check` | Passed during increment validation |
| README preservation | Unchanged SHA-256: `3B3DFA9C89DC97A7A92E3F5C743CBB2F24CBEAA07ACA838FB696BE6DCE75BEE5` |

Increment 2 review found an unwrapped transaction-startup connection error that initially mapped
to HTTP 500. Explicit connection/pool error classification fixed it; the HTTP regression
and full integration run above passed. Generic application errors still return 500.
The review correction is complete.

| Increment 3 command / check | Actual result |
| --- | --- |
| `bun run test:unit` | 232 passed, 0 failed, 592 assertions across 9 files |
| Plain `bun test` | 232 passed, 0 failed; 44 skips (40 integration tests and 4 suite hooks) |
| `bun run test:integration` | 40 passed, 0 failed, 547 assertions across 3 files; 7.92 seconds |
| Development `db:migrate` / `db:status` | Migration 002 applied; migrations 001 and 002 executed, none pending |
| 50 simultaneous copies of one BET | 1 initial result, 49 replays; 1 debit and one wallet version increment across 3 processes |
| Two simultaneous bets of 80.00 against 100.00 | 1 processed, 1 rejected; final balance 20.00, 1 debit; retries unchanged |
| Independent wallet locks | Another wallet completed while a wallet row was deliberately locked |
| Idempotency recovery | Original processed/rejected responses preserved; restart and other wagers do not alter replay results |
| Outbox insert failure | Processed and rejected decisions rolled back completely; retries succeeded |
| Migration 002 | Down/up preserved openings; downgrade with BET history refused without changing records |
| Exact Money persistence | One-cent BET at maximum balance committed exactly and matched the ledger sum |
| `bun run typecheck`, `bun run build` | Passed |

The first integration run found a race: 1 of 50 duplicate requests incorrectly
returned 409 when a commit occurred between the two identity lookups. No double debit
occurred. Identity resolution now recognizes the same key discovered through the
external-ID lookup; four deterministic regression tests and the full integration suite
passed after the correction. Review found no remaining blocking issue in this increment.
Changes remain local; no commit or push was made.

| Increment 4 command / check | Actual result |
| --- | --- |
| MiniStack image download and Compose health | Development 4566 and test 4567 healthy; upstream 1.5.24 pinned by digest |
| `bun run sqs:setup`, repeated | Passed; existing queue preserved |
| Real SDK queue smoke check | Create, URL lookup, send, receive, delete and attributes passed against isolated MiniStack test queue |
| SDK network timeout | A server that never responds produced TimeoutError in 3018 ms, with exactly one request |
| `bun run test:unit` | 246 passed, 0 failed, 717 assertions across 11 files |
| Plain `bun test` | 246 passed, 0 failed; 50 skips (44 integration tests and 6 suite hooks) |
| `bun run test:integration` | 44 passed, 0 failed, 600 assertions across 4 files; 25.43 seconds |
| Publication before financial commit | Test barrier held uncommitted opening; no visible wallet/outbox/event until commit |
| Concurrent publishers | Two publisher processes and three application processes; event envelopes preserved |
| Held outbox claim | Second publisher completed other rows while one publisher held its claim; wallet still accepted BET |
| SQS refusal/recovery | Pending state and backoff persisted; restarted publisher delivered original event IDs |
| Send/commit crash window | Real SQS send followed by SIGKILL before publication commit; surviving publisher recovered the same eventId |
| Nest lifecycle shutdown | Deterministic context-close test waited for send and persistence completion before shared resource shutdown |
| Polling failure | Deterministic failed-poll test confirmed the worker resumed polling |
| `bun install --frozen-lockfile`, typecheck, build | Passed |

The initial integration run exposed two test-fixture issues: raw PostgreSQL timestamps
were returned as strings, and a failed test's pending rows affected the next test queue.
The test now parses timestamps and isolates its database/application for each scenario.
The complete final integration command passed after these corrections. No publisher
production defect was found in that run or the independent review.

The lifecycle tests do not prove native SIGTERM delivery on Windows; process cleanup
may force SIGKILL after its grace period. Real publisher SIGKILL recovery was verified.
A full PostgreSQL outage during polling was not added in this increment; the existing
real HTTP connection-refusal test remains green. No new migration was needed, and the
original README remains unchanged. All changes are local, with no commit or push.

## Increment 5 validation record

Implementation adds SQS BET input, the transactional inbox, bounded retries/DLQ,
visibility renewal and the manual `sqs:send` helper. Unit/integration tests and static
checks completed with the measured results below.

| Increment 5 command / check | Actual result |
| --- | --- |
| `bun run test:unit` | 353 passed, 0 failed, 990 assertions across 17 files; 3.88 seconds |
| Plain `bun test` | 353 passed, 0 failed, 990 assertions; 62 skips (54 integration cases and 8 suite hooks); 4.06 seconds |
| `bun run test:integration` | 53 passed, 1 skipped, 0 failed, 695 assertions; 54 tests across 5 files, 100.17 seconds |
| `bun run typecheck`, `bun run build` | Passed |
| `bun install --frozen-lockfile` | Passed; no dependency changes |
| Development `db:migrate` / `db:status` | Migration 003 applied; migrations 001, 002 and 003 executed, none pending |
| `bun run sqs:send <message.json>`, repeated | Two real deliveries in an isolated test FIFO queue; original bodies and wallet groups preserved, distinct broker deduplication IDs; temporary queue/file removed |
| Migration 003 empty-inbox down/up and history-preserving refusal | Passed; financial records preserved, completed inbox identity/immutability enforced |
| Duplicate input and shared HTTP/SQS idempotency across three processes | Passed; 50 broker deliveries produced one debit; overlapping HTTP/SQS requests shared the same financial decision |
| Consumer death after commit, before acknowledgment | Passed; real SIGKILL at the test barrier followed by redelivery preserved the original transaction, balance, ledger and inbox |
| Retry, DLQ and atomic inbox/outbox rollback | Passed; transient failures rolled back every record, recovered after backoff, or reached DLQ after five receives without a financial effect |
| Native graceful SIGTERM on Windows | Skipped: the observed Bun child-process kill path forcibly terminates the process; this is not evidence of graceful shutdown |
| Documented PowerShell command syntax | All 12 command blocks parsed successfully |

The first full integration run exposed an incorrect migration target in the test
fixture: MikroORM's down target is inclusive. Correcting that target preserved the
opening-only round trip; the complete final run above passed. An independent code
review found no actionable defect within increment 5. Changes remain local, with
no commit or push.

Deterministic Nest lifecycle tests exercise graceful context closure separately from
abrupt process recovery. MiniStack itself remains running during consumer crash
tests; those tests do not establish broker durability after abrupt broker termination.

At the end of increment 5, full correlated logging, metrics, reconciliation,
liveness/readiness, FAILED persistence, WIN/LOSS and reversals remained pending.
The following record describes the next increment. The original README remains unchanged.

## Increment 6 validation record

Implementation adds unreferenced WIN, zero-amount LOSS, persistent credit-overflow
rejections and migration 004. No dependency or transport-specific financial processor
was added. The existing canonical BET hash and response contract remain valid.

| Command / check | Actual result |
| --- | --- |
| `bun run test:unit` | 398 passed, 0 failed, 1184 assertions across 17 files; 3.34 seconds |
| Plain `bun test` | 398 passed, 0 failed, 1184 assertions; 77 skips (67 integration cases and 10 suite hooks); 4.04 seconds |
| `bun run test:integration` | 66 passed, 1 skipped, 0 failed, 880 assertions across 6 files; 100.25 seconds |
| Focused WIN/LOSS integration rerun | 13 passed, 0 failed, 188 assertions; 13.51 seconds, after adding the explicit WIN/DEBIT SQLSTATE assertion |
| `bun run typecheck`, `bun run build` | Passed; build also ran through the official integration runner |
| Development `db:migrate` / `db:status` | Migration 004 applied; migrations 001–004 executed, none pending |
| 50 concurrent WIN copies across three independent processes | One credit, one version increment and two outbox events; other requests replayed |
| LOSS and concurrent distinct credits | LOSS preserved balance/version/updated_at and emitted one result event; credits had no lost updates; final balances matched ledger sums |
| Exact range and rejected replay | One-cent credit reached the numeric maximum exactly; overflow rejection remained immutable after a later debit |
| HTTP/SQS and recovery | Replays shared the original results; transient SQS failure rolled back inbox/financial records before retry; committed WIN survived process termination/restart |
| Migration and database constraints | Down/up preserved existing opening/BET/inbox history; new history prevented downgrade; invalid amounts, rejection codes, ledger direction and cross-kind identity collisions were rejected |
| PowerShell guide and source hygiene | All 13 command blocks parsed; tracked/untracked files checked for trailing whitespace and merge markers; `git diff --check` passed |

The focused integration rerun followed the full suite and added only a test assertion,
not a production change. It specifically verified a fresh WIN cannot create a DEBIT
ledger entry, with SQLSTATE 23514 from the direction guard and full fixture rollback.
The single full-suite skip is still native SIGTERM on Windows; graceful Nest lifecycle
and abrupt process recovery have separate passing tests. No test processes remained.

At the end of increment 6, WIN references, REFUND/ROLLBACK, pending-reference retry/expiry, persistent FAILED
transactions, reconciliation, complete correlated logs, metrics and health endpoints
remained unfinished. Broader infrastructure outage/recovery evidence was also pending.
An independent review found no actionable defect in this increment. No commit or
push was made, and the README's original SHA-256 remains unchanged.

## Increment 7 validation record

Implementation adds referenced WIN, durable pending acceptance and resolution,
bounded missing-reference retries, and migration 005. HTTP and SQS still share the
financial use case. No new dependency, endpoint, broker queue or CLI was added.

| Command / check | Actual result |
| --- | --- |
| `bun run test:unit` | 461 passed, 0 failed, 1445 assertions across 18 files; 4.05 seconds |
| Plain `bun test` | 461 passed, 86 skipped, 0 failed, 1445 assertions across 25 files; 4.55 seconds; integration suites disabled by default |
| `bun run typecheck`, `bun run build` | Passed |
| `bun run test:integration` | 75 passed, 1 skipped, 0 failed, 1185 assertions; 76 tests across 7 files, 166.95 seconds; includes the latest build |
| Focused referenced-WIN integration run | 9 passed, 0 failed, 301 assertions; 66.71 seconds; three additional fresh-insert constraint assertions were subsequently included in the full run above |
| Development `db:migrate` / `db:status` | Migration 005 applied; migrations 001–005 executed, none pending |
| 50 pending copies across three application processes | One transaction and one pending event; requests returned 202, then replayed one resolved credit after the BET arrived |
| Pending SQS acknowledgment and replay | A later BET in the same FIFO group completed; repeated envelopes preserved the inbox, credit and original correlation |
| Reference identity and invalid contracts | Correct BET accepted with different game/amount; mismatched identity, kind and status rejected persistently; provider lookup remained scoped; malformed/self references persisted nothing |
| Ten missing checks and expiry | Persisted backoff and acceptance balance verified without duplicate pending events; expiry saved one REFERENCE_NOT_FOUND rejection and no ledger movement |
| Initial/final outbox failure | Injected transient failures rolled back pending inbox acceptance and later credit finalization atomically; retry completed without duplicate effects |
| Three reference workers after restart | Six pending wallets survived application SIGKILL; three restarted process IDs completed each once after test-held wallet locks were released |
| Migration 005 and database guards | Downgrade/up preserved unreferenced financial/inbox history; reference history prevented downgrade; pending identity, state, ledger and resolved-reference constraints held |
| Cleanup | No application/fixture Bun processes remained; no other test database connections remained |
| PowerShell command syntax | All 14 command blocks parsed successfully |
| Source hygiene and README preservation | 97 source/configuration/documentation files checked without trailing whitespace or merge markers; `git diff --check` passed; original README SHA-256 unchanged |

The nine new integration scenarios compare every final wallet with its ledger sum.
Early focused runs required test-fixture corrections; the final focused and full
runs above passed. Those fixture failures did not identify a production defect.
The single full-suite skip remains native SIGTERM on Windows, distinct from the
passing graceful Nest context-closure and abrupt process-recovery checks.

At the end of increment 7, REFUND/ROLLBACK, persistent FAILED
transactions, reconciliation, complete correlated logs, metrics and health endpoints
remained unfinished. Reversal-before-reference and broader infrastructure outage/recovery
scenarios still needed evidence. That increment did not complete the full README contract.

## Increment 8 validation record

Implementation adds full BET refunds through the shared HTTP/SQS financial use case,
duplicate-refund protection, pending-reference recovery and migration 006. No new
dependency, queue, endpoint or worker was added.

| Command / check | Actual result |
| --- | --- |
| Focused application validation/replay tests | 148 passed, 0 failed, 226 assertions across 3 files; 194 ms |
| Focused REFUND domain/event tests | 155 passed, 0 failed, 662 assertions across 2 files; 171 ms |
| `bun run test:unit` | 514 passed, 0 failed, 1694 assertions across 18 files; 4.70 seconds |
| Plain `bun test` | 514 passed, 95 skipped, 0 failed, 1694 assertions across 26 files; 5.08 seconds; integration suites disabled by default |
| `bun run typecheck` | Passed after schema and application changes |
| `bun run build` | Passed before the focused integration suite and through the official full integration runner |
| Focused REFUND integration suite | 9 passed, 0 failed, 280 assertions; 73.49 seconds; first focused run passed |
| `bun run test:integration` | 84 passed, 1 skipped, 0 failed, 1464 assertions; 85 tests across 8 files, 237.38 seconds; includes all 9 REFUND scenarios and the latest build |
| Development `db:migrate` / `db:status` | Migration 006 applied; migrations 001–006 executed, none pending |
| 50 duplicate requests and 12 distinct refund identities across three processes | Duplicate requests returned one credited result; distinct identities produced one successful refund and 11 immutable REFERENCE_ALREADY_REFUNDED rejections |
| REFUND before BET through SQS and restart | Pending acceptance acknowledged; after SIGKILL, three restarted workers settled three wallets once despite competing refunds; final balances matched ledger sums |
| Reference, amount, overflow, expiry and atomicity | Invalid references and unequal amounts rejected; rejected overflow did not reserve the BET; ten missing checks expired without movement; injected outbox failures rolled back inbox acceptance and finalization |
| Migration 006 and database guards | Down/up preserved processed/pending WIN references and inbox/outbox history; REFUND history prevented downgrade; required reference, exact amount, processed-refund uniqueness and CREDIT direction enforced |
| Cleanup and environment | All four Compose services healthy; no application/fixture Bun processes remained |
| PowerShell command syntax | All 15 command blocks parsed successfully |
| Source hygiene and README preservation | 99 tracked/untracked source, configuration and documentation files checked without trailing whitespace or merge markers; `git diff --check` passed; original README SHA-256 unchanged |

The first focused REFUND integration run and the final full suite both passed.
Independent schema, domain and application review found no blocking defect in
this increment. All changes remain local; no commit or push was made.

At the end of increment 8, ROLLBACK, persistent FAILED transactions, reconciliation,
complete correlated logs, metrics and health endpoints remained unfinished. Broader
infrastructure outage/recovery scenarios also needed additional evidence. The native
Windows SIGTERM limitation was unchanged; graceful Nest context closure and abrupt
process recovery are separate checks. That increment did not complete the full README contract.

## Increment 9 validation record

Implementation adds ROLLBACK through the shared HTTP/SQS financial use case,
inverse BET/WIN/REFUND ledger movements, per-kind reversal uniqueness, explicit
reversal insufficiency and migration 007. No dependency, queue, endpoint or worker
was added. Earlier migrations and the original README remain unchanged.

| Command / check | Actual result |
| --- | --- |
| Focused application validation/replay tests | 157 passed, 0 failed, 245 assertions across 3 files; 101 ms |
| Focused ROLLBACK domain/event tests | 220 passed, 0 failed, 974 assertions across 2 files; 76 ms |
| `bun run test:unit` | 588 passed, 0 failed, 2025 assertions across 18 files; 2.88 seconds |
| Plain `bun test` | 588 passed, 105 skipped, 0 failed, 2025 assertions across 27 files; 3.26 seconds; integration suites disabled by default |
| `bun run typecheck` | Passed after schema and application changes |
| `bun run build` | Passed before the focused integration suite and through the official full integration runner |
| Focused ROLLBACK integration suite | 10 passed, 0 failed, 359 assertions; 28.44 seconds; first focused run passed |
| `bun run test:integration` | 94 passed, 1 skipped, 0 failed, 1822 assertions; 95 tests across 9 files, 143.82 seconds; includes all 10 ROLLBACK scenarios and the latest build |
| Development `db:migrate` / `db:status` | Migration 007 applied; migrations 001–007 executed, none pending |
| Inverse movements and immutable history | ROLLBACK credited BET and debited WIN/REFUND exactly once while preserving all original transactions and ledger entries |
| 50 concurrent copies and distinct reversal identities across three processes | Copies replayed one debit; competing identities could not reverse the same WIN twice |
| Reversal eligibility and balance rejection | REFUND and ROLLBACK retained independent slots; reversing a REFUND did not free its BET; insufficient funds and overflow were persisted without reserving eligibility |
| Out-of-order SQS and recovery | ROLLBACK before BET, WIN and REFUND committed pending acceptance, survived process termination and completed once after three process restarts; final balances matched ledger sums |
| Atomicity and reference expiry | Injected outbox failures rolled back pending inbox acceptance, debit finalization and rejected decisions; ten missing checks expired without wallet or ledger movement |
| Migration 007 and database guards | Down/up preserved earlier reference/inbox/outbox history; ROLLBACK history prevented downgrade; exact amount, required/eligible references, uniqueness and inverse ledger directions enforced |
| Cleanup and environment | All four Compose services healthy; no application/fixture Bun processes remained |
| PowerShell command syntax | All 16 command blocks parsed successfully |
| Source hygiene and README preservation | 101 tracked/untracked files checked without trailing whitespace or merge markers; `git diff --check` passed; original README SHA-256 unchanged |

The first focused ROLLBACK integration run and the final full suite both passed.
Independent schema, domain and application review found no blocking defect in this
increment. The PowerShell examples were syntax-checked; equivalent HTTP behavior
was verified by integration tests. All changes remain local; no commit or push was made.

At the end of increment 9, persistent FAILED transactions, reconciliation,
complete correlated logs, metrics and health endpoints remained unfinished.
Broader infrastructure outage/recovery scenarios still needed evidence. The single
full-suite skip was native SIGTERM on Windows; graceful Nest context closure and
abrupt recovery were separate passing checks. That increment did not complete the
full README contract.

## Increments 10–12 validation record

These increments add durable FAILED decisions and migration 008, exact read-only
reconciliation, sanitized correlated logs, operational metrics, liveness/readiness,
and network recovery tests. HTTP and SQS retain the same financial use case. No
dependency, dashboard, authentication system or additional infrastructure service
was added. The original challenge README and migrations 001–007 remain unchanged.

| Command / check | Actual result |
| --- | --- |
| FAILED focused domain/application/database-error unit tests | 291 passed, 0 failed, 1245 assertions; 204 ms; additional pending-winner and log-context tests are included in final unit totals below |
| Reconciliation unit tests | 13 passed, 0 failed, 30 assertions; 12 ms |
| Final observability/privacy unit tests | 21 passed, 0 failed, 65 assertions; 54 ms |
| Final plain `bun test` | 647 passed, 130 skipped, 0 failed, 2231 assertions; 777 tests across 35 files, 3.08 seconds; integration suites are disabled by default |
| `bun run typecheck` | Passed on final source |
| `bun run build` | Passed, including a final rebuild after the log-context sanitizer correction |
| FAILED focused integration | 6 passed, 0 failed, 70 assertions; 16.73 seconds |
| Reconciliation plus database-outage integration | 8 passed, 0 failed, 356 assertions; 4.44 seconds |
| `bun run test:integration` | 115 passed, 1 skipped, 0 failed, 2369 assertions; 116 tests across 13 files, 166.51 seconds |
| Final telemetry/health integration after sanitizer correction and rebuild | 6 passed, 0 failed, 65 assertions; 3.31 seconds |
| Development `db:migrate` / `db:status` | Migration 008 applied; migrations 001–008 executed, none pending |
| Development startup smoke check | Fresh compiled application returned HTTP 200 for live, ready and metrics; readiness reported PostgreSQL and SQS up; workers disabled for this read-only check, then process stopped |
| Permanent failure correctness | 50 copies across three processes shared one FAILED result; all five external kinds retained balance/ledger; failed audit rolled back inbox/outbox; pending failure stopped retries; crash before DLQ settlement recovered through three restarted processes |
| Reconciliation concurrency | 60 debit/snapshot pairs across three processes remained consistent; three readers waited for an uncommitted writer and observed its final balance and ledger together |
| Real network outage and recovery | Three application processes used local TCP forwarding to actual containers; SQS loss retained events until reconnection; PostgreSQL disconnect returned retryable responses and the same identity later debited once, without false FAILED decisions |
| Operational correctness | HTTP correlation reached outbox events; real PostgreSQL lock timeout incremented the lock metric and permitted safe retry; duplicates, rejection, DLQ and reconciliation divergence were counted; a deleted queue made readiness fail while liveness stayed available |
| Cleanup and environment | All four Compose services healthy; no Bun application or fixture processes remained |
| PowerShell syntax and source hygiene | All 17 command blocks parsed; 122 tracked/untracked files checked without trailing whitespace or conflict markers; `git diff --check` passed |
| Specification preservation | Original README SHA-256 remained `3B3DFA9C89DC97A7A92E3F5C743CBB2F24CBEAA07ACA838FB696BE6DCE75BEE5` |

The initial combined recovery/telemetry run passed both network recovery tests but
found two test-fixture errors: an unreferenced correlation was read from the pending
transaction column instead of its outbox envelope, and a test lock was issued without
the transaction context. Both fixtures were corrected; the focused telemetry suite
and subsequent full suite passed. A later narrow sanitizer correction preserves
all domain-valid business IDs in logs, including punctuation and 255-character IDs.
Final unit tests and rebuilt telemetry integration passed after that correction;
the full financial regression above preceded only this diagnostic correction.

The single integration skip is native SIGTERM delivery on Windows. Graceful Nest
context closure, abrupt application death, restart and redelivery are separately
tested. Do not treat those as proof of native Windows signal handling. Other limits
are documented in architecture: database-unavailable audit fallback to DLQ, process
metric resets, and MiniStack snapshot durability across broker/container loss.

Independent review found no blocking defect in the FAILED atomicity, reference
locking or reconciliation design. All work remains local and uncommitted. Manual
PowerShell examples are syntax-checked; equivalent HTTP behavior is covered by real
integration tests. The candidate can run the examples after startup without any
additional installation.

## Integration failure investigation — 2026-10-11

A candidate run on native Windows with Bun 1.4.3 reported 114 passed, one skipped
and one failed in 194.90 seconds. The failure was migration 008's history-preservation
test in `tests/integration/failed.test.ts`, taking 16.56 seconds. The supplied excerpt
contained the final summary and runner exit code, but not the original exception.
The runner's `exited with 1` reports a failed child command; it is not the root cause.

Reproduction used the unchanged application and tests, real isolated PostgreSQL/SQS
containers and three independent application processes:

| Command / check | Actual result |
| --- | --- |
| `bun test tests/integration/failed.test.ts --timeout 30000`, with the runner's isolated test environment | 6 passed, 0 failed, 70 assertions; 16.56 seconds |
| `bun run test:integration` | Build passed; 115 passed, 1 skipped, 0 failed, 2369 assertions; 172.78 seconds |
| `bun test tests/integration/failed.test.ts --timeout 30000 --test-name-pattern 'migration 008' --rerun-each 10`, with the same isolated environment | 10 passed, 50 filtered out, 0 failed, 100 assertions; 22.30 seconds |

The reported failure remains unexplained. HTTP requests in this suite and application
startup each have a 15-second deadline, making a timeout plausible, but elapsed time
alone cannot identify the failing step or establish its cause. Passing reruns do not
prove that the intermittent failure is fixed. No implementation, assertion, migration
or timeout was changed. The original exception is needed for further diagnosis.

A subsequent candidate-reported Windows run passed 115 tests, skipped native SIGTERM
and had no failures in 166.94 seconds. This investigation is closed without a confirmed
cause or claimed fix; the record is retained as historical validation evidence.

Full integration runs take minutes because they repeatedly start processes and test
real retries, visibility delays and crash recovery. Migration `Reverted`/`Applied`
messages are expected in the disposable test database. The native Windows SIGTERM
skip is a separate, documented limitation. Tests are repeatable; run only one
integration suite at a time against the shared test database.

To retain the complete output, including the first exception above the final summary:

```powershell
bun run test:integration 2>&1 | Tee-Object -FilePath "$env:TEMP\jungle-integration.log"
```

## Linux shutdown validation and final contract review — 2026-10-11

The README explicitly requires graceful SIGTERM handling in section 10 and real
multi-process recovery tests in section 13. The Linux test runner closes the native
signal validation gap without requiring a separate Linux installation or changing
financial application code. It uses official Bun 1.4.3 (Linux x64), the existing
PostgreSQL 17.6 and MiniStack 1.5.24 test services, and independent application processes.

Measured final validation:

| Command / check | Actual result |
| --- | --- |
| `bun run test:unit` on Windows | 647 passed, 0 failed, 2231 assertions; 22 files, 4.26 seconds |
| `docker compose --profile test run --build --rm integration-linux bun scripts/test-linux-container.ts tests/integration/sqs-wager.test.ts --test-name-pattern SIGTERM` | 1 passed, 9 filtered out, 0 failed, 6 assertions; 6.95 seconds |
| `docker compose --profile test run --build --rm integration-linux bun scripts/test-linux-container.ts tests/integration/reconciliation.test.ts --rerun-each 3` | 21 passed, 0 failed, 1248 assertions; 28.12 seconds; the three concurrent cases required 7, 0 and 2 transient retries |
| `bun run test:integration:linux` | 116 passed, 0 skipped, 0 failed, 2446 assertions; 13 files, 385.93 seconds; native SIGTERM passed and the concurrent reconciliation case recovered from 8 transient responses |
| `bun test tests/integration/reconciliation.test.ts --timeout 30000` on Windows, with the isolated test environment | 7 passed, 0 failed, 413 assertions; 10.92 seconds; no transient retries needed |
| `bun run typecheck` | Passed after the reconciliation test change |
| `bun run build` on Windows | Passed on final application source |
| Linux image build | Frozen dependency installation and TypeScript build passed |
| `docker compose --profile test --profile linux-test config --quiet` | Passed |
| Documentation and source hygiene | All 19 PowerShell blocks parsed; 123 source/configuration/documentation files checked without trailing whitespace or conflict markers; `git diff --check` passed |

The first full Linux attempt encountered `503` in the reconciliation concurrency
test and was stopped to investigate; it is not counted as a completed suite. A
focused run passed once (304 assertions, 7.72 seconds). Disabling TCP packet batching
in the test forwarder did not resolve the intermittent failure: the next three
repetitions had two passes and one failure (863 assertions, 30.69 seconds). A diagnostic
run again had two passes and one failure (883 assertions, 28.31 seconds), capturing
the actual response: `503 DATABASE_UNAVAILABLE`.

The original test required all 120 simultaneous requests to succeed on their first
attempt. The application already treats temporary connection-pool pressure as
retryable. Only this concurrency test now retries that exact response, with a maximum
of three attempts, bounded backoff and unchanged wager identities. It still starts
all 120 requests concurrently and now explicitly verifies 60 distinct PROCESSED bets,
60 debits, one opening credit, balance `40.00`, version 61 and consistent snapshots.
All requests finish before cleanup, even on failure. No application timeout, database
constraint, financial rule or migration was changed.

The native SIGTERM test holds the wallet lock while processing is in flight, sends
the real operating-system signal, then releases the lock. It verifies that the
consumer commits the debit and inbox, acknowledges the message and exits. Windows
continues to skip this specific signal test; Linux execution supplies the missing
evidence. Abrupt process death and restart remain separate scenarios.

Read-only reviews of financial correctness, messaging/recovery and the Linux runner
found no blocking defect or missing mandatory implementation. The requirement map
at the beginning of ARCHITECTURE.md separates mandatory behavior from optional work.
At that review, authentication omission retained its documented guard/authorization
extension point, and dashboards, load benchmarking and OpenTelemetry were outside
the agreed scope. The subsequent optional increment below supersedes that scope decision.

The complete Linux run covers the README's required concurrency and recovery cases,
including at least three independent processes. No known mandatory implementation
or Linux validation item remains open after this review. Native Windows SIGTERM,
MiniStack durability across broker/container loss and process-local monitoring still
have the limitations documented in ARCHITECTURE.md. No production deployment claim
is made by these local integration results. The original README and all eight
migrations remain unchanged; work remains local and uncommitted.

## Optional features and presentation validation — 2026-10-11

The candidate subsequently requested external authentication enabled by default,
OpenTelemetry, a dashboard, a load experiment and an interactive presentation UI.
The original README and all eight financial migrations remain unchanged. No
development financial database reset was needed. Double-entry accounting was deferred
at this stage and subsequently approved; see the next increment below. The existing
immutable wallet ledger is retained.

| Validation | Actual result |
| --- | --- |
| `bun run test:unit` | 676 passed, 0 failed; 2,357 assertions; 5.20 s |
| `bun run test:integration:linux` | 118 passed, 0 skipped, 0 failed; 2,460 assertions; 411.82 s |
| `bun run test:auth` | 8 passed, 0 failed; 55 assertions; 13.59 s, excluding Keycloak startup and build |
| Linux tracing and telemetry focused rerun | 8 passed, 0 failed; 90 assertions; 20.80 s |
| `bun test tests/load/report.test.ts` | 9 passed, 0 failed; 46 assertions; 23 ms |
| `bun run test:load --requests 60 --concurrency 6` | 120 measured requests and 30 warmup requests, all HTTP 200; exact ledger/outbox checks passed; no cleanup errors |
| `bun run typecheck`, `bun run build` | Passed |
| `bun run obs:check` | Grafana healthy, ten panels provisioned, real metrics available, real exported trace stored in Tempo and queried through Grafana |
| PowerShell examples and Compose configuration | 31 PowerShell blocks parsed successfully; combined Compose configuration valid |

The full Linux run includes native SIGTERM, three-process concurrency and recovery,
and two real PostgreSQL/SQS tracing scenarios. Subsequent changes only hardened
instrumentation failures so they cannot prevent/repeat processing or replace its
result. Unit fault-injection tests and the focused Linux rerun cover that final code.
The focused command is:

```powershell
docker compose --profile test run --build --rm integration-linux bun scripts/test-linux-container.ts tests/integration/tracing.test.ts tests/integration/telemetry-health.test.ts
```

An initial targeted invocation omitted `bun scripts/test-linux-container.ts`, replacing
the container command with a TypeScript filename; it failed before running any test.
The corrected invocation above passed. It is not counted as a test failure or a pass.

Browser verification used the real Keycloak Authorization Code + PKCE flow and an
authenticated API process on port 3100. It exercised opening `100.00`, BET `25.00`,
an identical replay, a changed-amount 409 conflict, a new `80.00` rejected BET, a
referenced WIN `10.00`, LOSS `0.00`, REFUND `25.00`, and ROLLBACK of that WIN `10.00`.
Final balance `100.00`, version 5, five ledger entries and reconciliation difference
`0.00` were verified. A subsequent API restart preserved authenticated ledger reads.

That browser check exposed two integration defects before completion: the SDK was
given a duplicated discovery-path suffix, and the public Keycloak client lacked the
`basic` scope that supplies the required user subject. Both were corrected. New
regressions cover the SDK issuer mapping, the real public PKCE/refresh flow and a
presenter token opening a wallet and placing a BET. The verifier was not relaxed.
Review also fixed unsupported LOSS references, incomplete response-body handling,
and observability exceptions; these are reflected in the final tests above.

The small repeated load run completed at 2026-10-12 02:48:04 UTC, using distinct PIDs
40788, 33556 and 38348. This confirms repeatability after the optional changes, not a
capacity comparison with the earlier 600-request baseline. See LOAD_TESTING.md for
both measurements. Financial fixtures disable auth/tracing by default; dedicated
authentication/tracing suites explicitly enable the feature under test.

Presentation history exists only in the browser session. Grafana's default scrape
target is the normal API on port 3000; a temporary preview on 3100 is not automatically
included. Tracing remains opt-in, exports are best effort, and pending-reference
workers retain correlation IDs without rejoining the original trace. These local
fixtures are not a production deployment. All work remains local and uncommitted.

## Optional double-entry validation — 2026-10-12

The candidate approved double-entry bookkeeping while asking to keep the model small.
The increment adds one account per wallet, one house settlement account and one
opening clearing account per enabled currency. A journal row stores one exact amount
shared by its debit and credit. Existing wallet ledger entries, public wager results,
idempotency, inbox/outbox boundaries and wallet locking remain in place.
`GET /wallets/:walletId/journal` and **Read accounting journal** in the presentation
expose those pairs to authenticated operators. See [ARCHITECTURE.md](ARCHITECTURE.md)
for the account meanings, constraints and migration decisions.

| Validation | Actual result |
| --- | --- |
| `bun run test:unit` | 698 passed, 0 failed; 2,433 assertions; 5.62 s |
| Focused wallet integration on Windows | 18 passed, 0 failed; 221 assertions; 13.46 s |
| Focused double-entry integration on Windows | 9 passed, 0 failed; 191 assertions; 15.21 s |
| `bun run test:integration:linux` | 127 passed, 0 skipped, 0 failed; 2,988 assertions; 545.56 s |
| `bun run test:auth` | 8 passed, 0 failed; 61 assertions; 15.90 s, excluding startup/build; journal reads require an operator token |
| `bun run test:load --requests 60 --concurrency 6` | 120 measured requests plus 30 warmup requests, all HTTP 200; wallet/ledger/accounting/outbox audits passed; no cleanup errors |
| `bun run typecheck`, `bun run build` | Passed |
| PowerShell documentation | All 31 examples parsed successfully |
| README preservation | SHA256 remains `3B3DFA9C89DC97A7A92E3F5C743CBB2F24CBEAA07ACA838FB696BE6DCE75BEE5` |

The new tests cover historical backfill and identical down/up reconstruction, zero
opening account coverage, exact maximum amounts, journal pagination, every posting
direction, absent postings for non-financial outcomes, 50 concurrent HTTP/SQS copies,
competing 80.00 bets against 100.00, independent wallets while the house row is held
with a write-conflicting lock, injected journal/outbox failures, opening rollback,
deferred coverage constraints and immutable accounting records. Thirteen existing
integration suites now also audit accounting consistency after their recovery,
reference, reversal and concurrency scenarios. Linux includes native SIGTERM.

The first full Linux invocation was stopped before completion to update an existing
pagination fixture that deliberately overrides ledger timestamps. It now applies
the same artificial timestamp to the journal before validation. The interrupted
invocation is not counted as a pass; the complete run above used the corrected
fixture. A new failure-injection barrier also checks PostgreSQL sequence `is_called`
instead of `last_value`, so assertions cannot run before the injected failure.

Development migration `Migration202610120001` was applied after stopping both old
application instances. A before/after comparison preserved all original rows:
2 wallets, 10 transactions, 7 ledger entries, 17 outbox records and 0 inbox records.
It added 4 accounting accounts, 7 journal transfers and 14 posting-view rows without
resetting data. Both local API ports (3000 and 3100) were restarted with the updated
application and mandatory authentication.

Browser validation used the existing Keycloak presenter session. The previous wallet
still had balance `100.00`, version 5 and five reconstructed journal transfers with
their original timestamps. A fresh wallet then opened with `100.00`, processed a
`25.00` BET and replayed it. The UI showed balance `75.00`, version 2, exactly two
journal transfers and reconciliation difference `0.00`. The displayed PowerShell
command calls the real protected journal endpoint; it contains no bearer token.

The final short load run completed at 2026-10-12 03:27:09 UTC using three independent
application PIDs (41328, 41316, 35008). It measured 18.31 requests/s on one hot wallet
and 55.77 requests/s across 20 wallets. This is a correctness and repeatability check
with auth/tracing disabled in isolated test processes, not a controlled capacity
comparison. Detailed latency and publication measurements are in [LOAD_TESTING.md](LOAD_TESTING.md).

This is a two-leg settlement model, not a general accounting or treasury product.
The house account has no mutable shared balance, solvency gate or real bank funds.
Current reconciliation retains its original balance-versus-ledger contract; the
automated audit separately checks accounting postings. No further optional features
were added. Work remains local and uncommitted.

## Isolated presentation controls validation — 2026-10-12

The candidate subsequently requested a reset/seed action and individual complex-scenario
controls. `bun run demo` now owns three real Nest processes, PostgreSQL 55434 and MiniStack
4568, with a separate resettable dataset. The ordinary development API/database remain
available. No migration was added or changed in this increment; README SHA-256 remains
`3B3DFA9C89DC97A7A92E3F5C743CBB2F24CBEAA07ACA838FB696BE6DCE75BEE5`.

Measured on Windows, Bun 1.4.3, Docker Engine 29.7.2:

| Check | Actual result |
| --- | --- |
| `bun run test:unit` | 703 passed, 0 failed; 2,478 assertions, 27 files, 3.94 s |
| `bun run test:demo` | 20 passed, 0 failed; 164 assertions, 3 files, 35.54 s |
| `bun run typecheck` and `bun run build` | Passed |
| PowerShell documentation blocks | 28 parsed without syntax errors; generated parallel command also parsed |

The demo suite includes 14 supervisor contract/security/lifecycle tests, one real parent
death/child cleanup test, and five PostgreSQL/SQS scenarios: reset removes old financial
history plus visible/in-flight messages; 50 copies share one financial effect; a consumer
dies after commit/before ACK; poison messages survive inspection/redrive; application
network outages retain committed events and recover. Every runtime scenario checks an
exact wallet/ledger/accounting snapshot. Three process IDs before reset were 43924, 33612,
37908; fresh processes afterward were 40840, 38624, 4872. Authentication remained enabled.

The first real run exposed a Windows lifecycle bug: Bun's `exited` promise resolved after
SIGTERM while `exitCode` remained null, so the harness mistakenly kept stopped processes
marked alive. Process tracking now clears its handle on the settled promise, with an
identity check. The complete rerun above passed. IPC cleanup also terminates children when
their supervisor dies. These changes are confined to demo tooling, not financial logic.

Browser verification through real Keycloak sign-in confirmed repeated reset with a fresh
`100.00` wallet; 50 simultaneous HTTP copies gave one applied BET and 49 replays, balance
`75.00`, version 2, reconciliation difference `0.00`. Two distinct `80.00` requests against
`100.00` gave one PROCESSED and one REJECTED/INSUFFICIENT_FUNDS, balance `20.00`. SQS replay
with the same and then a new envelope message ID produced two inbox records but one debit.
Crash/restart, DLQ inspection/redrive and the post-commit ACK barrier were also exercised
using the buttons. Another process consumed the held delivery without another ledger entry.
An HTTP REFUND submitted before its BET moved from PENDING_REFERENCE to PROCESSED
after that BET arrived, with both inverse ledger entries and a zero reconciliation difference.

Development record counts before and after isolated resets stayed at 3 wallets,
12 transactions, 9 ledger entries, 9 accounting transfers and 21 outbox records.
The full financial Linux suite and load experiment were not rerun in this presentation
increment; their preceding results remain recorded above. Constraint/migration corruption
and graceful Unix signal assertions remain automated CLI checks. See [DEMO.md](DEMO.md)
for manual controls, reset boundaries and known inspection/platform limitations.
