# CKBolt context

What the project is, what exists, what was decided and why. Update this file when a decision changes.

## The product in one paragraph

Bitcoin payments run on Lightning, CKB payments on CKB's Fiber Network, and the two cannot pay each other. CKBolt is a
hub between them. It runs a Lightning node (LND) and a Fiber node, prices each route, and locks both legs of a payment to
one SHA-256 payment hash using hold invoices: the recipient is paid and the hub settles, or the payer is refunded.
Fiber already ships a Cross-Chain Hub (CCH) that does this for one wrapped-BTC token at a fixed 1:1 rate; CKBolt adds a
price per route so native CKB and CKB stablecoins work too (RUSD is whitelisted on Fiber testnet and is the stablecoin
the site uses as its example; USDI, formerly the mainnet default, was discontinued on CKB in August 2026, so the site and
the app no longer offer it). Uses: a merchant gets paid in CKB by any Lightning wallet; a CKB holder pays a Lightning
invoice; anyone swaps BTC and CKB tokens both ways. Ethereum comes later through Perun channels.

Who: TEX Labs (texlabs.org). Audience of the site: reviewers (grants, ecosystem), merchants, wallets, liquidity
providers. The site aims to show reviewers quickly what problem CKBolt solves and what CKB gains.

## Two states: no hub, or a live hub

The server decides. `/app` does real things only through a CKBolt hub: when `HUB_URL` points at a healthy hub, Swap,
Pay and Get paid run on testnet (stage 3, see "Live mode" below). Without `HUB_URL`, or while the hub is unreachable
or degraded, each tab says so in one line in the hub's status colour (`components/app/hub-unavailable.tsx`); since
2026-10-30 there is no stage 2 simulation on `/app` any more. The page's eyebrow and lead follow the same check: "Live
testnet demo" by default, "Live on testnet: real swaps with test money" once the hub is live.

## What is real without a hub

- Reference prices: `/api/rate`, CoinGecko then Binance then KuCoin, 20 s server cache, a source older than 10 minutes
  is skipped. The landing page's examples use them, labelled as reference prices.
- Lightning network figures: `/api/lightning-stats` from mempool.space, 1 h cache, saved snapshot when the source fails.
- Codecs: BOLT11 (decode, and encode unsigned invoices for tests), Fiber invoices (bech32m, fibb/fibt/fibd), CKB
  addresses (RFC 0021), BIP21, QR scanning.
