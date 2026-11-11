# Pay, Get paid and one wallet

Status: **built 2026-10-30**, with later changes in their dated sections; Pay and Get paid run on the public testnet
demo. The decision is in
[context.md](context.md); the parts it replaces are listed under [Removed](#removed).

## Why

- Nobody connects both a Fiber wallet and a Lightning wallet to swap. The only wallet is the **Fiber node in the
  header**; the Lightning side is always a **QR code or a pasted invoice**, so any Lightning wallet works.
- Pay and Get paid were a simulation. They become real, on the same hub and node as Swap.
- The CKB and Bitcoin wallet panels (CCC) on `/app` did nothing for a live swap: they go.
- History belongs to the node: the app's History tab becomes the node's History, in the popup.

## A. Swap card: one wallet

| Direction | Lightning side | Fiber side |
| --- | --- | --- |
| BTC to CKB/RUSD (`ln_to_fiber`) | After the quote, Swap creates the swap and shows the hub's hold invoice as a QR with Copy and "Open in wallet" (`lightning:` URI). With `window.webln`, also "Pay with browser wallet" | The node makes the payout invoice over the bridge, as today |
| CKB/RUSD to BTC (`fiber_to_ln`) | The visitor pastes or scans their own BOLT11 invoice. Its amount fixes the quote (`side: "receive"`, exact out); the pay box shows the CKB or RUSD needed. Typing an amount first asks for an invoice of that amount | The node pays the hub's hold invoice over the bridge, as today |

- The hub refuses an invoice without an amount (`invoiceAmountMissing`, `../ckbolt-hub/src/application/swaps/
  payout-invoice.checks.ts`), so an amountless invoice is refused in the card with one clear line. The invoice must
  also outlive the quote (`assertInvoiceOutlivesQuote`); the card checks both before Swap.
- The run's five steps stay. Step 1 for `fiber_to_ln` is "Your invoice"; step 3 for `ln_to_fiber` is "Pay the invoice
  below" with the QR until the hub holds the payment.
- The own Fiber node kind (Fiber Studio, fnn by hand) stays in the Fiber chip's dialog.
- The hub's Lightning channel (F3.1) needed the wallet's node key from NWC: it moves to the guide's hub card, with the
  visitor's node id pasted.
- Lightning addresses (`user@domain`) are a later item.

## B. Pay (real)

Paste or scan one of:

| Input | What happens |
| --- | --- |
| Lightning invoice (BOLT11, with an amount) | A `fiber_to_ln` swap, exact out by the invoice amount: shows what the merchant gets (sats), what you pay (CKB or RUSD), the fee and the quote's expiry. Confirm: the node pays the hub's hold invoice; the result as the swap card's |
| Fiber invoice | The node pays it directly (`send_payment`). Before: network and expiry checked in the page, then read by the node (`parse_invoice`). Shows the amount, the max fee and, after, the actual fee. The payment hash goes to History **before** sending; after a reload, entries still pending are checked with `get_payment` (the dev log's payment-recovery pattern) |
| CKB address | On-chain CKB from the node's balance, with an amount (the Withdraw code with an amount) |

Pay needs the running Fiber node; it runs over the same bridge as Swap (new bridge methods for a Fiber invoice and an
on-chain send, each checked in the node's tab). The popup's Send code from before its rescope (`payments.ts`,
`invoice-parse.ts`, `molecule.ts`, `send-form.tsx`) is revived where it fits.

### B as built (2026-10-30)

**The tab** (`components/app/pay/`): one card like the swap card. One labelled field, "Invoice or address" (`pay-input`,
a "?" for what it takes), with a scan button (`pay-scan`, the shared QR scanner: camera or image). The page reads it
first (`lib/pay/classify.ts` `classifyPayInput`, on `parsePaymentRequest`): a Lightning invoice through part A's checks
(`checkPayoutInvoice`: the hub's network, an amount, whole sats, a hash, not expired), a Fiber invoice of the browser
node's network (`checkInvoiceText`, the dev log's client-side network check), a CKB address of that network; anything
else is one line (`pay-error`) with the reader's sentence behind a "?". The kind shows under the field (`pay-kind`).
While a payment runs the field is read-only and keeps what is being paid. Copy: `lib/pay/copy.ts`; timings:
`lib/pay/constants.ts`.

**The browser node only.** Pay always uses the browser node (`useFiberWalletController` with `fixedKind:
"browser-node"`, whatever the swap card chose; it asks the node tab while the tab is shown or a payment runs). Until the
node runs, one line says "Pay needs your Fiber node running." with "Open your Fiber node" (`pay-needs-node`,
`pay-open-node`), which opens the header's Fiber node on the page that fixes it (`nodeFixPage`, Home by default).

**A Lightning invoice** (`lightning-pay.tsx`): a `fiber_to_ln` swap, exact out. `POST /v1/quotes` with `side:
"receive"` and the invoice's sats, in CKB or RUSD from the token picker (`pay-token`). The preview (`pay-preview`):
"They get" (sats), "You pay" (the quote's CKB or RUSD), the fee (a "?") and the quote's countdown. The invoice must
outlive the quote (`outlivesQuote`); the per-swap limits, the hub's refusals, what the node can send and the node's
problems are each one line, with the node's fix page one click away. "Pay 10,000 CKB" (`pay-confirm`) starts the swap
card's own run (`useSwapRunner`, the invoice as the plan's payout invoice): the browser node pays the hub's hold
invoice over the bridge under the swap rule (the hub confirms it is the swap's), so nothing is confirmed in the node
for it. The run shows in place (`pay-result`) with the swap card's steps and result (`components/app/swap/run-view.tsx`,
now shared with the progress dialog), "Try again" or "Get a new quote" when a step failed, and "New payment" (`pay-new`)
once settled. The swap goes to the app's History like the card's.

**A Fiber invoice** (`fiber-pay.tsx`): the node reads it a moment after it is pasted (bridge `read-invoice`:
`parse_invoice`, then the checks of `checkParsedInvoice`: network, expiry, an amount, a token the hub lists, not the
node's own invoice, not the hub's (a hub invoice is a swap's: "Pay it from Swap"), and the amount plus the max fee
within what its ready channels can send in that token). The preview (`pay-preview`): amount and token, payee, max fee
(a "?"), expiry; the page checks the expiry against its own clock before it asks. The max fee is fnn's default rate
(0.5 %, `PAY_MAX_FEE_PER_THOUSAND`), passed to `send_payment` as `max_fee_amount`, so what is shown is what fnn enforces.
"Pay 5 CKB" sends `request-payment`; the page says "Confirm it in your Fiber node." (`pay-waiting`) and opens the
header's popup on Confirm when the popup runs the node (a node window or the node page shows it by itself). On Confirm
the node checks the expiry again, writes the payment to History with its hash, status `Created`, **before**
`send_payment`, then sends and answers with the hash and status. The page then reads `payment-status` every 2 s until
`Success` or `Failed` and shows the result (`pay-result`: Paid, the fee it took next to the max: "0.001 CKB (max
0.025 CKB)", the payment hash). Decline, or no answer within two minutes, sends nothing and the page says so.

**A CKB address** (`on-chain-pay.tsx`): an amount in CKB (`pay-amount`, with the node's on-chain CKB beside it, checked
in the page against it), the preview (address and amount), "Send 100 CKB". The node checks the address (its network,
not its own), the amount (at least one cell of the address's lock, under its balance) and that no channel moves funds,
then builds the transaction with its lock but without its key for the fee; the visitor confirms in the node with the
node's password. The node opens its keystore with it (a wrong password keeps the request up, with the reason), sends
exactly the amount with the change back to its own lock (`ccc-withdraw.ts` `sendAmount`, `buildExactSend`; refused when
the rest would be under one cell), wipes the keys, records a `withdraw` History entry and answers with the transaction;
the page shows it with the explorer link (`pay-explorer`).

**The security rule.** The node never pays a Fiber invoice nor sends CKB because a page asked over the bridge. The bridge
handlers (`components/app/fiber-node/use-bridge-server.ts`, `lib/wallets/fiber-browser/pay-requests.ts`) do every check
in the node's tab, then put the request up in the node's confirmation queue
(`lib/wallets/fiber-browser/confirmations.ts`): one request at a time (another gets `busy`), declined after two minutes
(`BRIDGE_TIMING.confirmTimeoutMs`), refused when the node stops. Only the visitor's Confirm on the node's own page runs
it. Swaps keep their own rule (the hub confirms the hold invoice is a waiting swap's). Passwords never cross the bridge:
the on-chain password is typed in the node. Nothing secret is shown or stored: no preimage, no key, no password, no
invoice text in History.

**Bridge methods** (`bridge-protocol.ts`, version 1): `read-invoice` (`{invoice}` → the preview: payment hash, asset,
amount, max fee, expiry, payee), `request-payment` (`{invoice}` → `{paymentHash, status, maxFee}` once confirmed; since 2026-11-04 the preview also
carries `route`, "B: routes"),
`payment-status` (`{paymentHash}` of a `payment` in the node's History → `{status, fee, failedError}`; it also moves the
History entry), `request-on-chain` (`{address, amount}` in shannons → `{txHash, amount, fee}` once confirmed). Params are
rebuilt from their listed fields only, so nothing a page adds reaches the handlers. New error codes: `declined` (the
visitor declined or did not answer), `busy`, and (2026-11-04) `no_route`.

**The node's Confirm page**: the popup's `confirm` page (in `WALLET_PAGES`; it opens by itself when a request comes,
in the popover and in the node's window; Home shows "The app waits for you to confirm a payment." with Review while one
waits) and, on `/app/fiber`, a Confirm section at the top (`fiber-node-confirm`). It shows what was asked (a Fiber
payment: amount, payee, max fee, the invoice's note cut to 140 characters, expiry; an on-chain send: amount, address,
network fee, and the node password), Confirm ("Pay 5 CKB", "Send 100 CKB") and Decline, then how it ended.

**History** (`activity.ts`): a new kind `payment` (a Fiber invoice paid from Pay: hash, asset, amount, status from
`get_payment`, the fee it took, `payment: {maxFee, payee}`). It holds the node like a swap leg while under way, and
`isPollable` reads it again with `get_payment` until final, also after a reload (the dev log's payment-recovery
pattern). A read that started before a newer record (send_payment's answer) no longer overwrites it (`landRead`). The
popup lists it as "Payment of 5 CKB" (then "Paid 5 CKB"), with a send icon, the Sending, In flight, Paid, Failed
badges in the payment tones, and Max fee and Paid to in its details; the filters stay as they were (All shows it).

**Tests**: unit `tests/unit/pay.spec.ts` (the field's reading, `parse_invoice` and the checks, the max fee, the bridge
methods' validation and round trip with nothing secret, the confirmation queue, the node's handlers with History before
`send_payment`, the `payment` kind and its recovery, the exact-amount transaction on a fake CKB testnet, the adapter's
`max_fee_amount`, the Confirm page in the relay); e2e `tests/e2e/pay.spec.ts` (a Lightning invoice paid as a swap; a
Fiber invoice declined, then confirmed, the fee it took, recovery after the node's document goes; the node page's
Confirm; refusals; an on-chain send with a wrong then right password, exactly the amount and the change; axe and
390 px). Where the browser has DIP (`PW_CHANNEL=chrome`) the node runs in the header's popup; otherwise in its window,
a page of its own. The fake fiber-js answers `parse_invoice` from an `InvoiceBook` (support/fiber-wallet.ts), pays
under the parsed hash and reports a fee once paid.

### B: routes (2026-11-04)

**Why.** Every browser node has only a private channel with the CKBolt hub (the node opens it with `isPublic: false`,
`peer-connect.ts`; the hub's inbound channels are private too). A payer routes from its own view of the graph, cannot
see the hub's private channel to the payee, and fnn invoices carry no route hints, so paying another browser node's
Fiber invoice failed after Confirm with "Failed to build route", while the preview looked fine.

**The fix: trampoline through the hub, only when needed.** fnn 0.9.1 (fiber-js and the hub) routes through trampoline
nodes by default: `send_payment` with `trampoline_hops: [hub]` needs a route to the hub only, and the hub finds the rest
over its own channels. When the node reads a Fiber invoice for Pay (bridge `read-invoice`, and again on
`request-payment`), after `checkParsedInvoice`, it probes with dry runs (`send_payment` with `dry_run: true`: fnn builds
the route and fee without sending, keeps no payment session, and answers an RPC error when it finds no route), in this
order (`pay-requests.ts` `chooseRoute`, `probePayment`):

1. its own route: `{invoice, max_fee_amount, dry_run}`; it works → `direct`;
2. else, when the hub's Fiber node runs on the node's network (`hubNode.nodeId`, never `hubNodeIds`, which may hold an
   id kept from before) and is not the payee: `{invoice, max_fee_amount, trampoline_hops: [hub], dry_run}`; it works →
   `hub`. This dry run checks the path to the hub only, not the hub's path on to the payee: if the payee's node is
   offline or its channel with the hub is short, the payment can still fail after Confirm (Pay then shows Failed);
3. else the read is refused with the bridge error `no_route` (its message is fnn's reason, both when both were tried);
   Pay shows "No route to this payee now. Their node may be offline." with that reason behind a "?", and Pay stays off.

The node keeps the route it probed (`PayablePreview.route`: the kind and the trampoline hops) and sends exactly that on
Confirm: `trampoline_hops` for `hub`, as before for `direct`. Only the kind crosses the bridge (`FiberInvoicePreview.route`,
`"direct" | "hub"`); the preview (`pay-route`, "Route": "Direct" or "Through the CKBolt hub", with a "?") and the node's
Confirm page (`fiber-wallet-confirm-route`) show it. Dry runs write nothing to History. The swap path (the hub's hold
invoice) and Get paid are unchanged.

**Trade-offs.** Through the hub, the hub learns who the visitor paid (it is the trampoline, it sees the payee). The
payment moves the hub's liquidity: it forwards on its channel to the payee, so that channel's balance shifts towards
the payee. The hub cannot keep the payment: it is locked to the invoice's hash, so the payee gets it or it comes back.
Its trampoline fee sits inside the same 0.5 % max fee (fnn requires `max_fee_amount` with `trampoline_hops`); the cap is
not raised. For tiny amounts the cap rounds down to 0, so the dry runs find no route within it and the no-route line
shows with fnn's reason.

## C. Get paid (real)

- Amount (in the asset received, with sats and USD shown as a conversion), the asset (CKB or RUSD), an optional note.
- A request has two invoices: a **Fiber** invoice from the node (a Fiber payer pays it directly), made by "Create
  request", and a **Lightning** invoice through the hub (an `ln_to_fiber` swap whose payout invoice the node makes;
  whoever pays BTC on Lightning, the node gets CKB or RUSD), made only when the visitor opens its tab (since
  2026-11-06, [C: on demand, cancelled when not needed](#c-on-demand-cancelled-when-not-needed-2026-11-06)). Two QR
  tabs, "Fiber" and "Lightning", with live status, then a "Paid" receipt.
- Validity: the Lightning invoice lives as long as the hub's request quote (`purpose: "request"`,
  `REQUEST_QUOTE_TTL_SECONDS`, 900 s by default; the hold invoice expires with the quote). A countdown, and "New
  invoice" once it expires.
- Testnet caveat (one InfoTip): on Mutinynet only a wallet with a direct channel to the hub can pay the Lightning
  invoice (LDK's CLTV limits).

### C as built (2026-10-30)

**The tab** (`components/app/get-paid/`): one card like Pay's (`request-card`), shown with a live hub; without one the
tab keeps the hub's one line (`hub-unavailable`), and the "Not available yet" line is gone. The pure logic is
`lib/get-paid/request.ts`, the copy `lib/get-paid/copy.ts`, the timing `lib/get-paid/constants.ts`.

**The form** (`request-form`, `use-request-form.ts`): the swap card's amount box (`SwapBox`, `AmountInput`) labelled
"Amount" (`request-amount`, any decimal mark, in the asset received) with the token picker (`request-asset`: the assets
the hub serves `ln_to_fiber`, so CKB and RUSD); under it the conversion (`request-conversion`, "≈ $2.00 · 2,526 sats":
the receive leg's USD and the sats a Lightning payer pays, fee included) from `POST /v1/quotes` `ln_to_fiber`, `side:
"receive"`, through `useHubQuote` (a "?" says what it is); "Note (optional)" (`request-note`, labelled, at most 100
characters, a "?": it goes into the Fiber invoice and History, not into the hub's Lightning invoice). "Create request"
(`request-create`) is enabled only when the amount reads, the quote is in, no limit or refusal applies and the browser
node runs, reaches the hub and can receive the amount over its channels with the hub. One error line (`request-error`,
`checkRequestForm`, `requestLimit`, `rangeError`): an amount that is not above zero; the per-swap limits on the
Lightning invoice ("On Lightning, requests run from 1,000 to 100,000 sats.", checked on the quoted sats, or on the
amount sized at earlier prices when the hub refused it); the hub's refusals; the node's problem; what it can receive
("Your node can receive 500 CKB now. Not enough for this.", with "Open your Fiber node" on the page that fixes it,
`nodeFixPage`). Without the node running: "Get paid needs your Fiber node running." with "Open your Fiber node"
(`request-needs-node`, `request-open-node`; Pay's `NodeNeeded`, now with its line and test ids as props).
Since 2026-11-06 the form's quote is a request quote (`purpose: "request"`), so the conversion is the price the
Lightning invoice would ask, the hub's request premium included, and it reads "≈ $2.00 · 2,526 sats on Lightning".

**Create** opens the request (`request-view`): the amount and note on top (`request-summary`), then two Radix tabs
(`request-tabs`), Fiber (`request-tab-fiber`, first and open) and Lightning (`request-tab-lightning`), each with its
status in words and the status dot (`data-status`; tones `requestPartTone` in `lib/status-tone.ts`: Not made yet grey,
Making…, Waiting and Arriving amber, Paid green, Expired and Cancelled grey, Returned and Failed red). Both stay
mounted. "New request" (`request-reset`) goes back to a blank form (the asset kept); the Fiber invoice already made
stays in History and payable until it expires, and an unpaid Lightning invoice is cancelled at the hub.

**The Lightning invoice** (`use-lightning-invoice.ts`, panel `request-lightning`), made when its tab first opens: a
fresh request quote (`POST /v1/quotes` `ln_to_fiber`, `side: "receive"`, `purpose: "request"`, the request's base
units, so the countdown starts at the full request TTL), then the swap
card's own run (`useSwapRunner`, the plan without a payout invoice): the node makes the payout invoice over the bridge
(`make-invoice`, as for Swap; it becomes a swap leg in the node's History), `POST /v1/swaps`, and the hub's hold invoice
once checked against the swap (`checkHoldInvoice`). The panel shows it with the swap card's `InvoiceToPay` (now
exported, with an optional text test id): the label "They pay BTC on Lightning. You receive CKB." (the request's asset;
before the invoice is there the same line shows on its own, `request-lightning-line`, with "The hub and your node make
the invoice…") and its "?" (the hub swaps the payer's sats and pays the node, so the requester never holds BTC; made when
the tab opens, payable for the request TTL, cancelled once the request is paid on Fiber or replaced; the testnet caveat:
on Mutinynet only a wallet with a direct channel to the hub can pay it, LDK's CLTV limits), the QR code
(`request-lightning-qr`), the invoice (`request-lightning-text`), Copy (`request-lightning-copy`), "They pay 2,526 sats",
"Expires in" with the quote timer (`request-countdown`, `QuoteTimer` with a test id prop) and "Open in wallet"
(`request-lightning-open`, `lightning:`). No WebLN button: the payer is someone else. The states (`lightningPart`):
`idle` (its tab never opened: nothing asked of the hub), `making` (the quote, the payout invoice, the swap), `waiting` (the QR code), `arriving` (the hub holds the payer's sats:
"Payment held. The hub is paying your node…"), `paid` (the swap reached `outgoing_succeeded` or `succeeded`), `expired`
(the quote, and so the hold invoice, ran out unpaid by the page's clock, also once the hub cancels it), `cancelled` (the
hub cancelled it before its time, its reason behind a "?"), `returned` (the hub held the payment but could not pay the
node; the payer is refunded), `failed` (a refused quote or a failed step, its line and the reason behind a "?"). After
any of the last four, "New invoice" (`request-new`) makes a fresh quote and swap for the same request. The swap goes to
the app's History, as the card's and Pay's do.

**The Fiber invoice** (`use-fiber-invoice.ts`, panel `request-fiber`): the node makes it over the bridge
(`make-receive-invoice`) and the page checks the answer (`checkNodeInvoice`: a Fiber testnet invoice for exactly the
amount; its parameter type is now the amount and network only). Shown with `InvoiceToPay`: "Pay from a Fiber wallet" and
its "?", the QR code (`request-fiber-qr`), the invoice (`request-fiber-text`), Copy (`request-fiber-copy`) and "Valid
until 12:52 PM". Its status is read through the node every 3 s (`invoice-status`, `REQUEST_TIMING.statusPollMs`) until
final: Open is `waiting` (or `expired` once past its expiry by the page's clock), Received `arriving`, Paid `paid`,
Expired `expired`, Cancelled `cancelled`; a refusal is `failed` with the node's words (`fiberStepError`). "New invoice"
there too once it expired or was refused.

**The receipt** (`request-paid`, `data-count`): once either invoice is paid it replaces the tabs, under the request's
amount and note: "Paid", then per payment (`request-payment`, `data-network`) Received (amount and asset), Paid with
("Lightning, 2,526 sats" or "Fiber") and At (when the page saw it paid). Both invoices stay followed, so if a payer
(rarely) pays both, it reads "Paid twice" with a "?" and lists both.

**Bridge methods** (`bridge-protocol.ts`, version 1): `make-receive-invoice` (`{asset, amount, note}`: a Fiber asset id,
base units above zero, a note of at most 100 characters or null → `{invoice, paymentHash, expiresAt}`; params and the
answer are rebuilt from their listed fields only) and `invoice-status` (`{paymentHash}` → `{paymentHash, status}`, one of
fnn's five statuses). Making an invoice spends nothing, so there is no Confirm in the node. The node's handlers
(`lib/wallets/fiber-browser/request-invoices.ts`, wired in `use-bridge-server.ts`): `makeReceiveInvoice` checks the
amount, the note (trimmed, one line), the token's script from the hub's node (only a hub on the node's network lends
it), and that the node's ready channels with any peer can receive the amount (`NO_INBOUND` otherwise); then it draws the
preimage, calls `new_invoice` (`receiveInvoiceArgs`: regular invoice, sha256, `RECEIVE_INVOICE_EXPIRY_SECONDS` = 1 h,
the note or "CKBolt request" as description, the UDT script), wipes the preimage and records History.
`readRequestInvoiceStatus` answers only for a `request` entry of the node's History (not a swap's payout invoice),
reads `get_invoice` and moves the entry. Constants: `RECEIVE_INVOICE_EXPIRY_SECONDS`, `INVOICE_NOTE_MAX_LENGTH`,
`REQUEST_INVOICE_DESCRIPTION` (`lib/wallets/fiber-browser/constants.ts`).

**History** (`activity.ts`): a new kind `request`, the Fiber invoice of a Get paid request (hash, asset, amount, status
from `get_invoice`, `request: {note, expiresAt}`; no invoice text, no preimage). It is read again until Paid, Expired or
Cancelled, also after a reload (`isPollable`), but does **not** hold the node (`holdsNode`): it stays open an hour and is
often paid on Lightning instead, so Lock and leaving the page are not held up for it. The popup lists it as "Request for
1,000 CKB" (then "Received 1,000 CKB"), with a receive icon, the invoice badges (Waiting, Arriving, Received, Expired,
Cancelled) in the request tones (`activityTone`), and Note and Valid until in its details; All shows it. The request's
Lightning invoice is a swap and shows as the swap's payout leg ("Swap: payout of …"), as before.

**Lifetime: request quotes (done in the hub, used since 2026-11-06).** A merchant waits minutes, so the Lightning
invoice asks a request quote: `CreateQuoteBody.purpose: "request"` (left out for a swap quote; ln_to_fiber only, 422
`purpose_unsupported` otherwise), and `QuoteDto.purpose` says which it is. The hub keeps such a quote, and the unpaid
hold invoice with it, `REQUEST_QUOTE_TTL_SECONDS` (900 s by default) instead of `QUOTE_TTL_SECONDS` (180 s, still what
Swap and Pay get), adds `REQUEST_PREMIUM_BPS` (0 by default) to its fee, and counts its swaps toward
`REQUEST_MAX_OPEN_PER_CLIENT` (3 by default) instead of `SWAP_MAX_UNPAID_PER_CLIENT` while they wait for a payment. The
page needed nothing more: its countdown reads the quote's `expiresAt` ("Expires in 899s"), and "New invoice" follows an
expiry as before. Each unpaid request swap still reserves up to `SWAP_MAX_SATS` of the hub's liquidity for up to 15
minutes, which is why the page cancels the ones it no longer needs (below). Nothing changes on Lightning's side of the
lock: the hold invoice's CLTV is separate from its expiry, and the node's payout invoice already outlives the quote by an
hour (`INVOICE_EXTRA_SECONDS`).

**Tests** (as built on 2026-10-30; the changes of 2026-11-06 are listed in their own section below): unit
`tests/unit/get-paid.spec.ts` (the form's checks and the limits on the Lightning invoice; the Lightning
invoice from the swap card's run model: making, waiting, the countdown and expiry, arriving, paid, returned, cancelled,
failed, when "New invoice" shows; the Fiber invoice's states and the receipt's payments; the page's check of the made
invoice; the bridge's two methods: listed fields only, refusals, the answers' checks, a round trip with nothing secret,
an idle tab answering none; the node's handlers: the `new_invoice` arguments, the preimage wiped, History without the
invoice text, the refusals, the status only for request entries; History's `request` kind: pollable without holding
the node, labels, tones, titles, kept and read back, malformed entries dropped). E2E `tests/e2e/get-paid.spec.ts` (the
node runs in the node page next to /app, since nothing needs the popup's Confirm, so every browser runs it all): the
conversion and the quote's body; Create makes both invoices (the node's two `new_invoice` calls, nothing sent), both
tabs' QR codes, Copy, "Open in wallet", the countdown; paid on Lightning through the fake hub, the receipt, History in
the node and in the app; paid on Fiber (the node's invoice settled, `settleNodeInvoice`), then also on Lightning: "Paid
twice"; the Lightning invoice expiring with a short quote and "New invoice" making a second swap while the Fiber invoice
stays; refusals (no node, out of the limits both ways, zero, RUSD quoted in RUSD, a node that cannot receive the
amount); axe and 390 px for the form, the tabs and the receipt. `tests/e2e/hub-live.spec.ts` and `web-polish.spec.ts`
now find the Get paid card with a live hub.

### C: a request is paid once (2026-10-30)

Both invoices of a request stayed payable, so two payers could pay it twice. Now the **node** pairs them, so it also
works while the node runs with the app page closed (its window, `/app/fiber`):

- **The pairing.** Create draws the request's id (a UUID, `OpenRequest.id`). The Fiber invoice carries it
  (`make-receive-invoice`'s `request`) and so does the Lightning invoice's payout invoice (`make-invoice`'s `request`,
  through `SwapPlan.request` and the Fiber wallet's `makeInvoice`); both are rebuilt and checked on the bridge (a UUID,
  in lower case, or left out for a swap; anything else is refused). The node keeps it in History: `request.id` on the
  Fiber invoice's entry, `swap.request` on the payout leg. No invoice, no secret.
- **The rule** (`invoicesToCancel` in `lib/wallets/fiber-browser/history.ts`, run by `use-activity.ts` every 5 s while
  the node runs and right when it applies): once one of a request's invoices is paid (its Fiber invoice reads Paid; or
  its Lightning invoice: the payout invoice reads Paid, or the kept swap reached `outgoing_succeeded` or `succeeded`),
  the node cancels the request's other invoices still Open with fnn's `cancel_invoice` (new in the node port, the
  fiber-js adapter and the fake fnn). The entry then reads Cancelled.
- **Paid on Lightning first:** the Fiber invoice is cancelled; a Fiber payer's payment is refused. The request's History
  entry reads Cancelled, the receipt shows the Lightning payment.
- **Paid on Fiber first:** since 2026-11-06 the page cancels the request's Lightning invoice at the hub (`POST
  /v1/swaps/:id/cancel` with the swap's cancel token, which cancels the hold invoice; see the section below), so a
  Lightning payer is refused at once. The node's own pairing stays as the fallback, for a cancel that failed or a page
  that was closed: it cancels the payout invoice of the request's Lightning invoice (and of any earlier one "New
  invoice" replaced), and a Lightning payer who still pays the hub's hold invoice gets their sats back: the hub's payout
  to a cancelled invoice fails, and the hub then cancels the hold (`swap-processor.ts`, `refundFailedPayout`); the
  request's Lightning part reads Returned. On the page the receipt replaces both QR codes as soon as the Fiber invoice
  is paid ("Paid", paid with Fiber), so the Lightning invoice is not shown as payable any more. A request paid on Fiber
  before its Lightning tab opened never had a swap at all.
- **The gap that stays:** two payers at the same moment can still both pay, since fnn refuses to cancel an invoice once
  a payment for it arrived, and the hub refuses to cancel a swap once a payment is held (409). The receipt then reads
  "Paid twice" and lists both, as before. (The other half of the old gap, the hub's hold invoice staying payable until
  the quote expired, is closed by the cancel route since 2026-11-06.)
- **Tests**: unit (`node-history.spec.ts`: the rule both ways, only open invoices, only the same request, not for
  entries kept before ids, never the paid payout; `get-paid.spec.ts`: the id on both bridge methods, refused when
  malformed, kept in History and read back; `fiber-browser.spec.ts`: the adapter's `cancel_invoice`). E2E
  (`get-paid.spec.ts`): paid on Lightning, the node cancels the Fiber invoice and the entry reads Cancelled; paid on
  Fiber, the node cancels the payout invoice and a late Lightning payer is refunded, one payment on the receipt; a
  payout already arriving cannot be cancelled, "Paid twice"; with the app page closed, the node still cancels the Fiber
  invoice once the payout invoice is paid.

### C: on demand, cancelled when not needed (2026-11-06)

The hub (deployed on the testnet server) gained request quotes and a cancel route; Get paid uses both, and makes its
Lightning invoice only when it is wanted, so a request paid on Fiber leaves nothing at the hub.

- **The Lightning invoice on demand.** "Create request" makes only the Fiber invoice (the node's, as before). The
  Lightning invoice (request quote, the node's payout invoice, the swap and its hold invoice) is made when the visitor
  first opens the Lightning tab (`RequestView`'s tab change calls `renew` while the part is `idle`); going back and
  forth makes nothing more, and "New invoice" makes the next one. Opening the tab, not a separate button, was chosen:
  it is the visitor's choice of the Lightning invoice already, it costs no extra click or words, and the hub limits
  what it can cost (one swap per request at a time, cancelled when not needed, `REQUEST_MAX_OPEN_PER_CLIENT`).
- **Fiber first.** The request opens on the Fiber tab, now the first tab: its invoice exists as soon as the request
  does (no waiting for the hub), it pays the node directly with no swap, no hub fee and no hub liquidity, and opening
  on Lightning would make the Lightning invoice at once and undo the point of making it on demand. The Lightning tab
  reads "Not made yet" (grey) until then.
- **Nobody thinks they receive BTC.** The Lightning panel's line is "They pay BTC on Lightning. You receive CKB." (the
  request's asset, 8 words), shown while the invoice is made and as the label over its QR code; the detail (the hub
  swaps the sats, you never hold BTC, made when the tab opens, payable 15 minutes by default, cancelled when the request
  no longer needs it, the testnet caveat) is behind its "?". The form's conversion reads "≈ $2.00 · 2,526 sats on
  Lightning", and its "?" says the Lightning invoice is made only when its tab opens.
- **Request quotes.** The form's conversion quote and the Lightning invoice's quote both send `purpose: "request"`; the
  swap card and Pay keep plain quotes.
- **The cancel token stays in memory.** `POST /v1/swaps` answers `cancelToken` once (`CreatedSwapDto`).
  `useHubSwap` takes it off the swap before anything keeps the swap (state, History's record, the run), and hands it
  only to a receiver (`onCancelToken`, through `useSwapRunner`); the swap card and Pay give none, so theirs is dropped.
  `useLightningInvoice` keeps Get paid's tokens in a ref (`Map` by swap id), never in React state, localStorage,
  sessionStorage, History or a bridge message, and never logs them; a reload forgets them (the hub then ends the swap
  when its quote expires).
- **When the page cancels** (`POST /v1/swaps/:id/cancel`, header `x-ckbolt-cancel-token`, body `{}`): the request was
  paid on Fiber (`release`), "New request" (`reset`), or "New invoice" in place of an unpaid one (`renew`), each only
  while the hub last said nobody paid the swap (`shouldCancelSwap`: state `pending`); a held or paid swap goes on (the
  receipt can read "Paid twice"). A swap the hub creates after the request ended (an answer that comes back after "New
  request", or after the Fiber payment) is cancelled as soon as its token arrives. The hub's answer is kept in the
  swap's History record, so the node's History reads Cancelled at once and its payout invoice holds the node no more.
  A cancel that fails (403, 409, 503, no answer) is only logged in the console, by swap id ("[ckbolt get paid] The hub
  did not cancel swap …"); the node's pairing (it cancels the payout invoice once the request is paid) stays.
- **The proxy** allows `POST /v1/swaps/:id/cancel` (POST only, a UUID id; `lib/hub/routes.ts`) and passes the cancel
  token header on for that route alone (`HubRoute.forwardedHeaders`, `forwardedHeaders` in `lib/hub/proxy.ts`), only
  as 1 to 128 visible ASCII characters (`FORWARDED_HEADER_VALUE_PATTERN`); anything else is dropped and the hub answers
  403 `cancel_refused`. The request guard applies as to every write: same origin, JSON body.
- **The contract copy** (`lib/hub/contract.ts`) follows the hub again: `QuotePurpose`, `QUOTE_PURPOSE`,
  `CreateQuoteBody.purpose`, `QuoteDto.purpose`, `CreatedSwapDto`, `API_ROUTES.SWAP_CANCEL`, the error codes
  `purpose_unsupported` and `cancel_refused`, the event `cancelled_on_request`, and `SWAP_CANCEL_TOKEN_HEADER`.
- **Tests**: unit `tests/unit/hub.spec.ts` (the contract against the hub, its request schema with `purpose`, the cancel
  header's name; the route in the allow-list, POST only, its header forwarded there alone and only when well formed,
  the guard on it; the client's `cancelSwap` and `createSwap`'s token), `tests/unit/get-paid.spec.ts` (`idle`, the
  copy's word budget, `shouldCancelSwap`), `tests/unit/live-swap.spec.ts` (the token never in the run and dropped without
  a receiver, handed over with whether the run follows that swap; the real `useLightningInvoice`: nothing asked before
  its tab opens, a request quote, cancelled with its own token on release, New invoice and New request, never once held,
  a failed cancel only logged, a late swap cancelled on arrival). E2E `tests/e2e/get-paid.spec.ts` (Create makes the
  Fiber invoice only and opens on it, no quote or swap until the Lightning tab opens, then a request quote with a
  15-minute countdown; paid on Fiber with no Lightning invoice: no swap at all; paid on Fiber with one open: the cancel
  with its token, the swap Cancelled in the node's History, the token in no storage and no bridge message of either
  page; a failed cancel logged, the node's pairing refunding a late payer; New invoice and New request cancelling;
  "Paid twice" with the hub refusing the cancel), the fake hub (`tests/e2e/fakes/hub.ts`: `purpose`, `cancelToken`, the
  cancel route and its header), `tests/e2e/node-history.spec.ts` (New request cancels at the hub, then Lock is free).

### More tokens: cWBTC (2026-11-06)

Pay and Get paid take their tokens from `GET /v1/assets` as the swap card does, so cWBTC shows once the hub serves it
([context.md](context.md), "More tokens, driven by the hub"):

- **Pay a Lightning invoice** with the token picker on cWBTC: an invoice for 24,750 sats costs "0.00025 cWBTC" at the
  fake's 1 % fee, "Pay 0.00025 cWBTC", and the node pays the hub's cWBTC hold invoice. Pay's "?" says the node pays
  "in CKB or a token the hub serves".
- **A Fiber invoice in cWBTC** is read and paid as any token the hub lists (the node checks it against the hub's list);
  its amount shows with the hub's decimals, and in base units for a token the page's `GET /v1/assets` did not list.
- **Get paid in cWBTC**: the asset picker lists what the hub serves `ln_to_fiber`; 0.0001 cWBTC reads "≈ $8.00 · 10,102
  sats on Lightning", both invoices are for cWBTC's script, and the Lightning panel says "They pay BTC on Lightning.
  You receive cWBTC."
- **Tests**: `tests/e2e/multi-asset.spec.ts`.

## D. One wallet on /app

- Removed: the CKB and Bitcoin wallet panels (`WalletBar`), `BtcWalletProvider`, `CkbWalletProvider`, quote signing,
  NWC and "Connect Lightning" on the card (with `FakeNwc` and their tests where nothing else needs them).
- CCC stays where it is still used: `/app/fiber/fund` (JoyID funding) and the withdraw destination picker.
- Without a live hub, Pay, Get paid and Swap show the hub-unavailable state instead of the simulation.

## E. History in the Fiber node

- The app's History tab goes. The popup's Activity page becomes **History**: everything that moved money through the
  node: swaps, Pay payments, Get paid requests and receipts, channels, withdrawals. Filters: All, Payments, Swaps,
  Channels, Funds.
- A swap or payment opens a compact detail in the popup: status, amounts, hash, fees, refund, Report a problem.
- After a swap, payment or request ends in the app, "View in History" opens the popup on that entry (relay
  `open-entry`, page to iframe).
- The app page and the `/app/wallet` iframe share localStorage (same origin, checked in an e2e); the swap records the
  card makes are written where the node's History reads them.

### E as built (2026-10-30)

**One store, checked first.** In real Chrome (`PW_CHANNEL=chrome`) the app page and the popup's iframe, isolated by
Document-Isolation-Policy `isolate-and-credentialless`, share localStorage: a value written by either reads back in
the other, and a write reaches the other document as a `storage` event (`tests/e2e/node-history.spec.ts`). So nothing
goes through the relay but a reference: History reads both stores directly.

**The model** (`lib/wallets/fiber-browser/history.ts`, hook `components/app/fiber-node/use-activity.ts`):

- The node's own entries stay as they were (`activity.ts`, per network and node id): its leg of each swap, Pay's Fiber
  payments and on-chain sends, Get paid's Fiber invoices, channels, withdrawals.
- The swaps the app starts are kept by `useSwapRunner`, the machinery the swap card, Pay's Lightning invoices and Get
  paid's Lightning invoices share, as soon as the hub created the swap and on every change it reads
  (`lib/swap/history.ts`, `keepSwapRecord`): `ckbolt:swap-history:<hub network>` (the app History's key, so older
  swaps stay), the newest 100, with the swap's id, direction, asset and symbol, both legs' amounts, payment hash,
  creation time, state, `refunded` and `funded`. The app page and the node both write it, so each write reads what is
  stored, merges and writes back in one task, and the merge never moves a swap back (`mergeSwapRecord`). The node
  re-reads it on the `storage` event.
- `mergeHistory` makes one list, newest first: a swap is one entry, its node leg and its record matched by the payment
  hash (bare or 0x, any case) or by the swap id the leg learned; a record without a leg (a swap through the visitor's
  own node) and a leg without a record each stand alone. A kept swap reads by both sides ("Swap: 2,526 sats →
  1,000 CKB") and how it stands at the hub: In progress, Completed, Refunding, Refunded, Cancelling, Cancelled, in the
  run's tones (`historyTone` in `lib/status-tone.ts`); everything else reads as before.
- The node (the document that runs it) reads the kept swaps not final yet from the hub every 10 s
  (`SWAP_HISTORY.refreshMs`; a failed swap that never showed a held payment also reads its events; one the hub answers
  404 for is left be), and writes what it read back to the store.
- Nothing secret in either store or on the relay: no invoice, no preimage, no key.

**The popup's History page** (`components/app/fiber-wallet/history-page.tsx`; page id `history`, which replaces
`activity` in `WALLET_PAGES`, the relay and the tests): "Kept in this browser." with a "?" (`HISTORY_TIP`), the
keep-open notice, then the list by day with the filters All, Payments (Pay's Fiber payments, Get paid's requests and
receipts), Swaps, Channels, Funds (withdrawals and on-chain sends). Home's last five entries and the node page's panel
05 (now titled History) show the same merged list.

**The detail** (`history-list.tsx`): one entry open at a time, under its row, in compact rows (label and value side by
side, `Row`'s `compact`); the five filters fill one row (`ChoiceGroup`'s `fill`), so they fit the 380 px popup. A swap: You pay and You receive, the
refund or cancel line, the node's routing fee when it paid the hold invoice, the hub's reason for a failed swap, the
swap id, the payment hash with Copy, and Report a problem with the swap id. While it is open and the swap is not final
the iframe reads it from the hub every 2 s through the same-origin proxy (`use-swap-read.ts`, `useHubClient`); it reads
it once when final, for the reason, and keeps each read in the store. A Pay payment: the amount, "0.001 CKB (max
0.025 CKB)" once paid (the max fee before), the payee, the hash with Copy, the node's error, Report a problem. Requests,
channels and withdrawals keep their details.

**View in History** (`components/app/fiber-wallet/host/view-in-history.tsx`): on the swap card's result (it hides the
progress dialog; the banner brings it back), on Pay's result (a Lightning invoice's swap once settled, a Fiber payment
once paid or failed, an on-chain send; beside New payment) and on Get paid's receipt (beside New request; under each
payment when it was paid twice). It calls the host's new
`showEntry(ref)`: the popover shows and the page sends the relay's new page → iframe message `open-entry` (`{id,
hash}`: a swap id and a 0x hash, a payment's or a transaction's, rebuilt from those two fields and validated like
`navigate`; queued until the iframe's first status). The shell goes to History and the list opens the entry
(`findHistoryItem`: by swap id, else by hash), shows All, and brings it into view, or says "This node has no record of
it.". The button shows only while the header's popup runs the node (`popupRunsNode`): a node in its own window or on
`/app/fiber` cannot be steered from the page. The iframe → page `open-swap` message and the entries' "View in the
app's History" links are gone.

**The fix: a failed swap's payout invoice no longer holds the node.** An ln_to_fiber swap whose hub swap failed or was
cancelled (an abandoned run, Get paid's "New invoice" or "New request") left the node's payout invoice Waiting until
it expired an hour later, which kept Lock waiting and made leaving the page ask. Now a payout leg still open whose
swap record says failed (cancelled unpaid, refunding or refunded) is done (`releasedBySwap`, `itemHoldsNode`,
`pollableEntries`): it holds nothing and is not read again; fnn keeps the invoice, and no payer comes. The page's run
writes the failure while it follows the swap; after "New request" it no longer follows it, but since 2026-11-06 it
cancels an unpaid one at the hub and keeps the hub's answer in the record, and otherwise the node learns it from the hub
within 10 s. A payout already arriving (Received) and the node's own payments still end by their own status.

**Tests**: unit `tests/unit/node-history.spec.ts` (one entry per swap by hash or id, records and legs alone, newest
first, words and tones, the five filters, finding an entry by id or hash, the leg-final rule and what it leaves alone),
`tests/unit/swap-core.spec.ts` (the swap records: final states, the two writers' merge, newest first and the cap,
nothing secret or malformed read back, read-merge-write, a read from the hub with its events), `tests/unit/
fiber-wallet-popup.spec.ts` (`open-entry`: built and parsed, listed fields only, no invoice rides along, malformed
refused, `open-swap` gone; `activity` is no page any more). E2E, Chrome: `tests/e2e/node-history.spec.ts` (the page and
the iframe share localStorage and its events; Pay's Fiber payment opened from its result with its fee and max and the
filters; a Get paid request left behind with "New request": its Lightning invoice's swap holds the node until the page
cancels it at the hub (2026-11-06; before, until the hub cancelled it), then Lock is free, the swap Cancelled and nothing cancelled in fnn; a request paid on Fiber: its receipt
opens it in History and the node cancels its Lightning leg's payout invoice; History and an open swap at the
popover's size and on a phone with axe), `tests/e2e/fiber-wallet-popup.spec.ts` (a swap as one merged entry with its
detail; View in History on the swap card's result, the node still running; History's channels, withdrawal and filters),
`tests/e2e/pay.spec.ts` and `tests/e2e/get-paid.spec.ts` (the swap in the node's History as one Completed entry; no
View in History while the node runs in another tab), `tests/e2e/live-swap.spec.ts` (the card's swap kept with nothing
a wallet holds; no History tab, an old `?tab=history` link opens the page as usual), `tests/e2e/hub-live.spec.ts` (three
tabs).

## F. From the Fiber dev log (2026-10-29), without upgrading

fiber-js and fnn stay at 0.9.1 (0.10.0-rc1 cannot upgrade existing data; the features are on `develop`). Applied now:
the payment-recovery pattern and the actual-fee display (B), the client-side invoice-network check. The rest is in
[fiber-wallet-popup.md](fiber-wallet-popup.md#upgrade-notes).

## Hub calls

`POST /v1/quotes` (`side: "pay"` or `"receive"`; Get paid adds `purpose: "request"`), `POST /v1/swaps`, `GET
/v1/swaps/:id`, `GET /v1/swaps/:id/events`, `POST /v1/swaps/:id/cancel` (Get paid, with the swap's cancel token; added
2026-11-06), `GET /v1/fiber/node`, `GET /v1/assets`, `GET /v1/health`: all in the proxy's allowlist.

## Test ids

Pay: `pay-input`, `pay-scan`, `pay-preview`, `pay-confirm`, `pay-result`, `pay-error`; as built also `pay-card`,
`pay-kind`, `pay-token`, `pay-amount-due`, `pay-amount`, `pay-needs-node`, `pay-open-node`, `pay-waiting`,
`pay-show-node`, `pay-new`, `pay-explorer`, `pay-route` (`data-route`, 2026-11-04). The node's Confirm: `fiber-wallet-page-confirm`, `fiber-wallet-confirm`,
`fiber-wallet-confirm-request` (`data-kind`), `fiber-wallet-confirm-password`, `fiber-wallet-confirm-accept`,
`fiber-wallet-confirm-decline`, `fiber-wallet-confirm-error`, `fiber-wallet-confirm-outcome` (`data-status`),
`fiber-wallet-confirm-empty`, `fiber-wallet-confirm-waiting`, `fiber-wallet-confirm-route` (`data-route`), `fiber-wallet-open-confirm`, and `fiber-node-confirm` on
`/app/fiber`. Get paid: `request-form`,
`request-amount`, `request-asset`, `request-create`, `request-tabs`, `request-lightning`, `request-fiber`,
`request-countdown`, `request-paid`, `request-new`; as built also `request-card`, `request-amount-box`,
`request-conversion`, `request-note`, `request-error`, `request-needs-node`, `request-open-node`, `request-view`,
`request-summary`, `request-tab-lightning`, `request-tab-fiber` (`data-status`, `idle` for a Lightning invoice not made
yet), `request-lightning-line` (2026-11-06), `request-lightning-invoice`,
`request-lightning-qr`, `request-lightning-text`, `request-lightning-copy`, `request-lightning-open`,
`request-lightning-error`, `request-fiber-invoice`, `request-fiber-qr`, `request-fiber-text`, `request-fiber-copy`,
`request-fiber-error`, `request-payment` (`data-network`), `request-reset`; History entries of the new kind have
`data-kind="request"`. Gone: `mode-not-yet`. Swap card: `swap-ln-invoice` (pasted invoice), `swap-hold-qr`,
`swap-hold-copy`, `swap-hold-open`, `swap-webln`. History in the popup: `fiber-wallet-history`, `history-entry`,
`history-entry-detail`, `history-entry-view`; as built also `fiber-wallet-page-history`, `fiber-wallet-open-history`,
`fiber-wallet-history-list`, `fiber-wallet-history-empty`, `fiber-wallet-history-<page>`, `history-entry-report`,
`history-entry-missing`, and `data-key` on `history-entry`. Gone: `mode-history`, `swap-history*`,
`fiber-wallet-activity*`, `fiber-wallet-page-activity`, `fiber-wallet-open-activity`, `history-entry-details`,
`history-entry-swap-link`.

## Removed

Parts D and A (2026-10-30):

- **The simulation on `/app`** (D): the simulated Get paid flow and merchant checkout (`components/app/receive-flow.tsx`),
  the simulated Pay flow and swap form with the ETH route (`components/app/pay-flow.tsx`), their route and status panels
  (`components/app/route-panel.tsx`), the reference-price note (`PriceSourceNote`, `isPriceStale` in
  `components/app/ui.tsx`), quote signing (CCC `signMessage` and the Bitcoin key in `pay-flow.tsx`), the demo invoice
  (`lib/demo.ts`), the ETH address check (`lib/eth-address.ts`), and the quote maths only they used (`quoteInvoice`,
  `quoteFromBtc`, `quoteFiberInvoice` in `lib/quote.ts`; `fmtAmount`, `fmtSats` in `lib/format.ts`; `tokenExplorerUrl` and
  the ETH entry of `RECEIVE_TOKENS` in `lib/tokens.ts`; `isHex32`, `hexToBytes` in `lib/payment-request.ts`;
  `LightningMark` in `components/app/ui.tsx`). The landing page keeps `quoteSwap`, `satsForUsd` and its reference prices.
- **The L1 wallets on `/app`** (D): the CKB and Bitcoin wallet panels (`components/app/wallet-bar.tsx`),
  `BtcWalletProvider` (`components/app/btc-wallet.tsx`), the Bitcoin balance API it read (`app/api/btc-balance/`, with
  `lib/btc-address.ts`), and the CCC provider, `CkbWalletProvider` and `RateProvider` around the tabs
  (`components/app/app-modes.tsx`). `CkbWalletProvider` (`components/app/ckb-wallet.tsx`) stays for the funding page
  (`/app/fiber/fund`), trimmed to what that page reads; CCC also stays for the withdraw destination picker.
- **The tabs' simulation labels** (D): the `Simulated` tag and the per-tab descriptions; without a live hub Get paid, Pay
  and Swap show one line (`components/app/hub-unavailable.tsx`, which replaces `hub-degraded-note.tsx`); with one, Get
  paid and Pay show "Not available yet. Swap works today." until parts B and C.
- **NWC and "Connect Lightning"** (A): the Lightning chip and dialog (`components/app/swap/wallets/lightning-dialog.tsx`,
  `nwc-connect-form.tsx`, the Lightning parts of `wallet-button.tsx`, `chip-view.ts` and `copy.ts`), the page's Lightning
  wallet hook (`hooks/use-lightning-wallet.ts`), the NWC client, URI check, wallet and test hook
  (`lib/wallets/lightning/nwc-client.ts`, `nwc-uri.ts`, `nwc-wallet.ts`, `nwc-test-hook.ts`), the wallet store and types
  (`store.ts`, `types.ts`; a smaller `pay-store.ts` keeps the browser wallet's pay attempts), the wallet's network check
  (`checkWalletNetwork`), the payout invoice a wallet made (`lib/swap/lightning-invoice.ts`, `checkWalletPayoutInvoice`),
  WebLN's `makeInvoice`, `getInfo` and `sendPaymentAsync`, the `@getalby/sdk` dependency, and the tests' `FakeNwc` and
  `FakeRelayWallet` (`tests/e2e/fakes/lightning-wallet.ts`) with every test of them.
- **The Lightning channel section of the wallet dialog** (A, F3.1): moved to the guide's hub card
  (`components/app/guide/hub-channel.tsx`), where the visitor pastes their node id.
- **The run's step help button** (A): a failed step no longer opens a dialog; a browser wallet with no route to the hub
  shows the channel link (the guide's hub card) beside its button instead.

Part B (2026-10-30): nothing removed. Pay's "Not available yet" line goes (Get paid keeps it until part C); the
progress dialog's body moved to the shared `components/app/swap/run-view.tsx`.

Part C (2026-10-30): the "Not available yet" line (`NotYet` and `HUB_UNAVAILABLE_COPY.NOT_YET` in
`components/app/hub-unavailable.tsx`, test id `mode-not-yet`), since Get paid was the last tab to show it.

Part E (2026-10-30):

- **The app's History tab**: the tab and its deep links (`/app?tab=history&swap=<id>`, `&hash=`, `mode=history`) in
  `components/app/app-modes.tsx`; the list and its read-only swap dialog (`components/app/swap-history/swap-history.tsx`,
  `swap-detail-dialog.tsx`); its provider (`hooks/use-swap-history.tsx`) and the keeping in the swap card, Pay and Get
  paid (now in `useSwapRunner`); its copy (`SWAP_HISTORY_COPY` in `lib/swap/copy.ts`); from `lib/swap/history.ts` its
  statuses, tones and filters (`swapHistoryStatus`, `swapHistoryTone`, `SWAP_HISTORY_LABEL`, `SWAP_HISTORY_FILTERS`,
  `inSwapHistoryFilter`), the deep link (`HISTORY_LINK`, `readHistoryLink`, `historyHref`), `findSwapRecord` and
  `recordedRunInput`; and their tests (the History block of `tests/e2e/live-swap.spec.ts`, the app History's unit
  tests in `tests/unit/swap-core.spec.ts`, the popup's two tests that went from the node's activity to it).
- **The popup's way to it**: the iframe → page relay message `open-swap` (`WALLET_RELAY.KIND.OPEN_SWAP`, `SwapRef`,
  `pickSwapRef`, `openSwapMessage`), the host's `router.push` to the app's History, and the entries' "View in the app's
  History" links (`HISTORY_COPY.OPEN_SWAP`, `OpenSwap`, `history-entry-swap-link`).
- **The Activity page's name and filters**: `activity-page.tsx` became `history-page.tsx`, the page id `activity`
  became `history`; `ACTIVITY_FILTERS`, `inActivityFilter` and `ActivityFilter` in `activity.ts` gave way to History's
  filters.
