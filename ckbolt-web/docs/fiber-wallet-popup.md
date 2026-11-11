# Fiber node popup

Status: **planned and built 2026-10-27**, then **rescoped the same day into the "Fiber node"**: the popup is the node, infrastructure the app uses, not a wallet. Read
[Fiber node (current)](#fiber-node-current) first; the plan and the first build below are kept as history, and where
they disagree the current section wins.

## Fiber node (current)

### The principle

Decision (2026-10-27, also in [context.md](context.md)): **the CKBolt app (`/app`) is where people do things
with money** (Swap, and early versions of stage 4's Pay and Get paid). **The header popup is the node**: infrastructure the app uses. It
never duplicates the app's functions. So the popup keeps the node's status and balances, what a swap can move, adding
funds, channels (the hub first, other nodes under Advanced), withdrawing and closing, settings, and the node's History
(everything that moved money through it, since 2026-10-30 also the swaps the app started); paying and getting paid are
gone from it and from `/app/fiber`.

### Naming

Every piece of text the visitor reads says **"Fiber node"**: the header button ("Fiber node", its accessible name
"Fiber node: …"), the popover's title and Close ("Close the Fiber node"), the window's title, the swap card's Fiber
dialog ("Fiber node", "Which Fiber node", "Connect Fiber node"), the run's step labels ("Invoice from your Fiber node",
"Pay from your Fiber node"), the guide's steps (open Fiber node, Settings, Add funds, the node's Channels) and How it
works. To limit churn, **code identifiers, test ids and the route stay**: `components/app/fiber-wallet/`,
`FiberWalletHost`, `useWalletHost`, `WALLET_*` constants, the `fiber-wallet-*` test ids, the
`ckbolt:fiber-wallet` relay source and `/app/wallet`.

### Layout

No bottom bar. The pages stay mounted (`hidden` when not shown), so what was typed survives going back.

- **Home, node running** (`home-page.tsx`):
  - **Ready to swap**: per token, what a swap can send and receive now, over the node's channels with the hub
    (`swapLiquidity`, the same numbers the bridge reports to the swap card; the header button shows the CKB a swap can
    send). "No channel with the hub yet." under it while both are zero.
  - On-chain CKB, and the hub's badge (Connected, Connecting…, Not connected with Connect, Unavailable).
  - A 2 × 2 grid of large icon buttons: **Add funds**, **Channels**, **Withdraw**, **Settings**.
  - **History**: the last 5 entries, and **View all** (the History page).
- **Home, locked or not set up**: the key forms (create, unlock), and a **Settings** button (restore or forget a key
  works while the node is locked).
