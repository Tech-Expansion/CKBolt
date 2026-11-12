# Phase 3 plan: live testnet swaps

Decision (2026-10-23): NestJS for the hub, Mutinynet for the public demo's Bitcoin side, both demo wallets and bring-your-own, and one workspace folder holding `ckbolt-web/` and `ckbolt-hub/` side by side. Coding rules: clean architecture, no hard-coding, shared code in `common`, RESTful API (see [architecture.md](architecture.md)).

Goal of stage 3 (from [roadmap.md](../../ckbolt-web/docs/roadmap.md)): real swaps on testnet between BTC on Lightning
and CKB tokens on Fiber, in both directions; both legs held on one SHA-256 hash with hold invoices; refunded if the
payout fails; firm quotes from the hub's own liquidity; a public live demo.

## Status

Everything in scope works end to end on the local devnet, through the API and through the web app. The public testnet
demo is live: the web app at https://ckbolt.texlabs.org, and the hub on a testnet server (Mutinynet + CKB testnet) that
the web server reaches through its proxy, deployed with the runbook ([../deploy/README.md](../deploy/README.md)). How
each part is tested: [testing.md](testing.md).

| Part (section 2) | Status | Evidence |
| --- | --- | --- |
| ckbolt-hub repo, every module behind its port | Done | Unit tests per module with the fakes: 109 suites, 3503 tests pass (2026-11-10); typecheck clean |
| Integration: AppModule wiring, `.env` loading, contract fixes, shared constants and helpers, shutdown order | Done | `nest build`, `node dist/main` serves `/v1` on the devnet; app module, config and shutdown tests |
| Both directions for CKB and RUSD | Done on the devnet | e2e `swap-success`; manual swaps via the API and the UI |
| cWBTC, and any UDT by config | In the code (2026-11-06), on the testnet server (2026-11-07); token config in one place, nodes' own token channels (peerChannels, offered up to `FIBER_PEER_CHANNELS_MAX_OPEN` open), display metadata, and `testnet sync` regenerating the whitelists from the server's hub.env in the code (2026-11-07), not deployed | `FIBER_ASSETS` lists the UDTs with per-asset fee, premium and caps; the fnn kit whitelists cWBTC; unit tests swap cWBTC both ways on the fakes, also with the CKB price feeds down (`test/unit/assets`). Steps: testing-testnet.md section 6 |
| Firm quotes: median of exchange prices, spread and option premium, size caps, Ed25519 signature, liquidity net of open swaps' payouts and the routing fee budget, one swap per quote | Done | Pricing unit tests; 409 `conflict` on a second swap per quote |
| Refunds when the payout fails or the quote no longer holds | Done | e2e `refund` and `quote-expiry`; forced refund by hand (testing.md) |
| Restart safety | Done | e2e `restart-recovery`; manual restart mid-swap |
| Security rules (section 3) | In the code | e2e `security` and `rejections`; unit safety, security, payout-recovery, unpaid-caps, held-asset-and-hold-delta and config security specs |
| Local devnet (Docker) and e2e tests | Done | `npm --prefix devnet run up`, smoke and 42 live checks pass; e2e 7 suites, 24 tests pass (2026-11-10) |
| Web app calls the hub: proxy, live quotes, demo wallet, start, pay, settle or refund; simulation as fallback | Done, then replaced | Phase 3b replaced the live form on 2026-10-24 by a DEX-style card with the user's own wallets only (`ckbolt-web/docs/live-swap-ui.md`); `hub-real.spec.ts` and the demo wallet in the UI were removed |
| Copy fixes (160 minutes, USDI removed, stage wording, price sources) | Done | Web suite |
| Runbook for the public demo (CKB testnet + Mutinynet) | Done, deployed | `deploy/`: compose config validates, the hub and Mutinynet bitcoind images build; the testnet server runs it |
| Public live demo | Live | Web app at https://ckbolt.texlabs.org; hub on a testnet server, set up per the runbook; cWBTC faucet at https://ckbolt-faucet.texlabs.org |

Research behind every decision: [research/cch.md](research/cch.md), [research/fiber-node.md](research/fiber-node.md),
[research/lnd.md](research/lnd.md). Web-side context: `../ckbolt-web/docs/`.

## 1. What changed after research

- **An external hub can do everything Fiber's Cross-Chain Hub (CCH) does, using only the public fnn RPC.** CCH even has
  a standalone mode that runs out of process. The hub needs fnn **v0.9.0 or later**: from v0.9.0, `get_payment` returns
  `payment_preimage`.
