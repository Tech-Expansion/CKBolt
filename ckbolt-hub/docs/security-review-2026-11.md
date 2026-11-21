# Security review, November 2026

Four independent, read-only reviews ran on 16 November 2026, one each for:

- the hub (`src/`, at 74689eb);
- the web app (`../ckbolt-web`, at eb1b8e8);
- the deploy kit (`deploy/`);
- the cWBTC faucet (`../cwbtc-faucet`).

The server was also checked read-only.

This file lists every finding and its status. Per the project's rule 7, the tests of each fix were written by someone other
than its author. "Fixed (untested)" means that is still to come.

## What the reviews found sound

- **Swap engine:**
  - No double payout.
  - No settle before the preimage is known and checked.
  - No refund while a payout is in flight.
  - One swap per quote and one hash per swap.
  - Restart recovery works.
- **Invoice checks:** network, exact amount, expiry, sha256, MPP refused, asset by type script, delta and CLTV within the timing caps.
- **Proxy and hub authentication:** the secret is compared in constant time; X-Forwarded-For is trusted only from private peers; cancel tokens are stored as hashes.
- **Web proxy:**
  - Strict path and method allow-list.
  - CSRF stopped by the JSON content type and the Origin and Sec-Fetch-Site checks.
  - Framing denied.
  - Origin-checked postMessage relay.
  - Keystore uses AES-256-GCM with scrypt.
  - Pay's Confirm page shows exactly what is paid.
  - No XSS sink found.
- **Deploy kit:**
  - Only the P2P ports (8228, 9735) and the hub on loopback are published.
  - Missing secrets stop Compose.
  - Binaries are verified.
  - No privileged containers and no Docker socket mounts.
- **Server:**
  - The admin ports of fnn, LND and bitcoind are not reachable from the internet.
  - The secret files are mode 600.

## Findings and status

### Hub

| # | Finding | Severity (testnet / mainnet) | Status |
|---|---|---|---|
| H1 | Fiber invoice attributes read last-wins: a payout invoice with two `hash_algorithm` or two `udt_script` entries passes the check on one value while fnn may use the other | Medium / Critical if fnn reads the first | Fixed and tested: repeated attributes are refused (`fiber-rpc.mappers.ts`) |
| H2 | The hub served every request when HUB_PROXY_SECRET was unset, even when reachable from outside | Medium | Fixed and tested: refuses to start when HUB_HOST is not loopback and there is no secret, unless HUB_ALLOW_OPEN_API=true |
| H3 | IPv6 clients counted per address when the proxy is trusted | Medium | Fixed and tested: counted per /64 (`clientNetworkKey`) |
| H4 | Swap id in hold invoice memos (an id lets anyone read the swap) | Low | Fixed and tested: memo is "CKBolt swap" |
| H5 | No check that the timing profile matches the Bitcoin network | Low / High | Fixed and tested: mainnet starts only with the mainnet profile |
| H6 | One fresh price source is enough; two sources are averaged; prices up to 10 minutes old | Medium on mainnet | Fixed and tested: a coin's price is the median of the largest group of fresh sources that agree within PRICE_MAX_SPREAD_BPS (300), and that group needs PRICE_MIN_SOURCES (2); two equal groups that share no source give no price. So one wrong feed among agreeing ones is left out instead of setting or blocking the price. PRICE_MAX_AGE_SECONDS default 120. The live hub uses all three sources (coingecko, binance, kucoin) |
| H7 | LN inbound channels push sats to any requester | Low / High | Fixed and tested; live since 21 November: on `BTC_NETWORK=mainnet`, `LN_INBOUND_PUSH_SATS` defaults to 0 and any other value is refused at start-up. There is no opt-in: the per-client caps can be worked around with new keys, and paid channel requests are mainnet design (H11). Test networks keep the 20,000-sat default |
| H8 | Removing an asset strands its open swaps | Low | Fixed and tested; live since 21 November: the hub refuses to start while an open swap (not final, or failed and not refunded) is in an asset it no longer serves. The message names the swaps and the asset to put back (`assertOpenSwapAssetsServed`, checked before the recovery pass) |
| H9 | Quotes are never pruned | Low | Fixed and tested; live since 21 November: quotes that expired more than `QUOTE_RETENTION_DAYS` (7) ago and that no swap references are deleted at start-up and every `QUOTE_PRUNE_INTERVAL_MINUTES` (60). One statement checks the reference (`QuoteRetentionService`, `QuoteRetention` port) |
| H10 | Node error text reaches API clients | Low | Fixed and tested; live since 21 November: the adapters' client-facing errors are fixed sentences (invoice cannot be read, node unavailable, node data unreadable). The node's text and the call go into a log-only `detail` (`HubErrorOptions`), which `describeError` prints and the HTTP filter logs. A reason the hub writes about the user's own invoice (a repeated attribute, an unknown currency, an unknown Lightning prefix) is still shown. Swap events already carried only `SWAP_REASON` sentences |
| H11 | Inbound Fiber channels are never closed; per-client caps can be bypassed with many IPv6 /64s; the free option is priced flat for any lock time | Medium / High | Mainnet design (stage 4): idle close, a cost for unpaid swaps and channel requests, premium by lock time. Design: docs/mainnet-design.md |

