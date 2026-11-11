# Testing the hub and the web app

How to test everything, step by step, on a development machine. The commands were run on Windows on 2026-10-23 with
the results shown (the browser steps through the Playwright spec that clicks the same buttons). Paths are relative to
the folder that holds both: the hub in `ckbolt-hub/`, the web app in `ckbolt-web/`. Commands work in PowerShell and in
Git Bash unless a line says otherwise; run hub commands from the hub root and web commands from the web root.

## At a glance

| Level | Command | Needs | Time | Result on 2026-10-23 |
| --- | --- | --- | --- | --- |
| Hub type check | `npm run typecheck`, `npm --prefix devnet run typecheck` | nothing | 10 to 15 s each | clean |
| Hub unit tests | `npm test` | nothing (no network, no Docker) | 20 s | 91 suites, 2900 tests pass |
| Devnet script tests | `npx tsx --test "test/unit/*.test.ts"` in `devnet/` | nothing | 5 s | 106 tests pass |
| Devnet live checks | `npx tsx test/check.ts` in `devnet/` | devnet up | 15 s | 42 checks pass |
| Devnet smoke test | `npm --prefix devnet run smoke` | devnet up | 25 s | passed |
| Hub end-to-end tests | `npm run test:e2e` | devnet bootstrapped (it runs `up` itself) | 2 min | 6 suites, 23 tests pass |
| Web suite (mocked hub) | `npm run build`, then `npx playwright test` | Edge or a Playwright Chromium | 3 min plus the build | 723 tests pass (unit 425, desktop 149, mobile 149) |
| Real wallets on the test networks | [testing-testnet.md](testing-testnet.md) | the stack on the testnet server, an SSH tunnel, the web app on 3200 | 15 min | swaps complete both ways with your own wallets |
| Manual swaps | browser, PowerShell or curl | devnet, hub, web | 5 min | both directions settle; refunds and restart recovery work |

The order below goes from the cheapest to the most complete: unit tests first, then the devnet, then the hub on the
devnet, then the web app on the hub.

## 0. One-time setup

- **Node.js 22 or later** and npm (`node --version`).
- **Docker Desktop** (tested with Docker 28 and Compose v2.33) with about 3 GB of memory free for the devnet.
- **A browser for Playwright**: on Windows, Microsoft Edge is already installed, so set `PW_CHANNEL=msedge` (or run
  `npx playwright install chromium` once).
- Install the dependencies:

```
cd ckbolt-hub
npm install
npm --prefix devnet install
cd ../ckbolt-web
npm install
```

Setting an environment variable for one command differs between the shells:

| Git Bash | PowerShell |
| --- | --- |
| `HUB_URL=http://127.0.0.1:8787 npx next start -p 3200` | `$env:HUB_URL="http://127.0.0.1:8787"; npx next start -p 3200` |

A PowerShell `$env:` variable stays set for the rest of that window; remove it with `Remove-Item Env:HUB_URL`. In
Windows PowerShell 5.1 `curl` is an alias of `Invoke-WebRequest`: type `curl.exe` for the curl commands below, or use
`Invoke-RestMethod`.

## 1. Hub unit tests

```
cd ckbolt-hub
npm run typecheck                  # src and test
npm --prefix devnet run typecheck  # the devnet scripts and tests (own tsconfig)
npm test                           # Jest: src/**/*.spec.ts and test/unit/**/*.spec.ts
```

- They need no network, no Docker and no `.env`: the ports are faked by `test/fakes` (FakeLightningNetwork,
  FakeFiberNetwork, FakeClock, FakePriceSource, FakeSwapStore), which behave like LND and fnn where it matters. Besides
  `"succeed"`, `"fail"` and `"hang"`, a payout can be set to `"refuse"` (`setPayoutBehavior`): the paying node refuses
  to start it, so nothing is sent and it keeps no record. The fake LND auto-cancels accepted holds
  `holdExpiryDeltaBlocks` before the earliest HTLC expiry (18 by default, like `invoices.holdexpirydelta`) and, like
  LND, refuses a payment whose `cltv_limit` is not above the invoice's CLTV + 3. A fake fnn payer with
  `paysOverChannelOf` sends its TLC over a channel of another asset (a TLC fnn has committed but not rejected yet).
