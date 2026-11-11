# Architecture

Clean architecture in NestJS. Dependencies point inwards; the domain knows nothing about Nest, HTTP, SQLite, LND or fnn.
The other coding rules: no hard-coding (constants in `common/constants`, tunables in config), shared code in `common`,
a RESTful API.

```
src/
  main.ts, app.module.ts          bootstrap (loads .env) and the composition root (wires every module)
  config/                         HubConfig from env (zod), .env loader, HubConfigModule (HUB_CONFIG, TIMING_PROFILE, ASSETS, CLOCK);
                                  fiber-assets.config.ts: FIBER_ASSETS (the served UDTs) and the legacy asset variables
  common/
    constants/                    protocol facts, asset metadata, timing profiles, API routes and error codes, swap names
    utils/                        hex, amounts (bigint <-> hex/decimal, sums), time, timing, errors (describeError,
                                  rethrowAsHubError), pricing maths, molecule; lightning.util (BOLT11 network from the
                                  prefix, sats as a number, minLnCltvLimit: the smallest cltv_limit LND takes);
                                  network.util (loopback and private addresses, bind hosts only a proxy can reach);
                                  script.util (CKB script and Fiber asset equality); chain.util (a node's real network
                                  from its chain: LND chain ids, fnn chain_hash); node-id.util, multiaddr.util;
                                  sliding-window-limiter.util (the rate limits and the inbound channel caps);
                                  serial-queue.util (check-then-act sequences that must not interleave)
    errors/                       HubError (with an optional cause), NotFoundError, DuplicateHashError, QuoteAlreadyUsedError,
                                  RateLimitedError (429 rate_limited; its retryAfterSeconds goes out as Retry-After)
  domain/                         pure: types, asset registry (built from config), timing policy, pricing maths (per-coin
                                  market price, asset prices by USD rule, per-asset terms), swap state machine
  application/
    ports/                        LightningPort, FiberPort, PriceSource, Clock, SwapStore, InboundOpenStore + injection
                                  tokens
    pricing/                      PricingService (contract + implementation)
    swaps/                        SwapEngine (contract + implementation), scheduler, the caps on unpaid swaps
                                  (unpaid-swap-limits.ts)
    demo/                         DemoWallet (contract + implementation)
    health/                       HealthService (contract + implementation, the plain reasons of a degraded report)
    fiber-node/                   the hub's Fiber node for other Fiber nodes: FiberNodeService (GET /v1/fiber/node) and
                                  InboundChannels (contracts + implementations, the daily caps, the rules); the peer
                                  channel offers (peer-channel.rules.ts)
  infrastructure/
    lightning/                    LND adapter (LightningPort) + LightningModule (LIGHTNING, DEMO_LIGHTNING)
    fiber/                        fnn JSON-RPC client and adapter (FiberPort) + FiberModule (FIBER, DEMO_FIBER)
    persistence/                  SQLite SwapStore, ChannelOpenLog and InboundOpenStore + PersistenceModule
                                  (SWAP_STORE, CHANNEL_OPEN_LOG, INBOUND_OPEN_STORE): one database, one migration list
    prices/                       CoinGecko, Binance, KuCoin price sources + PricesModule (PRICE_SOURCES)
  interfaces/http/
    contract/                     request schemas and response DTOs + mappers: the public API contract
    controllers, filters, pipes   REST endpoints under /v1: ApiModule, and FiberApiModule for /v1/fiber/... (its own
                                  module, so the API starts without the Fiber node services)
    guards, rate-limit/           rate limits per client (and in total for the demo wallet), the client key (clientKeyOf)
  interfaces/cli/fnn-whitelist/   fnn's udt_whitelist (fnn-hub, fnn-demo) generated from FIBER_ASSETS; in the image as
                                  dist/interfaces/cli/fnn-whitelist/main.js (docs/add-token.md)
test/
  fakes/                          FakeLightningNetwork, FakeFiberNetwork, FakeClock, FakePriceSource, FakeSwapStore,
                                  FakeInboundOpenStore
  support/                        shared by unit integration and e2e tests: the hub over HTTP (supertest), polling
  unit/                           unit tests by module
  e2e/                            end-to-end tests against the devnet (support/: devnet hub config, node views)
devnet/                           Docker compose for bitcoind regtest, 2 LND, CKB devnet, 2 fnn; bootstrap scripts
deploy/                           README.md runbook and testnet/ compose profile: Mutinynet bitcoind, LND, fnn on CKB
                                  testnet, the hub image (it runs the public testnet demo)
docs/                             plan, this file, testing.md (how to test everything), research/
```

