# Live swap UI: a DEX-style card with real wallets

Status: **done on 2026-10-24.** Testing the live swap showed the screen was unreadable: too much text, L1 wallet buttons where L2 wallets are needed, and a demo wallet in the way. This spec
replaced the live part of the swap form with a card that reads like a DEX swap. Explanations open on demand. Where the
build differs from the text below, [As built](#as-built-2026-10-24) at the end says how.

## Goals

1. **Real wallets only.** The user connects their own Lightning wallet (BTC) and their own Fiber wallet (CKB, RUSD),
   then swaps. The demo wallet is not offered in the UI. The hub's demo API stays for `testnet:smoke`.
2. **One click.** "Swap" runs every step with the connected wallets:
   - the payout invoice, the swap and the payment, without copy and paste;
   - except with the user's own Fiber node, which cannot be driven from the page.
3. **Terse.** Only what a DEX shows: amounts, tokens, wallets, rate, fee, quote timer and one button. Every
   explanation sits behind a "?" (`InfoTip`, a popover) or the "How it works" dialog.
   - Budget: at most **25 visible words** in the card at rest, numbers and token symbols excluded.
   - No sentence longer than 12 words on screen.
   - No paragraph on screen: a paragraph goes in a popover or dialog.
4. **L2 is the point.** Swaps run on Lightning and Fiber, never on L1.
   - L1 wallets (JoyID through CCC) appear only where they fund a Fiber node: the Fiber wallet dialog and `/app/fiber`.
   - They do not appear on the swap card.

Out of scope here: the simulated Get paid and Pay tabs (stage 4) and the simulated swap shown when no hub is live. They
keep working as they are; only their tab labels get shorter.

## Layout

The card is centred, `max-w-[480px]`, in the template's look:
- square, `border-foreground/10`;
- amounts in `font-display`;
- labels in `font-mono` small;
- pill buttons;
- no new colours. `docs/style-guide.md` applies in full.

```
┌──────────────────────────────────────────────┐
│ Swap   [Testnet]                How it works │  header
├──────────────────────────────────────────────┤
│ You pay                    [⚡ Alby Hub ●]   │  pay box: label + WalletButton(network of this side)
│ 2,000                            [⚡ BTC]    │  amount input (h-14 text-3xl) + token (BTC is fixed)
│ ≈ $1.62                      Max 20,000 sats │  USD hint + limit (or "Can send 1,000 CKB" for Fiber)
├──────────────────── (⇅) ─────────────────────┤  flip button on the divider
│ You receive               [CKBolt node ●]    │  receive box
│ 1,091.23                         [CKB ▾]     │  read-only amount from the quote
│ ≈ $1.60                              ◔ 24s   │  USD hint + the quote's countdown
├──────────────────────────────────────────────┤
│ 1 BTC = 54.56M CKB  ·  Fee 0.30% (?) Details ▾ │  details row; "Details ▾" expands route, limits, price
│ [                 Swap                 ]     │  primary button, full width, h-14
│  one short error line when needed            │
└──────────────────────────────────────────────┘
```

- Token buttons:
  - The Lightning side always shows BTC; it is not a picker.
  - The Fiber side lists the hub's assets for this direction (CKB, RUSD) from `GET /v1/assets`.
  - The flip button swaps the direction.
- Typing the amount:
  - The user types the amount they pay. `side: "pay"` quotes are what the card asks for; a receive-side input is not
    needed.
  - The input is in sats when BTC is paid, and in token units when CKB or RUSD is paid.
- Own Fiber node and BTC to Fiber: under the receive amount, a single input "Your Fiber invoice" (sha256, `fibt`) with a
  "?".
- Details (collapsed): route `Lightning → CKBolt hub → Fiber`, min and max per swap, price source and time.

## The primary button

The first matching state wins:

| State | Label | Action |
| --- | --- | --- |
| Hub not live | `Hub unavailable` | disabled |
| No amount, or zero | `Enter an amount` | disabled |
| Below min / above max / above liquidity | `Min 1,000 sats` / `Max 20,000 sats` / `Not enough liquidity` | disabled |
| Lightning wallet not connected | `Connect Lightning wallet` | opens its dialog |
| Fiber node not chosen | `Connect Fiber node` | opens its dialog |
| Fiber node not ready | the node's `problem`, e.g. `Open your Fiber node` | browser node: opens the header's Fiber node on the page that fixes it (Home, Channels, or Add funds); otherwise the Fiber dialog |
| CKBolt node (browser node) short of liquidity | `Not enough CKB to send` / `Your node can't receive this much CKB` / `Ask the hub for a channel first` (it can receive none of the token) | opens the header's Fiber node on Channels, or on Add funds while the node holds too little CKB to accept the hub's channel |
| External node (own node), BTC to Fiber, no valid invoice | `Paste your Fiber invoice` | focuses the field |
| Quote loading | `Getting quote…` | disabled |
| Quote expired | `Refresh quote` | refreshes |
| Ready | `Swap` | runs the swap |

## The run

"Swap" opens the progress dialog and runs these steps. The hub's swap state is the truth; wallet answers only move the
dialog along.

| # | BTC to Fiber (`ln_to_fiber`) | Fiber to BTC (`fiber_to_ln`) |
| --- | --- | --- |
| 1 | Invoice from your Fiber node (browser node: bridge `makeInvoice`; own node: the pasted invoice) | Invoice from your Lightning wallet (`makeInvoice`, checked) |
| 2 | Swap locked with the hub (`POST /v1/swaps`) | same |
| 3 | Pay from your Lightning wallet (`payInvoice` on the hold invoice, checked) | Pay from your Fiber node (browser node: bridge `payInvoice`; own node: QR + copy of the `fibt` hold invoice, then wait) |
| 4 | The hub pays you (`outgoing_in_flight` to `outgoing_succeeded`) | same |
| 5 | Complete (`succeeded`) | same |

- Each step shows pending, active, done or failed, with one short line.
- **Success**: "Swap complete", the amounts, and a collapsed "Details" (swap id, payment hash, preimage, and
  `sha256(preimage) = payment hash` checked in the page).
- **Refund**: "Refunded: your payment went back to your wallet", with the hub's reason in Details.
- **Cancelled** (nothing paid): "Swap cancelled", with a Try again button.
- **Errors**: a refused wallet step shows its error and "Try again" (it never pays twice). An NWC payment reported as
  "no answer" or "timeout" means "Sent; waiting for the hub". Never offer to pay again.
- **Closing the dialog while running**: it is not dismissible while running (`hideClose`), but has "Hide". The card
  then shows a one-line banner "Swap in progress · View".

## Parts

Every part follows `docs/style-guide.md` and this file.

| Part | Files | Builds |
| --- | --- | --- |
| **swap-core** | `components/app/swap/*.tsx` (not `wallets/`, `help/`, `info-tip.tsx`), `hooks/use-swap-runner.ts`, `lib/swap/**` | `SwapCard`, its boxes, details row, primary button state machine (a pure function in `lib/swap/`), progress dialog, `useSwapRunner` (reuses `useHubQuote`, `useHubSwap`'s start and poll, the Lightning store's `makeInvoice` and `pay` with `checkWalletPayoutInvoice` and `checkHoldInvoice`, and `useFiberWallet()`) |
| **wallets** | `components/app/swap/wallets/**`, `lib/wallets/fiber-wallet/**` | `FiberWalletProvider` and `useFiberWallet()` (contract in `components/app/swap/contracts.ts`), described below |
| **help** | `components/app/swap/help/**`, `components/app/app-intro.tsx`, `components/app/fiber-node/**`, `components/app/fund-fiber-node.tsx` (copy only) | The help pieces and copy cuts, described below |
| **integrate** (after the three above) | `components/app/app-modes.tsx`, `components/app/pay-flow.tsx`, `components/app/live-swap.tsx`, `components/app/live-wallets/**`, `hooks/use-hub-demo-invoice.ts`, `hooks/use-hub-swap.ts`, old specs | Described below |

**wallets** builds:
- `FiberWalletProvider` and `useFiberWallet()`:
  - the browser node over the bridge (`useFiberBrowserBridge`, `BridgeClient`);
  - own node (manual; `ManualFiberStep`);
  - the choice remembered in `sessionStorage`.
- `WalletButton`: a chip that opens the network's dialog. Disconnected: "Connect Lightning" or "Connect Fiber".
  Connected: icon, short name and status dot; the dialog shows details and Disconnect.
- **Lightning dialog**:
  - NWC paste (with "Remember in this tab") and WebLN when present;
  - a mainnet wallet is refused;
  - it reuses `useLightningWallet`, and the secret never leaves the browser.
- **Fiber dialog**:
  - CKBolt node (browser node): status, "Open Fiber node" opening `/app/fiber` in a new tab, and what it can send and receive.
  - External node (own node): one line and a "?".
  - "Add CKB" links to the node's funding page; this is the only L1 wallet touchpoint.

**help** builds:
- `HowItWorksButton` and its dialog: at most 4 short sections.
  - What happens: 4 numbered lines.
  - Wallets you need: Lightning wallet on Mutinynet (e.g. Alby Hub over NWC); Fiber: browser node or your own node.
  - Is it safe: the hash lock; no payout means an automatic refund.
  - Test networks only.
- Cut `AppIntro` to an eyebrow, an H1 and one line in live mode.
- Cut `/app/fiber` (node, key, hub, channel and activity panels) and the funding page the same way: keep the controls;
  move explanations into `InfoTip`s.

**integrate** does:
- In `app-modes`, when `hub.live`:
  - open on Swap;
  - the Swap tab renders `<FiberWalletProvider><SwapCard /></FiberWalletProvider>`;
  - the L1 `WalletBar` is hidden on the Swap tab;
  - tab buttons show titles only, with a `Simulated` tag on Get paid and Pay.
- When not live, nothing changes.
- Strip the live branch and the demo wallet from `pay-flow`.
- Delete:
  - `live-wallets/**`;
  - the parts of `live-swap.tsx` nothing uses;
  - `use-hub-demo-invoice`;
  - the demo payment in `use-hub-swap`.
- Remove old Playwright tests of the removed UI. Keep unit tests of the libs that stay.

## Test ids (new)

`swap-card`, `swap-pay-box`, `swap-receive-box`, `swap-amount`, `swap-receive-amount`, `swap-token-pay`,
`swap-token-receive`, `swap-flip`, `swap-details`, `swap-quote-timer`, `swap-primary`, `swap-error`,
`swap-own-invoice`, `wallet-button-lightning`, `wallet-button-fiber`, `wallet-dialog-lightning`, `wallet-dialog-fiber`,
`swap-progress`, `swap-step-<n>`, `swap-result`, `swap-manual-invoice` (own node pays by hand), `how-it-works`,
`info-tip` (all "?" buttons).

## Tests

- Unit:
  - the primary button state function;
  - the runner's step logic with fake wallets and a fake hub;
  - the Fiber wallet provider with a fake bridge.
- Playwright, with the hub faked by `page.route('/api/hub/**')`, NWC by `window.__ckboltTestNwc` and the browser node
  by the `/app/fiber` page with `window.__ckboltTestFiberNode`:
  - every button state;
  - both directions run automatically end to end;
  - own node, both directions;
  - refund and cancel;
  - the NWC timeout shows "Sent", and nothing is paid twice;
  - a mainnet wallet is refused;
  - the secret never leaves the browser;
  - axe has no serious findings;
  - nothing is wider than a 390 px screen;
  - the word budget of the card at rest.

## As built (2026-10-24)

What the build changed against the text above, after the design review (18 states at 1280 and 390 px):

- **Quote timer**: in the receive box, next to the USD hint, under the amount it holds; not in the details row.
- **Wallet chips**: "Connect Lightning" and "Connect Fiber" instead of "Connect", so each side says which L2 wallet it
  needs.
- **Primary button**: three more states. First of all, a running swap shows "Swap in progress" and an ended one "View
  result" (both open the dialog), so the card never offers a second swap. "Enter a valid amount" for text that is not
  a number, "Amount out of range" for a Fiber amount the hub refuses before a price is known, and "Try again" after a
  failed quote.
- **Hidden dialog**: the banner "Swap in progress · View" takes the primary button's place.
- **Page intros**: `AppIntro`, `/app/fiber` and `/app/fiber/fund` share `components/app/page-intro.tsx`: an eyebrow, an
  H1 and one line, with any detail behind a "?".
- **Removed with the old live form**: `live-wallets/**`, `live-swap.tsx`, `hooks/use-hub-demo-invoice.ts`, the demo
  payment in `use-hub-swap`, `tests/e2e/hub-real.spec.ts`, and the lib helpers only they used (the Status panel rows,
  the optional quote approval, the payout invoice notice, the fnn request guide for an own node). Since 2026-10-26
  the hub client has no demo calls either: the proxy refuses `/v1/demo/*`.
- **Still open** (then): while a hub is live, the Swap tab is this card, which has no ETH; the simulated ETH route
  (stage 5) shows only without a live hub. The simulation and its ETH route went on 2026-10-30
  ([pay-get-paid.md](pay-get-paid.md#removed)); ETH comes back with Perun channels.
- **Tests**: `tests/unit/live-swap.spec.ts` (button states, the runner with fake wallets and a fake hub),
  `tests/unit/fiber-wallet.spec.ts` (the provider with a fake bridge), `tests/e2e/live-swap.spec.ts` (with
  `tests/e2e/support/` and `tests/e2e/fakes/`) and `tests/e2e/hub-live.spec.ts` (the page around the card).
- **More test ids**: `swap-banner`, `swap-token-list`, `fiber-option-browser-node`, `fiber-option-own-node`,
  `wallet-disconnect`, `wallet-error`, `wallet-nwc-form`, `wallet-nwc-secret`, `wallet-nwc-connect`, `wallet-webln`,
  `wallet-lightning-connected`, `wallet-lightning-network`, the browser node's `fiber-node-status`, `fiber-node-phase`,
  `fiber-node-hub`, `fiber-node-liquidity`, `fiber-node-problem`, `fiber-open-node`, `fiber-check-again`, and
  `how-it-works-steps`, `how-it-works-guide`, `hub-degraded`.

## Public demo additions (2026-10-26)

From the public demo's plan (tasks F3.1, F8.1, F9.1, F1.1, P7). Each keeps the card's word
budget at rest: nothing new shows on the card until it is needed.

- **Swaps paused** (P7): when `GET /v1/health` reports `swaps.paused`, or a quote is refused with `maintenance`, the
  primary button reads `Swaps paused`, disabled, right after `Hub unavailable` in the table, and the error line says
  "Swaps are paused for maintenance. Try again later." No quote is asked for while the health says paused. A swap the
  hub refuses with `maintenance` fails step 2 and offers a new quote.
- **Get a Lightning channel from the hub** (F3.1), in the Lightning dialog of a connected wallet, while
  `GET /v1/lightning/node` offers channels (`inbound.enabled` and an address): 1, the hub's address to add as a peer
  (Copy address); 2, `Get a channel`, which sends the wallet's node key (NWC `get_info.pubkey`, WebLN
  `getInfo().node.pubkey`) to `POST /v1/lightning/inbound-channels`. The line then follows
  `GET /v1/lightning/inbound-channels/:pubkey` (every 10 s while it opens): `Opening`, then `Ready: you can pay N
  sats`. Why it is needed is behind the "?". Refusals read in plain words; a 409 is "add the hub as a peer first",
  unless the hub lists a channel with the wallet, which then shows instead.
- **No route** (F8.1): a Lightning payment refused with `RouteNotFound` or `PaymentSendingFailed` (LDK) fails step 3
  with "Your wallet found no route to the hub." (the wallet's words behind the "?") and a text button `Get a Lightning
  channel from the hub`, which hides the progress dialog (the banner stays) and opens the Lightning dialog. Try again
  still pays at most once more.
- **Report a problem** (F9.1): under the result's Details, a link to a new issue (`NEXT_PUBLIC_FEEDBACK_URL`, GitHub
  issues on the public repo by default) with the swap id in its title and body.
- **How it works** ends with a link to the testnet guide (`/app/guide`).
- **Test ids**: `wallet-lightning-channel`, `wallet-lightning-channel-uri`, `wallet-lightning-channel-request`,
  `wallet-lightning-channel-status`, `wallet-lightning-channel-error`, `swap-step-help`, `swap-report`,
  `how-it-works-guide-link`; on the guide page `testnet-guide`, `testnet-guide-steps`, `testnet-guide-needs`,
  `testnet-guide-limits`, `testnet-guide-report`; on the node page `fiber-node-hub-line-<asset>` (since 2026-11-07 the line of each row of the hub's channel card,
  [fiber-wallet-popup.md](fiber-wallet-popup.md#channel-with-the-hub-one-card)).

## Hub details and getting CKB back (2026-10-26)

From feedback on the public demo: testers could not find the node page or the hub's addresses, and asked
how to get the CKB they put on the browser node back.

- **Header** (since 2026-10-27 the Fiber wallet button replaces "Fiber node"; see the last section): "Guide"
  (`/app/guide`) and "Fiber node" (`/app/fiber`, a plain anchor) sat next to "Open the app", on desktop and in the phone
  menu (a 2 by 2 grid of pills under the section links). The desktop row starts at `lg`
  (below it the menu button shows) and "View architecture" shows from `xl`, so the row never wraps.
- **CKBolt hub card** at the top of the guide (`/app/guide#hub`), read live through the proxy: status as the app reads
  `/v1/health` and `/v1/assets` (Live, Degraded with the reason behind a "?", Unavailable, Swaps paused); Lightning
  (`GET /v1/lightning/node`): the URIs with Copy, "Add it as a peer in your Lightning wallet (Alby Hub: Node →
  Advanced → Connect Peer)", and the channel the hub opens; Fiber (`GET /v1/fiber/node`): node id, the TCP address with
  the hub's peer id for Fiber Studio or fnn (Copy), the WebSocket addresses behind a "?", the inbound amounts per
  asset; and the per-swap limits as the card's Details write them. A part the hub cannot give says so on its own.
  "Hub connection details" links to it from How it works and from the Lightning dialog's channel section (new tab).
- **Close to my wallet**: a channel's Close opens a confirmation under the table: send the node's share to "This node"
  (the default; `shutdown_channel` without `close_script`) or "My wallet", a CKB address on the node's network that is
  not the node's own, pasted or taken from a CKB wallet through CCC (address only; nothing is signed). It goes to fnn as
  `close_script` (`{code_hash, hash_type, args}`). Popup wallets (JoyID) cannot connect on the isolated page; one
  connected on the funding page is restored by CCC, and the "?" says so.
- **Withdraw** on the node panel: all plain cells at the node's address to one address, minus the fee, in one CKB
  transaction (CCC: `completeInputsAll`, then `completeFeeChangeToOutput` on that output), signed in the page with the
  node's CKB key (`SignerCkbPrivateKey`) after the visitor's password opens the stored keystore again; the keys are
  wiped right after signing. Refused while a channel opens or closes (checked again right before signing), before the
  balance is read, and below one 61 CKB cell. Tokens (RUSD cells) and CKB in channels stay. The result shows the
  amount, the fee and the transaction with its CKB Explorer link. CCC loads only when one of these forms opens.
- **Guide**: the last step is "Take your CKB back", with both ways.
- **Test ids**: `hub-card`, `hub-card-status`, `hub-card-line`, `hub-card-lightning`, `hub-card-lightning-uri`,
  `hub-card-lightning-channels`, `hub-card-fiber`, `hub-card-fiber-node-id`, `hub-card-fiber-p2p`, `hub-card-fiber-ws`,
  `hub-card-fiber-inbound`, `hub-card-limits`, `hub-card-unavailable`, `how-it-works-hub-link`,
  `wallet-lightning-channel-hub-link`; on the node page `fiber-node-close-confirm`, `fiber-node-close-address-field`,
  `fiber-node-withdraw-open`, `fiber-node-withdraw`, `fiber-node-withdraw-amount`, `fiber-node-withdraw-blocked`,
  `fiber-node-withdraw-error`, `fiber-node-withdraw-sent`, `fiber-node-withdraw-address-field`.

## The Fiber wallet popup (2026-10-27)

From [fiber-wallet-popup.md](fiber-wallet-popup.md): the browser node moved from its own tab to the header's **Fiber
wallet**, a popover that runs the node in an iframe of `/app/wallet` (Document-Isolation-Policy), on every page.

- **Header**: the Fiber wallet button (status dot and "Fiber wallet", "Locked" or the CKB the node can send) replaces the
  "Fiber node" link, next to "Open the app" on desktop and beside the menu button on a phone. The header's links move
  client-side, so the node keeps running from page to page.
- **Fiber dialog**: with the browser node chosen and not running, "Open Fiber node" closes the dialog and opens the
  Fiber wallet over the page; the card follows the wallet's node over the same bridge as before (an iframe is the same
  origin). Browsers without Document-Isolation-Policy get "Open the wallet in a window" inside the popover.
- **Copy**: "Add CKB" and "About the browser node" point to the wallet (Deposit, Fund from a wallet); "Do this in your
  Fiber wallet."; the run's errors say "Open your Fiber wallet" where they said "node tab".
- **Liquidity**: what the browser node can send and receive for a swap counts the hub's channels only; a channel the
  node opened with another node is the wallet's own business.
- **Test ids**: the dialog keeps `fiber-open-node` (now a button); the wallet's own ids are listed in
  [fiber-wallet-popup.md](fiber-wallet-popup.md), "As built".

## The Fiber node and the card's CTAs (2026-10-27)

The popup was rescoped the same day ([fiber-wallet-popup.md](fiber-wallet-popup.md#fiber-node-current)): the
header popup is the **Fiber node**, infrastructure the app uses; the app is where money moves. For the card:

- **Words**: every visible "Fiber wallet" is now "Fiber node": the chip's dialog title ("Fiber node") and its choice
  ("Which Fiber node"; "Runs in this browser, at the top of the page. Makes and pays invoices for you."), the primary button ("Connect Fiber
  node", "Check your Fiber node"), the run's steps ("Invoice from your Fiber node", "Pay from your Fiber node") and
  errors, and How it works ("The Fiber node at the top of the page, or your own.").
- **CTAs land on the page that fixes the node** (`nodeFixPage`, `lib/wallets/fiber-wallet/node-page.ts`; the form's
  `nodePage`): with the browser node chosen, the primary button opens the header's Fiber node directly, without the
  dialog: "Open your Fiber node", "Unlock…", "Check your Fiber node" and "Connect your node to the hub" go to Home;
  "Ask the hub for a channel (first)", "Your node can't receive this much …" and "Not enough … to send" go to Channels,
  or to Add funds while the node holds too little CKB on chain to accept the hub's channel in that token (the node's
  tab reports its on-chain CKB and what it puts in with its status). "Use the tab that runs your node" and a hub on
  another network still open the Fiber dialog. In the dialog, a running node with a problem shows the matching button
  ("Open Channels", "Open Fiber node", `fiber-fix-in-node`) and "Add funds" (`fiber-add-funds`); "Open Fiber node"
  (`fiber-open-node`) opens Home.
- **A late answer keeps the node**: the card asks the node every 5 s and collects answers for 800 ms. Under load a
  busy or hidden tab answered in 1 to 3 s (measured in the e2e runs), and those answers were dropped: two such windows
  in a row made the card read "Open your Fiber node" for one poll, and a click then sent the visitor to Home. Now an
  answer that arrives after an empty window still counts until 4.5 s after the request (`BridgeClient.status(onLate)`,
  `BRIDGE_TIMING.statusLateMs`; an answer never replaces one to a newer request), and the card keeps its last view of
  the node until two windows in a row bring no answer at all (`nextPresenceRead`, `BRIDGE_TIMING.missesBeforeGone`).
  A closed tab is still noticed within about 11 s.
- **Status colours**: the chips' dots (not connected is grey), the progress steps (done green, the current one amber,
  failed red), the result's tint and the hub's badge follow the [style guide](style-guide.md#status-colours). The
  Fiber chip is amber ("needs attention") for any step the visitor takes: open, unlock or connect the node, a channel
  from the hub, or a channel too small for the swap on the card (`attention`, from the form's `nodePage`); red ("not
  usable") only for a failure: the node failed to start, or the hub runs on another network
  (`isFailureProblem`, `lib/wallets/fiber-wallet/node-status.ts`). A Lightning wallet on mainnet is "not usable" too.

## History (moved into the Fiber node, 2026-10-30)

The app's History tab (2026-10-27) is gone: History belongs to the node, in the header's popup
([pay-get-paid.md](pay-get-paid.md) part E;
[fiber-wallet-popup.md](fiber-wallet-popup.md#history-sources-detail-and-limits)).

- Every swap the card starts (and Pay's and Get paid's Lightning invoices, which run the same `useSwapRunner`) is still
  kept as soon as the hub creates it and as the card reads it, in localStorage per hub network
  (`ckbolt:swap-history:<network>`, `lib/swap/history.ts`), with nothing a wallet holds. The node's History reads it
  there (the page and the popup's iframe share localStorage) and merges each swap with its own leg by the payment hash.
- The tab, its filters, its read-only swap dialog and its deep links (`/app?tab=history&swap=<id>`, `&hash=`,
  `mode=history`) are gone; an old link opens the page as any other. The card's result has **View in History** instead,
  which opens the header's popup on that swap (relay `open-entry`) while the popup runs the node.
- Test ids gone: `mode-history`, `swap-history`, `swap-history-empty`, `swap-history-start`, `swap-history-list`,
  `swap-history-row`, `swap-history-detail`, `swap-history-missing`, `history-entry-swap-link`. New on the card's result:
  `history-entry-view`.

## One wallet (2026-10-30)

From [pay-get-paid.md](pay-get-paid.md), part A: nobody connects both a Fiber wallet and a Lightning wallet to swap.
The card's only wallet is the **Fiber node** (the browser node over the bridge, or the own node; the Fiber chip and its
dialog are unchanged). The Lightning side is always a **QR code or a pasted invoice**, so any Lightning wallet works. NWC,
the Lightning chip, its dialog and "Connect Lightning" are gone (the full list is in
[pay-get-paid.md](pay-get-paid.md#removed)).

- **BTC to CKB or RUSD** (`ln_to_fiber`): the visitor types the sats; Swap makes the payout invoice (the browser node over
  the bridge, or the own node's pasted one), creates the swap, and step 3 ("Pay from your Lightning wallet", line "Pay
  the invoice below") shows the hub's hold invoice, checked against the swap first (`checkHoldInvoice`; a mismatch is
  never shown): its QR code, the invoice, Copy, and "Open in wallet" (`lightning:<invoice>`). With `window.webln` (an
  extension such as Alby, also one injected later with `webln:ready`), "Pay with browser wallet" calls `enable()` then
  `sendPayment(invoice)`. The page's store records the attempt before it asks, once per payment hash
  (`lib/wallets/lightning/pay-store.ts`): a refusal ("User rejected") leaves the invoice to pay, the wallet's words
  behind a "?" and the button again; any other answer (paid, a closed prompt, a timeout) takes the box away, the step
  reads "Paying from your wallet…" or "Sent; waiting for the hub", and nothing is offered to pay again. A wallet with no
  route to the hub (LDK `RouteNotFound`) reads "Your wallet found no route to the hub." with a link to the channel on
  the guide's hub card. The hub's state moves the run on, as before; the run never pays a Lightning invoice by itself.
- **CKB or RUSD to BTC** (`fiber_to_ln`): the receive box has "Your Lightning invoice" (a labelled field, a "?", and a
  scan button that opens the QR scanner: camera or image). A valid invoice fixes the swap exact out: the card quotes
  `side: "receive"` with its sats (`POST /v1/quotes`), the receive figure is its sats, and the pay box shows the CKB or
  RUSD needed, read-only, until the invoice is cleared. An amount typed first is quoted on the pay side as before, and
  the field's caption asks "For exactly N sats". The card refuses, in one line, an invoice that is not a Lightning one
  (a Lightning address or LNURL says why behind the "?"), one without an amount (the hub's `invoiceAmountMissing`), one
  for part of a sat, for mainnet or another network, without a payment hash, expired, or expiring before the quote
  (`assertInvoiceOutlivesQuote`, checked once the quote is there): `checkPayoutInvoice` and `outlivesQuote` in
  `lib/wallets/lightning/invoice-check.ts`. Its sats are checked against the per-swap limits in the page, before any
  quote. The pasted invoice is the swap's `payoutInvoice`; step 1 reads "Your invoice" ("Your pasted invoice"). A run
  that ended forgets it.
- **The primary button**: "Connect Lightning wallet" is gone. CKB or RUSD to BTC with neither an amount nor an invoice
  reads "Paste your Lightning invoice" (it focuses the field, in place of "Enter an amount"); after the Fiber node's
  states, a missing or refused invoice reads "Paste your Lightning invoice" too, before the own node's "Paste your Fiber
  invoice" and the quote's states (`lib/swap/primary-button.ts`, `lnInvoice`).
- **Limits** (`lib/swap/limits.ts`): checked on the sats the page knows (the BTC typed, or the invoice's amount), or on a
  typed Fiber amount the hub sizes, as before.
- **The hub's Lightning channel** (F3.1) needed the wallet's node key from NWC: it moved to the guide's hub card, under
  the hub's Lightning address (`components/app/guide/hub-channel.tsx`): a labelled field for the visitor's node id (66
  hex characters), "Get a channel", and the channel's state read from the hub, with the same calls and refusals as before.
- **How it works**: Lightning reads "Any wallet on Mutinynet, by QR code or pasted invoice."; the steps say "receiving
  side" and "paying side", and "Your Fiber node acts by itself. Lightning is a QR code or a paste."
- **Without a live hub** (part D): the Swap tab, like Get paid and Pay, shows one line in the hub's status colour
  (`components/app/hub-unavailable.tsx`: checking, not available, or not taking swaps with the hub's reason behind a
  "?"); the simulated swap form is gone.
- **Test ids**: new `swap-ln-invoice` (the pasted invoice), `swap-ln-invoice-scan`, `swap-ln-invoice-ask`,
  `swap-hold-invoice` (the box), `swap-hold-qr`, `swap-hold-copy`, `swap-hold-open`, `swap-webln`, `swap-webln-error`;
  `swap-step-help` is now the channel link beside the browser wallet's error; on the hub card
  `wallet-lightning-channel`, `wallet-lightning-channel-pubkey`, `wallet-lightning-channel-request`,
  `wallet-lightning-channel-status` and `wallet-lightning-channel-error`; on `/app` `hub-unavailable`, `hub-checking`
  and `hub-degraded` (`mode-not-yet`, also added then, went with part C). Gone: `wallet-button-lightning`, `wallet-dialog-lightning`, `wallet-nwc-*`,
  `wallet-webln`, `wallet-lightning-connected`, `wallet-lightning-network`, `wallet-lightning-channel-uri`,
  `wallet-lightning-channel-hub-link`.
- **Tests**: unit `tests/unit/ln-wallet.spec.ts` (the invoice checks, WebLN, the pay store, the channel),
  `tests/unit/swap-core.spec.ts` (limits, the button's states, the run with a hold invoice paid by hand) and
  `tests/unit/live-swap.spec.ts` (the form's exact-out quote and refusals, the runner with a fake WebLN); e2e
  `tests/e2e/live-swap.spec.ts` (both directions with the browser node and the own node, the QR code, Copy, Open in
  wallet, a fake `window.webln` paying once, a QR image scanned into the field, the refusals, axe, 390 px),
  `tests/e2e/guide.spec.ts` (the channel on the hub card) and `tests/e2e/hub-live.spec.ts` (the page without a live hub).
  The fake hub prices `side: "receive"` both ways.

## More tokens: cWBTC (2026-11-06)

The hub serves any UDT its `FIBER_ASSETS` lists ([context.md](context.md), "More tokens, driven by the hub"); cWBTC
(CCH Wrapped BTC, 8 decimals, quoted 1:1 with BTC, so one base unit is one sat) is the first. The card names no token
of its own:

- **The picker** lists `GET /v1/assets` for the direction, in the hub's order, each with the app's token when it knows
  it (`PAY_TOKENS`: cWBTC as "CCH Wrapped BTC (test)" with a plain local icon) and the hub's own name and symbol
  otherwise. The list's second line is now the app's name for a known token (CKB "Nervos CKB", RUSD "Stable++ USD
  stablecoin"), the hub's for any other. Since 2026-11-07 the hub's `displayName` and `iconUrl` come first when its
  FIBER_ASSETS sets them (cWBTC on the testnet hub: "Wrapped BTC (test)" and an inline SVG), checked again in the page; a broken
  or blocked icon falls back to the app's icon, then the initials ([fiber-wallet-popup.md](fiber-wallet-popup.md#tokens-from-the-hub-the-udt-whitelist),
  "Names and icons from the hub"). The same name and icon show in Pay's and Get paid's pickers (they share it); amounts
  keep the symbol.
- **Both directions** work as for RUSD: BTC to cWBTC (2,000 sats buy 1,980 base units, "0.0000198 cWBTC", at the
  fake's 1 % fee) with the node's invoice for cWBTC's script, and cWBTC to BTC exact out by the visitor's invoice.
- **Words**: How it works lists the hub's symbols on the Fiber side ("CKB, RUSD, cWBTC"; "CKB tokens" before the hub
  lists any), and the Fiber node's dialog says "CKB, RUSD, and cWBTC on CKB L2". The page's metadata says "CKB and CKB
  tokens".
- **The node**: the node tab reports its liquidity in CKB and every asset the hub serves (no fixed list), and a short
  channel sends the visitor to Channels or Add funds as for RUSD (the token reserve is shared, about 180 CKB).
- **Tests**: `tests/e2e/multi-asset.spec.ts` (the picker, both directions, How it works and the dialog, axe and 390 px;
  the hub's names and icons with their fallbacks), `tests/unit/token-display.spec.ts` (the checks and fallbacks).


## External node, step by step (2026-11-09)

The Fiber chip's two choices read **CKBolt node** (the browser node) and **External node** (a node the visitor runs:
Fiber Studio or fnn). CKBolt cannot reach an external node, so each manual step now comes with the exact fnn JSON-RPC
call, as a copyable curl line for fnn's RPC (`http://127.0.0.1:8227` by default), built by
`lib/wallets/fiber-byo/rpc-commands.ts` (field names and encodings of fnn v0.9.1) and shown by `NodeCommand`
(`components/app/swap/node-command.tsx`) behind a disclosure:

| Where | Call | What it carries |
| --- | --- | --- |
| Swap card, BTC to a token, once quoted ("Make it with fnn", `swap-own-invoice-command`) | `new_invoice` | the quote's exact receive amount (hex), `currency` of the hub's network, `hash_algorithm: "sha256"` (fnn's default, `ckb_hash`, is refused), `expiry` one hour, the token's `udt_type_script` from GET /v1/fiber/node (none for CKB). fnn's defaults already give what the hub needs for `final_expiry_delta` (160 minutes) and `allow_mpp` (off) |
| Progress dialog, a token to BTC, under the hub's hold invoice ("Pay it with fnn", `swap-manual-command`) | `send_payment` | the hold invoice, `max_fee_amount` 0.5 % of what the visitor pays (the browser node's cap, `maxFeeOf`) |
| Guide, hub card, Fiber side ("Connect your fnn to the hub", `hub-card-fiber-connect`) | `connect_peer` | the hub's first TCP address with its peer id |

The guide's hub card also has **Get a Fiber channel from the hub** (`components/app/guide/fiber-channel.tsx`,
`hub-card-fiber-channel`): the node id, a token among those the hub funds (with what it puts in), and for a token the
`ckb.udt_whitelist` entry the node's config needs to accept the channel by itself (`hub-card-fiber-whitelist`, built
with the browser node's `whitelistEntryYaml`). It posts `POST /v1/fiber/inbound-channels` and follows
`GET /v1/fiber/inbound-channels/:nodeId` from Opening to Ready ("you can receive …"). A 409 is read first: a channel the
node already has is shown; otherwise the line says to connect the node first. Logic: `lib/wallets/fiber-byo/hub-fiber-channel.ts`.

Tests: `tests/unit/fiber-byo.spec.ts` (the calls, the shell quoting, the channel logic), `tests/e2e/live-swap.spec.ts`
("the user's own Fiber node": the new_invoice call for CKB and RUSD, the send_payment call with its fee cap, copied,
no wider than a phone), `tests/e2e/guide.spec.ts` (connect_peer, a CKB and an RUSD channel, the whitelist entry, a 409,
a ready channel).