- One folder or file: `npx jest test/unit/swaps`, `npx jest swap-engine.safety`. Coverage: `npx jest --coverage`.
- `test/unit/integration/` boots the whole AppModule over HTTP with the fakes (swap lifecycle, error codes, shutdown
  order, config tunables, the caps on unpaid swaps).
- The security review's rules have their own specs: `swap-engine.safety` and `swap-engine.security`;
  `swap-engine.payout-recovery` (a payout the node refuses is refunded at once; one it has no record of is sent again
  at most `PAYOUT_MAX_RESENDS` times and refunded only after `PAYOUT_MISSING_CONFIRM_SECONDS`);
  `swap-engine.unpaid-caps` (`SWAP_MAX_UNPAID_PER_CLIENT` and `SWAP_MAX_UNPAID` in the engine);
  `swap-engine.held-asset-and-hold-delta` (held Fiber TLCs count only in the swap's asset; the Lightning hold is planned
  with `LND_HOLD_EXPIRY_DELTA_BLOCKS`); `unpaid-swap-caps.http` (the caps over HTTP: 429 with `Retry-After`, one client
  per X-Forwarded-For entry only behind a trusted proxy); `hub-config.security` (the new tunables, their defaults in
  `.env.example`, and the start-up checks on `PAYOUT_MISSING_CONFIRM_SECONDS` and `HUB_TRUST_PROXY`).

The devnet scripts have their own tests (Node's test runner), run from `devnet/`:

```
cd ckbolt-hub/devnet
npx tsx --test "test/unit/*.test.ts"
```

## 2. The devnet

A local Bitcoin regtest + LND x2 + CKB devnet + fnn x2 in Docker. `devnet/README.md` has the details (ports, secrets,
tunables); this is the short path. Run from the hub root with `npm --prefix devnet run <command>`, or from `devnet/` with
`npm run <command>`.

| Step | Command | When |
| --- | --- | --- |
| Start | `npm --prefix devnet run up` | Every time, after a stop or a Docker restart. Starts the containers with their saved state, rewrites `devnet/hub.env` if the host ports changed, reconnects the nodes and waits until every channel is active (5 s when already running). |
| Set up | `npm --prefix devnet run bootstrap` | Only the first time, after a reset, or when `up` fails. Builds the fnn image, funds the wallets, opens the channels, bakes the macaroons and writes `devnet/hub.env`. About 2 minutes. Safe to re-run. |
| Smoke test | `npm --prefix devnet run smoke` | Proves both legs work without the hub: a Lightning hold invoice and two Fiber sha256 hold invoices (CKB, RUSD), each held and settled. |
| Check | `npx tsx test/check.ts` (in `devnet/`) | Read-only checks of the running devnet against its spec: containers, secrets and `hub.env`, liquidity, the protocol behaviour the hub relies on. Its own invoices are cancelled, so no balance moves. |
| Mine | `npm --prefix devnet run mine -- 6` | When LND says it is not synced (the regtest tip is old). Bitcoin blocks come only from this; CKB blocks come every second on their own. |
| Logs | `npm --prefix devnet run logs` | Follow every container's log (Ctrl+C to leave). |
| Stop | `npm --prefix devnet run stop` | Stops the containers and keeps the state. |
| Reset | `npm --prefix devnet run reset` | Deletes the containers, volumes, state, secrets and `hub.env`. Run `bootstrap` afterwards, then copy `hub.env` to `.env` again. |

Expected output of `up` on a devnet that was set up before:

```
==> Starting the devnet containers (docker compose up)
==> Writing devnet/hub.env for the hub
    ...\ckbolt-hub\devnet\hub.env is up to date
==> Reconnecting the nodes and waiting for their channels
    Lightning: both channels active
    Fiber: fnn-hub and fnn-user are peers
==> Devnet up
```

If it ends with "The devnet is not set up yet: run npm run bootstrap", run `bootstrap`.

## 3. The hub against the devnet

### Start it

```
cd ckbolt-hub
npm --prefix devnet run up
cp devnet/hub.env .env          # cp is Copy-Item in PowerShell
npm run build
npm run start:prod              # node dist/main
```

Or `npm run start:dev` to rebuild and restart on every source change. The hub loads `.env` at start-up (variables already
set in the environment win) and logs `CKBolt hub listening on http://127.0.0.1:8787`. Copy `hub.env` again whenever `up`
or `bootstrap` says it changed. With `hub.env` the hub uses the demo wallet (lnd-user and fnn-user) and real exchange
prices, so quotes need internet access; `QUOTE_SIGNING_KEY` is unset, so the hub makes a new quote key at each start.

Stop it with Ctrl+C in its window, or by port from any PowerShell window:

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess }
```

### Check it

```
curl http://127.0.0.1:8787/v1/health
curl http://127.0.0.1:8787/v1/assets
```

`/v1/health` must say `"status":"ok"`, Lightning `"reachable":true,"synced":true` on `regtest`, Fiber reachable on
`devnet` version `0.9.1`, and `"demo":{"enabled":true}`. A 503 with `"status":"degraded"` names the node that is
unreachable or unsynced (see [Troubleshooting](#8-troubleshooting)). `/v1/assets` lists CKB and RUSD in both directions
with `minSats` 1000, `maxSats` 100000 and the liquidity each side can pay out.

### One swap each way through the API (demo wallet)

The demo wallet makes the payout invoice (`POST /v1/demo/invoices`) and pays the hold invoice (`POST /v1/demo/payments`),
so no node commands are needed. PowerShell:

```powershell
$hub = "http://127.0.0.1:8787/v1"