### Web app

| # | Finding | Severity | Status |
|---|---|---|---|
| W1 | The browser never checked that the hub's hold invoice has the swap's hash, the quoted amount and asset, and the hub as payee | Medium / High | Fixed and tested; live since 20 November. CKB or a token to BTC: the node reads the hold invoice itself and requires: the hash of the visitor's own Lightning invoice, the quoted amount and token, the hub's node as payee, and a max fee. BTC to CKB or a token: the page requires the quoted amount, the payout invoice it sent, and that invoice's hash when the browser node made it. A pasted Fiber invoice from an external node cannot be read in the browser, so that hash is not checked there |
| W2 | A `pay-invoice` request on the same-origin bridge pays a swap without the node's Confirm page | Medium / High | Fixed and tested; live since 20 November: a swap payment waits for Confirm in the node (amount, what you get on Lightning, max fee), like Pay |
| W3 | Rate limits live in each serverless instance; channel requests cost nothing | Low / Medium | Partly covered by H3; the rest is mainnet design |
| W4 | CSP has no script-src, connect-src or default-src | Medium | Fixed and tested; live since 21 November: /app/fiber and /app/wallet get a strict policy from the web app's proxy.ts, with a nonce per request, `'strict-dynamic'`, the one inline script by its hash, `'wasm-unsafe-eval'` and blob: workers for fiber-js, and connect-src limited to the site, the CKB RPC and `wss:` peers. The rest of the site keeps its framing policy, since wallet extensions inject scripts there |
| W5 | Next.js 16.0.10 has applicable RSC advisories | Medium | Fixed and tested; live since 21 November: Next.js 16.4.6 |
| W6 | Keystore: 8-character passwords; restored backups keep weak scrypt parameters | Low / Medium | Fixed and tested; live since 21 November: new passwords need 12 characters (a key under a shorter one still unlocks); a record with weaker scrypt parameters is encrypted again with today's on unlock or restore |
| W7 | The funding page trusts the address in its URL | Low / Medium | Fixed and tested; live since 21 November: the page sends only to the node's own address, confirmed by the node's tab over the bridge or by the address kept next to its key; a link to any other address funds nothing |
| W8 | The proxy passes the hub's Content-Type, 3xx and Location through | Low | Fixed and tested; live since 20 November: always JSON with `default-src 'none'; sandbox` and nosniff; a 3xx becomes a 503 error; Location only on 201 |

### Deploy kit and server