- The browser Fiber node itself (the header's Fiber node, `/app/fiber`): keys, start, channels need the hub's Fiber node
  to be of use, but the node runs and funds without it.
- Removed with the simulation (2026-10-30, [pay-get-paid.md](pay-get-paid.md) "Removed"): the simulated settlement and
  merchant checkout, the ETH route, the CKB and Bitcoin wallet panels, quote signing, and `/api/btc-balance`.

## Live mode (stage 3): what is real when `HUB_URL` points at a hub

When it is live:
- The browser asks `GET /v1/health`, then `GET /v1/assets`, once per page load (one status for the whole page, shared by
  the intro and the swap form). The hub is live when it reports `ok` and serves at least one asset in some direction.
  A live or degraded hub is checked again every minute; an unconfigured or unreachable one is not asked again until
  reload; a running swap keeps the state it started with. A reachable but degraded hub leaves the tabs
  saying so, with its reason behind a "?".
- Every call goes through `/api/hub/v1/...`, a same-origin proxy (`app/api/hub/[...path]`) with a path and method
  allow-list, a body limit, a timeout and a rate limit. The allow-list is the paths the app calls (`lib/hub/routes.ts`):
  health, assets, quotes, swaps, their events and their cancel (POST only, the one route that passes a browser header
  on: the swap's cancel token), the Fiber node and its inbound channels, the Lightning node and its
  inbound channels. Anything else, the hub's demo wallet (`/v1/demo/*`) included, is a 404 that never reaches the hub.
  Writes must come from the app's own pages (`lib/hub/request-guard.ts`): a POST that is not
  `content-type: application/json`, or whose `Sec-Fetch-Site` or `Origin` names another site, is a 403 `forbidden`,
  so another site cannot make a visitor's browser spend that visitor's budget at the hub.
  With the server-only `HUB_PROXY_SECRET` the proxy sends the hub `X-CKBolt-Proxy-Secret` and `X-CKBolt-Client` (the
  client key of its own rate limit: with `TRUST_PROXY=1`, the last `X-Forwarded-For` entry, an IPv6 address counted by
  its /64, `lib/client-address.ts`); the hub then refuses callers without the secret (401 `unauthorized`). The secret
  needs `TRUST_PROXY=1` and an https `HUB_URL`, unless the hub is on a loopback address; otherwise the proxy forwards
  nothing and logs the fix. Without `HUB_URL` it answers 503 `hub_unavailable`. Errors keep the hub's shape
  `{ error: { code, message } }`; besides the hub's codes the proxy answers `hub_unavailable`, `hub_timeout`,
  `forbidden`, `method_not_allowed` and `payload_too_large` (all listed in `lib/hub/contract.ts`). The app shows the
  message as it comes.

What is real then:
- The hub (`../ckbolt-hub`) runs a Lightning node (LND) and a Fiber node on test networks: bitcoind regtest and a CKB
  devnet locally, and Bitcoin Mutinynet and CKB testnet on the testnet hub that the public demo at
  https://ckbolt.texlabs.org uses (runbook in `../ckbolt-hub/deploy/`). Swaps move test money between those nodes and
  the user's wallets.
- The page shows "Live on testnet" and opens on Swap. The Swap tab is a card that reads like a DEX swap
  ([live-swap-ui.md](live-swap-ui.md)) and offers only what the hub serves (`GET /v1/assets`): CKB and RUSD on the
  testnet hub today, and cWBTC (CCH Wrapped BTC) once its `FIBER_ASSETS` lists it, both directions (BTC on Lightning
  to the asset on Fiber, and back). No list of assets is kept in the web app (2026-11-06, below). There are no L1 wallet panels on `/app`: swaps run on Lightning and Fiber.
- One wallet (2026-10-30, [pay-get-paid.md](pay-get-paid.md)): the visitor's Fiber node, either the browser node (the
  header's Fiber node popup, its window or `/app/fiber`, driven over a same-browser bridge) or the visitor's own node.
  The Lightning side is any wallet on the hub's network: the hub's hold invoice as a QR code to scan (or "Open in
  wallet", or a WebLN extension's "Pay with browser wallet"), or the visitor's own invoice, pasted or scanned. NWC and
  "Connect Lightning" are gone. An L1 wallet (JoyID through CCC) only funds the browser node, on `/app/fiber/fund`, and
  picks where a withdrawal goes.
- Firm quotes from the hub (`POST /v1/quotes`): the median of fresh CoinGecko, Binance and KuCoin prices, RUSD at its
  $1 peg, the hub's spread already in the amounts, per-swap limits and a liquidity check, an expiry set by the hub, and
  the hub's signature. No CKB DEX or oracle gives a usable price: UTXOSwap shut down on 2026-10-11.
- One "Swap" button runs every step it can: the browser node makes the payout invoice (BTC to CKB; checked in the
  browser against the quote, then by the hub) or the visitor's pasted Lightning invoice is the payout (CKB to BTC, its
  amount fixing the swap), the swap is created (`POST /v1/swaps`), the hub's hold invoice is checked against the swap
  and then paid by the browser node (CKB to BTC, never twice) or shown as a QR code for any Lightning wallet (BTC to
  CKB), and a progress dialog follows `GET /v1/swaps/:id` to "Swap complete" (with `sha256(preimage) = payment hash`
  checked in the page) or "Refunded: your payment went back to your wallet". With the user's own Fiber node the page
  cannot drive it: the user pastes the payout invoice (BTC to CKB) or pays the hold invoice by hand from a QR code (CKB
  to BTC). Both legs are held on one SHA-256 hash; the hub
  cancels the incoming hold when the payout fails.
- The hub's demo wallet (`/v1/demo/*`) is not offered in the UI, and the proxy refuses it; the hub keeps it for its
  own smoke test, which calls the hub directly.
- Public demo additions (2026-10-26, [live-swap-ui.md](live-swap-ui.md) "Public demo additions"): a Lightning channel
  from the hub, for wallets that cannot route to the hub (Alby Hub on Mutinynet; since 2026-10-30 on the guide's hub
  card, with the visitor's node id pasted); "Report a
  problem" on every swap result; `Swaps paused` when the hub is in maintenance; and the tester's guide at
  `/app/guide`.
- Hub details and getting CKB back (2026-10-26, [live-swap-ui.md](live-swap-ui.md) "Hub details and getting CKB
  back"): "Guide" and "Fiber node" in the header; a live "CKBolt hub" card at `/app/guide#hub` (the hub's Lightning
  URIs, Fiber node id and addresses, channels and limits, from its API); on the node page, Close can send the node's
  share straight to the visitor's address (fnn's `close_script`), and Withdraw sends the node's on-chain CKB to it,
  signed in the page with the node's key after the password opens the keystore again.
- The Fiber node popup (2026-10-27, [fiber-wallet-popup.md](fiber-wallet-popup.md)): the browser node runs in the
  header's Fiber node on every page, an iframe of `/app/wallet` isolated by Document-Isolation-Policy (Chrome and Edge;
  other browsers open it in a window), kept running across client-side navigation. It is the node, not a wallet: Home
  (what a swap can move, on-chain CKB, the hub, the latest History) and pages for Add funds, Channels (the hub first,
  other nodes under Advanced), Withdraw, Settings, History and Confirm. The swap card's Fiber buttons open the page that
  fixes the node. `/app/fiber` stays as the full page with the same parts.
- Pay (2026-10-30, [pay-get-paid.md](pay-get-paid.md) part B): paste or scan a Lightning invoice (paid as a swap from
  CKB or a token the hub serves to BTC, exact out), a Fiber invoice (the node pays it once the visitor confirms it in the node, with the max fee
  shown and the fee it took after) or a CKB address (an on-chain send confirmed in the node with its password).
- Get paid (2026-10-30, part C): an amount and a note make a request with two invoices for the visitor's node, a
  Fiber one and a Lightning one (the hub's hold invoice of a BTC to CKB or token swap), as QR tabs with live status,
  then a receipt. The node pairs them: once one is paid it cancels the other, so a request is paid once. Since
  2026-11-06 the request opens on Fiber and the Lightning invoice is made only when its tab opens, on a 15-minute
  request quote, and the page cancels it at the hub once the request no longer needs it.
- History in the node (2026-10-30, part E): the app's History tab (2026-10-27) is gone. The Fiber node's History lists
  everything that moved money through the node: the swaps the app started (kept in localStorage per network, the last
  100, nothing secret, merged with the node's own leg of each), Pay's payments and on-chain sends, Get paid's requests,
  channels, withdrawals, with filters and a detail per entry; "View in History" on the app's results opens the popup
  on that entry.

Nothing on `/app` is simulated any more. The ETH route (stage 5) went with the simulation and comes back with Perun
channels. A live swap asks for no signature: the user's payment is the commitment, and the hub's signed quote binds
the price.

## Decisions and why

- **One payment hash, hold invoices on both sides.** It is the CCH pattern. The hub never settles the incoming leg
  before it has the preimage from the outgoing leg.
- **Fiber invoices must use `hash_algorithm: sha256`.** Fiber's default is `ckb_hash`; only sha256 can share a hash with
  Lightning. The app warns about it.
- **BTC to CKB swaps deliver to a Fiber invoice, never an L1 address.** An L1 transfer cannot be hash-locked to the
  Lightning payment. A destination invoice must have no amount or one between the signed minimum and the estimate.
- **Holds last hours.** Fiber's minimum `final_expiry_delta` is 160 minutes in release builds (the "16 hours" in older
  upstream docs is stale; the site and README say 160 minutes). The
  Lightning hold must outlast the Fiber leg, so a stuck payment stays locked for hours. The price risk ("free option") is
  the hub's: short quotes, short lock budgets, size caps and a spread.
- **Reference prices are labelled so.** The landing page's examples use them with assumed costs (0.5% spread, 0.5%
  routing, 1% slippage); nothing on `/app` uses them since the simulation went (2026-10-30).
- **Live quotes use a median of exchange prices with the hub's spread.** UTXOSwap shut down on 2026-10-11, and there is
  no live CKB DEX or oracle price to use, so the hub takes the median of the fresh exchange prices it reads and adds
  its spread, which also prices the risk of a held payment. The copy says exactly this and promises no other check.
- **USDI is gone from the site and the app.** It was discontinued on CKB in August 2026; RUSD is the stablecoin
  example everywhere, and the only stablecoin a live hub serves on testnet.
- **Test hooks only in test builds.** The Playwright fake of fiber-js (`window.__ckboltTestFiberNode`) is loaded only behind `process.env.NEXT_PUBLIC_CKBOLT_TEST_HOOKS === "1"`, which
  `next.config.mjs` always defines ("1" only for `npm run build:test`), so a production build drops them and their
  names. The comparison is written at the two call sites, not as a shared constant, so the bundler can fold it.
- **The browser node runs in an iframe, not on every page.** Isolating every page with COOP/COEP would break the
  CCC wallet popups (JoyID); Document-Isolation-Policy isolates the wallet's iframe alone. Only `/app/wallet` may be
  framed, and only by this site (`frame-ancestors 'self'`); everything else keeps `DENY`. The page and the iframe
  exchange the header button's status by postMessage, checking origin and source, and nothing secret.
- **One wallet: the Fiber node; Lightning by QR code or paste; Pay and Get paid real; History in the node; no CCC
  wallet panels** (2026-10-30, [pay-get-paid.md](pay-get-paid.md)). Nobody connects both a Fiber wallet and a
  Lightning wallet to swap, so the only wallet is the Fiber node in the header (or the visitor's own node), and the
  Lightning side is a QR code or a pasted invoice, which any Lightning wallet handles: NWC and "Connect Lightning" went.
  Pay and Get paid became real on the same hub and node as Swap. History belongs to the node: the app's History tab
  became the popup's History page, and the app's results open it on their entry. The CKB and Bitcoin wallet panels did
  nothing for a live swap and went, with quote signing and the Bitcoin balance API; CCC stays for funding the node and
  picking a withdrawal's address. Without a live hub, `/app` says so instead of simulating.
- **The app does things with money; the header popup is the node** (2026-10-27). The CKBolt app (`/app`) is
  where people do things with money: Swap, and early versions of stage 4's Pay and Get paid. The header popup is the Fiber node,
  infrastructure the app uses, and never duplicates the app's functions. So the popup and `/app/fiber` have no Send or
  Receive: paying and getting paid belong to the app's own tabs. Every visible "Fiber wallet" became "Fiber node"; code
  identifiers, test ids and the `/app/wallet` route kept their names to limit churn.
- **Pay reaches another browser node through the hub, only when needed** (2026-11-04,
  [pay-get-paid.md](pay-get-paid.md) "B: routes"): browser nodes have only private channels with the hub, so the node
  dry-runs its own route first, then the hub as a trampoline (`trampoline_hops`), and refuses with "No route to this
  payee now." when neither works; the hub then learns the payee, and the 0.5 % max fee stays.
- **The node accepts the hub's CKB channel itself** (2026-11-05, suggested by the Fiber developer Joii;
  [fiber-wallet-popup.md](fiber-wallet-popup.md) "The hub's CKB channel: accepted by the node"): the browser node's
  config sets `auto_accept_channel_ckb_funding_amount: 0`, and after the hub opens a CKB channel the node calls
  `accept_channel` with the hub's temporary id and the amount the visitor typed, so "Your node puts in" changes per
  request with no restart. Token channels (RUSD, cWBTC) are still accepted by fnn's UDT whitelist, since 2026-11-06
  with the hub's own entries (below); CKB channels from other nodes now wait unaccepted. The hub abandons an open nobody accepted after 10 minutes (only one it made itself; it keeps them in its database across restarts).
- **Get paid's Lightning invoice on demand, on a request quote, cancelled when not needed** (2026-11-06,
  [pay-get-paid.md](pay-get-paid.md) "C: on demand, cancelled when not needed"): "Create request" makes only the
  Fiber invoice and the request opens on it (it exists at once, pays the node directly, and needs no swap); opening the
  Lightning tab makes the Lightning invoice, labelled "They pay BTC on Lightning. You receive CKB.", on a quote with
  `purpose: "request"` (the hub's `REQUEST_QUOTE_TTL_SECONDS`, 900 s, instead of 180 s; Swap and Pay keep plain
  quotes), so a request paid on Fiber leaves no swap at the hub. The swap's cancel token stays in the page's memory
  only (never in storage, History, the bridge or a log); the page calls `POST /v1/swaps/:id/cancel` with it when the
  request is paid on Fiber, on "New request", or when "New invoice" replaces an unpaid one, and only logs a failure:
  the node's pairing (it cancels the payout invoice) stays as the fallback.