How to run and test all of it: [testing.md](testing.md). The public demo's deployment: [../deploy/README.md](../deploy/README.md).

## Contracts between modules

| Contract | File | Implemented by | Used by |
| --- | --- | --- | --- |
| `LightningPort` | `application/ports/lightning.port.ts` | `infrastructure/lightning` | swaps, pricing (liquidity), demo, health |
| `FiberPort` | `application/ports/fiber.port.ts` | `infrastructure/fiber` | swaps, pricing (liquidity), demo, health, fiber-node |
| `PriceSource` | `application/ports/prices.port.ts` | `infrastructure/prices` | pricing |
| `SwapStore` | `application/ports/swap-store.port.ts` | `infrastructure/persistence` | pricing (quotes, payouts open swaps still need), swaps |
| `InboundOpenStore` | `application/ports/inbound-open-store.port.ts` | `infrastructure/persistence` (table `inbound_opens`) | fiber-node (the inbound opens it may abandon) |
| Timing policy | `domain/timing/timing.policy.ts` | domain timing | swaps |
| `PricingService` | `application/pricing/pricing.contract.ts` | application pricing | http, swaps |
| `SwapEngine` | `application/swaps/swap-engine.contract.ts` | application swaps | http, demo |
| `DemoWallet` | `application/demo/demo-wallet.contract.ts` | application demo | http |
| `HealthService` | `application/health/health.contract.ts` | application health | http |
| `FiberNodeService` | `application/fiber-node/fiber-node.contract.ts` | application fiber-node | http |
| `InboundChannels` | `application/fiber-node/inbound-channels.contract.ts` | application fiber-node | http |
| HTTP API v1 | `interfaces/http/contract/` | http controllers | ckbolt-web (`lib/hub/contract.ts`) |

A module that needs a change in these files asks for it instead of editing another module's contract; the integration
step applied the changes asked for while the modules were built (shared constants and helpers, new error codes and
tunables, one swap per quote, the error behaviour below).

The port files state the error behaviour every implementation keeps: lookups resolve null for "not found"; an invoice
the node cannot use throws a HubError with `invoice_invalid`; an unreachable node or an unknown outcome throws a 503
`upstream_unavailable` HubError; payInvoice resolves FAILED (Lightning) or Failed (Fiber) for a payment the node refuses
for good, because nothing was sent. In a SwapStore patch, an absent or `undefined` field means "leave unchanged".

Signatures the security review changed:

| Signature | File | What it says |
| --- | --- | --- |
| `FiberPort.heldTlcs(paymentHash, udtTypeScript)` | `application/ports/fiber.port.ts` | Counts only TLCs on ready channels in the given asset (`null` for CKB): a TLC on a channel of another asset never pays for the swap |
| `SwapFlow.readIncoming(swap)` | `application/swaps/swap-flow.ts` | Takes the swap, so a Fiber incoming leg is read in the swap's own asset |
| `SwapFlow.sendPayout(swap): PayoutLegView` | same | Sends with the swap's saved `payoutLockLimit` and returns what the paying node reports at once; FAILED means nothing of the payout is out (the node refused it or it failed for good at once) |
| `CreateSwapInput.clientKey` | `application/swaps/swap-engine.contract.ts` | The HTTP layer's client key (the one the rate limiter counts), for the caps on unpaid swaps |
| `lnSettleDeadlineHeight(profile, earliestHtlcExpiryHeight)` | `domain/timing/timing.policy.ts` | Takes the profile, whose `lndHoldExpiryDeltaBlocks` comes from `LND_HOLD_EXPIRY_DELTA_BLOCKS` |
| `new SlidingWindowRateLimiter(limit, windowMs, maxKeys)` | `common/utils/sliding-window-limiter.util.ts` (the HTTP layer imports it through `interfaces/http/rate-limit/sliding-window.limiter.ts`) | Tracks at most `maxKeys` clients (`HUB_RATE_LIMIT_MAX_CLIENTS`) and forgets the one idle the longest; `ClientRateLimitGuard(config, clock, policy)` builds one per budget, plus a shared one when `policy.total` is set |

Signatures phase 3b added (browser Fiber node, real networks):

