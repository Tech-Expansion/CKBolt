# CKBolt

CKBolt is building the link between Bitcoin Lightning and CKB's Fiber Network, so people can spend CKB wherever Lightning works and accept Lightning payments on CKB's Fiber Network. Both legs of every Lightning–Fiber payment or swap are locked to one SHA-256 payment hash, on L2. Ethereum is planned through Perun multi-ledger channels, which settle by a jointly signed channel state rather than a hash.

CKBolt is a project by [TEX Labs](https://texlabs.org). This repository contains the landing page and a **testnet prototype app** (`/app`). Nothing in it moves funds without a CKBolt hub: with `HUB_URL` set to a healthy hub (stage 3), Swap, Pay and Get paid move test money on testnet, through the visitor's Fiber node in the browser. The public testnet demo runs at https://ckbolt.texlabs.org.

| Route | Who it serves | Status |
| --- | --- | --- |
| BTC on Lightning → CKB and CKB tokens on Fiber | Merchants and POS (get paid), Lightning users buying into CKB | Live on testnet with a hub: Swap and Get paid |
| CKB and CKB tokens on Fiber → BTC on Lightning | CKB holders and wallets paying Lightning invoices or selling to BTC | Live on testnet with a hub: Swap and Pay |
| CKB ↔ ETH through Perun channels | Users and apps moving between CKB and Ethereum | Planned for stage 5 |
| Liquidity from CKBolt hubs, CCH operators and independent providers | Liquidity providers earning routing fees | Planned |

## How it works

A CKBolt hub runs a Lightning node and a [Fiber](https://github.com/nervosnetwork/fiber) node.

**Lightning → CKB (merchant checkout)**

1. The merchant's Fiber node creates a CKB invoice with `hash_algorithm: sha256`. The merchant keeps the preimage.
2. CKBolt quotes the sale in sats and creates a Lightning **hold invoice** with the same payment hash, shown to the customer as a BIP21 QR code.
3. The customer pays from any Lightning wallet. The hub holds the payment; it cannot settle without the preimage.
4. The hub pays the merchant's Fiber invoice. The merchant's node reveals the preimage to claim it, and the hub uses that preimage to settle the Lightning payment. If the payout fails, the hub cancels the hold and the payment returns to the customer at once.

**CKB → Lightning** runs the same steps in reverse: CKBolt creates a Fiber hold invoice (Fiber's `new_invoice` with `payment_hash`), the CKB holder pays it, and the hub pays the Lightning invoice to learn the preimage.

Either the recipient is paid and the hub settles, or the payer's funds are released: at once if the payout fails, or when the hold expires if it gets stuck (Fiber's minimum expiry is 160 minutes; the Lightning hold lasts longer, because it must outlast the Fiber one). The hub, not the user, carries that risk. Merchants need a Fiber node (a hosted option comes in stage 4) but no Lightning node and no BTC. Fiber nodes carry only whitelisted tokens; the default testnet list has RUSD, and the browser node also whitelists every token the hub serves (such as cWBTC, CCH Wrapped BTC, once the testnet hub lists it), from the hub's own entries. USDI, formerly the mainnet default, was discontinued on CKB in August 2026.

Both legs are L2 (Lightning and Fiber); L1 is only used to open or top up channels. Fiber's Cross-Chain Hub (CCH) links the two networks for one wrapped-BTC token at a fixed 1:1 rate ([spec](https://github.com/nervosnetwork/fiber/blob/develop/docs/specs/cross-chain-htlc.md)); CKBolt builds on the same hash-lock pattern for native CKB and CKB tokens, with a price per route, and can use CCH operators as a liquidity source for wrapped-BTC routes. An Ethereum route through [Perun](https://github.com/hyperledger-labs/go-perun) state channels is planned for stage 5; Perun's CKB cross-chain support is still marked "in development" upstream.

## What is real in this prototype

| Capability | Status |
| --- | --- |
| Reference prices for CKB, BTC and ETH (`/api/rate`: CoinGecko, then Binance, then KuCoin; 30 s refresh) | Working, **indicative only**. A live hub quotes from the median of exchange prices with its spread; no CKB DEX or oracle gives a usable price since UTXOSwap shut down in October 2026 |
| Pay: scan (camera or image) or paste a Lightning invoice (paid as a swap from CKB or a token the hub serves to BTC, exact out), a Fiber invoice (the node pays it once you confirm it in the node; max fee shown, the fee it took after) or a CKB address (an on-chain send confirmed with the node's password) | Working on testnet with a hub |
| Get paid: an amount and a note make a request: a Fiber invoice (your node's) at once and, when the Lightning tab is opened, a Lightning invoice (the hub's, paid to your node through a swap, payable 15 minutes), as QR tabs with live status, then a receipt; once one is paid the other is cancelled (the page asks the hub to cancel an unpaid Lightning invoice) | Working on testnet with a hub |
| BOLT11 invoice decoding (bech32 checksum, amount, expiry, description) | Working |
| One wallet: your Fiber node. The Lightning side is any wallet, by QR code or a pasted invoice (WebLN extensions can pay with one click). There are no CKB or Bitcoin wallet panels; a CKB wallet through [CCC](https://github.com/ckb-devrel/ccc) (JoyID and others) only funds the browser node and picks where a withdrawal goes | Working on testnet |
| Hub with Lightning and Fiber nodes, real swaps on testnet | Stage 3: running on the testnet hub (`../ckbolt-hub`); no security audit yet. With `HUB_URL` set and the hub healthy, the Swap tab is a live swap card: firm quotes, CKB and the tokens the hub serves (RUSD; cWBTC once its `FIBER_ASSETS` lists it) to and from BTC on Lightning, the visitor's Fiber node (the browser node or their own), the hub's invoice as a QR code or the visitor's own invoice pasted, one Swap button, refunds. Without a hub, each tab says so in one line |
| Fiber node in the header: a Fiber node (fiber-js) running in the browser, in a popover on every page, as infrastructure the app swaps, pays and gets paid through (those stay in the app). Home shows what a swap can move, on-chain CKB, the hub and the latest History; pages for Add funds (address with QR, funding page for JoyID), Channels (with the CKBolt hub first, other nodes under Advanced; close to your own address), Withdraw, Settings (back up, restore, forget, lock), Confirm (what Pay asks the node to pay) and History: everything that moved money through the node (swaps, payments, requests, channels, withdrawals), with filters and a detail per entry; "View in History" on the app's results opens it there. The swap card's Fiber buttons open the page that fixes the node | Working on CKB testnet. Chrome and Edge run it in the popover (`Document-Isolation-Policy` on `/app/wallet`); Firefox and Safari open it in a window. The full page is `/app/fiber` |
| Merchants beyond the demo: a checkout and payment API with webhooks, a hosted Fiber node option, submarine swaps for on-chain BTC | Stage 4 |
| Ethereum route via Perun | Stage 5 |

Token logos come from CoinGecko (BTC, ETH) and from the icons issuers registered on CKB Explorer (CKB and the xUDT tokens). RUSD has no published icon, so it is shown as a monogram; cWBTC, a testnet token, has a plain icon drawn for CKBolt.

## Run locally

Requires Node.js 22.

```bash
npm ci
npm run dev            # http://localhost:3000, app at /app
```

Production build:

```bash
npm run build
npm start
```

Docker:

```bash
docker compose up --build   # http://127.0.0.1:3000
```

Behind a reverse proxy, set `TRUST_PROXY=1` so the hub endpoints rate-limit per client using `X-Forwarded-For`; without it the header is ignored, because anyone could forge it.

To run live swaps, set `HUB_URL` to a CKBolt hub, such as `HUB_URL=http://127.0.0.1:8787` for the hub's local devnet. The browser calls the hub through the same-origin proxy `/api/hub/v1/...`, which forwards only the paths the app calls (the hub's demo wallet, `/v1/demo/*`, answers 404); without `HUB_URL` the proxy answers 503 and the app's tabs say the hub is not available. Writes (POST) must come from the site's own pages: a request that is not `content-type: application/json`, or whose `Sec-Fetch-Site` or `Origin` names another site, gets 403 `forbidden` (cross-site request forgery). Behind `TRUST_PROXY=1` an IPv4 client is counted by its address and an IPv6 client by its /64. Optional: `HUB_PROXY_TIMEOUT_MS` (default 10000), `HUB_PROXY_MAX_BODY_BYTES` (16384), `HUB_PROXY_RATE_LIMIT_PER_MINUTE` (120 per client with `TRUST_PROXY=1`), `HUB_PROXY_SHARED_RATE_LIMIT_PER_MINUTE` (600 shared without it) and `HUB_PROXY_GLOBAL_RATE_LIMIT_PER_MINUTE` (1200).

Environment of the public demo (Vercel):

| Variable | Where | Example | What |
| --- | --- | --- | --- |
| `HUB_URL` | server | `https://hub-api.example.org` | The CKBolt hub |
| `HUB_PROXY_SECRET` | server only, never `NEXT_PUBLIC_` | 32+ random characters, the hub's own `HUB_PROXY_SECRET` | Sent to the hub as `X-CKBolt-Proxy-Secret`, with the client key as `X-CKBolt-Client` |
| `TRUST_PROXY` | server | `1` | The client key is the last `X-Forwarded-For` entry (Vercel appends it): the address for IPv4, its /64 for IPv6. Required with `HUB_PROXY_SECRET` |
| `NEXT_PUBLIC_FEEDBACK_URL` | public, build time | `https://github.com/Tech-Expansion/CKBolt/issues/new` (the default) | Where "Report a problem" leads; `title` and `body` (with the swap id) are added |

`NEXT_PUBLIC_CKBOLT_TEST_HOOKS` is for the test build only (`npm run build:test`); never set it on a deployment. A Vercel production build (`VERCEL_ENV=production`) with it set to `1` stops with an error.

Rules for the Vercel deployment:

- **`HUB_PROXY_SECRET` needs `TRUST_PROXY=1` and an `https` `HUB_URL`.** Otherwise the proxy forwards nothing: every hub call answers 503 `hub_unavailable` and the function log names the setting to fix. Without `TRUST_PROXY=1` every visitor would reach the hub under one client key, and over plain http the secret could be read on the way. Only a hub on `127.0.0.1`, `::1` or `localhost` (an SSH tunnel, the local devnet) may take the secret over http without `TRUST_PROXY`.
- **Keep the site's domain DNS-only** (grey cloud, not proxied by Cloudflare). Behind Cloudflare's proxy, Vercel would see Cloudflare's address as the client, and the last `X-Forwarded-For` entry, which the proxy and the hub count visitors by, would be Cloudflare's instead of the visitor's.
- **Add a Vercel Firewall rate-limit rule on `/api/hub/*`** (per IP, for example 120 requests a minute, action deny or challenge). The proxy's own limit is in memory, per server instance, so it does not add up across Vercel's instances; the firewall rule does, and it stops a flood before a function runs.

To try it with a hub, create the Fiber node in the header (testnet CKB from the [Nervos faucet](https://faucet.nervos.org), or fund it from a CKB wallet such as JoyID) and use any Lightning wallet on the hub's network (Mutinynet) to scan or make invoices; the testnet guide at `/app/guide` walks through it.

## Tests

Unit tests cover bech32, BOLT11 against the spec's test vectors, payment-request parsing (BOLT12 offers, CKB address structure), amount input, quote maths, the hub client and proxy, the swap run, Pay, Get paid, the browser node and its bridge, and the node's History. End-to-end tests (Playwright) run against a fake hub and a fake fiber-js: the landing page and navigation, the live swap card both ways, Pay (Lightning, Fiber, CKB address), Get paid, the Fiber node popup and its History, the node and funding pages, the guide, the API routes and accessibility scans, on desktop and mobile viewports.

```bash
npm run build:test                # the production build with the test hooks; never deploy it
npx playwright install chromium   # or set PW_CHANNEL=msedge / chrome to use an installed browser
npm run test:e2e
npm run typecheck
```

The Fiber node popup needs `Document-Isolation-Policy`, which Playwright's bundled Chromium lacks: its tests skip themselves there, and run fully with `PW_CHANNEL=chrome` (or `msedge`).

The tests fake the browser Fiber node through a hook (`window.__ckboltTestFiberNode`) that exists only in a build made with `NEXT_PUBLIC_CKBOLT_TEST_HOOKS=1`, which `npm run build:test` sets. `npm run build` drops it and its name from the bundle.

Real wallets (a Lightning wallet on Mutinynet, JoyID funding the node) are tested by hand against the testnet hub: `../ckbolt-hub/docs/testing-testnet.md`.

## Project structure

```
app/page.tsx                   landing page
app/app/page.tsx               testnet prototype app
app/api/rate/route.ts          reference-price proxy (CoinGecko, Binance, KuCoin)
app/api/lightning-stats/route.ts  public Lightning network figures (mempool.space)
app/api/hub/[...path]/route.ts  same-origin proxy to a CKBolt hub (HUB_URL)
lib/hub/                       hub contract copy, client, proxy, live swap helpers
hooks/use-hub-*.ts             hub status, quotes and swaps
hooks/use-swap-runner.ts       runs a live swap's steps with the user's wallets
components/app/swap/           the live swap card, its wallet dialogs and How it works
components/app/fiber-node/     the browser Fiber node: its full page (/app/fiber) and the parts the popup shares
components/app/fiber-wallet/   the header's Fiber node popup: popover host, header button, Home and its pages (/app/wallet)
lib/swap/, lib/wallets/        the card's state functions; Lightning, browser Fiber node and own-node wallets; the
                               popup's postMessage relay (lib/wallets/fiber-popup)
lib/canvas-loop.ts             decorative canvas animations that pause off screen
components/app/                get paid, pay and swap flows, wallets (CCC), QR scanner, route and status panels
components/landing/            landing page sections
hooks/use-rate.ts              shared reference-price feed
lib/bech32.ts, lib/bolt11.ts   bech32/bech32m and BOLT11 encode/decode
lib/payment-request.ts         Lightning, BIP21, Fiber invoice and CKB address parsing
lib/quote.ts, lib/amount.ts    quote maths, prototype cost assumptions, amount input
lib/tokens.ts                  assets, decimals and price status
tests/unit/, tests/e2e/        Playwright unit and end-to-end tests
```

## Roadmap

| Stage | Status | Deliverables |
| --- | --- | --- |
| 1. Research and design | Done | Research on Fiber, CCH, hold invoices and Perun; shared-hash design (both legs on one SHA-256 hash); BOLT11 codec checked against the spec's test vectors; quote maths, product concept and this site |
| 2. Simulated prototype | Done | A simulation of the product: the interface for every flow is built and most functions are demos. Demo merchant checkout with BIP21 QR, demo scan to pay, demo swap quotes both ways for CKB, RUSD and ccBTC from reference prices, simulated hash-locked settlement; testnet wallets connect through CCC, including JoyID, to sign quotes; end-to-end tests. Outcome: every user step can be tried as a simulation, no payment is executed |
| 3. Live testnet swaps | **Now** | CKBolt hub with LND and a Fiber node and channels on both networks; real swaps CKB, RUSD → BTC on Lightning and BTC → CKB tokens; hold invoices on one SHA-256 hash with refund on a failed payout; firm quotes from hub liquidity; public live demo. Outcome: anyone can swap test tokens both ways on the live demo |
| 4. Invoices and merchant payments | Planned (early Get paid and Pay live on testnet since 2026-10-30) | Merchant checkout for real (CKBolt issues a Lightning invoice for the merchant's Fiber invoice; settlement in CKB or a stablecoin) and the reverse (a CKB holder pays a Lightning invoice); checkout and payment API with webhooks; hosted Fiber node option; submarine swaps for on-chain BTC; pilots with merchants, POS providers and wallets. Outcome: a merchant takes a Lightning payment on testnet and receives CKB |
| 5. Ethereum via Perun | Planned | CKB ↔ ETH swaps in Perun multi-ledger channels, all or nothing for both sides; ETH in the same quote engine, API and app. Outcome: a CKB → ETH swap works on testnet through a Perun channel |
| 6. Mainnet | Planned | Independent security audit; liquidity partners and CCH operators as sources; payment limits, monitoring and rebalancing; multi-hub routing and best-quote selection; SDK for wallets, POS and dApps. Outcome: capped mainnet payments running with monitoring |
