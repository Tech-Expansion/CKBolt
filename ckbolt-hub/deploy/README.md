# Testnet runbook: the hub on a testnet server (Mutinynet + CKB testnet)

**Status: deployed on the testnet server on 2026-10-24** with the demo profile on (`COMPOSE_PROFILES=demo`, `DEMO_ENABLED=true`).
- The public demo is live: the web app at https://ckbolt.texlabs.org reaches this hub through its proxy and the tunnel
  of section 10; cWBTC for testers comes from https://ckbolt-faucet.texlabs.org.
- Steps 1 to 13 below ran as written: the takeover kept the synced chain, and `testnet fund` claimed CKB by script.
- `testnet:check`: 34 OK, 0 failing. `testnet:smoke`: PASSED both ways.
- Two fixes were needed on the first run:
  - the fnn image lacked CA certificates for the https CKB RPC (fixed in `devnet/fnn/Dockerfile`);
  - the funding amounts were lowered to fit one faucet day next to the operator's own wallet channel: 670,000 sats for
    lnd-hub, a 495,000-sat channel to the Mutinynet faucet node, `DEPLOY_LN_DEMO_WALLET_SATS=150000`,
    `DEPLOY_LN_DEMO_CHANNEL_SATS=120000` in `deploy/deploy.env`.
- The server's `.env` sets `FIBER_PUBLIC_WS_ADDRS` and `FIBER_PUBLIC_P2P_ADDRS` with fnn-hub's peer id.
- RUSD, set up the same day:
  - we sent fnn-hub 100 RUSD;
  - `DEPLOY_FIBER_DEMO_CHANNEL_RUSD=60` opened a 60 RUSD channel to fnn-demo, 30 a side;
  - the server's `hub.env` has `FIBER_INBOUND_RUSD_AMOUNT=2000000000` (20 RUSD);
  - `testnet:smoke --asset RUSD` passed both ways;
  - `testnet:check` then reported 38 OK, 0 warnings.
- Lightning moved to the Megalith LSP on 2026-10-25, by hand:
  - why: Alby Hub wallets get their channels from Megalith, and the hub pays CKB to BTC payouts to them through it
    (the faucet-node route was one hop longer). For BTC to CKB an Alby Hub wallet still needs a channel of its own with
    lnd-hub (section 8);
  - lnd-hub now has a private channel of 220,000 sats to Megalith, 100,000 of them pushed to Megalith's side (the
    hub's inbound), and the server's `hub.env` has `LN_INVOICE_ROUTE_HINTS=true`;
  - the channel to the faucet node was closed;
  - `testnet channels` opens the same channel on a fresh deploy (`DEPLOY_LN_LSP_*` in `deploy/deploy.env`), and
    `testnet:check` checks it: 38 OK, 0 failing.