- **Fiber's minimum `final_expiry_delta` is 160 minutes in release builds, not 16 hours.** The site, README and app said
  16 hours, from stale upstream documentation; the copy now says 160 minutes (section 5).
- **USDI is discontinued on CKB** (swap-out ended 2026-08-15). On testnet the hub swaps **CKB and RUSD**, plus **cWBTC**
  (test wrapped BTC with a faucet) if time allows. USDI is removed from the site's live claims.
- **UTXOSwap shut down on 2026-10-11**; no live DEX or oracle on CKB gives a usable price. Quotes use a median of
  exchange prices with the hub's spread.
- **Lightning is the hard side for visitors.** No working testnet3/testnet4 Lightning faucet or custodial wallet was
  found. Mutinynet (a public signet with 30 s blocks) has a working Lightning faucet and the only live test-network
  Lightning graph. Fiber's side is easy: a browser Fiber node exists (`@nervosnetwork/fiber-js`), the CKB faucet has no
  captcha, and public relay nodes accept channels.
- **Upstream is moving toward CKBolt's idea.** Open PR nervosnetwork/fiber#1257 ("CCH multi-asset swap") adds CKB and
  UDT legs with an operator-set price. It is not merged and had a Medium security finding. CKBolt does not depend on it,
  but keeps its pricing service separable so it could serve as that PR's "swap acceptor" later.
- **Competition is testnet-only**: FiberSwap (cWBTC to BTC at 1:1 through CCH), the fiber-cch-hub kit, Fiber Studio
  (a desktop app with no default hub), Bifrost (dormant). No Lightning to Fiber hub is on mainnet.

## 2. Scope

In scope for stage 3:
- A new repo, **ckbolt-hub**: a TypeScript service that runs next to an LND node and a Fiber node and executes swaps.
- Both swap directions for CKB and RUSD (cWBTC optional): CKB tokens on Fiber to BTC on Lightning, and BTC on Lightning
  to CKB tokens on Fiber.
- Firm quotes: price, spread, size caps and liquidity checks, signed by the hub, valid for minutes.
- Refunds: the incoming hold invoice is cancelled when the payout definitely fails or the quote is no longer honoured.
- Restart safety: every order resumes correctly after a crash.
- A local devnet (Docker) that runs the whole thing, and end-to-end tests on it.
- The CKBolt web app calls the hub: live quotes, start a swap, pay, watch it settle or refund. The simulation stays as
  the fallback when no hub is configured.
- A runbook for the public testnet demo (CKB testnet + Mutinynet).

Not in stage 3 (later stages): merchant checkout with hub-issued invoices and paying merchants' Lightning invoices as a
product (stage 4), submarine swaps from on-chain BTC (stage 4), Ethereum via Perun (stage 5), mainnet, audits,
multi-hub routing (stage 6), a browser Fiber node inside the CKBolt app (it needs COOP/COEP headers that may break the
JoyID popup; evaluate in stage 4).

## 3. How a swap works (the hub's protocol)

The **user generates the preimage P** in both directions, through the invoice they give the hub; `H = sha256(P)`. The hub
only ever learns P from its outgoing leg, so it can never settle the incoming leg first.

### Direction A: BTC on Lightning to CKB tokens on Fiber

1. The user asks for a quote (asset, amount) and gives a **Fiber invoice** from their node (or the demo wallet) with
   `hash_algorithm: sha256`, currency `fibt`, the quoted amount or none, a sane expiry.
2. The hub reads it with `parse_invoice`, checks hash algorithm, network, UDT, amount, expiry, and that H is new.
3. The hub creates an **LND hold invoice** for the sats with the same H, `expiry` = quote validity, and `cltv_expiry = C`
   where `C >= ceil(F_max / t_fast) + 18 + m_ln + 3` (research/lnd.md 6.4). `F_max` is the outgoing Fiber lock, capped by
   `tlc_expiry_limit`. If C exceeds payer limits (LDK 1008 blocks), the quote is refused.
4. The user pays it (any Lightning wallet, the Mutinynet faucet, or the demo wallet). LND reports `ACCEPTED`.
5. The hub checks: full amount, quote still valid, `min(htlc expiry) - height >= C_required`. Otherwise it cancels.
6. The hub pays the Fiber invoice with `send_payment` (`max_fee_amount`, `tlc_expiry_limit`). On `Success` it reads
   `payment_preimage`, checks `sha256(P) == H`, **saves P**, then `SettleInvoice(P)` on LND, retrying until settled.
7. On a terminal Fiber failure it cancels the LND invoice: the user is refunded. **While the Fiber payment is in flight it
   never cancels.**

### Direction B: CKB tokens on Fiber to BTC on Lightning