| # | Finding | Severity | Status |
|---|---|---|---|
| D1 | fnn JSON-RPC needs no credential from any container on the shared Compose network | Medium / High | Partly fixed and tested; live since 21 November: bitcoind and LND have their own network (`bitcoin`), which only the hub joins besides them. fiber-ws, the fnn nodes, cloudflared and the faucet can no longer reach LND's gRPC or bitcoind's RPC. fnn's RPC is still open to the hub, fnn-demo and fiber-ws. Biscuit: plan below (fnn supports it, but minting tokens needs tooling the kit lacks) |
| D2 | The testnet server is shared with other projects and holds the hot keys | Low / High | Accepted for testnet. Mainnet needs a dedicated host and a non-root deploy user |
| D3 | No restore procedure: an old fnn store must never be restored (it can lose channel funds); an old hub DB can resume stale swaps | Low / High | Fixed: restore rules for fnn, LND and the hub database in deploy/README.md section 9; backups go off the server |
| D4 | The kit's tunnel profile does not require HUB_PROXY_SECRET | Medium | Fixed and tested; live since 21 November, on top of H2: `testnet env` stops once hub.env exists when `COMPOSE_PROFILES` lists `tunnel` and hub.env has no `HUB_PROXY_SECRET`, and `testnet:check` fails the same case. Neither reads the secret back |
| D5 | hub.env holds the proxy secret but is created world-readable | Low / Medium | Fixed and tested (0862a48): `testnet env` creates hub.env owner-only and runs chmod 600 on it every time |
| D6 | add_token.py drop guard parses YAML with regexes; temp folder mode 777; writes are not atomic | Low | Fixed and tested (Python tests: 155); live since 21 November. The guard reads the `ckb:` block with a small reader of the block-style YAML the kit writes (standard library). A block it cannot read counts as a drop, so it fails closed. The generator's out folder stays owner-only (0700) and the hub image writes into it as the caller's uid. Files are written through a temporary file and `os.replace`, keeping their mode and owner |
| D7 | Containers without log rotation, no-new-privileges, or socat max-children | Low / Medium | Fixed and tested; live since 21 November: every service has json-file rotation (`LOG_MAX_SIZE` 10m, `LOG_MAX_FILES` 5) and `no-new-privileges` (checked against each image: none needs setuid). fiber-ws relays at most `FIBER_WS_MAX_CHILDREN` (200) connections at once |
| D8 | Third-party images pinned by tag, not digest | Low / Medium | Fixed and tested; live since 21 November: LND, cloudflared and socat run as `image:tag@sha256:...` (`LND_DIGEST`, `CLOUDFLARED_DIGEST`, `SOCAT_DIGEST` next to the version variables). The bitcoind and fnn base images (`debian:bookworm-20261104-slim`) and the hub's `node:22.23.5-bookworm-slim` are pinned by digest too. deploy/README.md, "Image digests", says how to move one |
| D9 | The hub's LND macaroon is broader than needed | Low / Medium | Fixed and tested; live since 21 November: the kit and the devnet bake the hub and demo macaroons with LND URI permissions for exactly the 13 calls the LND adapter makes. Checked against LND v0.21.4: every call the adapter makes works, and ListChannels, DeleteAllPayments, UpdateChannelPolicy and NewAddress are denied. Entity permissions (`offchain:write`) also allowed deleting payments, changing fees and restoring channel backups |

### cWBTC faucet

