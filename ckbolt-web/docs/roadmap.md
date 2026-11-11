# Roadmap

Six stages. The site shows them in `components/landing/pricing-section.tsx`; keep this file and that one in step
(`tests/unit/public-demo.spec.ts` checks the statuses and stage 4's early-version tags). Stage 3 is where the project is
today (November 2026): the public testnet demo, live at https://ckbolt.texlabs.org. The site calls it "Live testnet
demo". Stage 3 stays Now until the
security audit; its functions are built. Stage 4 stays Planned, but early versions of its two user-facing deliverables
run on testnet since 2026-10-30: Get paid (a merchant paid from Lightning receives CKB or RUSD) and Pay (a CKB holder
pays a Lightning invoice). The cards tick them with the tag "Live on testnet, early version".

| Stage | Name | Status | Outcome |
| --- | --- | --- | --- |
| 1 | Research and design | Done | A design the next stages build on |
| 2 | Simulated prototype | Done | Every user step can be tried as a simulation; no payment is executed |
| 3 | Live testnet swaps | Now | Anyone can swap test tokens both ways on the live demo, and a failed payout is refunded |
| 4 | Invoices and merchant payments | Planned | A merchant takes a Lightning payment on testnet and receives CKB; a CKB holder pays a Lightning invoice (early versions of both live on testnet: Get paid and Pay) |
| 5 | Ethereum via Perun | Planned | A CKB to ETH swap works on testnet through a Perun channel |
| 6 | Mainnet | Planned | Audit findings fixed; capped mainnet payments running with monitoring |

## Stage 1: Research and design (done)

- Research on Fiber, its Cross-Chain Hub, hold invoices and Perun.
- Shared-hash design: both legs of a payment locked to one SHA-256 hash.
- Lightning invoice (BOLT11) codec, checked against the spec's test vectors.
- Quote maths, product concept and the site.

## Stage 2: Simulated prototype (done)

A simulation of the product: the interface for every flow is built, and most functions are demos.

- Interface for the three flows: get paid, pay and swap.
- Demo merchant checkout with a QR code, and demo scan to pay.
- Demo swap quotes both ways for CKB, RUSD and ccBTC, from reference prices.
- Simulated settlement: each step of a hash-locked payment is shown, no funds move.
- Testnet wallets connect through CCC, including JoyID, to sign quotes.

## Stage 3: Live testnet swaps (now)

Real swaps on testnet between BTC on Lightning and CKB tokens on Fiber, in both directions.

- CKBolt hub running a Lightning node (LND) and a Fiber node, with channels on both networks.
- Swap CKB and RUSD to BTC on Lightning, and BTC back to CKB tokens.
- Both legs held on one SHA-256 hash with hold invoices, refunded if the payout fails.
- Firm quotes signed by the hub, from a median of exchange prices plus its spread, paid from its own liquidity.
- Public live demo on testnet.

The plan is in the hub repo: `../ckbolt-hub/docs/phase-3-plan.md`.

### Progress (2026-10-24)

Built and tested on a local devnet (bitcoind regtest, two LND nodes, a CKB devnet, two Fiber nodes), and running on
Mutinynet and CKB testnet on a VPS reached through an SSH tunnel; not public then.

- Done: the CKBolt hub (`../ckbolt-hub`, NestJS) with LND and Fiber adapters, firm signed quotes, both swap directions
  for CKB and RUSD on one SHA-256 hash with hold invoices, refunds when the payout fails or the quote runs out, restart
  recovery, and a hub-run demo wallet for its smoke test. Unit, end-to-end and devnet tests pass.
- Done: this app's live mode. With `HUB_URL` set and the hub healthy, `/app` says "Live on testnet" and the Swap tab is
  a swap card that reads like a DEX (`docs/live-swap-ui.md`): the user's own Lightning wallet (NWC or WebLN) and Fiber
  wallet (the browser node on `/app/fiber`, or their own node), one "Swap" button that runs every step, and a progress
  dialog that ends in "Swap complete" or a refund. Tested with a mocked hub, fake wallets and a fake browser node.
  USDI (discontinued on CKB in August 2026) is removed; price-source copy says what the hub does.
- Done: the testnet stack on the VPS (`../ckbolt-hub/deploy/README.md`). Its readiness check passes, and its smoke
  test swaps both ways for CKB and RUSD.
- Next: real-wallet testing on the test networks (`../ckbolt-hub/docs/testing-testnet.md`), then the public demo.
- cWBTC stays optional and is not served yet.

### The public demo (2026-10-26)

The setup: web on Vercel, the hub on a testnet server (Bitcoin Mutinynet and CKB testnet) behind a Cloudflare Tunnel.
Done on the web side:

- The site says "Live testnet demo": stage 2 is Done, stage 3 Now.
- A tester's guide at `/app/guide`, linked from How it works, the Impact strip and the footer.
- The Lightning dialog gets a channel from the hub for wallets that cannot route to it (Alby Hub on Mutinynet); a
  payment that fails with no route points to it.
- "Report a problem" on every swap result and in the guide (`NEXT_PUBLIC_FEEDBACK_URL`, GitHub issues by default).
- The proxy forwards only the paths the app calls and, with `HUB_PROXY_SECRET`, sends the hub its secret and the
  client key; the test hooks exist only in builds made for tests.
- A paused hub (maintenance) shows "Swaps paused" on the card.

## Stage 4: Invoices and merchant payments

CKBolt creates and pays invoices: merchants get paid, and CKB holders pay Lightning.

- Merchant checkout: CKBolt issues a Lightning invoice for the merchant's Fiber invoice; the merchant settles in CKB or a
  stablecoin. Live on testnet, early version: Get paid (since 2026-10-30; payable from a Lightning or a Fiber wallet,
  paid once).
- The reverse: a CKB holder scans a Lightning invoice and pays it with CKB tokens. Live on testnet, early version: Pay
  (since 2026-10-30; it also pays Fiber invoices, through the hub when the payee sits behind it, and CKB addresses).
- Checkout and payment API with webhooks for wallets and POS terminals.
- Hosted Fiber node option for merchants who do not run one.
- On-chain BTC into Lightning through submarine swaps.
- Pilots with merchants, POS providers and wallets.

## Stage 5: Ethereum via Perun

ETH as a third network, through Perun state channels.

- CKB to ETH swaps in a Perun multi-ledger channel, all or nothing for both sides.
- Builds on Perun's CKB cross-chain support, in development upstream.
- ETH in the same quote engine, API and app.

## Stage 6: Mainnet

Real value, with an audit, limits and monitoring.

- Independent security audit.
- Liquidity partners and Cross-Chain Hub operators as sources.
- Payment limits, monitoring and rebalancing.
- Multi-hub routing and best-quote selection.
- SDK for wallets, POS terminals and dApps.

## Where stage names appear

- Landing: hero eyebrow ("Live testnet demo by TEX Labs, stage 3 of 6"), Impact section strip ("Today, stage 3 of 6",
  "Live testnet demo") and its lead (the API "planned for stage 4"), roadmap cards and their lead (stage 2 Done, stage 3
  Now, "We are here"; stage 4 Planned, with "Live on testnet, early version: Get paid" and "...: Pay" on its first two
  deliverables), use cases (Get paid, Pay and Swap "Live on testnet"; best-route liquidity "Planned for stage 6"; the
  API "Planned for stage 4", an SDK in stage 6), FAQ ("What works today?": "A live testnet demo, with test money
  only."; the hosted node "planned for stage 4"; Cross-Chain Hub operators as a source "planned for stage 6"), the
  architecture section (choosing among liquidity sources in stage 6; test money only), the Lightning figures' lead
  (mainnet from stage 6), footer ("Live testnet demo: stage 3 of 6"), the CTA's small print, and the site's meta
  description.
- Testnet guide (`/app/guide`): names no stage; it says test networks only.
- App (`/app`): names no stage since the simulation went (2026-10-30). Its intro (`components/app/app-intro.tsx`) says
  "Live testnet demo" by default and "Live on testnet: real swaps with test money" once the hub is live.
- README roadmap table (stage 2 Done, stage 3 **Now**).