# CKB on Fiber -> BTC on Lightning: receive 10,000 sats
$quote  = Invoke-RestMethod -Method Post "$hub/quotes" -ContentType "application/json" -Body '{"direction":"fiber_to_ln","asset":"CKB","side":"receive","amount":"10000"}'
$payout = Invoke-RestMethod -Method Post "$hub/demo/invoices" -ContentType "application/json" -Body (@{ direction = "fiber_to_ln"; asset = "CKB"; amount = $quote.receive.amount } | ConvertTo-Json)
$swap   = Invoke-RestMethod -Method Post "$hub/swaps" -ContentType "application/json" -Body (@{ quoteId = $quote.id; payoutInvoice = $payout.invoice } | ConvertTo-Json)
Invoke-RestMethod -Method Post "$hub/demo/payments" -ContentType "application/json" -Body (@{ swapId = $swap.id } | ConvertTo-Json)
(Invoke-RestMethod "$hub/swaps/$($swap.id)").state                       # a few seconds later: succeeded
(Invoke-RestMethod "$hub/swaps/$($swap.id)/events").data | Format-Table at, type, detail

# BTC on Lightning -> CKB on Fiber: pay 10,000 sats
$quote  = Invoke-RestMethod -Method Post "$hub/quotes" -ContentType "application/json" -Body '{"direction":"ln_to_fiber","asset":"CKB","side":"pay","amount":"10000"}'
$payout = Invoke-RestMethod -Method Post "$hub/demo/invoices" -ContentType "application/json" -Body (@{ direction = "ln_to_fiber"; asset = "CKB"; amount = $quote.receive.amount } | ConvertTo-Json)
$swap   = Invoke-RestMethod -Method Post "$hub/swaps" -ContentType "application/json" -Body (@{ quoteId = $quote.id; payoutInvoice = $payout.invoice } | ConvertTo-Json)
Invoke-RestMethod -Method Post "$hub/demo/payments" -ContentType "application/json" -Body (@{ swapId = $swap.id } | ConvertTo-Json)
(Invoke-RestMethod "$hub/swaps/$($swap.id)").state
```

What you should see: the quote's `pay` and `receive` legs (amounts in base units: sats, or 10^-8 CKB), `feeBps` 100 (the
50 bps fee plus the 50 bps option premium), an `expiresAt` 3 minutes ahead; the swap starts `pending` with a `fibd...` or
`lnbcrt...` hold invoice and `demo: true`; one or two seconds after the demo payment it is `succeeded`, with the events
`created`, `incoming_accepted`, `payout_started`, `payout_succeeded`, `settled` and a `preimage` whose SHA-256 is the
`paymentHash`. Use `"asset":"RUSD"` for the stablecoin. Errors come back as `{"error":{"code","message"}}`; in
PowerShell read them with `try { ... } catch { $_.ErrorDetails.Message }`. A second swap on the same quote gives 409
`conflict`.

The same in Git Bash with curl (`node -pe` reads one field of the JSON):

```bash
H=http://127.0.0.1:8787/v1
json() { node -pe "JSON.parse(process.argv[1]).$2" "$1"; }
Q=$(curl -s -X POST $H/quotes -H "content-type: application/json" -d '{"direction":"fiber_to_ln","asset":"CKB","side":"receive","amount":"10000"}')
INV=$(curl -s -X POST $H/demo/invoices -H "content-type: application/json" -d "{\"direction\":\"fiber_to_ln\",\"asset\":\"CKB\",\"amount\":\"$(json "$Q" receive.amount)\"}")
S=$(curl -s -X POST $H/swaps -H "content-type: application/json" -d "{\"quoteId\":\"$(json "$Q" id)\",\"payoutInvoice\":\"$(json "$INV" invoice)\"}")
SID=$(json "$S" id)
curl -s -X POST $H/demo/payments -H "content-type: application/json" -d "{\"swapId\":\"$SID\"}"
curl -s $H/swaps/$SID
curl -s $H/swaps/$SID/events
```

### Force a refund

Make the payout impossible before paying: cancel the payout invoice on the demo node. Both legs share one payment hash,
so the swap's `paymentHash` is the payout invoice's hash. Create a swap as above, but before the demo payment:

```powershell
# CKB -> BTC (the payout is a Lightning invoice on lnd-user)
docker exec ckbolt-devnet-lnd-user-1 lncli --network=regtest cancelinvoice $swap.paymentHash

