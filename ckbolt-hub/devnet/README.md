# CKBolt devnet

A local network the hub can swap on, in Docker: Bitcoin regtest with two LND nodes, a CKB devnet with the Fiber
contracts in genesis, and two release fnn v0.9.1 nodes. The `*-hub` nodes are the hub's; the `*-user` nodes play the
user and back the hub's demo wallet.

```
bitcoind (regtest 29.4) ── lnd-hub ⇄ lnd-user        LND v0.21.4-beta, one channel each way
ckb (0.202.0 dev chain) ── fnn-hub ⇄ fnn-user        fnn v0.9.1 release, CKB channel + RUSD stand-in channel
        └─ ckb-miner (a block every second)
```

After `npm run bootstrap` you have:

- LND wallets funded and two 10,000,000-sat channels (hub->user, user->hub), so each node can pay and be paid.
- fnn wallets funded with 1,000,000 CKB and 1,000,000 RUSD stand-in each, from the dev chain's genesis key.
- **RUSD stand-in**: an xUDT issued by the genesis key, in both fnn UDT whitelists (RUSD itself is not on devnet).
- A CKB channel (200,000 CKB) and a RUSD channel (100,000 RUSD) between fnn-hub and fnn-user, balanced half and half.
- A least-privilege macaroon for the hub (`info:read invoices:read invoices:write offchain:read offchain:write
  onchain:read`) and one with the same rights for the demo wallet, plus TLS certificates, in `devnet/.secrets/`.
- `devnet/hub.env`: every variable the hub needs for this devnet (nodes, demo wallet, `UDT_RUSD_SCRIPT`).

## Prerequisites

- Docker Desktop (tested with Docker 28 and Compose v2.33) with about 3 GB of memory to spare.
- Node.js 22 or later and npm.
- Works from PowerShell, cmd or Git Bash on Windows, and from any shell on Linux or macOS: the scripts are Node and
  run every node command inside its container.

## Commands

Run them in `devnet/`. Install the scripts' dependencies (tsx, CCC, and TypeScript for the type check) once with
`npm install`.