1. The user asks for a quote and gives a **Lightning invoice** (BOLT11) for the BTC they want.
2. The hub decodes it (`DecodePayReq`): network, amount within the quote, expiry, payee's `cltv_expiry`, H new.
3. The hub creates a **Fiber hold invoice**: `new_invoice` with `payment_hash: H`, `hash_algorithm: sha256`, the token
   amount (CKB in shannons or the RUSD type script), expiry = quote validity, and an explicit `final_expiry_delta`.
4. The user pays it from a Fiber node (their own, a browser node later, or the demo wallet). `get_invoice` (or the
   `subscribe_store_changes` WebSocket) shows `Received`.
5. The hub checks amount, quote validity and that the held payment is still pending in `list_channels`, then pays the
   Lightning invoice with `SendPaymentV2`: explicit fee limit, timeout, and
   `cltv_limit = floor((fiber_incoming_deadline - now - m_f) / t_slow)`.
6. On `SUCCEEDED` it checks the preimage, saves it, then `settle_invoice` on Fiber. On `FAILED` it cancels the Fiber
   invoice. On `IN_FLIGHT` it keeps tracking.

### Order states (same as CCH)

`Pending -> IncomingAccepted -> OutgoingInFlight -> OutgoingSuccess -> Success`, or `Failed` (refunded). Rules copied from
CCH, Boltz and Loop:
- Save the transition and the intent before every external call; on restart, look up every open hash on both nodes,
  re-track every outgoing payment, and resume.
- Never cancel the incoming leg once a preimage is known or while the outgoing payment is in flight.
- `OutgoingSuccess` that cannot settle is a loss in the making: alert loudly, retry until the hard deadline.
- One hash per swap, never reused; reject a hash that exists on either node.
- Keep LND's `holdexpirydelta` at 18 or more and set the hub's `LND_HOLD_EXPIRY_DELTA_BLOCKS` to the same value; alert
  on cancellations the hub did not request.
- Treat only Fiber `Paid` and LND `SETTLED` as final.
- **ln_to_fiber payout guard** (2026-11-09, `FIBER_PAYOUT_GUARD`, `SwapFlow.guardPayout`): fnn v0.9.1 lets a payee claim
  the hub's TLC on chain with the preimage even after the TLC expires, and on-chain settlement opens only once the
  channel's commitment delay has passed after a force close. fnn force-closes 2/3 of that delay before expiry, so a payee
  that withholds the preimage could claim about a third of the delay after expiry (about 80 minutes with the default
  1-epoch delay), after LND has given the Lightning hold back. While a payout is in flight, the hub force-closes a
  payout channel whose peer still holds the TLC at `fiberPayoutForceCloseAt` (expiry minus the channel's delay counted
  25 % long, minus 30 minutes; never sooner than 10 minutes after the send): settlement then opens before the expiry,
  while the hold still stands, and fnn reports a preimage claimed on chain as the payment's, so the hub collects. Only a
  public channel the hub opened itself, to a router that is not the payee, is left open: that router answers to its own
  payee a hop delta earlier. Every other channel is closed: a private one (its peer is the payee), a public one whose
  peer is the payee (a public node can be the payee; since 2026-11-12), and any channel a peer opened, public or not
  (anyone can open one to the hub, announce it and route a payout through it; since 2026-11-12). Not covered: a channel
  a peer opened with a delay between about 1.6 and 2.5 epochs (peer channels stay off until this is solved). Extending
  the hold instead does not fit LDK's 1,008-block cap on Mutinynet. Checked on the devnet's real nodes
  (2026-11-10, `test/e2e/payout-guard.e2e-spec.ts`): fnn-hub force-closes the private channel, the payee claims the TLC
  on chain with the preimage, fnn-hub reports that preimage as the payout's, and the hub settles the Lightning hold.

### Free option and limits

A user can delay claiming the payout while watching the price. Controls: quotes valid 2 to 5 minutes, short lock budgets,
small per-swap caps (testnet demo: up to 100,000 sats or the equivalent), a spread that includes an option premium, and
rate limits per client.

Rules the security review added:
- **Payout lock cap** (`MAX_PAYOUT_LOCK_MINUTES`, per timing profile: regtest 48 h, Mutinynet 12 h, testnet and mainnet
  96 h): payout invoices whose CLTV or final expiry delta needs a longer lock are refused, and `cltv_limit` and
  `tlc_expiry_limit` never exceed it. Size the option premium for holding a payout that long.
- **Routing fee budgets below the hub fee**: the payee can route its payout through a node of its own and collect the whole
  budget, so `LN_MAX_FEE_BPS` and `FIBER_MAX_FEE_BPS` must be below `FEE_BPS` (checked at start-up; both default to 25 bps against a 50 bps fee).