- **More tokens, driven by the hub; cWBTC first** (2026-11-06, [fiber-wallet-popup.md](fiber-wallet-popup.md) "Tokens
  from the hub: the UDT whitelist"; the hub's `FIBER_ASSETS`, `../ckbolt-hub/docs/architecture.md` "Assets"). The
  hub's contract made `FiberAssetId` an open, validated string (`^[A-Z][A-Z0-9]{1,15}$`; 422 `asset_unavailable` for a
  well-formed id it does not serve) and added `udtWhitelist` to each UDT in `GET /v1/fiber/node`. The web app keeps no
  asset list: the bridge accepts any well-formed id (`isFiberAssetId`) and the node refuses one its hub does not list;
  the node's liquidity, the swap card, Pay and Get paid follow the hub's assets; copy names the hub's symbols or says
  "CKB tokens". The browser node's config puts the hub's entries in fnn's `udt_whitelist` at every start (args anchored
  `^…$`, both cell dep kinds, `auto_accept_amount` left out when null): the hub's first, replacing fiber-js's entry for
  the same script, and fiber-js's other entries (RUSD on testnet) kept verbatim, so RUSD keeps working with other nodes
  and when the hub is unreachable at start. fnn reads the whitelist only at start, so a node started before the hub
  served a token gets one line on its hub channel, "Restart your node to accept cWBTC channels: lock it, then unlock.",
  with Lock node beside it; the hub's token channels are then auto-accepted at the hub's amount (the app still sends
  `accept_channel` for CKB only). Every token channel takes the same reserve, about 180 CKB (`CHANNEL_RESERVE_CKB.UDT`;
  an xUDT cell such as cWBTC's needs at least 146), so no token is left without the "fund first" guard. cWBTC is a known
  token (`PAY_TOKENS`: "CCH Wrapped BTC (test)", quoted 1:1 with BTC, testnet only, a plain local icon); a token the app
  does not know shows from the hub's own data. Decimals come from the hub; a token it did not list shows in base units,
  never at a guessed scale. "Get test cWBTC" (`NEXT_PUBLIC_CWBTC_FAUCET_URL`, default https://faucet-cwbtc.ckb.dev;
  CKBolt's own faucet runs at https://ckbolt-faucet.texlabs.org) shows under the node's address while the hub serves
  cWBTC, and in the guide's funding step. Funding cWBTC through a CKB wallet is not built: the funding page stays
  CKB and RUSD.
- **Channels from the hub: one card, ticked and opened in one press** (2026-11-07,
  [fiber-wallet-popup.md](fiber-wallet-popup.md#channel-with-the-hub-one-card)): the node page's panel 03 and the popup's
  Channels share one card with a row per asset the hub funds, built from GET /v1/fiber/node alone (CKB first, then the
  hub's order), so a token the hub adds needs no web change. Rows read Open (with what they move), Opening, Restart
  needed, Hub can't fund now (only without a channel) or Not open; the visitor ticks rows, sets what the node puts into
  a CKB channel, sees "Needs X CKB on chain · you have Y CKB" (the CKB put in plus 1, and 181 per token), and presses
  "Open N channels". Fiber 0.9.1 funds one channel per transaction and cannot add to an open one, so the run asks the
  hub for one channel after another (the same request as before; a failed row does not stop the next) and waits
  between them until the node's last funding is committed: fnn keeps a pending funding's cells from the next one, so a
  node funded by one transfer would fail the second channel's reserve otherwise. Stop, or leaving, asks for nothing
  more. Each token being its own channel, and more CKB meaning a new CKB channel, are said behind the "?".
- **A node's own token channel to the hub, and names and icons from the hub** (2026-11-07;
  [fiber-wallet-popup.md](fiber-wallet-popup.md#channel-with-the-hub-one-card), "Your own tokens", and "Names and icons
  from the hub"): GET /v1/fiber/node gives each asset `peerChannels` (`{ minAmount, assumedCommitmentDelayEpochs }`,
  null unless the hub's fnn accepts channels nodes open in the token; null everywhere on the testnet hub today, so
  nothing new shows there). For such a token the card's row offers "Your own cWBTC": the node opens the channel itself with its
  on-chain tokens (read with `get_cells` at its lock), at least `minAmount` and at most what it holds, with fnn's
  `open_channel` to the hub's node id, private, no commitment delay or TLC expiry of its own (the hub assumes 84 epochs
  anyway), one channel at a time in the card's run, and no request to the hub for that row. fnn 0.9.1 cannot take the
  node's tokens in a channel the hub opens, so this is the only way to pay the hub in a token before receiving it. The
  "?" says the trade-off: the node pays the hub up to what it put in, the hub adds nothing, and a payment over it may be
  held longer (days) if a swap fails. The generic "Open with another node" form still refuses the hub. GET /v1/assets
  gives `displayName` and `iconUrl`: the picker, the card's rows and History show the hub's name and icon first, then
  the app's (`PAY_TOKENS`, `public/tokens`), then the hub's name and initials; both are checked again in the page
  (https or an inline SVG only, the hub's length caps and SVG deny-list) and icons are only ever `<img src>`, so a token
  the hub adds needs no web change to look right.
- **Dialogs, popovers and the mode tabs animate only without reduced motion** (2026-11-06): their fade, zoom and colour
  transition are `motion-safe:`, so a visitor who asks for reduced motion gets them at once, and axe (which the tests
  run with reduced motion) never reads a colour halfway through a fade. The contrast failures axe reported on the mode
  tabs and the swap card's dialogs were those halfway colours; the colours at rest already pass AA, so none changed.
- **The Fiber node popup moves** (2026-11-06, [fiber-wallet-popup.md](fiber-wallet-popup.md#moving-the-popup)):
  from `sm` up its title bar drags it anywhere in the window (or Move and the arrow keys), it stays where it was left
  (localStorage, per viewer), and a double click or Home puts it back; on a phone it stays the full-height sheet.
- **Diagnostics on the node page, read-only** (2026-11-05, [fiber-wallet-popup.md](fiber-wallet-popup.md) "The node
  page's Diagnostics panel"): a browser node has no RPC a developer can reach, so panel 06 copies `node_info` and
  `list_channels` as JSON (listed fields only, nothing secret) and dry-runs an invoice directly and through the hub's
  live node id; ckbolt-hub's `scripts/diagnose-route.ts` reads the exports.
- **Status colours** (2026-10-27): more colour in the app so states are easy to tell apart, for status and
  Fiber's identity only, every colour with its words; the landing page and the black primary buttons stay monochrome
  ([style-guide.md](style-guide.md#status-colours)).
- **One hub status per page.** `HubStatusProvider` (`hooks/use-hub-status.ts`) wraps the `/app` page, so the intro and
  the swap form never disagree and the hub is asked once.
- **One swap card** with a token picker on the Fiber side and a flip arrow, like a DEX; the route follows the pair.
  (The Bitcoin wallet decisions, `ccc.SignersController`, JoyID's unknown Bitcoin network and UTXO Global's five
  addresses, went with the wallet panels on 2026-10-30.)
- **Landing structure** follows a reviewer's read: Hero, Problem and solution, Solution and impact on CKB, Lightning today
  (live figures), Use cases (three uses and what makes them work), How it works, Architecture, Roadmap, FAQ, Contact.
- **External node, step by step** (2026-11-09, [live-swap-ui.md](live-swap-ui.md#external-node-step-by-step-2026-11-09)):
  the Fiber chip's choices read "CKBolt node" and "External node" ("Own node" read as "my node" to a tester). For an
  external node (Fiber Studio, fnn) the card gives the exact fnn call for each manual step as a copyable curl line:
  `new_invoice` with sha256 and the exact amount and token (fnn's default hash, ckb_hash, is refused by the hub), and
  `send_payment` with a 0.5 % fee cap; the guide's hub card gives `connect_peer` and asks the hub for a Fiber channel
  in a token, with the whitelist entry the node needs for a token. Nothing reaches the visitor's node from CKBolt.
- **Withdraw takes a token too** (2026-11-09, [fiber-wallet-popup.md](fiber-wallet-popup.md#withdrawing-a-token-2026-11-09)):
  a node can hold a token on chain (a closed token channel, a faucet paid to its address), and wallets such as UTXO
  Global may not show a token like cWBTC, so Withdraw offers each hub token the node holds besides CKB and sends all of
  it to the visitor's address in one transaction signed with the node key. The token's cells' CKB comes back to the node
  as plain CKB; only cells of exactly that type script and the node's lock count (the indexer matches by prefix).

## Known gaps

- BOLT11 payee signatures are not verified (demo invoices are unsigned by design).
- The CCC modal's keyboard accessibility is third-party; axe scans exclude `ccc-connector`.
- Amount maths use JavaScript numbers; signed messages use integer base units.
- `/app` loads the CCC bundle (about 570 KB gzipped); lazy loading is not done.
- Landing animations are heavy on weak phones; there is a Pause motion control and reduced-motion support.

## Where things are tested

- `tests/unit/codecs.spec.ts`: codecs, amounts, quotes, addresses, keys.
- `tests/e2e/app.spec.ts`: landing, the header, API routes, `/app` without a hub (one line per tab, no wallet panel),
  axe scans, motion pause, mobile layout.
- `tests/e2e/hub-live.spec.ts`: the page around the live card against a mocked hub (every `/api/hub/**` call): hub up,
  down and degraded, which tab opens, no L1 wallets on Swap, the proxy without `HUB_URL`, and the copy fixes.
- `tests/e2e/live-swap.spec.ts`: the live swap card (fake hub in `tests/e2e/fakes/hub.ts`, a fake WebLN wallet in
  `tests/e2e/fakes/lightning-wallet.ts`, the browser node with a fake fiber-js in `tests/e2e/support/`): every button
  state, both directions end to end (the hold invoice's QR code, a pasted or scanned invoice), the own node, refund and
  cancel, nothing paid twice, mainnet refused, the secret never leaving the page, axe, 390 px, and the 25-word budget.
- `tests/e2e/pay.spec.ts`, `tests/e2e/get-paid.spec.ts` with `tests/unit/pay.spec.ts`, `tests/unit/get-paid.spec.ts`:
  Pay (a Lightning invoice as a swap, a Fiber invoice confirmed in the node, an on-chain send) and Get paid (both
  invoices, the receipt, a request paid once).
- `tests/e2e/node-history.spec.ts` and `tests/unit/node-history.spec.ts`: History in the node (one store shared by the
  page and the popup, merged swaps, filters, details, View in History, a failed swap's invoice freeing the node).
- `tests/e2e/fiber-browser.spec.ts`, `tests/e2e/fund-fiber-node.spec.ts`: the browser node page and its funding page;
  the first also covers closing to the visitor's wallet and Withdraw (fake fnn, fake CKB chain, fake UTXO Global from
  `tests/e2e/support/ckb-wallet.ts`). `tests/unit/node-funds.spec.ts`: CKB address parsing, when a withdrawal may run,
  `close_script`, and the withdrawal built, signed and sent through CCC to a fake chain.
- `tests/e2e/fiber-wallet-popup.spec.ts` and `tests/unit/fiber-wallet-popup.spec.ts`: the header's Fiber node, and
  moving it (run the e2e part with `PW_CHANNEL=chrome`: Playwright's Chromium has no Document-Isolation-Policy, so the
  tests that need the isolated iframe skip themselves there).
- `tests/e2e/guide.spec.ts`: the testnet guide and its live hub card. `tests/unit/public-demo.spec.ts`: the Report a problem link, the test
  hooks against the build in `.next` (present only in a test build), and copy that must stay in step.
- `tests/unit/hub.spec.ts`: the hub client, proxy, config, rate limit, formatting, swap progress, and the contract copy
  against `../ckbolt-hub` when it is checked out (the DTOs, the asset id pattern, cWBTC in the hub's request schemas).
- `tests/unit/hub-channel-rows.spec.ts` and `tests/e2e/hub-channels.spec.ts`: the hub's channels as one card (rows from
  the hub's assets, statuses, the total, the run one row after another, a failed row, Stop, the funding wait), on the
  node page and in the popup; the node's own token channel (`peerChannels`: the choice, the amount and the node's
  tokens on chain, open_channel's params, no request to the hub for it, nothing new without it).
- `tests/unit/token-display.spec.ts`: names and icons from the hub (the icon URL and display name checks against the
  hub's rule, the fallbacks); `tests/e2e/multi-asset.spec.ts` shows them in the picker, the card and History.
- `tests/unit/multi-asset.spec.ts` and `tests/e2e/multi-asset.spec.ts`: more tokens (cWBTC): the browser node's UDT
  whitelist built from the hub's entries and merged into fiber-js 0.9.1's real config, read back, fnn's lookup and
  auto-accept, when a restart is needed, the controller; the reserve every token shares; liquidity and decimals per hub
  asset; the faucet; then swaps BTC to cWBTC and back, Pay and Get paid in cWBTC, a cWBTC channel from the hub taken by
  the fake fnn's whitelist, the restart row and line and Lock node, the faucet link, axe and 390 px.
- `tests/unit/live-swap.spec.ts`, `tests/unit/swap-core.spec.ts`, `tests/unit/fiber-wallet.spec.ts`,
  `tests/unit/ln-wallet.spec.ts`, `tests/unit/fiber-browser.spec.ts`, `tests/unit/fiber-byo.spec.ts`: the card's
  state functions and runner, the Fiber node provider and the CTA to page mapping, the Lightning wallet, the browser
  node (with its activity store) and the own-node helpers.
- `tests/e2e/swap-form.ts`: shared helpers for the swap form's token pickers.