| Command | What it does |
| --- | --- |
| `npm run bootstrap` | **Start and set up everything.** Builds the fnn image, starts the stack, waits for health, funds, opens channels, writes secrets and `hub.env`. Safe to re-run: finished steps are skipped. About 2 minutes the first time. |
| `npm run smoke` | Proves both legs of a swap work: a Lightning hold invoice on lnd-hub paid by lnd-user and settled, then Fiber sha256 hold invoices (CKB and RUSD) on fnn-hub paid by fnn-user and settled. |
| `npm run up` | Start the stack again after a stop, with its state, and make it usable: rewrites `hub.env` when the published host ports changed, mines when LND is not synced (an old tip, or blocks bitcoind lost in an unclean stop: see Troubleshooting), reconnects the nodes (containers can get new IP addresses on restart, and the nodes remember peers by IP) and waits until every channel is active. Run it before the hub or the e2e tests after any restart. |
| `npm run stop` | Stop every container and **keep the state** (`docker compose stop`). Run it before shutting Windows down or quitting Docker Desktop: a clean stop writes everything to disk. |
| `npm run reset` | Delete the containers, every node's volume, `state/`, `.secrets/` and `hub.env`. Run `npm run bootstrap` again afterwards. |
| `npm run mine -- 6` | Mine regtest blocks to lnd-hub (default 1). Needed after a long pause: LND reports itself unsynced when the tip is hours old. Like every mine of the scripts, it makes bitcoind write the blocks to disk at once and records the new tip in `state/bitcoin-tip.json`. CKB blocks come from `ckb-miner` on their own. |
| `npm run secrets` | Bake the least-privilege macaroons again on a running devnet and copy them to `.secrets/` (after their permissions changed, e.g. a devnet bootstrapped before `onchain:read` was added). Restart the hub afterwards. |
| `npm run logs` | Follow the logs of every service (`docker compose logs`). |
| `npm run typecheck` | Type-check the scripts and tests with `devnet/tsconfig.json` (they import hub constants from `../src` by relative path, so the hub's own `npm install` must have run). The hub's `npm run typecheck` does not include `devnet/`. |

First time:

```
cd devnet
npm install
npm run bootstrap
npm run smoke
```

Tests of the devnet itself, run in `devnet/`: `npx tsx test/check.ts` checks a running devnet against this spec
(containers, secrets and `hub.env`, liquidity, the protocol behaviour the hub relies on; read-only for funds), and
`npx tsx --test "test/unit/*.test.ts"` runs the unit tests of the scripts. The whole testing sequence, hub and web app
included, is in [../docs/testing.md](../docs/testing.md).

## Use it from the hub

From the hub root:

```
cp devnet/hub.env .env       # PowerShell: Copy-Item devnet/hub.env .env
npm run start:dev
npm run test:e2e             # end-to-end tests against this devnet
```

Paths in `hub.env` are relative to the hub root. Variables it does not set keep the defaults of `.env.example`.
After the devnet was stopped, run `npm run up` in `devnet/` first (or `npm --prefix devnet run up` from the hub root).

`npm run test:e2e` runs `npm --prefix devnet run up` once (Jest `globalSetup`), then boots the hub's AppModule
in-process for each test with the real LND and fnn adapters, configured from `hub.env` (not the hub's `.env`), fixed
prices instead of the exchanges and a temporary SQLite file per test file. The tests act as the user through
`scripts/lib` (lnd-user, fnn-user) and move real funds, the same amounts each way per asset, so a run leaves the
channels about where they were (the hub keeps its fee). Their own tunables: `E2E_SKIP_DEVNET_UP=true` (the devnet is already up), `E2E_WAIT_TIMEOUT_MS` (120000),
`E2E_POLL_INTERVAL_MS` (250) and `E2E_HUB_LOG_LEVELS` (`error`; e.g. `error,warn,log` to see the hub's logs).

The scripts in `scripts/lib/` (fnn and lncli clients, `ensureConnected` in `scripts/steps/connectivity.step.ts`) can be
reused by the e2e tests, for example to mine blocks or to reconnect nodes after restarting a container.

## Ports and secrets

Every port is published on 127.0.0.1 only. Override any host port, version or dev credential with an environment
variable or an untracked `devnet/.env` file (Compose reads it). `npm run bootstrap` and `npm run up` write `hub.env`
with the ports published by that start, so a port override set (or dropped) for one command moves `hub.env` with it;
keep overrides in `devnet/.env` so every command, `docker compose` included, uses the same ports. Copy `hub.env` to
the hub's `.env` again when `npm run up` reports that it changed.

| Service | Host port | Container port | What | Override |
| --- | --- | --- | --- | --- |
| bitcoind | 18443 | 18443 | RPC, user and password `ckbolt` | `BITCOIND_RPC_HOST_PORT`, `BITCOIND_RPC_USER`, `BITCOIND_RPC_PASSWORD` |
| lnd-hub | 10009, 8180 | 10009, 8080 | gRPC, REST | `LND_HUB_GRPC_HOST_PORT`, `LND_HUB_REST_HOST_PORT` |
| lnd-user | 10010, 8181 | 10009, 8080 | gRPC, REST | `LND_USER_GRPC_HOST_PORT`, `LND_USER_REST_HOST_PORT` |
| ckb | 8114 | 8114 | JSON-RPC with indexer and `IntegrationTest` (`generate_block`) | `CKB_RPC_HOST_PORT` |
| fnn-hub | 8227 | 8227 | JSON-RPC and the pubsub WebSocket, no auth | `FNN_HUB_RPC_HOST_PORT` |
| fnn-user | 8237 | 8227 | JSON-RPC, no auth | `FNN_USER_RPC_HOST_PORT` |

Other Compose variables: `LND_VERSION`, `BITCOIN_CORE_VERSION`, `CKB_VERSION`, `CKB_BLOCK_INTERVAL_MS` (1000),
`CKB_MINER_LOCK_ARG`, `FNN_HUB_KEY_PASSWORD`, `FNN_USER_KEY_PASSWORD`, `FNN_LOG` (info).

fnn refuses to bind its RPC to `0.0.0.0` without a Biscuit key, so each node binds to its compose hostname
(`fnn-hub:8227`), which resolves to a private address, and Docker publishes that port on the host.

Generated files (all ignored by git, all test-only):

| Path | Content |
| --- | --- |
| `.secrets/lnd-hub/` | `tls.cert`, `admin.macaroon`, `hub.macaroon` (least privilege, what the hub uses) |
| `.secrets/lnd-user/` | `tls.cert`, `admin.macaroon`, `demo.macaroon` (least privilege, what the demo wallet uses) |
| `state/fnn-udt.env` | `CKB_UDT_WHITELIST` for both fnn nodes (the RUSD stand-in), read by `docker-compose.yml` |
| `state/bitcoin-tip.json` | `{ "height", "hash" }` of the Bitcoin tip after the scripts' last mine, so `npm run up` can tell when bitcoind came back below it |
| `hub.env` | The hub's settings for this devnet |

Keys: each fnn node creates a random CKB wallet key on first start, kept encrypted in its volume. The CKB funds come
from the genesis key named in `ckb/dev.toml` (public, dev only). LND wallets are created without a seed backup.

## Tunables

`scripts/lib/settings.ts` lists every amount, timeout and retry the scripts use, each with a `DEVNET_*` variable to
override it, for example `DEVNET_LN_CHANNEL_SATS`, `DEVNET_FIBER_CKB_CHANNEL_SHANNONS`, `DEVNET_FIBER_RUSD_CHANNEL`,
`DEVNET_SMOKE_LN_SATS` or `DEVNET_WAIT_TIMEOUT_MS`. Amounts are base units (sats, shannons, RUSD units of 10^-8).
The scripts read these from the environment of the npm command (`devnet/.env` is read by Compose only), for example
`DEVNET_WAIT_TIMEOUT_MS=300000 npm run bootstrap` in Git Bash or `$env:DEVNET_WAIT_TIMEOUT_MS=300000` in PowerShell.

Three tunables steer how `npm run up` catches LND up after lost blocks (Troubleshooting): `DEVNET_LND_STUCK_SECONDS`
(15; how long LND may stay behind before its log is read again; must exceed LND's 5 s wallet-sync retry),
`DEVNET_LND_LOG_TAIL_LINES` (200; lines of each LND log read) and `DEVNET_MAX_CATCH_UP_BLOCKS` (2016; most blocks the
doubling batches add in one run; 0 turns them off).

## How it is built

| Path | What |
| --- | --- |
| `docker-compose.yml` | The services, volumes and inline `bitcoin.conf` / `lnd.conf` |
| `ckb/dev.toml`, `ckb/contracts/` | Fiber v0.9.1's dev chain spec and contract binaries (`tests/nodes/deployer/dev.toml`, `tests/deploy/contracts/`), so the Fiber contracts, simple_udt and xUDT are in genesis |
| `ckb/docker-entrypoint.sh` | Initialises the CKB data directory from that spec and runs the node on the stock `nervos/ckb` image; for `ckb-miner`, calls the node's `generate_block` every `CKB_BLOCK_INTERVAL_MS` (like Fiber's own harness), which keeps producing after the Docker VM clock jumps back, where `ckb miner` stalls the chain |
| `fnn/Dockerfile` | Debian slim with the fnn v0.9.1 release binary (checksum verified); release timings, not the debug ones of Fiber's own harness. `fnn-hub` builds the image and `fnn-user` runs the same tag (two services building one tag race on a first start) |
| `fnn/config.yml` | Shared fnn config; per-node values come from the environment in `docker-compose.yml` |
| `scripts/bootstrap.ts`, `scripts/steps/` | The bootstrap, one file per step |
| `scripts/smoke.ts`, `scripts/smoke/` | The smoke test |
| `scripts/lib/` | Clients for bitcoin-cli, lncli, fnn JSON-RPC and CKB (CCC), settings, constants, waits, and the decisions for catching LND up after lost blocks (`chain-heal.ts`; `scripts/steps/lightning-sync.step.ts` runs them) |

fnn finds the FundingLock, CommitmentLock and auth cells in the genesis it builds from `ckb/dev.toml` (mounted at
`/devnet/ckb`), so its config needs no `scripts` section. The scripts read script locations from the genesis block
and published ports from Compose, so nothing about the chain or the ports is copied into them.

## Timing notes

- fnn is a release build: the minimum `final_expiry_delta` is 160 minutes, and fnn fails a held TLC about 161
  minutes before it expires. The smoke test uses 6 hours, like the hub's default.
- Bitcoin blocks only come when something mines them (`npm run mine`), which matches the hub's `regtest` timing
  profile. CKB blocks come every `CKB_BLOCK_INTERVAL_MS`.
- Bitcoin Core writes its block index about once an hour and its chainstate about once a day, and only a clean stop
  writes the rest. So after every mine the scripts call `bitcoin-cli gettxoutsetinfo none`, which writes everything at
  once (about 0.3 s).

## Troubleshooting

- **A port is in use**: set its override variable (table above), preferably in `devnet/.env`, and run `npm run bootstrap` again.
- **LND says it is not synced** after the stack was stopped for a while: `npm run up` (it mines a block when needed)
  or `npm run mine`.
- **LND logs `Unable to synchronize wallet to chain, trying again in 5s: -8: Block height out of range`**, and
  `lncli getinfo` says `synced_to_chain: false` although its healthcheck passes: bitcoind lost its newest blocks in an
  unclean stop (Windows shut down, Docker Desktop quit or its VM killed, with the devnet running). Bitcoin Core had not
  written them yet, and on regtest nobody sends them again, so LND's wallet is ahead of the chain and waits for ever.
  Run `npm run up`; it says what it found and mined:
  - When bitcoind comes back below the tip in `state/bitcoin-tip.json`, it mines the gap plus one block (`bitcoind is
    at height 160, below the 177 the devnet scripts mined to ... Mining 18 blocks`), and LND rolls back to the fork and
    syncs.
  - For blocks it has no record of (mined with `bitcoin-cli` by hand, or before the scripts recorded tips), it mines one
    block, then, every `DEVNET_LND_STUCK_SECONDS` while an LND node still logs that error, 2, 4, 8, ... more (at most
    `DEVNET_MAX_CATCH_UP_BLOCKS` in all) until both nodes sync.
  - By hand: `npm run mine -- <n>` with `n` above the number of lost blocks; LND recovers once the tip passes its
    wallet's height.
  - Lost blocks that held transactions (channel opens of a bootstrap that had just run) are rolled back. LND sends its
    own again, but one that spent a lost coinbase can never confirm: `npm run reset` and `npm run bootstrap`.
  - To avoid it: `npm run stop` before shutting Windows down or quitting Docker Desktop. Blocks the scripts mine are
    written to disk at once, so lost blocks should only be ones mined some other way.
- **Payments fail right after `docker compose start`**: the nodes have not found each other again; run `npm run up`.
- **`ckb-miner` logs `generate_block failed ... BlockTimeTooNew`**: the Docker VM's clock jumped back by more than
  the 15 s CKB allows for a block in the future. The producer keeps retrying and logs `Producing blocks again` once
  the clock has caught up, usually within seconds. Nothing to do.
- **A port override was set for one command only**: `npm run up` rewrites `hub.env` to the ports it published; keep
  overrides in `devnet/.env` instead.
- **fnn logs `ERROR ... Remove TLCs for payment hash ... because of error HoldTlcTimeout`** when a hold invoice
  receives its payment: fnn v0.9.1 logs this while rejecting an empty list of extra TLCs. The held TLC stays; the
  smoke test checks that it is still in the channel before settling.
- **Running `docker compose exec` by hand in Git Bash**: set `MSYS_NO_PATHCONV=1` first, or Git Bash rewrites
  container paths such as `/root/.lnd/...`. The npm scripts are not affected.
- **Changed `ckb/dev.toml` or a contract binary**: the genesis changes, so run `npm run reset`.
- **Anything else**: `npm run logs`, or `npm run reset` and `npm run bootstrap` for a clean start.