- **Sub-pages**: a top bar with **Back** (arrow and "Back") and the page's title. Opening a page moves focus to its
  title; Back returns to Home and to the button that opened it (or, for a page the header opened, Home's button for
  it). Escape still closes the popover. Passwords typed anywhere in the popup clear on every page change, when the
  popover hides and when the browser tab is hidden. Add funds, Channels and Withdraw need the running node and say
  "Opens once your node runs." until it runs.
  - **Add funds**: the node's address with QR and Copy, "Fund from a wallet" (the funding page in a new tab), the
    faucet, "Get test cWBTC" while the hub serves cWBTC (2026-11-06), Refresh balance.
  - **Channels** (`channels-page.tsx`): first the hub, one card with a row per asset the hub funds (CKB, RUSD, cWBTC),
    ticked and opened in one press, with "Your node puts in" and Max for the CKB row (see [Channel with the hub: one
    card](#channel-with-the-hub-one-card) and "The hub's CKB channel: accepted by the node" below); then every channel
    as a card with Close (to this node or to my wallet); last, collapsed under **Advanced**, a channel with another node.
  - **Withdraw**: the node page's form, open at once, under one line: "Closing a channel returns its funds to the
    node." with a link to Channels.
  - **Settings** (`settings-page.tsx`): the node (its id with Copy, Lock, which waits while a swap needs the node), the
    key (backup, restore while locked, forget), the full page and the guide in new tabs, the limits behind a "?".
  - **History** (`history-page.tsx`, 2026-10-30, [pay-get-paid.md](pay-get-paid.md) part E; it was Activity): "Kept in
    this browser." with a "?", then everything that moved money through the node by day, newest first, with a filter
    (All, Payments, Swaps, Channels, Funds); each entry opens to its detail
    ([History](#history-sources-detail-and-limits)). Empty: "No swaps, payments or channels yet." with Channels and Add
    funds.
- **Navigation from outside**: the page opens the popup on a page with the relay's `navigate` message
  (`host.show(page)`), or on one entry of History with `open-entry` (`host.showEntry(ref)`, below); a message sent
  before the iframe listens waits for its first status (in order). The pages are `WALLET_PAGES` in
  `lib/wallets/fiber-popup/constants.ts`: `home`, `add-funds`, `channels`, `withdraw`, `settings`, `history`, `confirm`.
  In a window of its own (browsers without DIP) the popup cannot be steered; the popover offers the window.
- **Confirm** (`components/app/fiber-node/confirm-request.tsx`, 2026-10-30, [pay-get-paid.md](pay-get-paid.md) part B):
  where the visitor confirms what Pay on `/app` asked the node for, a Fiber payment (amount, payee, max fee, note,
  expiry) or CKB on chain (amount, address, network fee, and the node password, typed here and never sent over the
  bridge), with Confirm and Decline. It has no Home button: it opens by itself when a request comes (in the popover and
  in the node's window), Pay opens the popover on it with `navigate`, and Home shows "The app waits for you to confirm a
  payment." with Review while one waits; `/app/fiber` shows the same as a section at its top. Unanswered for two
  minutes, the request is declined.

### Moving the popup

2026-11-06 (from feedback: "drag it to the middle or anywhere"). From `sm` up, where the popup is the 380 × 600 panel anchored
top right, the visitor can move it anywhere in the window; on a phone it stays the full-height sheet. The hook is
`components/app/fiber-wallet/host/use-popup-drag.ts`, the pure part `lib/wallets/fiber-popup/popup-position.ts`.

- **The handle is the title bar** (`fiber-wallet-handle`): the title, the state badge and the Testnet tag. It is the
  host's, outside the iframe, so nothing crosses the relay. Cursor `grab` (`grabbing` while pressed), no text
  selection, `touch-action: none`. A faint grip (`GripVertical`) sits in the bar's left padding, so it takes no width
  from the badges, and darkens while the bar is hovered: it is the **Move** button (`fiber-wallet-move`, named "Move the
  Fiber node popup"; its title, the tooltip and its description: "Drag it, or use the arrow keys. Double-click or press
  Home to put it back."). A press on Close, or any other control in the bar, never starts a drag; the badges are not
  controls and drag with the bar.
- **Dragging**: pointer events with pointer capture on the bar. The popup's place and size and the viewport are read
  once on the press; each move then only computes a clamped point, and `transform: translate3d()` is written once per
  animation frame, so a drag reads no layout. A press that moves less than 3 px is a click and changes nothing. While a
  press is under way the iframe has `pointer-events: none`, which it would otherwise use to swallow the moves. A press
  on the bar keeps focus where it was (a field inside the node keeps it: `preventDefault` on pointerdown); a press on
  Move focuses Move. Nothing animates: the popup follows the pointer and jumps back on a reset, so reduced motion needs
  nothing more.
- **Inside the viewport**: the popup stays wholly inside it, 8 px from its edges (`MARGIN_PX`; the viewport without
  scroll bars), on whole pixels: while dragging, on each arrow key, whenever it shows, and when the window resizes (once
  per frame). The place the visitor chose is kept as chosen and only what shows is clamped, so a window made smaller and
  then larger again gets it back where it was left. Narrowed below `sm` it is the sheet again; widened, it goes back to
  its place.
- **Kept**: its top-left (`{"x":…,"y":…}`) in localStorage under `ckbolt:fiber-wallet:position`, a per-viewer
  convenience: read once when the page runs, clamped when shown, every read and write in try/catch, so a blocked or
  full store only means it opens anchored. It stays where it was left while open, across Close and reopen, client-side
  navigation and reloads; a value the page did not write is ignored. Nothing else reads it: the iframe, the relay,
  `navigate`, View in History and Confirm opening by itself are unchanged.
- **Back to its anchored place**: a double click on the title bar (Move included), or Home on Move; the place is
  forgotten. There is no visible "Reset position": the bar has no room for it beside the badges, and Move's tooltip
  says how.
- **Keyboard**: Move comes before Close in the tab order (Close still takes focus when the popup opens). The arrow keys
  move it 10 px, with Shift 50 px (`STEP_PX`, `BIG_STEP_PX`); Home puts it back; nothing is announced while it moves.
  The focus trap's end (Tab past the node's last control) now returns to Move, or to Close on a phone. Escape closes
  the popup from Move as from anywhere in it.
- **Clicks outside**: the popover's own check (a pointerdown whose target it does not contain closes it) sees a drag
  start inside it, so a drag never closes it, even released over the page; a press on the page still does. The popover
  is not a Radix popover, so Radix's `onPointerDownOutside` is not involved; Radix popovers inside the iframe (the "?"
  tips) and on the page close as before.
- **Phones**: below `sm` the popup covers the screen and there is nowhere to move it, so there is no Move button, no
  grab cursor, and a press on the title bar does nothing. From `sm` up a finger drags it as a mouse does (a tablet).

### The swap card's CTAs

`nodeFixPage` (`lib/wallets/fiber-wallet/node-page.ts`) picks the page that fixes the browser node; the card's primary
button opens the popup there directly, and the Fiber dialog's buttons do the same:

| The card says | Opens |
| --- | --- |
| Open your Fiber node, Unlock…, starting, Check your Fiber node, Connect your node to the hub | Home |
| Ask the hub for a channel (first), Your node can't receive this much …, Not enough … to send | Channels |
| the same, while the node holds too little CKB on chain to accept the hub's channel in that token | Add funds |
| Use the tab that runs your node, Hub is on CKB …: use your own node | nothing: the Fiber dialog |

The node's tab reports `onChainCkb` and `contributionCkb` (the visitor's last choice, while the node runs) with its
status (`NodePresence`, optional, whole numbers only); "too little" is `ckbNeededToAccept` (what the node puts in, or
the token channel's reserve, plus the fee margin).

### Channel with the hub: one card

2026-11-07 (the aim: "select several tokens and put them in at once, easier, and no web change when the hub adds a
token"). Before, the card had one button per token, each a separate wait, a reserve line that mixed the CKB and token
figures ("Hold at least 20,001 CKB first (181 CKB for a token channel)." for 20,000 CKB put in), and a token that already
had a channel said "The hub cannot fund a new cWBTC channel right now." Now one card
(`components/app/fiber-node/hub-channel-request.tsx`, the same on the node page's panel 03 and the popup's Channels;
pure logic in `lib/wallets/fiber-browser/hub-channel-rows.ts`):

- **Rows from the hub alone.** One row per asset GET /v1/fiber/node funds inbound channels in (`inbound.amounts`), or
  lets the node open its own channel in (`peerChannels`, below), CKB first, then the hub's tokens in its order
  (`hubRowAssets`). A token the hub adds is a new row with no web change. Since 2026-11-07 its name and icon come from
  the hub too (GET /v1/assets `displayName` and `iconUrl`, [names and icons](#tokens-from-the-hub-the-udt-whitelist)):
  the hub's, else the app's for a symbol it knows, else the hub's name and the initials. Each row: a checkbox named by
  the symbol, the token's icon and symbol, its name beside them (not part of the checkbox's name), a status badge
  (status colours) and one line.
- **Where a row stands** (`hubRows`, in this order): **Open** (a ready channel with the hub in the asset; the line says
  "You can send 19,901 CKB · receive 2,901 CKB", what a swap can move over it now), **Opening** (a channel whose funding
  is not confirmed: "Ready after a few confirmations."), **Restart needed** (`assetsNeedingRestart`, with the restart line
  and Lock node under the rows), **Hub can't fund now** (`inbound.fundable` false and no channel), **Not open**. A
  channel always wins (whoever opened it): a token with a channel is Open, never "can't fund". Only a Not open row can be
  ticked; a row that cannot says why in its checkbox's `title` ("Your node already has a cWBTC channel with the hub.",
  the restart line, "The hub cannot fund a new RUSD channel right now. Try again later."). A token the hub cannot fund
  now but lets the node fund itself stays Not open, with the node's own tokens as its only way.
- **Lines.** CKB: "Hub funds 1,000 CKB", and under it "Your node puts in [ ] CKB" with Max (the field shows while the
  CKB row is Not open; validation as before: whole CKB, at least 200, `parseContribution`; saved per network). A token:
  "Hub funds 10 RUSD · needs 181 CKB reserve" (`ckbNeededToAccept`: the reserve plus the fee margin). Max is all the
  node holds less the fee margin, less 181 CKB per ticked token (`maxContribution`), so the total then fits.
- **The total** (`selectionNeeds`), before the button while a row is ticked: "Needs 20,363 CKB on chain · you have
  20,100 CKB": the CKB put in plus 1 CKB fee margin, and 181 CKB per token channel, the same maths as one channel. Short:
  "Not enough CKB on chain. Add 263 CKB first." (rounded up; "you have" rounds down).
- **One button**: "Open a channel" or "Open N channels" (primary pill). It waits, saying why in its `title`, until the
  node runs and is connected ("Start the node first." / "Connect to the hub first.", also as a line), no other node
  action runs ("Wait until the node's current action finishes."), a row is ticked ("Tick at least one token first."),
  the CKB field is valid, the balance is read, and the node holds the total.
- **The run** (`runHubRequests`), which takes the view's one node action (`useNodeAction`, key `inbound-run`: the peer
  form and other hub actions wait, as before): the ticked rows in the rows' order, one after another, each with the
  same `requestHubChannel` as before (CKB: plan the amount, ask the hub, `accept_channel` with its retries; a token: ask
  the hub, fnn's whitelist takes it), recorded in History as before. Each row goes Queued, Opening…, then Done or
  Failed with its reason on a line under it (the hub's message, such as its 409 or 429, or the node's refusal). A
  failed row does not stop the next. Between two rows the run waits until the channel just asked for shows on the node
  and no channel of the node is still being funded (`waitForFunding`, `HUB_RUN_TIMING`: reads every 3 s, a token's open
  may take 20 s to arrive, at most 4 minutes), saying "Waiting until the CKB channel is funded…": fnn 0.9.1 keeps the
  cells of a funding transaction out of any other funding until it is committed, and the change of the first is a live
  cell only then, so a node funded by one transfer could not fund the next channel's reserve at once (on the hub, two
  opens at once failed with "can not find enough UDT owner cells", 2026-11-07). fnn calls a channel ready after 4
  confirmations, about 40 s on testnet; nothing waits after the last row, and after a failed row the run waits only
  while a channel of the node is still being funded (a request can fail after the hub or fnn acted on it). A funding
  still pending after the 4 minutes stops the run: the rows not yet asked fail with "Not asked: a channel is still being
  funded. Try again once it is ready." (`FUNDING_STUCK_REASON`), since fnn would refuse the next funding or the hub would
  open a channel the node cannot accept, and they can be ticked again. **Stop** asks for nothing more
  (the row under way finishes; the others go back to Not open); leaving the page or locking the node does the same, as
  each row is a request of its own. At the end one summary: "3 channels asked for. Each reads Ready after a few
  confirmations." (green), "2 of 3 channels asked for. See the failed row." or "Stopped. 1 of 3 channels asked for."
  (amber), "No channel opened. Each row says why." (red). The hub is read again after the run.
- **After a run** a Done row shows its channel's own state once the node lists it (Opening, then Open); a Failed row
  keeps its reason and can be ticked again (that clears it).
- **Copy**: every line on the card within 12 words; the "?" says once that each token is its own channel and its own
  transaction on chain, opened one after another, that the hub funds every channel (token channels alone; the node puts
  in CKB for a CKB channel and about 180 CKB of reserve per token channel), that Fiber cannot add funds to an open
  channel yet (more CKB: close the CKB channel, then open a new one), and the hub's daily limit. "To put in more CKB,
  close this channel, then ask again." moved there.
- **Your own tokens** (2026-11-07, with the hub's `peerChannels`; `lib/wallets/fiber-browser/own-token-channel.ts`).
  On fnn 0.9.1 the node cannot add its tokens to a channel the hub opens (a dual-funded UDT channel is broken there,
  nervosnetwork/fiber#1671), so for a token whose GET /v1/fiber/node entry has `peerChannels` (`{ minAmount,
  assumedCommitmentDelayEpochs }`, null on the testnet hub today) the node may open the channel itself with its on-chain
  tokens, and the hub's fnn accepts it by itself from `minAmount` on, adding no tokens. Only then the row shows two
  choices under its line, "Hub funds it" and "Your own cWBTC" (a radio group; the hub's by default; choosing the node's
  own ticks the row), with a "?"; a token the hub cannot fund now (or funds no inbound channel in) shows the node's own
  with no choice, its "?" after the line. The line then reads "Your node funds it · needs 181 CKB reserve", and under it
  "Your node puts in [ 0.01 ] cWBTC" with Max (the field starts at the hub's minimum; Max is all the node holds; both
  written with the locale's decimal mark, `ownAmountText`, so "1,125" in a comma locale reads back as 1.125, not 1,125) and
  "You hold 0.05 cWBTC on chain · at least 0.01 cWBTC". The balance is the node's cells of the token at its lock
  (`CkbRpcClient.tokenAmount`: `get_cells` with the type script as filter, the first 16 bytes of each cell's data little
  endian, summed over the pages; the indexer matches both scripts by prefix, so only cells whose lock and type are
  exactly the node's and the token's count), read when the field shows, again after a run or a new CKB balance, and on "Read again"
  after "Could not read your cWBTC on chain.". The amount must be at least the minimum and at most what the node holds
  ("Put in at least 0.01 cWBTC.", "Your node holds only 0.05 cWBTC on chain.", "Your node holds no cWBTC on chain.",
  "Wait until the node has read its cWBTC." on the button); the total counts the same 181 CKB reserve as a token channel
  from the hub. In the run that row calls `openOwnTokenChannel` instead of the hub. It first reads GET /v1/fiber/node
  again (`ownOfferChange`), as the page reads the hub once and fnn-hub accepts such a channel whatever the hub's cap
  (`FIBER_PEER_CHANNELS_MAX_OPEN`, which only the offer enforces): an offer gone (the cap reached, every `peerChannels`
  null) fails the row with "The hub no longer takes a channel of your own tokens. Try again later.", a minimum raised
  above the amount with "The hub now asks for at least 0.02 cWBTC.", and nothing is opened. Then: `open_channel { pubkey: <hub node
  id>, funding_amount: <hex>, funding_udt_type_script: <the asset's script>, public: false }`, with no
  `commitment_delay_epoch` or `tlc_expiry_delta` (fnn's defaults; the hub assumes 84 epochs whatever the node picks),
  after the node is connected to the hub (it dials the hub's first address only if the hub is no longer a peer), one
  channel at a time with the same funding wait; no POST to the hub for that row. History records it as a channel with
  the hub ("Your node is opening a channel of 0.05 cWBTC to the hub."). The node must have the token in its UDT
  whitelist: a token with `peerChannels` that the running node's whitelist does not name reads Restart needed
  (`assetsNeedingRestart`), with the same line and Lock node. The row's "?" gives the trade-off: the node can pay the hub
  up to what it put in, such as a swap from cWBTC to BTC at once; the hub adds no cWBTC, so it receives over it only what
  it has paid; it keeps about 180 CKB as its reserve; and, because nodes may open their own channels in the token, the
  hub plans every swap from it to BTC for the longest safety delay (84 epochs), over the hub's channel or the node's, so
  a payment could stay locked up to about 10 days if the hub stopped mid-swap. The card's "?" adds
  one paragraph naming such tokens, and the node page's "Paying from your node" "?" says the hub takes a node's own
  channel in them. "Open with another node" still refuses the hub's id (`PEER_CHANNEL_MESSAGE.HUB`): this path is the
  card's only.
- **The hub's limits stay the hub's**: one request per asset (`POST /v1/fiber/inbound-channels`), a 409 while the node
  has a channel in it, and a few requests per node and per client a day (`FIBER_INBOUND_MAX_PER_NODE_PER_DAY` and
  `FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY`, 2 each by default): with those defaults a run of three gets a 429 on its third
  row, which then says so. A hub that serves three or more tokens should raise them.
- **Test ids**: `fiber-node-hub-request` (the card), `fiber-node-hub-row-<asset>` (with `data-status`: `open`,
  `opening`, `available`, `unfundable`, `restart`, `queued`, `asking`, `done`, `failed`), `fiber-node-hub-line-<asset>`,
  `fiber-node-hub-name-<asset>` (the token's name beside its symbol), `fiber-node-hub-fund-<asset>` (the choice "Hub
  funds it" / "Your own cWBTC"), `fiber-node-hub-own-<asset>` (the node's own amount field),
  `fiber-node-hub-own-held-<asset>`, `fiber-node-hub-own-error-<asset>`,
  `fiber-node-hub-reason-<asset>`, `fiber-node-contribution`, `fiber-node-hub-total`, `fiber-node-hub-short`,
  `fiber-node-hub-blocked`, `fiber-node-hub-open`, `fiber-node-hub-stop`, `fiber-node-hub-progress`,
  `fiber-node-hub-summary`, `fiber-node-hub-restart`, `fiber-node-hub-restart-lock`. Gone: `fiber-node-hub-capacity-<asset>`,
  `fiber-node-hub-unfundable`, `fiber-node-hub-more`, and the buttons "Open a channel with the hub", "Open a RUSD channel
  with the hub".
- Tests: `tests/unit/hub-channel-rows.spec.ts` (rows from the hub's assets, a new asset as a row, the status order, the
  totals and Max, the run's order and statuses, a failed row not stopping the next, Stop, the funding wait, what a row
  shows, the summaries, every line within 12 words; the node's own tokens: the hub's offer read safely, rows with and
  without `peerChannels`, the forced own row, the amount checks and Max, the run opening the own row without asking the
  hub, `openOwnTokenChannel`'s open_channel, dial and refusals, the copy); `tests/e2e/hub-channels.spec.ts` (CKB, RUSD
  and cWBTC in one press: three requests in order, `accept_channel` for CKB only, rows Open; the hub's 409 on one row and
  the node's refusal on another while the next succeed; not enough CKB with the total line, Max; a token with a channel
  Open and not tickable, one the hub cannot fund, the "?"; the popup's Channels with Stop while the run waits; the
  node's own cWBTC with CKB from the hub in one press: open_channel's exact params, the hub asked for CKB only, Opening
  then Open, History; nothing new without `peerChannels` (no token read either); the hub unable to fund cWBTC, the own
  field with no choice, a failed read read again; the popup's own cWBTC at 380 px; axe, 390 px and the popover's
  380 × 550); the restart row and names and icons from the hub in `tests/e2e/multi-asset.spec.ts`; the node page's flows in
  `tests/e2e/fiber-browser.spec.ts`; the popup's Channels and History in `tests/e2e/fiber-wallet-popup.spec.ts`.

### The hub's CKB channel: accepted by the node

2026-11-05 (approach suggested by the Fiber developer Joii). Before, fnn accepted the hub's CKB channel by
itself with `auto_accept_channel_ckb_funding_amount`, a start-time config, so a new "Your node puts in" needed a
restart. Now:

- The browser node's config, built afresh at every start and never saved (`node-config.ts`), sets
  `auto_accept_channel_ckb_funding_amount: 0` (`NODE_AUTO_ACCEPT_CKB_FUNDING_SHANNONS`). fnn v0.9.1 then never accepts a
  CKB channel by itself (network.rs: auto-accept needs that amount above 0). A node started before this picks it up at
  its next start; nothing migrates.
- The CKB row of "Channel with the hub" ([one card](#channel-with-the-hub-one-card)): `requestHubChannel`
  (`channel-actions.ts`) checks the amount typed first
  (`planHubContribution`, `lib/wallets/fiber-browser/hub-accept.ts`: whole CKB, at least 200, the 99 CKB reserve
  included; the balance read; at most what the node holds less the 1 CKB fee margin), so the hub is never asked for a
  channel the node cannot accept. Then `POST /v1/fiber/inbound-channels`; its `temporaryChannelId` goes to
  `acceptHubChannel`, which calls `accept_channel { temporary_channel_id, funding_amount }` (the amount in shannons, hex;
  no `shutdown_script`, so the node's own lock, as for the channels it opens; Close can still send its share to the
  visitor's wallet with `close_script`). The hub answers before its open_channel message reaches the node, and fnn
  then says "No channel with temp id ... found": `acceptHubChannel` tries again after 0.25, 0.5, 1, 2 and four times
  4 seconds (`HUB_ACCEPT_RETRY_DELAYS_MS`, about 20 s), then says "The hub's channel did not arrive. Try again in 10
  minutes." Any other refusal is final, in one line: "Your node could not accept the hub's channel: <fnn's
  reason>". fnn drops the request from its waiting list before it checks the amount, so a refused accept cannot be
  retried. Either way the hub answers 409 for that node and asset until it abandons its side after
  `FIBER_INBOUND_ACCEPT_TIMEOUT_SECONDS` (10 minutes, ckbolt-hub `stale-inbound-opens.ts`; only opens it made since it
  last started), and the node may ask again then. The failed open still counts toward the hub's daily limit per node
  (`FIBER_INBOUND_MAX_PER_NODE_PER_DAY`, 2 by default); the line stays short and the hub channel's "?" says that it
  counts.
- The amount is per request: the field's value when Open is pressed. A valid amount is saved per network as the next
  default (`channel-contribution.ts`). No restart prompt, no `contributionCkb` in the controller's state.
- RUSD (any UDT) is unchanged: fnn accepts it by its UDT whitelist with nothing from the node; no `accept_channel`.
  Since 2026-11-06 that whitelist carries the hub's own entries ([Tokens from the hub](#tokens-from-the-hub-the-udt-whitelist)).
- A CKB channel another node opens to the browser node is no longer accepted: it waits in fnn's list of channels to
  accept, which the app neither shows nor accepts, and fnn drops it when that node disconnects. Channels the node opens
  itself ("Open with another node") are unchanged.
- Tests: `tests/unit/fiber-browser.spec.ts` (config, adapter mapping, amount checks, retries and errors, the flow, no
  restart copy), `tests/e2e/fiber-browser.spec.ts` (the field, no restart, `accept_channel` with the hub's id after one
  "not found", a refused accept, RUSD without accept), `tests/e2e/fiber-wallet-popup.spec.ts` (Channels page). The
  fake nodes (`tests/e2e/support/fiber-node.ts` and the one in `fiber-browser.spec.ts`) model the hub's open arriving
  `acceptMisses` accept calls late.

### Tokens from the hub: the UDT whitelist

2026-11-06, with the hub's `FIBER_ASSETS` (any UDT by config; cWBTC first). fnn takes a channel in a token only when
its config's `ckb.udt_whitelist` names the token's type script, and accepts the hub's inbound channel in it by itself
only from that entry's `auto_accept_amount` up (the app sends `accept_channel` for CKB only). fiber-js 0.9.1 bundles
RUSD alone on testnet, unanchored, auto-accepted from 10 RUSD.

- **The hub's entries.** `GET /v1/fiber/node` gives each UDT a `udtWhitelist` (`name`, the exact `script`,
  `cellDeps` by out point or by type id, `autoAcceptAmount` or null). `lib/wallets/fiber-browser/udt-whitelist.ts`
  checks every field (hex, hash types, a name of at most 32 plain characters, a decimal amount; an entry that fails is
  left out whole) and writes fnn's YAML: `args: "^<args>$"` (fnn reads args as a regex; anchored, it matches this
  token only), `cell_dep: { out_point: { tx_hash, index }, dep_type }` or `type_id: { code_hash, hash_type, args }`,
  and `auto_accept_amount` only when the hub gives one.
- **Merge policy.** `browserNodeConfig` (`node-config.ts`) puts the hub's entries first in the `ckb` section's
  `udt_whitelist` and drops fiber-js's entry for the same script (same code hash, hash type and exact args); fiber-js's
  entries for scripts the hub does not name stay verbatim, after the hub's. So RUSD keeps working with other nodes and
  when the hub cannot be reached at start (no entries: the config is fiber-js's), the hub's tokens are whitelisted
  exactly as the hub funds them, and nothing the hub sends removes another token. fnn takes the first entry that
  matches, so the hub's win. A config with no `ckb` section is left as it is.
- **Read at start only.** The config is built at every start (`BrowserNodeController.start` takes the hub's entries
  from the workspace's `hubNode`), and the controller keeps the whitelist it started with, read back from the YAML
  (`NodeState.udts`). `assetsNeedingRestart` lists the tokens the hub funds inbound channels in that this whitelist
  would not take by itself (no matching entry, no auto-accept amount, or one above the hub's funding); a node started
  before the hub served cWBTC, or before the hub answered, is one. The hub channel card (node page panel 03, the
  popup's Channels) then shows that token's row as "Restart needed", which cannot be ticked (also a token with
  `peerChannels` its whitelist does not name at all, since fnn's open_channel needs it), and one line under the
  rows, "Restart your node to accept cWBTC channels: lock it, then unlock.", with **Lock node** beside it (it waits
  while a swap needs the node, as Settings' Lock does, and while a run asks for channels); unlocking starts the node
  with the hub's whitelist and the line goes. An older hub without `udtWhitelist` never asks for a restart.
- **Reserves.** Every token channel takes the same CKB reserve from the node, about 180 CKB (`CHANNEL_RESERVE_CKB`
  `{ CKB: 99, UDT: 180 }`, `channelReserveCkb`; an xUDT cell such as cWBTC's needs at least 146), so the "fund first"
  guard and the swap card's Add funds CTA cover any token the hub lists. A token's row reads "Hub funds 10 cWBTC ·
  needs 181 CKB reserve", and the card's total adds 181 CKB per ticked token (it replaced "Hold at least 1,201 CKB
  first (181 CKB for a token channel).", 2026-11-07).
- **Faucet.** Under the node's address (node page and Add funds), "Get test cWBTC at faucet-cwbtc.ckb.dev, to this
  address." while the hub serves cWBTC (`lib/faucets.ts`; `NEXT_PUBLIC_CWBTC_FAUCET_URL` names another, such as
  CKBolt's own at https://ckbolt-faucet.texlabs.org). The funding page stays CKB and RUSD.
- **Names.** Channel lists show the hub's symbol (cWBTC, not the id CWBTC); decimals come from `GET /v1/assets`, and a
  token it did not list shows in base units (`assetDecimals`, `formatAssetUnits`) and is not offered (`shownTokens`).
- **Names and icons from the hub** (2026-11-07, `lib/token-display.ts`). GET /v1/assets gives each asset `displayName`
  and `iconUrl` (the hub's FIBER_ASSETS, null when unset). The token picker (swap card, Pay, Get paid), the hub card's
  rows and History's detail ("Token: Wrapped BTC (test) (cWBTC)") show the hub's display name, else the app's name for a
  token it knows (`PAY_TOKENS`), else the hub's name, else the symbol; amounts keep the symbol. The icon is the hub's,
  else the app's own (`public/tokens`), else the initials; `TokenIcon` tries them in order and moves on when one fails
  to load. The page checks both fields again before use (`safeDisplayName`: 1 to 64 characters, no control characters
  or bidi overrides; `safeIconUrl`: https of at most 2,048 characters with no credentials, or
  `data:image/svg+xml;base64,` of at most 8,192 that decodes to a plain SVG under the hub's own deny-list, its
  `ICON_URL_RULE` copied and compared in `tests/unit/token-display.spec.ts`). Icons are only `<img src>` (with
  `referrerPolicy="no-referrer"`), never inlined markup. The node page sends COEP require-corp in browsers without
  Document-Isolation-Policy, so an https icon from a host without `Cross-Origin-Resource-Policy: cross-origin` fails
  there and the next icon shows; an inline SVG shows everywhere.
- **Test ids**: `fiber-node-hub-restart`, `fiber-node-hub-restart-lock`, `fiber-node-faucet-<asset id>`.
- Tests: `tests/unit/multi-asset.spec.ts` (the entries and their checks, the merge into fiber-js 0.9.1's real config,
  read back, fnn's lookup and auto-accept, the restart list, the controller, reserves, the faucet),
  `tests/e2e/multi-asset.spec.ts` (a cWBTC channel taken by the fake fnn's whitelist with no `accept_channel`; a node
  started before the hub served cWBTC: the fake refuses the channel, the line, Lock node, unlock, then taken; the
  faucet link; axe and 390 px). The fake fiber-js (`tests/e2e/support/fiber-node.ts`) bundles fiber-js's RUSD entry,
  reads the whitelist from the config it is started with, and takes a token channel the fake hub opens
  (`deliverHubUdtChannel`, `LiveHub.openUdtChannels`) as fnn would.

### History: sources, detail and limits

2026-10-30 ([pay-get-paid.md](pay-get-paid.md), part E): the app's History tab is gone; the node's History is the one
place. The model is `lib/wallets/fiber-browser/history.ts`; the hook `components/app/fiber-node/use-activity.ts`; the
list and its detail `components/app/fiber-node/history-list.tsx` (Home's last 5, the History page, the node page's
panel 05, now titled History).

- **Two sources, one storage.** Both live in this browser's localStorage, which the app page and the popup's iframe
  share: checked in real Chrome (`tests/e2e/node-history.spec.ts`: same values both ways, and a write in one document
  reaches the other as a `storage` event, although the iframe is isolated by Document-Isolation-Policy
  `isolate-and-credentialless`). So the relay carries no records.
  - **The node's own entries** (`activity.ts`), kept by the node because fiber-js 0.9.1 can look up one payment or
    invoice by hash but cannot list them: per network and node id (`ckbolt:fiber-browser:<network>:history:<nodeId>`),
    the newest 200, the same in the popup and on `/app/fiber`. Its leg of each swap (keyed by the payment hash both
    legs share: BTC to CKB the payout invoice it made, Waiting to Received from `get_invoice`, its swap id not known
    yet; CKB to BTC the hub's hold invoice it paid, Sending to Paid or Failed from `get_payment`, with its fee, the
    swap id and the Lightning sats), Pay's Fiber payments and on-chain sends, Get paid's Fiber invoices, channels asked
    for or closed from this browser, withdrawals.
  - **The swaps the app started** (`lib/swap/history.ts`): the swap card's, Pay's Lightning invoices and Get paid's
    Lightning invoices. `useSwapRunner` (the one machinery all three use) writes the swap as soon as the hub created it
    and on every change it reads, per hub network (`ckbolt:swap-history:<network>`, the key the app's History used, so
    swaps kept before stay), the newest 100: id, direction, asset and symbol, both legs' amounts, payment hash,
    creation time, state, `refunded`, and whether the hub ever held the payment (`funded`). Both documents may write,
    so a write reads what is stored first, merges and writes back in the same task (`keepSwapRecord`), and the merge
    never moves a swap back (`mergeSwapRecord`: the state that got further wins; `refunded` and `funded` stay once
    set).
- **Merged** (`mergeHistory`): one entry per swap, the node's leg and the app's record together, matched by the payment
  hash (0x and case aside: the hub writes it bare, fnn with 0x) or by the swap id the node's leg learned. A swap the
  node has no leg of (through the visitor's own node) and a leg the app has no record of each show on their own. Newest
  first by the node's time, or the hub's creation time for a record alone.
- **How an entry reads**: a swap the app kept by both its sides ("Swap: 2,526 sats → 1,000 CKB") and how it stands at
  the hub, with the run's tones (`historyTone`, `outcomeTone`): In progress (amber), Completed (green), Refunding and
  Refunded (amber: the payment comes or came back), Cancelling (amber), Cancelled (grey: nothing was paid); anything
  else by the node's own entry, as before ("Swap: payout of 1,000 CKB", "Paid 5 CKB", "Request for 1,000 CKB",
  "Closing channel with the CKBolt hub · 401 CKB", "Withdrew 750 CKB") with its badge. Each entry has `data-kind`,
  `data-status` (the hub's state for a kept swap, else the node's status) and `data-key`.
- **Filters** (`HISTORY_FILTERS`): All, Payments (Pay's Fiber payments and Get paid's requests and receipts), Swaps
  (every swap, Get paid's Lightning invoice included), Channels, Funds (withdrawals and Pay's on-chain sends).
- **The detail**: one entry open at a time, under its row (`history-entry-detail`). A swap: what the visitor pays and
  receives, the refund or cancel line, the node's routing fee when it paid the hold invoice, the hub's reason for a
  failed swap, the swap id, the payment hash with Copy, and Report a problem (`FeedbackLink`, with the swap id). While
  it is open the iframe reads the swap from the hub (`GET /v1/swaps/:id` through the same-origin proxy,
  `useSwapRead`: once, then every 2 s until final; a failed swap that never showed a held payment also reads its
  events), and keeps what it read, so the list and the node's hold follow; "The hub cannot be reached right now." or
  "The hub has no record of this swap." when it cannot. A Pay payment: the amount, the fee it took next to the most it
  could ("0.001 CKB (max 0.025 CKB)") or the max fee while on its way, the payee, the hash with Copy, the node's error,
  Report a problem. Requests, channels and withdrawals keep their details (note, valid until, channel, peer, fee,
  address, CKB Explorer).
- **Kept current**: the node's entries under way are read again from fnn every 5 s, also after a reload (the dev log's
  payment-recovery pattern); channels follow `list_channels`; the swaps not final yet are read from the hub every 10 s
  (`SWAP_HISTORY.refreshMs`) by the document that runs the node (one the hub answers 404 for is left be).
- **Holding the node**: a swap's leg under way or a Pay payment in flight holds it (leaving asks first, Lock and Forget
  wait), a Get paid invoice does not. New (`releasedBySwap`, `itemHoldsNode`): a payout invoice still open whose swap
  failed (cancelled unpaid, refunded, or left behind by an abandoned run or Get paid's "New invoice" or "New request")
  is done: no payer will come, so it neither holds the node nor is read again, although fnn keeps it open for its hour.
  The page's run writes the failure while it follows the swap; once it no longer does, the node reads it from the hub.
  A received payout and the node's own payments still end by their own status.
- **Nothing secret**: no invoice text, no preimage, no key, in either store or on the relay.
- **Deposits are not listed**: telling a transfer in from a channel's funds coming back would need every transaction
  of the node's address; the balance on Home shows them instead.

### View in History, and the relay

After a swap, a payment or a request ends in the app, **View in History** (`components/app/fiber-wallet/host/
view-in-history.tsx`, `history-entry-view`) opens the header's popup on History with that entry open: the swap card's
result (it hides the progress dialog; the banner brings the result back), Pay's result (a Lightning invoice's swap
once settled, a Fiber payment once paid or failed, an on-chain send), and each payment of Get paid's receipt (the
Lightning invoice's swap, the Fiber invoice's payment hash). It is shown only while the header's popup runs the node
(`popupRunsNode`): a node in a window of its own or on `/app/fiber` cannot be steered from the page, and its History is
in that window.

The relay (`lib/wallets/fiber-popup/relay.ts`) has a page → iframe message `open-entry` (`openEntryMessage`,
`pickEntryRef`): `{ id, hash }`, a swap id (UUID) and a 0x hash (a payment hash, or an on-chain send's transaction),
either may be null, rebuilt from those two fields only and refused when neither is valid, so no invoice, preimage or
path a page adds reaches the node. The host's `showEntry(ref)` shows the popover and sends it (queued, like
`navigate`, until the iframe's first status); the shell (`wallet-shell.tsx`, `useParentRelay`'s `onOpenEntry`) moves
to History, and the list (`HistoryList`'s `target`, `findHistoryItem`: by swap id, else by hash) shows All, opens the
entry and brings it into view, or says "This node has no record of it." (`history-entry-missing`). The iframe → page
`open-swap` message, its `router.push` to `/app?tab=history`, and the entries' "View in the app's History" links are
gone with the app's History.

### Removed

Send (pay an invoice, keysend) and Receive (make an invoice) are gone from the popup and from `/app/fiber` (its Panel 04
"Send and receive"; "Channels with other nodes" is now 04 and Activity 05, titled History since 2026-10-30), with
their copy, their history kinds and the logic only they used: `parse_invoice` (`invoice-parse.ts`, `molecule.ts`),
keysend (`sendKeysend`, `keysendParams`),
`checkInvoiceText`, `checkParsedInvoice`, `checkKeysend`, `checkReceive`, `receiveInvoiceArgs`, and their tests.
`lib/wallets/fiber-browser/payments.ts` became `tokens.ts` (tokens, amounts, node ids). `sendPayment` and `newInvoice`
stay in the node port and the adapter: the swap bridge uses them.

### The node page's Diagnostics panel

2026-11-05. Panel 06 of `/app/fiber`, only while the node runs and not in the popup
(`components/app/fiber-node/diagnostics-panel.tsx`, logic in `lib/wallets/fiber-browser/diagnostics.ts`): for a Fiber
developer looking into a payment. Nothing in it pays, changes a channel or writes History.

- **Copy diagnostics** reads `node_info` and `list_channels` (closed channels too; open ones only when the node refuses
  `include_closed`) and copies one JSON (`kind: "ckbolt-fiber-diagnostics"`, `schemaVersion: 1`), also shown under the
  button to select by hand when the clipboard is blocked: when, the network, the fiber-js version, the hub's live node
  id; the node's version, commit, id, addresses, chain hash, auto-accept amounts, TLC settings, counts and UDT settings;
  per channel its id, peer (`withHub` by every id the hub is known by), state, public or not, opener, asset, balances,
  TLC balances, any reserve field, pending TLC count, creation time and outpoint; and the last route check.
- **Nothing secret**: fields are copied one by one from a fixed list, never the raw answers; amounts are decimal strings
  of base units; no key, preimage, password or invoice text (a route check keeps the invoice's network, amount, asset,
  payee, hash and expiry, not the invoice).
- **Check a route**: a pasted Fiber invoice, checked as Pay checks it, then `send_payment` dry runs (`dry_run: true`,
  Pay's 0.5 % fee cap): directly, and through the hub as a trampoline (`trampoline_hops`), each "Route found, fee …" or
  "No route: <fnn's error>". fnn builds the route and keeps no payment session. The trampoline uses only the hub's live
  node id on the node's network, as Pay does, never an id kept from before; without it the outcome says "Not checked:
  the hub's Fiber node is not available now." (`trampolineSkipped: "no_hub_node"` in the JSON), and for the hub's own
  invoice "Not needed" (`payee_is_hub`).
- **The hub's side**: `scripts/diagnose-route.ts` in ckbolt-hub reads the payer's and the payee's exports next to the
  hub's own node and checks each hop (`../ckbolt-hub/docs/diagnose-route.md`).
- Tests: `tests/unit/diagnostics.spec.ts` (the JSON's fields, nothing secret, the dry runs and skips, the adapter),
  `tests/e2e/diagnostics.spec.ts` (copy, route check, a kept hub id never probed, axe and 390 px).

### Status colours

The popup and the swap card use the status palette of the [style guide](style-guide.md#status-colours): the header
button's dot (and a faint green outline while running), the popover's state badge and the Testnet tag (amber), the
hub's badge, channel states with a left rule on each card, History's badges, and notices (done green, failed red,
waiting amber). Every colour keeps its words.

### Test ids (current)

`fiber-wallet-button`, `fiber-wallet-popover`, `fiber-wallet-handle` (the title bar that moves it), `fiber-wallet-move`
(Move), `fiber-wallet-close`, `fiber-wallet-frame`, `fiber-wallet-state`,
`fiber-wallet-silent`, `fiber-wallet-reload`, `fiber-wallet`, `fiber-wallet-page-<page>`, `fiber-wallet-page-bar`,
`fiber-wallet-page-title`, `fiber-wallet-back`, `fiber-wallet-open-<page>`, `fiber-wallet-needs-node`,
`fiber-wallet-home`, `fiber-wallet-ready`, `fiber-wallet-liquidity`, `fiber-wallet-balance`, `fiber-wallet-hub`,
`fiber-wallet-recent`, `fiber-wallet-add-funds`, `fiber-wallet-channels`, `fiber-wallet-channels-notice`,
`fiber-wallet-channels-error`, `fiber-wallet-peer-channel`, `fiber-wallet-withdraw`, `fiber-wallet-withdraw-channels`,
`fiber-wallet-settings`, `fiber-wallet-node`, `fiber-wallet-node-id`, `fiber-wallet-lock`, `fiber-wallet-full-page`,
`fiber-wallet-guide`, `fiber-wallet-history`, `fiber-wallet-history-list`, `fiber-wallet-history-empty`,
the hub's card in Channels (shared with the node page: [its test ids](#channel-with-the-hub-one-card)),
`fiber-wallet-history-<page>`, `fiber-wallet-fallback`, `fiber-wallet-open-window`, `fiber-wallet-unavailable`,
`fiber-wallet-to-window`; shared `history-entry` (with `data-kind`, `data-status`, `data-key`), `history-entry-detail`,
`history-entry-token` (the detail's token, by the hub's name and icon), `history-entry-report`, `history-entry-missing`, `fiber-node-keep-open`; on the app `history-entry-view` (View in
History); in the swap card's Fiber dialog `fiber-open-node`, `fiber-fix-in-node`, `fiber-add-funds`. Gone with the
Activity page and the app's History: `fiber-wallet-page-activity`, `fiber-wallet-open-activity`,
`fiber-wallet-activity*`, `history-entry-details`, `history-entry-swap-link`.

### Tests

- Unit: the activity store (append newest first, update in place, the 200 cap, per node and network, node kinds only,
  payment and channel transitions) in `tests/unit/fiber-browser.spec.ts`; the `navigate` and `open-entry` relay
  messages, the activity's labels and tones, swap legs holding the node, and the bridge's funds in
  `tests/unit/fiber-wallet-popup.spec.ts`, where moving the popup is tested too (clamping and its margin, the keys, the
  stored value read and written, a blocked store, the `sm` breakpoint); History's model (`tests/unit/node-history.spec.ts`: one entry per swap by hash
  or id, records and legs alone, words and tones, the filters, finding an entry, a failed swap's payout invoice no
  longer holding the node); the swap records (`tests/unit/swap-core.spec.ts`: final states, the merge of two writers,
  the cap, nothing secret, read-merge-write, a read from the hub); the CTA to page mapping and the node's funds in
  `tests/unit/fiber-wallet.spec.ts`.
- E2E (`tests/e2e/fiber-wallet-popup.spec.ts`, run with `PW_CHANNEL=chrome`): Home, each page and Back (focus to the
  title and back to its button, by mouse and keyboard, passwords cleared); pages that need the node; Add funds;
  Channels (the hub first, then the list, then Advanced; CKB and RUSD asked for in one press; another node; close to
  the wallet); a channel
  asked for and one closed in History, following the node's channels, and the filters; Withdraw and its History entry
  under Funds; Settings; the swap card's CTAs landing on Home, Add funds and Channels, and the Fiber dialog's buttons; a
  swap in History as one entry (the node's leg and the card's record); View in History on the swap's result, the node
  still running; a swap's leg keeping the node busy across a reload; the renamed text; axe and no horizontal overflow
  of Home and every page at 380 × 550 and on a phone; moving the popup (its box before and after a drag by the title
  bar, the iframe without pointer events while pressed, the edges, released over the page and still open, a click
  outside still closing it, Close and reopen, a reload, Escape mid-drag, a double click and Home putting it back, a
  stored place clamped or ignored, the keys and the focus order, the node taking clicks after a drag, the badges
  dragging and Close not, a smaller window and back, 390 px and a phone with axe; these need no DIP: in Playwright's
  Chromium the click lands on the fallback's "?"). `tests/e2e/node-history.spec.ts`: the page and the iframe share
  localStorage; Pay's Fiber payment opened from its result (fee and max, the filters); a Get paid request left behind
  with "New request", its Lightning invoice's swap holding the node until the hub cancels it, read by the node itself;
  a request paid on Fiber opened from its receipt, its Lightning leg's payout invoice then cancelled by the node;
  History and an open detail at 380 × 550 and on a phone with axe.

## Upgrade notes

For when fiber-js and fnn 0.10 are released as stable. **Nothing is upgraded now**: the browser node stays on fiber-js
0.9.1 (`FIBER_JS_VERSION`) and the hub's fnn on the same minor, because 0.10.0-rc1 is a prerelease that "does not
support upgrading an existing database", and the changes below are merged into Fiber's `develop` but not yet in a
published release. Source: the Fiber dev log of 2026-10-29
([discussions/1712](https://github.com/nervosnetwork/fiber/discussions/1712)). Applied already without upgrading: the payment-recovery pattern (Pay's Fiber payments, History reading a payment again after a
reload), the actual routing fee next to the maximum, and the invoice's network checked in the page and in the node
before paying.

- **`await fiber.stop()` before Lock, Forget and export.** In 0.10 `stop()` "waits for accepted API calls, actor
  shutdown, background database work" (IndexedDB transactions included) before it closes the database and ends the
  workers, and rejects if shutdown fails or times out; once it succeeded, the instance's database can be exported
  without an extra flush. The node controller already awaits `stop()` (`node-controller.ts`, `teardown`), but with
  0.9.1 a stop can cut a database write, so Lock and Forget wait while the node is needed and a failed stop is ignored
  ("the workers are gone either way"). With 0.10, Lock, Forget and any export of the node's data should rely on the
  awaited stop and, when it rejects, keep the Web Lock and say so instead. Every instance on the same database must be
  stopped (the Web Lock already keeps one per browser profile; the dev log's tutorial now does the same for two tabs).
- **The hub's fnn with `store_sync_writes`.** Native nodes can set `fiber.store_sync_writes` (RocksDB and SQLite; off
  by default) so writes wait for the disk sync: slower, but a crash cannot lose a channel update the peer already has.
  Turn it on for the testnet hub's fnn (`../ckbolt-hub/deploy/`) once it runs 0.10; it does not apply to the browser
  node.
- **The new testnet commitment lock.** The new commitment-lock contract "went live on CKB Testnet on October 21" for
  integration work; its deployment PR in `fiber-scripts` is still open. Once the release uses it, the browser node's
  bundled testnet config and the hub's fnn config must name the same deployment (check the manifest for the code hash
  and cell deps), and channels opened under 0.9.1 should be closed before the switch unless the stable release can
  upgrade existing data (rc1 cannot).
- **Hosted LSP ([fiber#1623](https://github.com/nervosnetwork/fiber/pull/1623)), a future option.** Unmerged: WebSocket
  subscriptions for channel and watchtower signing requests, with browser-compatible authentication; after a reconnect
  a client subscribes again to get what is pending, and signatures still go through the existing RPCs. It could let a
  hosted node keep channels and the payout side of swaps alive while the browser node signs when its tab is open, so
  the visitor no longer needs to keep a tab open for a payout or a refund. It would change what "keep this page open"
  and the node's hold mean, so it is a design change for later, not an upgrade step.
- **Channel V2.** Marked ready for review on October 27, unmerged: eligible queued payment updates are batched into one
  commitment after an acknowledgement, each still checked against the channel's limits. Nothing to change in the app;
  expect fewer round trips per payment under load once both the hub and the browser node run it.
- Also in the log: Fiber now checks an outgoing invoice's network in `send_payment` (also on dry runs) before it
  creates payment state, which backs the page's own check; and it clears deferred peer payment updates when a
  connection drops, for the peer to replay after reconnecting.

---

The sections below are the first plan and build (before the rescope), kept as history.

The plan: the Fiber node moves from the `/app/fiber` page to a **button at the right of the header**. The
button opens a **popup that runs the node in the browser, like a wallet extension**, with all wallet functions:
- deposit and withdraw;
- send through the hub, choosing the token;
- manage channels, including channels with other nodes.

## 1. Why an iframe, and what it needs

fiber-js needs `SharedArrayBuffer`, so the document that runs it must be cross-origin isolated. Isolating every page
with COOP/COEP would break CCC wallet popups (JoyID) and third-party resources. `Document-Isolation-Policy` (DIP)
isolates one document on its own.

Spike, 2026-10-27: a normal page that embeds an iframe served with
`Document-Isolation-Policy: isolate-and-credentialless` gives the iframe `crossOriginIsolated === true` and
`SharedArrayBuffer`, while the page itself stays not isolated.

| Browser | Iframe isolated |
| --- | --- |
| Chrome 156 | yes |
| Edge 156 | yes |
| Playwright's bundled Chromium 140 | no; DIP is not enabled there |

So:
- **The node runs in an iframe** served from the new route **`/app/wallet`**. That route sends DIP and allows only
  same-origin framing (`frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`). Every other route keeps `DENY`.
- **The iframe is mounted once, in the root layout, the first time the user opens the wallet.** The popup then only
  shows or hides it, so the node keeps running across client-side navigation. A full page load restarts it, and the
  password is asked again. Visitors who never open the wallet do not download fiber-js (15 MB).
- **Browsers without DIP** (Firefox, Safari): the iframe reports it is not isolated, and the popup offers **"Open the
  wallet in a window"**: `window.open` of the existing isolated full page (COOP/COEP), in wallet layout.
- **One node at a time.** The existing Web Lock already lets only one document run the node. `/app/fiber` stays as the
  full-page view; when the popup holds the lock, it says so.
- **The swap card finds the node as before.** The node document already serves swap requests over the same-origin
  `BroadcastChannel` bridge, and an iframe is the same origin.

## 2. The header button

- On the right of the header, next to "Open the app", on every page: a **wallet button**.
- The button shows a state dot and a short label:

  | State | Label |
  | --- | --- |
  | not opened yet | "Fiber wallet" |
  | locked | "Locked" |
  | running | the CKB it can send |

- Click: a popover anchored top-right, about 380 × 600 px, like an extension. On a phone it is a full-height sheet.
  Esc or a click outside closes it; the node keeps running.
- The parent reads the button's state from the iframe through `postMessage` (status, balances). No keys or secrets
  cross the frame boundary.

## 3. Inside the popup: the wallet

Compact screens with a bottom tab bar, reusing the node page's logic (`lib/wallets/fiber-browser`, hooks in
`components/app/fiber-node`).

| Tab | What it does | Status |
| --- | --- | --- |
| **Home** | Unlock or create; node id (Copy); on-chain CKB; per token: can send and can receive over ready channels; hub connection; Lock | reuse |
| **Deposit** | Node CKB address with QR and Copy. "Fund from a wallet" opens the funding page (`/app/fiber/fund?address=…`, not isolated, so JoyID works) in a new tab. RUSD can be funded the same way | reuse, new layout |
| **Send** | (a) Paste a Fiber invoice: it is decoded (token, amount, expiry, payee) and paid with `send_payment`. (b) Keysend: node id, token, amount. Choose which channel or token to pay from where it applies | **new** |
| **Receive** | New invoice: token (CKB / RUSD), amount, note. Shows the invoice with QR and Copy; status Open / Paid / Expired | **new** |
| **Channels** | All channels: peer (hub or other), token, state, can send, can receive. **Open with the hub**: choose the token; for CKB, "Your node puts in" with Max (accepted by the node with that amount, no restart); shows what it will be able to send and receive. **Open with another node**: peer WebSocket multiaddr and pubkey, token, amount; the node opens and funds it. Note: the CKBolt hub only takes payments over channels it opened. **Close**: to this node or to my wallet (`close_script`) | open-with-other-node **new**, rest reuse |
| **Withdraw** | On-chain CKB to an address, with the node password (exists) | reuse |
| **More** | Key backup, restore, forget; activity (swap requests, payments); link to the full page and the guide | reuse |

Each tab follows the style guide: few words on screen, details behind "?" tips, the same testids pattern
(`fiber-wallet-*`).

## 4. Work items

1. **Route and headers.** `app/app/wallet/page.tsx`, the node in compact wallet layout, client only. In
   `next.config.mjs`: DIP and same-origin framing for `/app/wallet` only. The global `DENY` stays for every other route.
2. **Iframe host.** A context provider in the root layout:
   - mounts `<iframe src="/app/wallet">` once, on first open;
   - shows and hides it in the popover, and keeps it mounted;
   - relays status over `postMessage`, checking origin and source.
3. **Header button and popover**, in `components/landing/navigation.tsx` (desktop and phone). The popover is accessible:
   focus trap, Esc, `aria-expanded`.
4. **Wallet UI** with the tabs of section 3, extracted into reusable components shared with `/app/fiber`, so the full page
   and the popup do not drift apart.
5. **New node functions** in the fiber-js adapter and port:
   - `parse_invoice`;
   - `send_payment` with an invoice and with keysend (`target_pubkey`, `keysend: true`, `udt_type_script`);
   - `new_invoice` for the user's own receiving (non-hold, with a preimage the page makes);
   - `get_invoice` and `get_payment` for statuses;
   - `connect_peer` and `open_channel`, for other nodes.
6. **Fallback**: detect `crossOriginIsolated` in the iframe and show "Open the wallet in a window".
7. **Docs**: this file, `live-swap-ui.md` (the swap card's Fiber wallet points to the popup), README, the guide's steps.

## 5. Tests

- **Unit:**
  - invoice decoding and validation;
  - keysend arguments;
  - token amount formatting;
  - the `postMessage` relay: origin and source checks, no secrets in messages.
- **E2E** run on **real Chrome** (`PW_CHANNEL=chrome`), because the bundled Chromium has no DIP. They use the existing
  fake fiber-js and fake hub (test hook, test builds only):
  - the button opens and closes the popover; the node keeps running across client-side navigation;
  - create, lock and unlock;
  - deposit shows the address and QR;
  - send an invoice and send by keysend, checking the RPC parameters;
  - receive an invoice, then mark it paid;
  - open a channel with the hub for CKB and for RUSD;
  - open a channel with another node;
  - close to the wallet;
  - withdraw;
  - the swap card uses the popup's node;
  - the fallback in a browser without DIP;
  - axe and no horizontal overflow, on desktop and phone sizes.
- **Live check** after deploy: a real browser node in the popup on ckbolt.texlabs.org: fund it, get a channel to
  Ready, close it.

## 6. Risks

- **DIP is Chromium-only, and believed desktop-only.** Firefox and Safari use the window fallback, and so, most
  likely, does Chrome on a real Android phone. The phone e2e tests run desktop Chrome with a phone's screen (Pixel 7
  emulation), so they prove the layout, not DIP on a phone; check a real phone by hand.
- **One running node.** If `/app/fiber` already runs the node in another tab, the popup shows "running in another tab".
- **Full page loads restart the node**, and the password is asked again. Remembering the unlock for the session is
  left out for now (security).
- **fiber-js memory.** The node uses about 100–200 MB while running, and the popup keeps it alive until the tab closes.

## As built (2026-10-27)

### Route and headers

`next.config.mjs` splits the framing headers so Next never merges two policies on one path (it applies every rule that
matches):

| Rule (`source`) | Headers |
| --- | --- |
| `/:path*` | `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` |
| `/:path((?!app/wallet$).*)` (every path but the wallet's) | `Content-Security-Policy: frame-ancestors 'none'; …`, `X-Frame-Options: DENY` |
| `/app/wallet` | `Content-Security-Policy: frame-ancestors 'self'; …`, `X-Frame-Options: SAMEORIGIN`, `Document-Isolation-Policy: isolate-and-credentialless`; no COOP or COEP |
| `/app/fiber` (as before) | `Document-Isolation-Policy`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` |

A request to `/app/wallet` returns exactly one CSP (`frame-ancestors 'self'`) and `SAMEORIGIN`; every other page keeps
`frame-ancestors 'none'` and `DENY` (checked by `tests/e2e/fiber-wallet-popup.spec.ts`). The route path is
`FIBER_WALLET_PATH` in `lib/wallets/fiber-popup/constants.ts`; a unit test checks that `next.config.mjs` names the same.

### Parts

- **Host** (`components/app/fiber-wallet/host/wallet-host.tsx`), in the root layout: creates the iframe on first open and
  then only shows or hides it (`hidden`), never moving it, so the node keeps running across client-side navigation. The
  popover is a `role="dialog"` with `aria-modal`, a title bar (title, Testnet tag, Close), the iframe, and two focus
  guards: Tab past the wallet's last control returns to Close, Shift+Tab from Close goes to the wallet's last control.
  Escape (on the page, or relayed from inside the iframe when nothing there took it) and a click outside close it;
  focus returns to the header button. Desktop: 380 × 600 px anchored top right under the header; phone: a full-height
  sheet.
- **Relay** (`lib/wallets/fiber-popup/relay.ts`): the iframe posts `status` (`isolated`, `phase`, `hasKey`, `sendCkb`) and
  `close` (Escape); the page posts `focus` (first or last control). Both sides post to `location.origin` only; the page
  takes a message only when `event.origin === location.origin` and `event.source` is its iframe's `contentWindow`, the
  iframe only from its parent. Builders and parsers copy the listed fields alone, so no key, password or invoice can
  ride along.
- **Header button** (`components/app/fiber-wallet/host/wallet-button.tsx`, `lib/wallets/fiber-popup/button-view.ts`): a
  status dot and "Fiber wallet" (not opened, or no key yet), "Locked", "Starting…", "Other tab", "Failed", or the CKB the
  node can send ("1,101 CKB", two decimals at most, rounded down). Its accessible name says the state in words and holds
  the visible label. It replaced the header's "Fiber node" link, on desktop and in the phone's bar; the phone menu keeps
  Guide, Architecture and Open the app.
- **Client-side header links**: the header's links use `next/link`, so moving between `/`, `/app` and `/app/guide` keeps
  the iframe. On the isolated node page (`/app/fiber`) they stay plain anchors and the wallet button is not shown: that
  page runs the node itself, and a COEP page cannot frame the wallet.
- **Wallet** (`components/app/fiber-wallet/`): `/app/wallet` renders it in the iframe; `/app/fiber?view=wallet` renders it
  in a window of its own, with its own title bar. It runs the node through `useNodeWorkspace`
  (`components/app/fiber-node/use-node-workspace.ts`), the same hook the full page now uses, and the shared parts of
  `components/app/fiber-node/` (key forms, node address, hub channel request, channel list, send, receive, peer channel,
  withdraw, activity list, liquidity table) and `components/app/qr-code.tsx`.
- **Fallback**: without isolation the iframe shows "Open the wallet in a window" (`window.open` of
  `/app/fiber?view=wallet`, 420 × 720). It also follows that window's node over the bridge, so the header button shows
  it.
- **Swap card**: the Fiber dialog's "Open Fiber node" closes the dialog and opens the header's wallet (without a host,
  the full page in a new tab, as before).
- **Full page** (`/app/fiber`): the same panels, now built from the shared parts, plus "Send and receive" (04) and
  "Channels with other nodes" (05); "Swap requests" became "Activity" (06), listing the visitor's own payments and
  invoices too. Its "other tab" notice also names the Fiber wallet.

### Tabs

| Tab | As built |
| --- | --- |
| Home | Not running: create, or unlock the stored key, with what is wrong (another tab runs it, it failed). Running: on-chain CKB, node id with Copy, per token what ready channels can send and receive, the hub's connection with Connect, Lock (disabled while a payment is in flight) |
| Deposit | The node's address with QR and Copy, "Fund from a wallet" (the funding page in a new tab; CKB or RUSD), the faucet, Refresh balance |
| Send | "Invoice" or "Node id". Invoice: checked in the page (Fiber, the node's network, checksum), then read by the node (`parse_invoice`, 300 ms after typing): amount and token, expiry, payee, note; refused when expired, without an amount, in an unknown token, the node's own, or beyond what the channels can send in that token; paid with `send_payment { invoice }`. Node id: token, amount, `send_payment { target_pubkey, amount, keysend: true, udt_type_script? }`. The status follows `get_payment` |
| Receive | Token, amount (within what the channels can receive), note; `new_invoice` with a preimage the page draws and wipes, sha256, one hour; QR, text, Copy; status Open, Arriving, Paid or Expired from `get_invoice` |
| Channels | Every channel as a card (peer, token, state, send, receive, Close to this node or to my wallet); "Channel with the hub" per token, with "Your node puts in" and Max (the node accepts the hub's CKB channel with `accept_channel` and that amount); "Open with another node" (collapsed): node id, WebSocket address (TLS only on https; an address naming another node is refused), token, amount; `connect_peer` with the peer id appended, then `open_channel { pubkey, funding_amount, public: false, funding_udt_type_script? }`. The hub's own id is refused there, and the "?" says the hub takes payments only over channels it opened |
| Withdraw | The node page's Withdraw form, open at once |
| More | Key backup, restore (while locked), forget; activity; the full page and the guide in new tabs; the limits behind a "?" |

Tabs other than Home and More are disabled until the node runs ("Unlock the wallet first."). Every tab stays mounted
(Radix Tabs, `forceMount`), so what was typed survives switching.

### After the review (2026-10-27)

- **Peers before channels**: "Open with another node" dials only when `list_peers` does not show the peer, then polls
  `list_peers` (every 500 ms, up to 15 s, then "The node did not connect within 15 seconds…") before `open_channel`,
  and tries `open_channel` once more on fnn's "waiting for peer to send Init message" (`lib/wallets/fiber-browser/
  peer-connect.ts`, as the hub's deploy kit does). The e2e fake is strict: `connect_peer` adds the node its address
  names by `/p2p/` id, lists it after a set number of `list_peers` calls, and `open_channel` fails without it.
- **Client-side links across the site** (`components/site-link.tsx`, `lib/site-links.ts`): the header, the landing page
  (hero, call to action, overview, footer), the guide's step links and How it works use `next/link` for the site's own
  pages, so following them keeps the popup's node running; the isolated pages (`/app/fiber`, `/app/wallet`), the API and
  other sites load in full. The guide's node step no longer links to the node page.
- **Swap liquidity counts the hub's channels only** (`swapLiquidity`): the bridge's status for the swap card and the
  node's own checks before a payout invoice or a payment. The wallet's Home, Send and Receive count every channel.
- **A wallet that stops answering**: the iframe re-posts its status every 10 s; the page marks it stale after 30 s, or
  unanswered when no status came within 15 s of opening. The button then says "not answering" (problem dot), and the
  popover shows "The wallet is not answering." with "Reload wallet", offered only when the node was not last seen
  running.
- **Results next to their action**: in Channels, a close's result shows under the list, a channel from the hub under
  its buttons, a channel with another node inside its form.
- **The hub's id is kept** (localStorage, per network) and refused as "another node" (peer channel) and for keysend,
  also while the hub cannot be reached.
- **Checks at the moment of paying**: Pay reads the invoice's expiry and the channels again.
- **Passwords do not linger**: the key forms and Withdraw clear the password after a failed try; inside the wallet,
  choosing another tab, hiding the popover (the page tells the iframe, `visibility`) or hiding the browser tab clears
  every typed password.
- **`/app/wallet` opened on its own** goes to `/app/fiber?view=wallet` (COOP/COEP) instead of running the node in a
  document made for a frame.
- **Accessibility**: each key form points at its own error (no duplicate ids); a channel's Close is named after its
  channel ("Close the CKB channel with the CKBolt hub"); the focus trap skips elements taken out of the tab order;
  disabled tabs say why in their description; tab labels are text-xs (the bar scrolls sideways below about 360 px).
- **A token channel with another node** checks the node's token cells too (`get_cells`, summed), when the RPC answers.
- **Amounts** are parsed as decimal text straight to base units (`normalizeAmountInput`), never through a float.
- **Copy**: the "other tab" notice is shorter ("This node runs in another tab or Fiber wallet."), and the tips about
  wallet popups say "where the node runs" instead of "this page".
- **More test ids**: `fiber-wallet-silent`, `fiber-wallet-reload`, `fiber-wallet-to-window`.
- **More tests**: the strict peer fake and the wait for the peer; an invoice changed after its preview, and one the node
  cannot read; messages posted by the page itself or by another window of the site (ignored); the leave-page prompt
  while a payment is in flight; the popup and the node page in two tabs; the node through the guide's, How it works'
  and the landing page's links; Reload after a failed load; `/app/wallet` on its own; passwords cleared on leaving a
  tab or hiding the popover. Unit: the peer wait (fake clock), swap liquidity and the bridge's status, the kept hub id,
  token balances, exact amounts, the relay's health and `visibility`, the site's links, and `next.config.mjs` loaded
  and matched with Next's own path matcher.

### Other changes

- An invoice the visitor makes to receive does not keep the page busy (closing it only means it is not paid); a payment
  in flight does, as a swap's invoice or payment always did (`holdsNode`, `lib/wallets/fiber-browser/activity.ts`).
- The guide's steps point to the Fiber wallet (Create node, Deposit, Channels); the swap card's messages say "Fiber
  wallet" where they said "node tab".

### Test ids

`fiber-wallet-button`, `fiber-wallet-popover`, `fiber-wallet-close`, `fiber-wallet-frame`, `fiber-wallet`,
`fiber-wallet-tab-<tab>`, `fiber-wallet-panel-<tab>`, `fiber-wallet-home`, `fiber-wallet-balance`, `fiber-wallet-node-id`,
`fiber-wallet-liquidity`, `fiber-wallet-hub`, `fiber-wallet-lock`, `fiber-wallet-deposit`, `fiber-node-address-qr`,
`fiber-wallet-send`, `fiber-wallet-send-invoice`, `fiber-wallet-send-preview`, `fiber-wallet-send-node-id`,
`fiber-wallet-send-amount`, `fiber-wallet-send-result`, `fiber-wallet-send-status`, `fiber-wallet-send-error`,
`fiber-wallet-receive`, `fiber-wallet-receive-amount`, `fiber-wallet-receive-note`, `fiber-wallet-receive-invoice`,
`fiber-wallet-receive-qr`, `fiber-wallet-receive-text`, `fiber-wallet-receive-status`, `fiber-wallet-receive-error`,
`fiber-wallet-channels`, `fiber-wallet-channels-notice`, `fiber-wallet-channels-error`, `fiber-wallet-peer-channel`,
`fiber-wallet-peer-node-id`, `fiber-wallet-peer-address`, `fiber-wallet-peer-amount`, `fiber-wallet-withdraw`,
`fiber-wallet-more`, `fiber-wallet-full-page`, `fiber-wallet-guide`, `fiber-wallet-fallback`, `fiber-wallet-open-window`,
`fiber-wallet-unavailable`; on the node page `fiber-node-payments`, `fiber-node-peers`, `fiber-node-peers-notice`,
`fiber-node-peers-error`, `fiber-node-hub-request`, `fiber-node-activity-list`, and in its Diagnostics panel
(2026-11-05) `fiber-node-diagnostics`, `diagnostics-copy`, `diagnostics-copy-status`, `diagnostics-json`,
`diagnostics-route-form`, `diagnostics-route-input`, `diagnostics-route-submit`, `diagnostics-route`,
`diagnostics-route-check` (with `data-via`, `data-ok`), `diagnostics-route-skipped` (with `data-reason`).

### Tests

- Unit (`tests/unit/fiber-wallet-popup.spec.ts`): molecule Script decoding, `parse_invoice` answers, the invoice checks
  before and after the node reads it, keysend and receive arguments, the adapter's new calls, typed and shown amounts,
  the wallet's tokens, the channel with another node, the relay (listed fields only, origin and source checks,
  refusals), the header button's states and accessible names, the activity rule and the route constants.
- E2E (`tests/e2e/fiber-wallet-popup.spec.ts`, desktop and mobile): the headers; the popover (open, Escape inside and
  outside the iframe, Close, a click outside, size and anchoring, the iframe loaded once); the focus trap; create, lock
  and unlock with the button's labels; the node across client-side navigation; Deposit; Send by invoice (with every
  refusal) and by keysend, checking the RPC parameters; Receive, then Paid; channels with the hub for CKB and RUSD; a
  channel with another node in CKB and RUSD; close to the wallet; Withdraw; More; the swap card's Open Fiber node and a
  swap made by the popup's node; the window fallback; axe and horizontal overflow of the popover and of every tab at the
  popover's size and on a phone. The tests that need the iframe isolated (the node across navigation and the site's
  links, the swap card through the popup, the popup and the node page in two tabs) skip themselves when the browser has
  no DIP; the others run the wallet in its window there. Run them in full with `PW_CHANNEL=chrome`.
- `tests/e2e/live-swap.spec.ts`'s browser-node test opens the wallet from the card's dialog and, with DIP stripped, runs
  the node in the window the popover offers; `tests/e2e/app.spec.ts` checks the header's wallet button and the node
  page's plain links.

## Withdrawing a token (2026-11-09)

Withdraw (the popup's tab and the node page's form, `components/app/fiber-node/withdraw-section.tsx`) lists, when the
node holds any, the hub's tokens besides CKB ("What to withdraw", `fiber-node-withdraw-asset`). A token is withdrawn
whole: `withdrawTokenAll` (`lib/wallets/fiber-browser/ccc-withdraw.ts`) takes every cell of exactly that type script
at the node's lock (each cell checked in full: the indexer matches type and lock args by prefix), makes one cell with
the total for the visitor's address, adds the token's code as cell deps from the hub's whitelist entry (an out point
as is, a Type ID through the cell that carries it), and sends the rest of those cells' CKB back to the node as plain
CKB, adding the node's plain CKB when the new cell's lock needs more and for the fee. It is signed with the node key
opened by the password, then the keys are wiped, as for CKB. History shows "Withdrew 25 RUSD" with the transaction; the
fee, in CKB, is shown on the result but not kept in a token entry. Which tokens: `withdrawableTokens`
(`lib/wallets/fiber-browser/token-withdraw.ts`), the hub's tokens with a whitelist entry. Tests: `tests/e2e/fiber-browser.spec.ts`
("withdraws a token the node holds on chain", with a decoy token whose args start the same; "offers no token choice
while the node holds none"), `tests/unit/fiber-browser.spec.ts`.