- **Fiber payouts in one part**: payout invoices that allow MPP are refused and `send_payment` carries `max_parts: 1`; a
  payout that reads `Failed` still counts as in flight while a TLC the hub sent for the hash is not settled for good
  (any outbound state but `RemoveAckConfirmed`), and a matching preimage means success whatever the state.
- **Held Fiber TLC deadline per inbound channel**: fnn fails a held TLC 2/3 of its channel's commitment delay before
  expiry, and the channel's opener chooses that delay (1 to 84 epochs) without `list_channels` showing it. The hub uses
  fnn's default for channels it opened and assumes `FIBER_PEER_CHANNEL_COMMITMENT_DELAY_EPOCHS` (default 84) for
  channels a peer opened, so a payment over such a channel is refunded unless the operator vouches for a shorter delay.
  **Peer channels** (`FIBER_ASSETS` `peerChannels`, 2026-11-07): a node may open its own token channel to the hub, which
  fnn-hub auto-accepts. The hub then refuses to start unless that variable is 84, sizes the asset's fiber_to_ln hold
  invoices for an 84-epoch channel (224 h + 60 s + margin + the payout window), and refunds a payment over a peer
  channel that leaves too little time, with its own reason (architecture.md, "Peer channels").
- **LND must be synced** before its block height sizes a Fiber lock; until then the swap waits.
- **The demo wallet pays only demo swaps**: it pays a hold invoice only when the swap's payout is an invoice of the
  demo wallet's own node, and the swap's `demo` flag is worked out by the hub, never taken from the request.
- **Caps on unpaid swaps**: a swap waiting for its payment reserves its payout and leaves a hold invoice on the hub's
  nodes until its quote expires, yet costs nothing to make. `POST /v1/swaps` answers 429 `rate_limited` (with
  `Retry-After`) once the client has `SWAP_MAX_UNPAID_PER_CLIENT` (default 5) or every client together `SWAP_MAX_UNPAID`
  (default 50), before any hold invoice is made. The demo wallet also has a cap for every client together
  (`DEMO_MAX_ACTIONS_PER_HOUR_TOTAL`, default 600), since client keys can be shared or made up.
- **Client identity**: a client is its socket address; with `HUB_TRUST_PROXY=true` it is the last `X-Forwarded-For`
  entry, trusted only from a loopback or private peer, and the hub refuses to start unless `HUB_HOST` is such an address
  (or every interface inside a container). Behind the web app's proxy the hub needs `HUB_TRUST_PROXY=true` and the web
  server `TRUST_PROXY=1`; otherwise every visitor shares one key and one budget.
- **Payouts refused or unknown**: a payout the paying node refuses at send time is refunded at once. One the node has
  no record of is sent again at most `PAYOUT_MAX_RESENDS` times (default 3) and refunded only once it has stayed unknown
  for `PAYOUT_MISSING_CONFIRM_SECONDS` (default 30, at least the Fiber RPC timeout) since the last send, because a send
  whose call timed out can still be starting inside the node.
- **"Not found" means not found**: the Fiber adapter turns only fnn's exact "not found" texts for `get_invoice` and
  `get_payment` into null (`FIBER_RPC_ERROR_PATTERN`), since a null payment lets the engine send the payout again.
- **LND's own limits**: `LND_HOLD_EXPIRY_DELTA_BLOCKS` must equal `invoices.holdexpirydelta` in the hub LND's
  `lnd.conf` (18 or more), so the plan ends every ln_to_fiber payout before LND's real auto-cancel point. LND refuses a
  payment whose `cltv_limit` is not greater than the invoice's CLTV + 3, so a Lightning payout's limit is at least
  CLTV + 4 (`minLnCltvLimit`), or the swap is refunded before paying.
- **Held Fiber payments count only in the swap's asset**: `heldTlcs` ignores TLCs on channels of another asset, so a
  TLC fnn has committed but not rejected yet cannot pay for an RUSD swap with CKB.

## 4. Architecture of ckbolt-hub

Stack: NestJS 11 (Express), TypeScript strict, Jest + ts-jest, better-sqlite3, zod. LND through the typed `lightning`
package 13.1.7 (macaroon with `info:read invoices:read invoices:write offchain:read offchain:write onchain:read`). Fiber through a
small typed JSON-RPC client of our own (params as a one-object array, u64/u128 as `"0x..."` hex); `@fiber-pay/sdk` is a
reference. Layers, folders and module contracts: [architecture.md](architecture.md).