| Signature | File | What it says |
| --- | --- | --- |
| `LnNodeInfo.network: BtcNetwork \| null`, `FiberNodeInfo.network` | `application/ports/lightning.port.ts`, `fiber.port.ts` | The network the node itself reports (LND's chain ids, fnn's `chain_hash`), not the hub's configuration; null for a chain the hub does not know (LND only; fnn's other chains read as devnet) |
| `FiberPort.listChannelDetails(peer?)` | `application/ports/fiber.port.ts` | Every channel that is not closed, with `status` (`opening`, `ready`, `closing`), `public` and `openedByPeer`; `listChannels()` keeps the balances only |
| `FiberPort.isConnected(nodeId)` | same | `list_peers` has the node |
| `FiberPort.openChannel({ peer, fundingAmount, udtTypeScript, public })` | same | `open_channel` with fnn's default commitment delay; a refusal fnn answers with throws a plain Error (nothing opened), an unknown outcome a 503 HubError |
| `HealthReport.reason?` | `application/health/health.contract.ts` | One plain sentence per problem; present only when `degraded` |

Signatures the peer channels and asset display added:

| Signature | File | What it says |
| --- | --- | --- |
| `planFiberToLn(profile, { ..., inboundCommitmentDelayEpochs? })` | `domain/timing/timing.policy.ts` | Sizes the hold for a payment arriving over a channel with that commitment delay (fnn's default when left out); `fiberHoldReserveMs(profile, epochs?)` likewise |
| `HubConfig.fiberPeers.peerChannels.terms` | `config/hub.config.ts` | Per UDT with `peerChannels`: `{ minAmount }` |
| `HubConfig.fiberPeers.peerChannels.maxOpen` | same | `FIBER_PEER_CHANNELS_MAX_OPEN` (default 10): node-opened channels in those UDTs, together, past which GET /v1/fiber/node offers none |
| `HubFiberNode.peerChannels: PeerChannelOffer[]` | `application/fiber-node/fiber-node.contract.ts` | `{ asset, minAmount, assumedCommitmentDelayEpochs }` per UDT that takes them; empty at the cap or when the node's channels cannot be read |
| `isNodeOpenedPeerChannel`, `nodeOpenedPeerChannelCount`, `offersWithinPeerChannelCap` | `application/fiber-node/peer-channel.rules.ts` | Pure: which channels count against the cap (opened by the node, in a UDT with `peerChannels`, not closed) and the offers left |
| `FiberAsset.displayName?`, `FiberAsset.iconUrl?` | `domain/types.ts` | Set only when FIBER_ASSETS sets them |

Shutdown: Nest destroys the feature modules first (the swap scheduler stops taking work and waits for what runs), then
the global ones, then closes the HTTP server; the database and the LND connections close last, on application
shutdown.

## REST API v1

| Method | Path | Success | Body |
| --- | --- | --- | --- |
| GET | `/v1/health` | 200 (503 when degraded: a node is unreachable, Lightning is not synced, or a node runs on another network than the hub is configured for) | `HealthDto` (`reason` when degraded) |
| GET | `/v1/assets` | 200 | `{ data: AssetDto[] }` (`displayName`, `iconUrl`: the operator's display metadata, null when unset) |
| POST | `/v1/quotes` | 201, `Location: /v1/quotes/:id` | `QuoteDto` |
| GET | `/v1/quotes/:id` | 200 | `QuoteDto` |
| POST | `/v1/swaps` | 201, `Location: /v1/swaps/:id` (409 `conflict` when the quote already has a swap; 429 `rate_limited` with `Retry-After` when the client or the hub has too many swaps waiting for their payment) | `SwapDto` (its `pay.invoice` is what the user pays; its `demo` is true when the demo wallet's own node receives the payout, whatever the request says) |
| GET | `/v1/swaps/:id` | 200 | `SwapDto` |
| GET | `/v1/swaps/:id/events` | 200 | `{ data: SwapEventDto[] }` |
| POST | `/v1/demo/invoices` | 201 (404 `demo_disabled` when off) | `DemoInvoiceDto` |
| POST | `/v1/demo/payments` | 202 (409 `conflict` unless the swap is pending and pays out to an invoice of the demo wallet's own node) | `DemoPaymentDto` |
| GET | `/v1/fiber/node` | 200 (503 when the hub's fnn does not answer) | `FiberNodeDto`: `nodeId`, `network` (as the node reports it), `addresses` `{ p2p, ws }` from `FIBER_PUBLIC_P2P_ADDRS` and `FIBER_PUBLIC_WS_ADDRS`, `assets` `[{ id, udtTypeScript, udtWhitelist, peerChannels }]` (`udtWhitelist`: what a node puts in its `udt_whitelist` for the UDT, null for CKB; `peerChannels`: `{ minAmount, assumedCommitmentDelayEpochs }` when a node may open its own channel to the hub in the asset, else null; see Assets and Peer channels below), `inbound` `{ enabled, amounts, fundable }` (base units per asset; empty when off) |
| POST | `/v1/fiber/inbound-channels` | 202, `Location: /v1/fiber/inbound-channels/:nodeId` (404 `inbound_disabled`; 422 `asset_unavailable`; 429 `rate_limited`; 409 `conflict`; 422 `insufficient_liquidity`; 503 `upstream_unavailable`; rules below) | `InboundChannelOpeningDto`: `nodeId`, `asset`, `fundingAmount`, `temporaryChannelId` |
| GET | `/v1/fiber/inbound-channels/:nodeId` | 200 (404 `inbound_disabled` when off; 400 `validation_failed` for a malformed node id) | `{ data: InboundChannelDto[] }`: `channelId`, `asset`, `state` (`opening`, `ready`, `closing`), `hubBalance`, `nodeBalance` |

Errors: `{ "error": { "code": "<API_ERROR_CODE>", "message": "<plain sentence>" } }`: 400 for bad input, 422 for valid
input the hub cannot serve, 409 for a conflict with existing state, 429 when a client or the hub is over a budget, 503
when a node or every price source is unavailable.
Every code (`src/common/constants/api.constants.ts`) and the status it comes with:

| Code | HTTP status | When |
| --- | --- | --- |
| `bad_request` | 400 (or the framework's 4xx, e.g. 413) | The request cannot be read: malformed JSON, body too large, wrong method |
| `unauthorized` | 401 | `HUB_PROXY_SECRET` is set and the request does not carry it in `X-CKBolt-Proxy-Secret` |
| `validation_failed` | 400; 422 from pricing | A body or route parameter fails the schema (400); a quote amount that is not positive, rounds to nothing or puts the Lightning side outside the per-swap caps (422) |
| `not_found` | 404 | Unknown quote, swap or route |
| `conflict` | 409 | The quote already has a swap (one swap per quote); a demo payment for a swap that no longer waits for one, or whose payout does not go to the demo wallet; an inbound channel to a node that is not connected to the hub's fnn, or that already has a channel from the hub in the asset (open or opening) |
| `quote_expired` | 422 | The quote's validity has run out |
| `quote_unavailable` | 503; 422 | No fresh market price, so no quote can be made (503); a stored quote whose signature no longer verifies (422) |
| `purpose_unsupported` | 422 | A quote `purpose` the hub does not serve for the direction (request quotes are ln_to_fiber only) |
| `cancel_refused` | 403 | `POST /v1/swaps/:id/cancel` without the swap's cancel token, missing or wrong alike |
| `asset_unavailable` | 422 | A well-formed asset id the hub does not serve on its network (quotes, swaps, demo invoices, inbound channels), or has no inbound channel amount for; a malformed id is 400 `validation_failed` |
| `invoice_invalid` | 400; 422 | The payout invoice cannot be read (400); it is for another network, uses the wrong hash algorithm or asset, has no amount or the wrong one, expires too early, or its timing does not fit (422) |
| `duplicate_hash` | 409 | The payment hash is already used by a swap or by an invoice or payment on the hub's nodes |
| `insufficient_liquidity` | 422, 503 | 422: the payout, plus its routing fee budget, exceeds what the hub can pay out after open swaps' payouts; an inbound channel's funding exceeds what the hub's Fiber payout liquidity in the asset leaves for inbound channels (rule 6 below). 503: the unpaid swaps on the quote's side would reserve more than their share of its payout liquidity (`SWAP_MAX_UNPAID_SHARE_PERCENT`); try again later |
| `demo_disabled` | 404 | Demo routes on a hub without demo nodes |
| `inbound_disabled` | 404 | Inbound channel routes on a hub with `FIBER_INBOUND_ENABLED=false` |
| `rate_limited` | 429 (with `Retry-After`) | Too many requests (`HUB_RATE_LIMIT_PER_MINUTE`) or demo actions (`DEMO_MAX_ACTIONS_PER_HOUR`) from one client; too many demo actions from every client together (`DEMO_MAX_ACTIONS_PER_HOUR_TOTAL`); a new swap while the client has `SWAP_MAX_UNPAID_PER_CLIENT` swaps waiting for their payment, or the hub `SWAP_MAX_UNPAID` in total (`Retry-After`: when the first of them expires with its quote); an inbound channel past `FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY` or `FIBER_INBOUND_MAX_PER_NODE_PER_DAY` (`Retry-After`: when the oldest leaves the sliding day) or with `FIBER_INBOUND_MAX_OPEN` inbound channels open (`Retry-After`: one hour) |
| `upstream_unavailable` | 503 | A node does not answer or answers unreadably; balances cannot be read; the demo wallet cannot act; the hub's fnn refuses to open an inbound channel |
| `maintenance` | 503 | `SWAPS_PAUSED=true`: no new quote, swap or channel; the swaps already running finish |
| `internal_error` | 500 | Anything unexpected (logged with its stack, never shown) |

A client is the request's socket address or, with `HUB_TRUST_PROXY=true`, the last `X-Forwarded-For` entry of a request
that comes from a loopback or private address (the proxy in front of the hub); a client on the internet that reaches the
hub directly cannot choose its key with the header (`clientKeyOf`, `interfaces/http/rate-limit/client-key.ts`). The
rate limits, the caps on unpaid swaps and the per-client cap on inbound channels count the same key.

`GET /v1/health` asks each node for its own network (LND's chain ids from getinfo, mapped by genesis hash; fnn's
`node_info.chain_hash`: the testnet or mainnet genesis, anything else is a devnet) and reports what the node says. The
hub is `degraded` (503) with a `reason` of plain sentences when a node does not answer, Lightning is not synced, or a
node runs on another network than `BTC_NETWORK` / `CKB_NETWORK`. Every signet shares one genesis, so a Mutinynet hub
cannot tell an LND on the default signet from one on Mutinynet this way.

## Inbound channels (browser Fiber node)

A browser node (fiber-js) cannot listen, so it dials the hub's fnn at a WebSocket address from `GET /v1/fiber/node`
and, to receive an ln_to_fiber payout, asks for an inbound channel. `POST /v1/fiber/inbound-channels` checks, in this
order, then has the hub's fnn open a **private** channel funded from its own wallet (fnn's default commitment delay):

1. Inbound channels are on (404 `inbound_disabled`), and the asset is served with an amount (`FIBER_INBOUND_CKB_AMOUNT`,
   a UDT's `inboundAmount` in `FIBER_ASSETS`, or the legacy `FIBER_INBOUND_RUSD_AMOUNT` without it; 422
   `asset_unavailable`).
2. The client (`clientKeyOf`) and the node are under their caps for the last sliding day (429).
3. The node is connected to the hub's fnn (`list_peers`; 409 `conflict`).
4. The hub's fnn has no live channel it opened to that node in that asset, ready or opening (409 `conflict`).
5. Fewer than `FIBER_INBOUND_MAX_OPEN` inbound channels (live, private, opened by the hub's fnn) exist (429).
6. The funding fits in `inboundFundingRoom` (`application/fiber-node/inbound-channel.rules.ts`; 422
   `insufficient_liquidity`): the hub's Fiber payout liquidity in the asset, worked out as for `GET /v1/assets` (ready
   channels less what open swaps reserve, fee budgets included) but without its private channels, which pay only their
   own node (its inbound channels, and channels nodes opened to it privately, `paysOnlyItsPeer`), less what its inbound
   channels in the asset (opening included) already hold. So all inbound channels
   together never hold more than the hub keeps free to pay out swaps. The fnn wallet the funding comes from cannot be read
   over fnn's RPC; if it is short, fnn fails the open after it has answered, without telling the hub.

Opens run one at a time (`SerialQueue`), so two requests cannot both pass before the first channel shows on the node. A
refusal fnn answers with opens nothing and counts against no cap (503); an open whose answer is lost counts. The open
channels are read from the node, so they survive a restart, and so do the daily counts (the hub's database,
`ChannelOpenLog`). The fnn adapter lists channels with two `list_channels` calls, the plain one and `only_pending`: a
channel the hub asked a node to open that the node has not accepted yet appears only in the second (under its temporary
id, without its UDT, which the adapter fills in from what it opened), so a retry finds it and gets 409.

A browser node accepts the hub's CKB channel itself (`accept_channel`, with the amount its visitor chose; its config
turns fnn's automatic CKB accept off), so an open can wait for an accept that never comes (the tab closed, or the
accept failed). fnn keeps such a channel NegotiatingFunding until its funding timeout (one day by default); nothing is
funded, but it would block step 4, hold a place in step 5 and shrink step 6. So whenever the hub reads its channels for
an open or a listing (`application/fiber-node/stale-inbound-opens.ts`), it calls `abandon_channel` on every inbound
channel it opened itself whose peer has not accepted it (still `NegotiatingFunding` under its temporary id) within
`FIBER_INBOUND_ACCEPT_TIMEOUT_SECONDS` (600; at least 60, above the browser node's own 20 seconds of retries) of the
open. "Opened itself" means its temporary id is in the hub's record of the opens it made (`InboundOpenRequests` over
the `InboundOpenStore` port: table `inbound_opens` in the hub's SQLite database, key `temporary_channel_id`, with
`peer` and `asked_at`, the hub's clock), never the channel's flags: fnn v0.9.1 lists every channel still waiting for
its peer (`only_pending`) with `is_public: false`, so a public channel an operator opened over fnn's RPC would read as
an inbound one. The record survives a restart, so an open still waiting from before it is abandoned like any other,
timed from when the hub asked. A record is deleted once its channel is abandoned, or, at the first read after its
timeout, once the listing shows the channel no longer waiting (accepted) or no longer there (failed, abandoned, fnn's
data reset); a younger record stays even when unlisted, since a listing can miss an open made while it ran. Only an
open whose open_channel answer was lost (the hub never learnt its id) is left to fnn's own funding timeout, blocking
that node's next request in its asset until then. A refused abandon (accepted in between) keeps its record, is only
logged and is tried again at the next read. The daily caps still count an abandoned open.

Start-up checks (`HubConfig`), only when `FIBER_INBOUND_ENABLED=true`: an amount for at least one asset, each for an
asset the hub serves on `CKB_NETWORK`, a CKB amount of at least `INBOUND_CHANNEL_MIN_FUNDING` (199 CKB: fnn's 99 CKB
reserve plus the 100 CKB a node on fnn's defaults, such as Fiber Studio, auto-accepts; a browser node accepts every CKB
channel by hand), and at least one public address. An empty `FIBER_INBOUND_*_AMOUNT=` counts as not set. A UDT's
minimum is its own: `FIBER_ASSETS` refuses an `autoAcceptAmount` above the `inboundAmount` (a browser node whitelisting
it would not take the hub's channel on its own). Each UDT channel locks about 180 CKB of fnn's wallet as its reserve.

`GET /v1/assets` (pricing) still counts every ready channel's local balance, inbound channels included, although an
inbound channel pays only its own node: a quote whose payout goes to another node can be refused only at payout time
(then refunded). Leaving them out would refuse quotes whose payee is the browser node itself.

## Assets (FIBER_ASSETS)

CKB is built in. The UDTs the hub serves on `CKB_NETWORK` come from config, so a new token needs no code change:
`FIBER_ASSETS` (`src/config/fiber-assets.config.ts`) is one JSON list, validated at start-up, that `HubConfig` turns into
`ckb.udtAssets` (the asset registry, `ASSETS`), `pricing.termsByAsset` and the inbound channel settings. Per entry:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Upper-case letters and digits, 2 to 16, starting with a letter (`ASSET_ID_PATTERN`); `CKB` and `BTC` are reserved. What requests and responses call the asset |
| `symbol`, `name`, `decimals` | yes | Display metadata; decimals 0 to 18 (base units are 10^-decimals) |
| `usdRule` | yes | `usd_peg` ($1, e.g. RUSD) or `btc_parity` (1:1 with BTC, e.g. cWBTC). `ckb_market` is CKB's own |
| `typeScript` | yes | `{ codeHash, hashType, args }`, the UDT's exact type script (the registry finds an asset by it, hex case aside) |
| `cellDeps` | yes, at least one | As fnn's `udt_whitelist` needs them: `{ "outPoint": { "txHash", "index" }, "depType": "code" \| "dep_group" }` or `{ "typeId": <script> }`; `index` a hex quantity or a whole number |
| `feeBps`, `optionPremiumBps` | no | The asset's own hub fee and option premium; `FEE_BPS`, `OPTION_PREMIUM_BPS` otherwise. The fee must stay above `LN_MAX_FEE_BPS` and `FIBER_MAX_FEE_BPS`. A BTC-parity token can run with premium 0 |
| `minSats`, `maxSats` | no | The asset's own Lightning bounds per swap (decimal strings or safe integers); `SWAP_MIN_SATS`, `SWAP_MAX_SATS` otherwise. `GET /v1/assets` reports each asset's own |
| `inboundAmount` | no | Base units one inbound channel in the asset is funded with; without it the asset gets no inbound channels |
| `autoAcceptAmount` | no, needs `inboundAmount` | The `auto_accept_amount` a browser node whitelists to take the hub's channel; at most `inboundAmount`, which it defaults to. fnn-demo's generated whitelist auto-accepts from it too |
| `peerChannels` | no | `{ "minAmount": <base units> }`: nodes may open their own channel to the hub in the UDT, funded with their own tokens. fnn-hub's generated whitelist auto-accepts one from `minAmount` on. See "Peer channels" below |
| `displayName` | no | The name the web app shows instead of `name`: 1 to 64 characters, no control characters. `GET /v1/assets` `displayName`, null when unset |
| `iconUrl` | no | The icon the web app shows, either an https URL (at most 2,048 characters, no user name or password) or an inline SVG `data:image/svg+xml;base64,...` of at most 8,192 characters. The SVG may hold no script, event handler, link, animation, character reference, DTD or outside reference (`ICON_URL_RULE`). `GET /v1/assets` `iconUrl`, null when unset |

Unknown keys, duplicate ids or type scripts, and a non-empty list on mainnet (the hub serves no UDT there in stage 3) are
refused. `FIBER_ASSETS=[]` serves CKB only. Every listed UDT must also be in the hub fnn's `udt_whitelist`
(`deploy/testnet/fnn/hub.yml`), with its `args` anchored as `^…$` because fnn reads them as a regex. fnn reads the
whitelist only at start. That whitelist, and fnn-demo's, is generated from `FIBER_ASSETS` by
`src/interfaces/cli/fnn-whitelist` (`npm run fnn-whitelist`, or in the hub image on the server through
`deploy/testnet/add_token.py`). It rewrites only the `udt_whitelist` block, and is the way to add a token:
[add-token.md](add-token.md).

**Display.** `displayName` and `iconUrl` let the operator show a new token with no web change. An https icon is fetched
from its own host. On a page with `Cross-Origin-Embedder-Policy: require-corp` (the web app's node page in browsers
without Document-Isolation-Policy) it shows only if that host sends `Cross-Origin-Resource-Policy: cross-origin`. An
inline SVG needs no request, so it shows everywhere. Either is shown only as an image (`<img src>`). The SVG deny-list
is defence in depth, not a sanitizer for inlined markup.

**Backward compatibility.** Without `FIBER_ASSETS` (unset or empty), the legacy variables apply as before: RUSD from
`UDT_RUSD_SCRIPT` (on testnet Fiber's whitelist script when unset, with its known type-id cell dep), CWBTC from
`UDT_CWBTC_SCRIPT` (no cell deps known), RUSD inbound channels from `FIBER_INBOUND_RUSD_AMOUNT` (auto-accepted at that
amount), every asset at the global terms, and none on mainnet. Setting `FIBER_ASSETS` together with any of those three
variables is refused at start-up, naming the ones to remove.

**Prices per coin.** A price source answers per coin (`UsdPrices`: `btc` and `ckb`, each `{ usd, at }` or null when that
coin's feed failed); a source fails only when it has no coin. `MarketPriceService` takes, per coin, the median of the
fresh prices, timestamped with the oldest one used, and answers 503 `quote_unavailable` only when no coin has one.
`assetPriceFor` then needs only the coins the asset's rule uses: BTC for every quote (the Lightning leg), CKB only for
`ckb_market`. So RUSD and cWBTC are quoted while the CKB feeds are down, and CKB quotes answer 503. The signed quote is
unchanged: `btcUsd`, `assetUsd`, `priceAt` (the oldest coin price used) and `priceSource` (`median:` and every source
used).

**Browser nodes.** `GET /v1/fiber/node` gives, per served UDT, `udtWhitelist`: `name` (the symbol), `script` (exact; write
`args` as `^<args>$`), `cellDeps` (fnn's `cell_dep` / `type_id` in camelCase) and `autoAcceptAmount` (decimal string, the
hub's offer for the asset; null when it opens no inbound channel in it). A web app builds fiber-js's `udt_whitelist`
entry from it. It also gives `peerChannels` per asset: `{ minAmount, assumedCommitmentDelayEpochs }`, or null (also for
every asset at the cap of node-opened channels; see "Peer channels").

## Peer channels (a node's own token channel to the hub)

A browser node can pay the hub in a UDT only from a channel that holds its own tokens. The CKB way does not work for
UDTs on fnn v0.9.1: there the hub opens the channel and the node adds its CKB with `accept_channel`, but a UDT funding
transaction with the accepting side's tokens is broken in that version (fixed later upstream, nervosnetwork/fiber#1671).
So for an asset with `peerChannels`, the node opens the channel itself, and fnn-hub's whitelist auto-accepts it from
`minAmount` on. Auto-accept funds a UDT channel with 0 tokens from the accepting side
(`network.rs` `handle_peer_message`, `ChannelInitialization`), but fnn-hub still locks its own CKB reserve, about
180 CKB a channel. CKB channels from nodes stay off: fnn auto-accepts CKB only with
`auto_accept_channel_ckb_funding_amount` above 0, and the kit sets it to 0.

**Cap.** `FiberNodeServiceImpl.describe` reads `listChannelDetails()` once per `GET /v1/fiber/node` (the same listing
the inbound `fundable` flags use; no polling loop) and counts the channels a node opened (`openedByPeer`: `is_acceptor`
true, or not reported) in any asset with `peerChannels`, in every state but closed, opening ones included: each holds,
or will hold, fnn-hub's reserve. At `FIBER_PEER_CHANNELS_MAX_OPEN` or more, `peerChannels` is empty, so every asset's
`peerChannels` is `null` in the response, the shape the web app already reads as "no own-token channel". A listing that
fails gives the same (fail closed, logged as a warning). This only stops CKBolt's UI from offering the path: fnn v0.9.1
has no per-count accept limit, so fnn-hub still auto-accepts a channel opened directly by any fnn client with at least
`minAmount`, cap or not. Its CKB is bounded only by `minAmount`, fnn-hub's wallet, and removing `peerChannels`.

**Safety.** The opener chooses the channel's commitment delay D. fnn accepts any well-formed D from 1 to 84 epochs
(`fee.rs` `check_open_channel_parameters`), and no RPC reports it: `list_channels` shows only `is_acceptor`, and a
pending channel shows nothing more. fnn fails a held TLC once `expiry < now + 2/3·D·4 h + 60 s`. A swap paid over such a
channel is safe only if the hub's Lightning payout resolves before that point, counted for the D the opener may have
chosen. The hub therefore:

- counts 84 epochs (`FIBER_PEER_CHANNEL_COMMITMENT_DELAY_EPOCHS`, default 84) for every channel a peer opened
  (`fiberHeldTlcFailsAt`), and refuses to start while any asset has `peerChannels` and that variable is not 84
  (`assertPeerChannelDelayUnverified`), since anyone may open such a channel with any delay;
- sizes every fiber_to_ln hold invoice in an asset with `peerChannels` for an 84-epoch channel
  (`planFiberToLn(..., inboundCommitmentDelayEpochs)`): the final expiry delta covers 224 h + 60 s + `fiberMarginMs` plus
  the Lightning payout window, about 237 h on Mutinynet, under Fiber's 14-day limit;
- refunds a payment that came over a peer-opened channel and leaves too little time, with the reason
  `SWAP_REASON.peerChannelHoldTooShort`.

The cost is the worst case if the hub stops mid-swap. A payment held over a hub-opened channel (D = 1) stays locked up to
about 10 days. One held over an 84-epoch channel stays locked about 13 h. A hub that runs settles or refunds within
minutes.

**Liquidity.** A private channel a node opened pays only that node, so it no longer counts as payout liquidity when the
hub decides how much more it may put into inbound channels (rule 6 above, `paysOnlyItsPeer`). `GET /v1/assets` still
counts it, as it counts inbound channels. Payouts are not over-promised for good: one that cannot route is refunded.

## Swap state machine

```
pending --(incoming held, quote valid, timing ok)--> incoming_accepted --(payout sent)--> outgoing_in_flight
outgoing_in_flight --(payout succeeded, preimage saved)--> outgoing_succeeded --(incoming settled)--> succeeded
pending | incoming_accepted | outgoing_in_flight --(definite failure)--> failed  (+ cancel incoming = refund)
```

`outgoing_succeeded` never goes to `failed`. A payout that reports a preimage matching the hash has succeeded whatever its
state says; a Fiber payout that reads `Failed` stays `outgoing_in_flight` while any channel still has a TLC the hub sent
for the hash whose removal is not acknowledged (any outbound state but `RemoveAckConfirmed`). `failed` with
`refunded = false` stays in `listOpenSwaps()` until the incoming leg is cancelled.

`outgoing_in_flight` goes to `failed` (with a refund) in three cases (`application/swaps/swap-processor.ts`):

- the payout definitely failed: the paying node reports it failed with no preimage that matches the hash (on Fiber,
  only once no part of it is still out);
- the paying node refused the payout at send time (`sendPayout` answers FAILED: nothing was sent): the hub refunds in
  the same pass instead of sending again on every pass until the hold runs out;
- the paying node has no record of the payout (a crash right after saving `outgoing_in_flight`, or a send whose answer
  was lost): while the hold allows a payout the hub sends it again, at most `PAYOUT_MAX_RESENDS` times (each resend is
  saved as a `payout_retried` event before it is sent, so the count survives a restart). Once the resends are used up
  or the hold no longer allows a payout, it refunds, but only after the payout has stayed unknown for
  `PAYOUT_MISSING_CONFIRM_SECONDS` since the last send: a send whose call timed out can still be starting inside the
  node until then.

When the node has already released the incoming leg, the swap fails without a cancel call (`refunded = true`).