# BTC -> CKB (the payout is a Fiber invoice on fnn-user, JSON-RPC on 127.0.0.1:8237)
$cancel = @{ jsonrpc = "2.0"; id = 1; method = "cancel_invoice"; params = @(@{ payment_hash = "0x$($swap.paymentHash)" }) } | ConvertTo-Json -Depth 4
Invoke-RestMethod -Method Post "http://127.0.0.1:8237" -ContentType "application/json" -Body $cancel
```

Then send the demo payment. The hub holds the payment, its payout fails, and it cancels the hold invoice: the swap ends
`failed` with `refunded: true`, the reason "The payout failed, so the payment is refunded." and the events
`incoming_accepted`, `payout_started`, `payout_failed`, `cancelled`. No balance moves. In Git Bash, prefix `docker exec`
commands that contain container paths with `MSYS_NO_PATHCONV=1` (this one has none).

### Restart the hub in the middle of a swap

1. Create a CKB -> BTC swap (quote, demo invoice, swap) and keep its hold invoice, `$swap.pay.invoice`.
2. Stop the hub (Ctrl+C or the port command above).
3. Pay the hold invoice from fnn-user directly, while the hub is down:

   ```powershell
   $pay = @{ jsonrpc = "2.0"; id = 1; method = "send_payment"; params = @(@{ invoice = $swap.pay.invoice }) } | ConvertTo-Json -Depth 4
   Invoke-RestMethod -Method Post "http://127.0.0.1:8237" -ContentType "application/json" -Body $pay
   ```

4. Start the hub again (`npm run start:prod`). Within a poll or two it finds the held payment, pays out and settles:
   `GET /v1/swaps/:id` goes `incoming_accepted`, then `succeeded`. The quote must still be valid (3 minutes), or the
   payment is refunded instead.

## 4. Hub end-to-end tests

```
cd ckbolt-hub
npm run test:e2e
```

- Jest `globalSetup` runs `npm --prefix devnet run up` once, so the devnet only needs to have been bootstrapped. Each
  test boots the hub's AppModule in-process (no port) with the real LND and fnn adapters, configured from
  `devnet/hub.env` (never from `.env`), fixed prices (no internet) and a SQLite file of its own. It does not use a hub
  running on 8787.
- The tests act as the user through lnd-user and fnn-user and move real funds, the same amounts each way, so the
  channels end about where they started.
- Suites: `swap-success` (both directions, CKB and RUSD), `refund` (payout failure, both directions), `quote-expiry`,
  `rejections` (ckb_hash invoice, amountless invoice), `restart-recovery` (crash mid-flight, then resume), `security`
  (demo wallet only pays demo swaps, MPP invoices refused, payout lock cap, 429 on a client's swap past
  `SWAP_MAX_UNPAID_PER_CLIENT`).
- Every test talks to the hub from one loopback client, polls its swaps and leaves some unpaid until their quotes
  expire, so `E2E_HUB_ENV` (`test/e2e/support/e2e.constants.ts`) lifts the limits on top of `devnet/hub.env`: the
  request rate limit, both demo caps (per client and `DEMO_MAX_ACTIONS_PER_HOUR_TOTAL`) and both caps on unpaid swaps
  (`SWAP_MAX_UNPAID_PER_CLIENT`, `SWAP_MAX_UNPAID`). A test that checks a limit sets it again for its own hub (the
  `security` suite starts one with `SWAP_MAX_UNPAID_PER_CLIENT=1`).
- Tunables: `E2E_SKIP_DEVNET_UP=true` (devnet already up), `E2E_WAIT_TIMEOUT_MS` (120000), `E2E_POLL_INTERVAL_MS` (250),
  `E2E_HUB_LOG_LEVELS` (`error`; `error,warn,log` shows the hub's logs). One file: `npm run test:e2e -- refund`.

## 5. Web app tests

### The offline suite (mocked hub)

```
cd ckbolt-web
npm run typecheck
npm run build                          # the tests run against the production build
PW_CHANNEL=msedge npx playwright test  # PowerShell: $env:PW_CHANNEL="msedge"; npx playwright test
npm run test:unit                      # unit tests only (no browser)
```

Playwright starts `next start` on port 3100 (or reuses a server already there: rebuild first so it tests the current
code). Live mode is tested without a hub: `tests/e2e/live-swap.spec.ts` (the swap card) and `tests/e2e/hub-live.spec.ts`
answer every `/api/hub/**` call themselves, in the shape of the hub's API, including refunds, expiry and error codes. The
Lightning wallet (NWC, WebLN) and the browser Fiber node are faked too.

### The live swap card and the devnet

The live swap card (`ckbolt-web/docs/live-swap-ui.md`) swaps only between the user's own wallets: a Lightning wallet
over NWC or WebLN, and a Fiber node, either in the browser at `/app/fiber` or the user's own. The devnet has no NWC
wallet, so the card cannot be driven against the devnet hub. Test each side this way:

- **The hub on the devnet**: through its API (section 3) and the e2e suite (section 4).
- **The card**: in the offline suite above, with the hub, NWC and the browser node faked.
- **Both together, with real wallets**: on the test networks; see [testing-testnet.md](testing-testnet.md).

Locally the web server runs without `TRUST_PROXY=1` and the hub without `HUB_TRUST_PROXY=true`, so the hub counts every
browser as one client, the web server: its rate limits and `SWAP_MAX_UNPAID_PER_CLIENT` are shared by every tab. The
public demo sets both (`deploy/README.md`, section 9).

## 6. A manual swap through the UI

On the test networks, with your own Lightning wallet and Fiber node: [testing-testnet.md](testing-testnet.md), section
3. On the devnet, swap through the API (section 3, "One swap each way through the API").

## 7. Clean up

- Stop the web server and the hub (Ctrl+C, or by port: 3200, 3100, 8787).
- Leave the devnet running, or `npm --prefix devnet run stop` to free memory; `up` brings it back with its state.

## 8. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `EADDRINUSE` or "port is already allocated" | Something holds the port. Find it with `Get-NetTCPConnection -LocalPort <port> -State Listen` (the `OwningProcess` column) and stop it with `Stop-Process -Id <pid>`, or `netstat -ano \| findstr :<port>`. Devnet ports: 18443, 10009, 10010, 8180, 8181, 8114, 8227, 8237 (overrides in `devnet/README.md`, keep them in `devnet/.env`). Hub 8787, web 3100 (tests), 3200 or 8080. A stopped `next start` can leave a node child on its port. |
| `/v1/health` is 503, Lightning `"synced":false` | The regtest tip is old (no block for hours). `npm --prefix devnet run mine -- 6`, or `npm --prefix devnet run up` (it mines when needed). |
| `/v1/health` is 503, a node `"reachable":false` | The devnet is stopped or a container restarted. `docker ps` should list seven `ckbolt-devnet-*` containers; run `npm --prefix devnet run up`. |
| After a Docker Desktop restart or a PC sleep | The containers come back but the nodes may not find each other (new container IPs). Run `npm --prefix devnet run up` before the hub or the tests. If `up` says `hub.env` changed, copy it to `.env` again and restart the hub. |
| Payments fail right after `docker compose start` | Same: run `npm --prefix devnet run up`, which reconnects the nodes and waits for active channels. |
| `ckb-miner` logs `BlockTimeTooNew` | The Docker VM clock jumped back; it recovers by itself within seconds. |
| `up` says "The devnet is not set up yet", or a node is broken | `npm --prefix devnet run bootstrap`; if that fails, `npm --prefix devnet run reset` then `bootstrap`, then copy `devnet/hub.env` to `.env`. |
| The hub exits with "Invalid hub configuration: ..." | A variable in `.env` is wrong; the message names it. `.env.example` lists them all. |
| Quotes fail with 503 `quote_unavailable` | No fresh exchange price: the hub reads CoinGecko, Binance and KuCoin, so it needs internet access. The e2e tests use fixed prices and do not. |
| 422 `insufficient_liquidity` | The payout is above what the hub can pay right now; `/v1/assets` shows the limits. Swaps in the other direction move liquidity back; `reset` and `bootstrap` start fresh. |
| 429 `rate_limited` on demo actions | `DEMO_MAX_ACTIONS_PER_HOUR` (60 per client) or `DEMO_MAX_ACTIONS_PER_HOUR_TOTAL` (600 for every client together) was reached. Raise it in `.env` and restart the hub (the counters live in memory). |
| 429 `rate_limited` on `POST /v1/swaps` | This client already has `SWAP_MAX_UNPAID_PER_CLIENT` (5) swaps waiting for their payment, or the hub `SWAP_MAX_UNPAID` (50). Pay them or let their quotes expire (`Retry-After` says when the first one does), or raise the caps in `.env` and restart the hub. Every manual swap from one machine counts as one client. |
| The web app stays in simulation | The server has no `HUB_URL` (set it in the same window as `next start`), or the hub is degraded. `curl http://127.0.0.1:3200/api/hub/v1/health` shows what the web server sees: 503 `hub_unavailable` means no `HUB_URL`. |
| Playwright tests old code | It reused a server already on 3100. Stop it, `npm run build`, run again. |
| `npm run test:e2e` fails in globalSetup | `npm --prefix devnet run up` failed; its output is in the error. Bootstrap the devnet first. |
| Git Bash rewrites `/root/...` paths in `docker compose exec` | Set `MSYS_NO_PATHCONV=1` for that command. The npm scripts are not affected. |