- Testing with real wallets: [`docs/testing-testnet.md`](../docs/testing-testnet.md).
- More tokens (2026-11-06; on the testnet server since 2026-11-07): the hub serves the UDTs `FIBER_ASSETS` in `hub.env` lists (one
  JSON line per the example in `hub.env.example`); without it, RUSD as above. `fnn/hub.yml` and `fnn/demo.yml` now
  whitelist cWBTC (anchored args, cell dep): after `testnet sync`, restart fnn-hub and fnn-demo, which read the whitelist
  only at start. With `FIBER_ASSETS` set, remove `FIBER_INBOUND_RUSD_AMOUNT` (RUSD's `inboundAmount` replaces it). Each
  UDT channel fnn-hub opens locks about 180 CKB of its wallet besides the token. Steps: testing-testnet.md, section 6.
- Tokens in one place (2026-11-07, in the code): fnn's whitelists are generated from `FIBER_ASSETS`, and
  `python3 add_token.py <token.json> [--apply]` in the kit folder on the server adds a token end to end (validate in
  the hub image, back up, regenerate, restart what changed, check, open channels one at a time).
  Runbook: [`docs/add-token.md`](../docs/add-token.md).
- Sync keeps the server's whitelists (2026-11-07, in the code, not applied on the testnet server yet): `testnet sync` uploads
  `fnn/hub.yml` and `fnn/demo.yml` as templates under `.sync-templates/`, never over the files fnn runs, then runs
  `python3 add_token.py --regenerate --apply --template-dir .sync-templates` in the kit folder, so they follow the server's `hub.env`
  (`FIBER_ASSETS`); it writes and restarts fnn-hub or fnn-demo only where the result differs from what fnn runs,
  refuses to drop a token fnn has, and never touches `hub.env` or the hub. It skips the step, keeping the server's
  files, before `testnet env`, before the hub image is built, or while that image predates the generator. **The first
  time:** `testnet sync` (it warns about the image), `testnet build hub`, `python3 add_token.py --regenerate --apply --template-dir .sync-templates`
  on the server, then `testnet up hub` to recreate the hub. Details: add-token.md, "After every `testnet sync`".
- Peer channels capped (2026-11-07, in the code): `FIBER_PEER_CHANNELS_MAX_OPEN` in `hub.env` (default 10) stops
  `GET /v1/fiber/node` from offering node-funded token channels once that many are open (each locks about 180 CKB of
  fnn-hub's wallet). fnn-hub still auto-accepts a channel opened directly with at least `minAmount`: fnn 0.9.1 has no
  count limit (add-token.md, "Peer channels").

The hub runs on **Mutinynet** (a custom signet with 30 s blocks and a working Lightning faucet) and **CKB testnet**
(Fiber's public test network) on a testnet server (`testnet-vps` in the commands below), under `/opt/ckbolt/testnet`.
The public web app reaches the hub through the tunnel of section 10; the operator reaches it through an SSH tunnel and
can run the web app locally against it (section 6). Local testing without real networks uses the devnet
(`docs/testing.md`).

Everything is driven from a development machine (on Windows, PowerShell or Git Bash; the same commands) with:

```
npm --prefix deploy run testnet -- <command>     # deploy, fund, channels (list: npm --prefix deploy run testnet)
npm --prefix deploy run testnet:check            # read-only readiness report; every red line says the next action
npm --prefix deploy run testnet:smoke            # one real swap each way, with evidence
```

Below, `testnet <command>` is short for `npm --prefix deploy run testnet -- <command>`, run from the hub repository root.

## 1. What runs on the server

```
bitcoind (Mutinynet fork) ── lnd-hub [⇄ lnd-demo]        LND v0.21.4-beta on signet; lnd-hub ── Megalith (private)
CKB testnet (public RPC)  ── fnn-hub [⇄ fnn-demo]        fnn v0.9.1 release, CKB and RUSD channels
hub (CKBolt) ── lnd-hub, fnn-hub; demo wallet (optional) ── lnd-demo, fnn-demo
```

| Service | Image | Role | Ports on the server |
| --- | --- | --- | --- |
| `bitcoind` | `ckbolt/bitcoind-mutinynet`, `testnet/bitcoind/Dockerfile` | Mutinynet full node (the fork Mutinynet's operators run, SHA-256 checked). Takes over the volume of the sync running since 2026-10-23 | none |
| `lnd-hub` | `lightninglabs/lnd:v0.21.4-beta` | The hub's Lightning node, with a private channel to Megalith (the LSP of Alby Hub wallets) | **9735 public** (P2P) |
| `fnn-hub` | `ckbolt/fnn:v0.9.1`, `devnet/fnn/Dockerfile` | The hub's Fiber node; RPC only on the Docker network | **8228 public** (P2P, and WebSocket for browser Fiber nodes on the same port) |
| `hub` | `ckbolt/hub`, `testnet/hub/Dockerfile` | The CKBolt hub, SQLite in volume `hub-data` | `127.0.0.1:18787` |
| `lnd-demo`, `fnn-demo` | same | Optional demo wallet (`COMPOSE_PROFILES=demo`): testnet:smoke pays and receives with them; the hub offers them to visitors only with `DEMO_ENABLED=true` | none |

**Shared server rules.** The testnet server also runs other projects: nginx on 80/443, containers on 127.0.0.1:3000, 127.0.0.1:8787,
127.0.0.1:6300 and 0.0.0.0:5432. The kit never touches nginx, those containers or their ports: it publishes only 9735,
8228 and 127.0.0.1:18787, and `testnet up` refuses to start when any port it wants is held by something else. Docker
publishes ports past ufw; nothing in the kit changes the firewall.

**Compose files.** `docker-compose.yml` is safe on any machine (no public address, only the hub on 127.0.0.1).
`docker-compose.public.yml` adds what a server with a public IP needs: LND's `--externalip`, the public P2P ports, the
announced Fiber addresses (TCP and `/ws`), and the hub's `FIBER_PUBLIC_P2P_ADDRS` / `FIBER_PUBLIC_WS_ADDRS`. The
server's `.env` selects both with `COMPOSE_FILE`, so plain `docker compose ...` in `/opt/ckbolt/testnet` sees exactly
what the scripts see.

Fixes from the research review of the kit: PUBLIC_IP is needed only by the public overlay and filled in by
`testnet env`; ports bind to 127.0.0.1 except the two P2P ports, and the hub moved to 18787; the demo nodes are
optional (profile `demo`, `depends_on ... required: false`); Node scripts replace the bash runbook, so Windows needs no
jq, sudo or winpty; fnn-demo dials fnn-hub by the peer id it announces; fnn-hub has its own config without the RUSD
`auto_accept_amount` (`fnn/hub.yml`; fnn-demo keeps it in `fnn/demo.yml`); fnn-hub announces
`/ip4/<PUBLIC_IP>/tcp/8228/ws` and the hub publishes it for browsers; funding fits one faucet day and `SWAP_MAX_SATS`
starts at 20,000; `dbcache` is a setting. `invoices.holdexpirydelta` and the hub's `LND_HOLD_EXPIRY_DELTA_BLOCKS` now
come from one variable.

## 2. Files and secrets

On this machine:

| Path | What | In git |
| --- | --- | --- |
| `deploy/deploy.env.example` -> `deploy/deploy.env` | The scripts' settings: `DEPLOY_SSH_HOST` (required), `DEPLOY_REMOTE_DIR`, amounts, timeouts | example only |
| `deploy/scripts/` | The commands (TypeScript, run with the hub's `ts-node`) | yes |
| `deploy/testnet/` | The kit: compose files, `.env.example`, `hub.env.example`, Dockerfiles, fnn configs, `lnd/init-wallet.sh` | yes |

On the server, `/opt/ckbolt/testnet` (`DEPLOY_REMOTE_DIR`):

| Path | What | Written by |
| --- | --- | --- |
| the kit's files | as in `deploy/testnet/` | `testnet sync` (it never deletes or overwrites `.env`, `hub.env`, `secrets/` or `sync.compose.yml`; `fnn/hub.yml` and `fnn/demo.yml` go up as templates and are regenerated from them and `hub.env` right after the upload) |
| `src/` | The hub source the images build from (`package.json`, `src/`, `devnet/fnn/`, `deploy/testnet/hub/`, ...) | `testnet sync` (replaced whole) |
| `.env` (mode 600) | Compose variables and secrets: `QUOTE_SIGNING_KEY`, `BITCOIND_RPC_PASSWORD` (kept from the sync), `FNN_*_KEY_PASSWORD`, `PUBLIC_IP`, `COMPOSE_FILE`, `COMPOSE_PROFILES`, `DEMO_ENABLED`, ports | `testnet env` (completes it; never changes a value) |
| `hub.env` | The hub's settings (no secrets) | `testnet env` (from `hub.env.example`; later only appends new keys) |
| `secrets/wallet/<node>.password` (600) | LND wallet unlock passwords, mounted into LND only | `testnet env` |
| `secrets/wallet/<node>.seed` (600) | The 24 seed words of each LND wallet, written once | `testnet wallet` |
| `secrets/hub/<node>/{tls.cert,*.macaroon}` (uid 1000, 600) | All the hub may read: TLS certificates and least-privilege macaroons (`info:read invoices:read invoices:write offchain:read offchain:write onchain:read`) | `testnet macaroons` |

Secrets are generated on the server (`/dev/urandom`) and never pass through this machine or a log; the scripts read
back only the names of `.env` keys and the values of its non-secret ones. The SSH user must be root (as for `/opt` on
the testnet server) or have passwordless sudo, which `testnet macaroons` uses to hand `secrets/hub` to the hub container's user.

## 3. One-time setup on Windows

1. Node 22 and the hub's dependencies: `npm install` in the hub repository (the deploy scripts use its `ts-node` and
   TypeScript; `deploy/` has no dependencies of its own).
2. `ssh testnet-vps` works without a password prompt (key or agent; the scripts run ssh with `BatchMode=yes`).
3. `copy deploy\deploy.env.example deploy\deploy.env` (Git Bash: `cp`), then set `DEPLOY_SSH_HOST=testnet-vps`. Leave the
   rest at their defaults unless a step below says otherwise.
4. `testnet` alone lists the commands; `testnet:check` must at least show the `server` lines green.

## 4. Deploy

| # | Command | What happens | Done when |
| --- | --- | --- | --- |
| 1 | `testnet sync` | Uploads the kit and the hub source (tar over ssh), then regenerates fnn's whitelists from the uploaded templates and the server's `hub.env` with `add_token.py --regenerate --apply --template-dir .sync-templates` (on a new server it says it skipped: no `hub.env` yet) | it prints the file counts |
| 2 | `testnet env` | Completes `.env` (keeps the sync's bitcoind credentials, generates the other secrets, sets `PUBLIC_IP` from the SSH host), creates `hub.env` and the wallet passwords | `.env already complete` on a second run |
| 3 | `testnet build` | Builds bitcoind, fnn and hub images on the server (minutes) | Docker prints the image names |
| 4 | `testnet up bitcoind` | **Takes over the running sync**: same project, service and volume `ckbolt-testnet_bitcoind` at `/data`, so nothing resyncs. Refuses when the volume is missing (would sync from block 0; `--fresh` allows it on purpose), when another container still uses it, or when it is mounted elsewhere | `testnet:check` shows bitcoind syncing or synced |
| 5 | `testnet up lnd-hub fnn-hub` | Starts the hub's nodes. LND waits for its wallet | `testnet status` shows both running |
| 6 | `testnet wallet lnd-hub` | Creates the LND wallet without a prompt (GenSeed and InitWallet inside the container). The 24 words go to `secrets/wallet/lnd-hub.seed` on the server only | it prints where the seed is |
| 7 | `scp testnet-vps:/opt/ckbolt/testnet/secrets/wallet/lnd-hub.seed .` | **Write the seed down offline**, then delete the local copy (and, if you like, the server's) | the words are safe |
| 8 | `testnet macaroons` | Bakes the hub's least-privilege macaroon, copies it and the TLS certificate into `secrets/hub/lnd-hub/` | it prints both paths |
| 9 | `testnet fund` | Prints every address, claims testnet CKB for fnn-hub by script, prints the hand steps (section 5) | hand step 1 done |
| 10 | `testnet channels` | Opens lnd-hub -> Megalith, private, with `DEPLOY_LN_LSP_PUSH_SATS` pushed to Megalith's side (the hub's inbound), and fnn-hub -> bottle and bracer (CKB). Run it again after confirmations; it opens only what is missing (any channel with the peer, open or opening, counts) | `testnet:check` shows the channels ready |
| 11 | `testnet up` | Starts everything, the hub once lnd-hub is healthy (LND is healthy only once bitcoind has synced) | `testnet:check` all green except liquidity |
| 12 | `testnet balance` | Needed only once swaps have used up the pushed inbound: pays Mutinynet faucet invoices from lnd-hub, through Megalith, until its channel to Megalith holds `DEPLOY_LN_INBOUND_TARGET_SATS` inbound again (no login: `/api/bolt11`, 60 per day) | `testnet:check`: inbound above the minimum |
| 13 | `testnet:check`, then `testnet:smoke` (section 7) | Readiness, then a real swap each way | smoke prints PASSED twice |

LND needs bitcoind synced before it reports `SERVER_ACTIVE`; steps 5 to 9 can run during the sync, `channels` needs
lnd-hub synced and funded. The hub never gets admin rights: it cannot open channels, send on-chain or make addresses.

**Demo wallet (needed by testnet:smoke).** In the server's `.env` set `COMPOSE_PROFILES=demo` (and `DEMO_ENABLED=true`
to offer it to visitors too); edit it on the server (`ssh testnet-vps`, then `nano /opt/ckbolt/testnet/.env`). Then
`testnet up lnd-demo fnn-demo`, `testnet wallet lnd-demo`, `testnet macaroons`,
`testnet fund` (lnd-hub sends lnd-demo `DEPLOY_LN_DEMO_WALLET_SATS` on chain and fnn-demo gets a CKB claim),
`testnet channels` (lnd-demo -> lnd-hub; fnn-hub -> fnn-demo with half moved to fnn-demo, which waits for the CKB
funding transaction to confirm), and `testnet up hub` to restart the hub with the demo settings. `testnet env` refuses
`DEMO_ENABLED=true` without the profile.

**Everyday commands.** `testnet status`, `testnet logs hub --tail 200 --follow`, `testnet down hub` (stop one service),
`testnet down` (stop and remove every container; volumes stay), `testnet compose -- ps` (any compose command),
`testnet addresses` (each running node's funding address, as `testnet fund` and the hand steps show them).
After a code change: `testnet sync`, `testnet build hub`, `testnet up hub`. The sync regenerates fnn's whitelists with
the hub image already on the server; when it warns that the image predates the generator (the first time), run
`python3 add_token.py --regenerate --apply --template-dir .sync-templates` on the server after `testnet build hub` and before `testnet up hub`.

## 5. Hand steps (the scripts print them with the addresses filled in: `testnet steps`)

| Step | Where | Why by hand |
| --- | --- | --- |
| 1. Mutinynet on-chain sats for lnd-hub | https://faucet.mutinynet.com, GitHub login, "On-chain", to the `lnd-hub` address `testnet fund` prints: LSP channel + demo wallet + reserve (by default 440,000 sats with the demo profile, 240,000 without) | The faucet needs a GitHub login (or L402 paid in mainnet sats). 1,000,000 sats per 24 h per IP and GitHub user, shared by on-chain, channel and Lightning |
| 2. RUSD (optional) | https://testnet0815.stablepp.xyz/faucet with JoyID (20 RUSD per click), then send from JoyID to fnn-hub's `ckt1...` address; then set `DEPLOY_FIBER_RELAY_CHANNEL_RUSD` (and `DEPLOY_FIBER_DEMO_CHANNEL_RUSD`) and run `testnet channels` | The page signs in the browser wallet |
| 3. CKB, only if the scripted claim failed | https://faucet.nervos.org for the `ckt1...` addresses | The claim API is read from the site's code and has not been called yet |

Funding fits one faucet day: lnd-hub gets 440,000 sats, opens a private 220,000-sat channel to Megalith with 100,000
pushed to Megalith's side (inbound for testers), sends 200,000 to lnd-demo, which opens 150,000 to lnd-hub. Swaps that
pay the hub use the inbound up; `testnet balance` tops it up to `DEPLOY_LN_INBOUND_TARGET_SATS` (100,000) again. CKB:
one 100,000-CKB claim covers fnn-hub's two 1,000-CKB relay channels, the 20,000-CKB demo channel and inbound channels
for browser nodes (`FIBER_INBOUND_CKB_AMOUNT`, 2,000 CKB each); claims stop at 300,000 CKB per address per month.

## 6. The web app against the hub (SSH tunnel)

1. Window 1, keep it open: `ssh -N -L 18787:127.0.0.1:18787 testnet-vps`. Check: `curl http://127.0.0.1:18787/v1/health`.
2. Window 2, in `ckbolt-web`: PowerShell `$env:HUB_URL="http://127.0.0.1:18787"; npx next start -p 3200` (after
   `npx next build`), or `npm run dev -- -p 3200`; Git Bash `HUB_URL=http://127.0.0.1:18787 npx next start -p 3200`.
3. `curl http://127.0.0.1:3200/api/hub/v1/health` answers the hub's health through the web proxy; open
   `http://localhost:3200/app` and swap with a Mutinynet wallet (Alby Hub over NWC) and a Fiber node.

Port 18787 on Windows does not clash with a local hub on 8787. Browser Fiber nodes dial fnn-hub directly at
`ws://<PUBLIC_IP>:8228` (from `GET /v1/fiber/node`): fine from an `http://localhost` page. A page served over https
needs a `wss://` address behind a TLS proxy: the tunnel of section 10 gives one (the server's nginx is another
project's and stays untouched).

## 7. testnet:check and testnet:smoke

`testnet:check` asks, and changes nothing (no address, invoice, claim or channel): SSH and Docker Compose on the server,
`curl` and `ss`, the kit files; every container and its health; bitcoind's chain and sync percentage; each LND node's
wallet state, sync, on-chain balance, peer and channels with local and remote balances; the hub's macaroon; each fnn
node's network (from its genesis hash), announced WebSocket address, relay peers, on-chain CKB (public CKB RPC) and
channels; the hub's `/v1/health`, its port binding (127.0.0.1 only), `/v1/assets` with each direction's liquidity and
`/v1/fiber/node`; the Mutinynet faucet. Each warning or failure prints `next:` with the command to run. Exit code 1 when
anything fails.

`testnet:smoke` makes one real swap each way and prints the evidence (needs the demo profile, the hub up and funded
channels; flags `--direction ln_to_fiber|fiber_to_ln|both`, `--asset CKB|RUSD`, `--sats N`, defaults in
`deploy.env.example`):

- **BTC to CKB**: a quote paying `--sats`; fnn-demo makes the payout invoice for a preimage the script creates, as a
  user's wallet does; lnd-demo pays the hub's `lntbs` hold invoice; the script follows the swap to its end.
- **CKB to BTC**: a quote receiving `--sats`; the payout is an invoice of the Mutinynet faucet's node (`/api/bolt11`);
  fnn-demo pays the hub's `fibt` hold invoice.
- Evidence per swap: swap id and state, both legs, payment hash, the revealed preimage and `sha256(preimage) == payment
  hash`, what lnd-demo and fnn-demo report (payment status, invoice `Paid`), and the hub's events. Exit code 1 unless
  both swaps succeeded with a matching preimage.

## 8. Settings that matter

| Setting | Where | Why |
| --- | --- | --- |
| `QUOTE_SIGNING_KEY` | `.env` | Required. Quotes keep verifying across restarts and the web app sees one hub key. Keep a copy offline |
| `LND_HOLD_EXPIRY_DELTA_BLOCKS` | `.env` | Feeds both LND's `invoices.holdexpirydelta` and the hub. 18 (LND's default) or more |
| `COMPOSE_FILE`, `PUBLIC_IP` | `.env` | The public overlay and the address lnd-hub and fnn-hub announce |
| `COMPOSE_PROFILES=demo`, `DEMO_ENABLED` | `.env` | Demo nodes, and whether the hub offers them |
| `FIBER_PUBLIC_WS_ADDRS`, `FIBER_PUBLIC_P2P_ADDRS` | `.env` (optional) | Override what browsers are told to dial, e.g. with `/p2p/<peer id>` or a future `wss` address |
| `SWAP_MAX_SATS=20000` | `hub.env` | Kept low until the channels hold more |
| `LN_INVOICE_ROUTE_HINTS=true` | `hub.env` | The hold invoices carry a route hint for the private channel to Megalith, so LND payers behind it find the hub (LDK payers cannot use it, section 8) |
| `FIBER_INBOUND_*` | `hub.env` | Inbound channels fnn-hub opens to browser Fiber nodes: amount per asset and caps per client, per node, in total |
| `HUB_TRUST_PROXY=false` | `hub.env` | One client through the tunnel. Set true only behind a public web server with `TRUST_PROXY=1` (section 10) |

Timing on the `mutinynet` profile: a BTC to CKB payout through at most one Fiber hop needs a Lightning hold invoice of
861 blocks for a payout invoice with Fiber's minimum final expiry delta (160 minutes): fnn locks any payout for at least
400 minutes (the invoice's 160 plus a 4 h random expiry reserve), about 800 of Mutinynet's 30-second blocks. LDK payers
such as Alby Hub accept at most 1,008 blocks for the whole route and keep 80 of them for a random offset
(rust-lightning `router.rs`), so the nodes between them and the hub get 1,008 - 861 - 80 = 67 blocks: not enough for
Megalith (144). **An Alby Hub wallet pays BTC to CKB only over a channel of its own with lnd-hub**: it connects to
lnd-hub (`021d22f9…@203.0.113.10:9735`), then lnd-hub opens a channel to it with a push, for example
`lncli openchannel --node_key=<wallet pubkey> --local_amt=30000 --push_amt=20000 --private`. LND payers (2,016 blocks)
can pay through Megalith, whose route hint every hold invoice carries; payouts to Alby Hub wallets (CKB to BTC) go
through Megalith too. On networks with 10-minute blocks the hold invoice is about 115 blocks and none of this applies.
A visitor's Fiber invoice must set its final expiry delta between 160 and 233 minutes.

## 9. Operations

| Check | How | Expect |
| --- | --- | --- |
| Everything | `testnet:check` | no FAIL |
| Hub | `curl -fsS http://127.0.0.1:18787/v1/health` on the server (or through the tunnel) | 200 `ok`; 503 `degraded` names the node |
| Containers | `testnet status` | every service running, healthy |

**Alert events.** When the hub meets something only a person can resolve, it records an `alert` event on the swap and
logs `Swap <id> needs attention: <reason>` once per new problem. Every alert means funds may be at risk:

| Reason | What to do |
| --- | --- |
| The held payment is settled although the hub never paid out | Check both nodes for the hash; pay the user by hand if owed |
| The payout succeeded but the held payment is gone | A loss for the hub: check the node's logs and the timing settings |
| The payout reports success without a matching preimage | Inspect the payout (`lncli trackpayment` or fnn `get_payment`) |
| The swap has no saved preimage to collect the held payment with | Find the preimage on the paying node and settle the hold invoice by hand before it expires |
| The hub did not cancel the held payment because a payout may exist | Cancel only once the payout has failed on the node |

Watch them with `testnet logs hub --follow` (look for `needs attention` and `ERROR`), or list them on the server
(`ssh testnet-vps`, `cd /opt/ckbolt/testnet`):

```bash
docker compose exec hub node -e "const db = require('better-sqlite3')('/data/hub.sqlite', { readonly: true });
  console.table(db.prepare(\"SELECT swap_id, datetime(at / 1000, 'unixepoch') AS at, detail FROM swap_events WHERE type = 'alert' ORDER BY id DESC LIMIT 20\").all())"
```

**Restarts and upgrades.** The hub saves every transition before acting and resumes open swaps at start-up:
`testnet compose -- restart hub` any time. Upgrade: `testnet sync`, `testnet build hub`, `testnet up hub`. Pinned:
LND v0.21.4-beta, fnn v0.9.1 (not v0.10.0-rc: it cannot upgrade an existing database), the Mutinynet fork in
`bitcoind/Dockerfile`.

**Backups** (test money, but losing it costs faucet days): each LND seed (step 7) and static channel backup
(`testnet compose -- cp lnd-hub:/root/.lnd/data/chain/bitcoin/signet/channel.backup ./lnd-hub.channel.backup`, then
`scp` it home), the hub database (on the server: `docker compose exec hub node -e "require('better-sqlite3')('/data/hub.sqlite').backup('/data/hub-backup.sqlite').then(() => process.exit(0))"`),
each fnn volume with the node stopped, and the server's `.env`.

**Biscuit (fnn RPC on another host).** Here the hub reaches fnn on the Docker network, so no token is used. If fnn's
RPC ever has to listen on a non-private address, fnn needs `RPC_BISCUIT_PUBLIC_KEY` and the hub `FIBER_RPC_TOKEN`
(facts: `read("node"); read("channels"); read("invoices"); write("invoices"); read("payments"); write("payments");
internal("store_changes");`, the last one for the pubsub WebSocket).

## 10. The public web app: Cloudflare Tunnel (profile `tunnel`)

The public demo (ckbolt.texlabs.org on Vercel) reaches the hub and browser nodes reach fnn-hub through a Cloudflare
Tunnel that runs in the kit, so the server opens no new port and its nginx stays untouched (2026-11-09: in the repo; it
ran on the server since the public demo went live).

| Service | Network | What it does |
| --- | --- | --- |
| `cloudflared` | `edge` only | Dials out to Cloudflare (`tunnel run` with `TUNNEL_TOKEN`); publishes nothing |
| `fiber-ws` | `default` and `edge` | A plain TCP relay (socat) to fnn-hub's P2P port 8228, where fnn also serves the browser nodes' WebSocket; never its JSON-RPC 8227 |
| `hub` | `default` and `edge` | The API, reached by the tunnel as `http://hub:8787` |

fnn-hub, LND and bitcoind stay off `edge`: the tunnel cannot reach their RPCs.

1. In Cloudflare (Zero Trust, Networks, Tunnels) create a tunnel and copy its token. Public hostnames, in this order:
   `ckbolt-hub-api.<domain>` -> `http://hub:8787`; `ckbolt-hub-fiber.<domain>` -> `http://fiber-ws:8228`; anything
   else -> `http_status:404`.
2. In the server's `.env`: `COMPOSE_PROFILES=tunnel` (or `demo,tunnel`), `CLOUDFLARED_TUNNEL_TOKEN=<token>` by hand
   (`testnet env` refuses the profile while it is empty and never reads it back), and
   `FIBER_PUBLIC_WS_ADDRS=/dns4/ckbolt-hub-fiber.<domain>/tcp/443/wss/p2p/<fnn-hub's peer id>`.
3. In `hub.env`: `HUB_PROXY_SECRET` (the web app's proxy sends it) and `HUB_TRUST_PROXY=true`.
4. `testnet up` starts cloudflared and fiber-ws with the rest.

`docker-compose.yml` holds both services, so `testnet sync` keeps the tunnel (before 2026-11-09 the repo's copy lacked
them and a sync would have dropped the tunnel). `deploy/test/kit-config.test.ts` checks the profile with
`docker compose config`: nothing published, cloudflared on `edge` only, fiber-ws relaying 8228 only.

## 11. Checklist before testers

- [ ] `testnet:check` without FAIL; `testnet:smoke` PASSED both ways.
- [ ] `QUOTE_SIGNING_KEY` and both LND seeds copied offline; seeds deleted from this machine.
- [ ] `BTC_NETWORK=signet`, `TIMING_PROFILE=mutinynet`, `CKB_NETWORK=testnet` in `hub.env`. Never mainnet.
- [ ] Only 9735 and 8228 public; the hub on 127.0.0.1:18787 (`testnet:check` checks the binding).
- [ ] Liquidity both ways in `/v1/assets` above `SWAP_MAX_SATS`.
- [ ] This file's status line updated with what really happened.

## 12. Open items

- Verified on the first run (2026-10-24):
  - the takeover of the running sync's container;
  - the CKB faucet claim API (HTTP 200, funds arrived within minutes);
  - the Mutinynet faucet's `/api/bolt11` (`testnet balance` paid 5 invoices).
- The hand-step text of `fund` always asks for the full on-chain amount, even when lnd-hub is already funded.
- `FIBER_PUBLIC_WS_ADDRS` is built from `PUBLIC_IP` without `/p2p/<peer id>` (the peer id exists only after fnn-hub's
  first start); `testnet:check` warns when the hub serves addresses without it. Set the full multiaddr in `.env` once
  known, unless the hub appends fnn-hub's peer id itself.
- TLS for browser Fiber nodes only through the tunnel (section 10); the kit has no TLS proxy of its own.
- The faucet paying a hub hold invoice and waiting is read from its code (`SendPaymentV2`), not exercised.

## 13. Checking the kit on this machine (no server)

From the hub repository root, after any change under `deploy/`:

```
npm --prefix deploy test            # node:test through ts-node: the scripts against a fake ssh runner, a scripted hub and fake nodes
npm --prefix deploy run typecheck   # the scripts and their tests (the hub's `npm run typecheck` and Jest do not cover deploy/)
```

The tests never open an ssh connection. With Docker Compose installed they also run `docker compose config` on a copy
of the kit in every mode (public overlay, base only, demo profile, missing secrets); without it those tests are
skipped. One test creates and unlocks a wallet in a real LND container, only when asked: PowerShell
`$env:DEPLOY_TEST_LND_IMAGE="lightninglabs/lnd:v0.21.4-beta"; npm --prefix deploy test`, Git Bash
`DEPLOY_TEST_LND_IMAGE=lightninglabs/lnd:v0.21.4-beta npm --prefix deploy test`.

To resolve the compose files by hand, the kit folder needs the two files `testnet env` writes on the server (both
gitignored): `deploy/testnet/.env` from `.env.example` with `QUOTE_SIGNING_KEY`, `BITCOIND_RPC_PASSWORD`,
`FNN_HUB_KEY_PASSWORD`, `FNN_DEMO_KEY_PASSWORD` and `PUBLIC_IP` filled in (any test values), and `deploy/testnet/hub.env`
copied from `hub.env.example`. Then `docker compose -f deploy/testnet/docker-compose.yml config` resolves the base file,
and, with `-f deploy/testnet/docker-compose.public.yml` added, the public overlay. Delete both files afterwards. (Plain
`docker compose config` inside the folder follows `COMPOSE_FILE`, whose `:` separator is the Linux one: on Windows set
`COMPOSE_PATH_SEPARATOR=:` first.)