Versions to pin: fnn **v0.9.1** (v0.10.0-rc1 cannot upgrade an existing database and changes channel locks), LND
**v0.21.4-beta**, Bitcoin Core 29.4 (regtest) or the Mutinynet fork, CKB **0.202.0** for the devnet.

### HTTP API (v1)

RESTful, versioned, resource-oriented; the full table, status codes and error shape are in
[architecture.md](architecture.md#rest-api-v1) and the contract in `src/interfaces/http/contract/`. Resources: health,
assets, quotes, swaps (with events), demo invoices and demo payments.

### Demo wallets

So a visitor with no node can try a real swap, the hub runs a "demo payer/receiver" LND node and Fiber node. Clicking
"Pay with demo wallet" makes a real Lightning or Fiber payment between real nodes; the swap logic is the same. It is
custodial test money, labelled as such, and rate limited. "Bring your own" works too: any wallet that can pay a Mutinynet
Lightning invoice (the Mutinynet faucet can) and any Fiber node.

## 5. Changes in the CKBolt web app

- `HUB_URL` env and a server-side proxy `app/api/hub/[...path]` (same-origin, rate limited and time-limited like
  `/api/btc-balance`, errors as `{error}`). Without `HUB_URL` the app stays in simulation, as today.
- `lib/hub/contract.ts` (copied contract) and `lib/hub/client.ts`; a `useHubQuote` hook in the shape of `useRate`.
- (Replaced in phase 3b by the live swap card, `ckbolt-web/docs/live-swap-ui.md`.) Swap form, when the hub is live: a "Live on testnet" tag; quotes from the hub with its expiry; the destination is the
  user's invoice or "Use demo wallet"; the button becomes "Start swap"; then a panel with the invoice to pay (QR, copy) or
  "Pay with demo wallet"; the lifecycle rows Funded, Routed, Settled or Refunded follow the hub; route steps change from
  Planned to Live.
- The wallet signature becomes optional in live mode: the user's own payment is the commitment; the hub's signed quote
  is what binds the price.
- Copy fixes: 160 minutes instead of 16 hours (FAQ, README, `docs/context.md`, app notes); USDI removed from live claims
  and the hero rotation; `pay-flow.tsx` says `parse_invoice` arrives "once the hub is live in stage 3" while
  `receive-flow.tsx` says stage 4; make them consistent.
- Playwright tests with a mocked `/api/hub/**` for every new state, including refund and expiry.

## 6. How the work is checked

Each module sits behind a port in its own folder. Its unit tests are written from the protocol and safety rules by
someone other than its author, against fakes that behave like LND and fnn where it matters. End-to-end tests run both
directions on a local devnet with release fnn binaries. A security review of the settle and cancel rules, timing, the
free option and secrets followed; the rules it added are in section 3.

## 7. Test plan

- Unit (Jest, hub): timing formulas against hand-worked cases (Mutinynet 30 s blocks, mainnet 10 min, payer caps);
  pricing (median, spread, caps, expiry, signatures); state machine (every allowed and forbidden transition, the
  never-cancel-after-preimage rule); engine with fake ports (success, payout failure, in-flight then failure, crash at
  each step then resume); API validation and error shapes; Fiber and LND adapters against recorded RPC responses.
- E2E (devnet in Docker): both directions, payout failure refund, quote expiry, wrong hash algorithm, duplicate hash,
  restart mid-flight, demo wallet flow, with release fnn binaries for real timings; expiry paths with a debug profile
  or fake clocks.
- Web (Playwright, CKBolt): live mode with a mocked hub, and the existing tests keep passing; real swaps through the UI
  run by hand against a hub on the devnet ([testing.md](testing.md)).
- Manual: run the devnet with one command, open the app with `HUB_URL` pointing at it, swap both ways with the
  demo wallets, force a refund, restart the hub mid-swap. Every step is written out in [testing.md](testing.md).

## 8. Decisions taken (2026-10-23)

1. Repos: `ckbolt-web/` and `ckbolt-hub/`, two git repos side by side in one workspace folder; both are now
   published together on GitHub.
2. Demo Bitcoin network: Mutinynet.
3. Demo model: hub-run demo wallets (custodial test money, labelled) plus bring-your-own.
4. Hosting for the public demo: a Linux server, provided once the code was ready (planned at about 4 vCPU, 8 GB RAM,
   150 GB disk); the demo now runs on it ([../deploy/README.md](../deploy/README.md)).
5. Assets on testnet: CKB and RUSD first, cWBTC if time allows; USDI removed from the site's live claims.
6. NestJS for the hub, with these coding rules (clean architecture, no hard-coding, `common` for shared code,
   RESTful API).