| # | Finding | Severity | Status |
|---|---|---|---|
| F1 | Long lock args made each claim cost about 725 CKB instead of 147 | Medium | Fixed, tested, deployed 2026-11-20: exact args lengths (20 standard, 22 JoyID) and a capacity backstop |
| F2 | Rate limits per full IPv6 address and per address text | Medium | Fixed, tested, deployed 2026-11-20: IPv6 per /64 (IPv4-mapped addresses as IPv4, however written); recipients by canonical address of the lock |
| F3 | `/api/balance` uncached against the shared public CKB RPC | Low | Fixed, tested, deployed 2026-11-20: cached 60 s, concurrent calls share one lookup |
| F4 | Admin token compared with `!==` | Low | Fixed, tested, deployed 2026-11-20: both sides hashed, then compared in constant time (the token's length is not revealed either) |
| F5 | A restored database re-sends paid claims | Low | Fixed, tested, deployed 2026-11-20: `fail-pending-claims` command and a runbook step; the claims it fails do not count for the limits |
| F6 | 28 dependency advisories in what the faucet runs | Medium | Fixed, deployed 2026-11-20: on `@ckb-ccc/core`, 7 left at run time (zod, elliptic, and the JoyID chain the faucet needs); 22 counting development tools, which the image does not ship |
| F7 | Faucet on the hub's `edge` network; key file mode 644 | Low | Key file: no change needed. The secrets folder is owner-only (700), so the 644 files in it are readable only by root on the host; the container reads them as its own user through Compose secrets. Network: unchanged; it needs the faucet's own tunnel network |

## Biscuit RPC auth for fnn (D1, plan)

What fnn v0.10.1 offers (`crates/fiber-lib/src/rpc/biscuit.rs`, `middleware.rs`, `docs/biscuit-auth.md`):

- Setting `rpc.biscuit_public_key` (or `RPC_BISCUIT_PUBLIC_KEY`) to an Ed25519 key, written `ed25519/<hex>`, turns
  authentication on for every connection.
- Each request then needs `Authorization: Bearer <base64 token>`. A method with no rule is refused.
- `subscribe_store_changes` needs `internal("store_changes")`. There is no revocation list in the config: revoking
  means a new key pair.
- The hub already sends `FIBER_RPC_TOKEN` and `DEMO_FIBER_RPC_TOKEN` this way, on HTTP and on the pubsub WebSocket.

The facts the hub needs:

- `read("node")`;
- `read("invoices")` and `write("invoices")`;
- `read("payments")` and `write("payments")`;
- `read("channels")` and `write("channels")` (inbound channels, abandons and the payout guard's force close);
- `read("peers")`;
- `internal("store_changes")`.

Why it is not done: the key pair is easy (Ed25519), but a token is Biscuit's own signed format: protobuf, Datalog
blocks, a signature per block. Fiber's documentation mints tokens with `biscuit-cli` 0.6.0-beta.2 (Rust, `cargo
install`). The hub has no Biscuit library, and writing our own encoder would leave a crypto format to maintain.

Plan:

1. A pinned one-off container that runs `biscuit-cli`. It is built from a pinned Rust image with
   `cargo install biscuit-cli --version 0.6.0-beta.2 --locked`, or uses a release binary checked by SHA-256. `testnet
   secrets` runs it on the server. It writes the private key to `secrets/biscuit/` (mode 600) and makes three tokens:
   - the hub's, with the facts above;
   - the demo wallet's, for fnn-demo: node, invoices, payments, channels;
   - an operator token, for the kit's own fnn calls. `testnet:check`, `channels`, `fund` and `smoke`, and
     add_token.py's `node_info`, all call fnn through `docker compose exec ... curl`, and those need a token too once a
     key is set.
2. Compose passes `RPC_BISCUIT_PUBLIC_KEY` from `.env` to fnn-hub and fnn-demo. hub.env gets `FIBER_RPC_TOKEN` and
   `DEMO_FIBER_RPC_TOKEN`. The kit's fnn client and add_token.py send the operator token.
3. Rehearse on the devnet first, with every e2e suite. Then on the server: pause swaps, roll out, and add a
   `testnet:check` line that a call without a token is refused.
4. Rotation: new key pair and tokens, then recreate fnn-hub, fnn-demo and the hub together.

Until then, the network separation above limits who can reach fnn's RPC to the hub, fnn-demo and fiber-ws (a socat relay
with a fixed target).

## Monitoring

New in the same work: the hub watches itself and alerts the operator through a webhook (Discord, Slack, Telegram or
JSON) or its log (docs/monitoring.md). It alerts when:

- the hub is degraded;
- a swap stays too long where money waits on the hub (payout sent but incoming not collected, payout in flight,
  payment held, refund not done);
- payout liquidity runs low;
- swap processing keeps failing;
- the payout guard closes a channel or cannot check one.

## Upstream

`list_channels` does not show a channel's commitment delay. Because of that, the hub cannot accept user-opened token
channels safely (peerChannels stays off).

A Fiber pull request adds `commitment_delay_epoch` to `list_channels`. It also covers inbound requests still waiting for
`accept_channel`, so an acceptor can read the delay before it accepts. It is ready on a local branch, with tests, and will
be opened with the owner's agreement. Fiber's maintainer welcomed it on CKBuilder issue #54.
