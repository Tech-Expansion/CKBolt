/**
 * Copy of "Channel with the hub" (hub-channel-request.tsx, shared by the node page's panel 03 and the popup's Channels):
 * one card, a row per asset the hub funds, ticked and opened in one press. Every line on screen stays within 12 words;
 * the why is behind the card's "?" (TIP).
 */
export const HUB_PANEL_COPY = {
  TITLE: "Channel with the hub",
  TIP_LABEL: "About the channel with the hub",
  /**
   * Behind the card's "?", as paragraphs: each token is its own channel and transaction, who funds what, and no top-up
   * in Fiber yet.
   */
  TIP: (ckbReserve: number, tokenReserve: number, ownSymbols: readonly string[] = []): string[] => [
    "Each token is its own channel and its own transaction on chain, so they open one after another.",
    `The hub funds every channel, so your node can receive. For CKB your node also puts in the CKB you choose, so it can pay at once; ${ckbReserve} CKB of it stays as its reserve. The hub funds token channels alone; each takes about ${tokenReserve} CKB from your node as its reserve. Both come back when the channel closes.`,
    ...(ownSymbols.length > 0
      ? [`For ${new Intl.ListFormat("en-US", { type: "disjunction" }).format(ownSymbols)}, your node may instead open the channel with its own tokens, and the hub adds none: that row's "?" says what changes.`]
      : []),
    "Fiber cannot add funds to an open channel yet: to put in more CKB, close the CKB channel, then open a new one.",
    "The hub takes a few requests per node a day. A channel that never reaches your node still counts; the hub drops it after about 10 minutes.",
  ],
  NOT_OFFERED: "This hub does not open inbound channels to visitors' nodes.",
  /** A row's word, by its state (hub-channel-rows.ts HubRowView). */
  STATUS: {
    open: "Open",
    opening: "Opening",
    available: "Not open",
    unfundable: "Hub can't fund now",
    restart: "Restart needed",
    queued: "Queued",
    asking: "Opening…",
    done: "Done",
    failed: "Failed",
  },
  /** An open row: what the node can move over the channel now. */
  CAPACITY: (send: string, receive: string, symbol: string) => `You can send ${send} ${symbol} · receive ${receive} ${symbol}`,
  /** A channel whose funding is not confirmed yet. */
  READY_SOON: "Ready after a few confirmations.",
  /** The CKB row: what the hub puts in; the field below says what the node does. */
  HUB_FUNDS: (amount: string) => `Hub funds ${amount}`,
  /** A token row: the hub funds it alone; the node needs only CKB for its reserve (with the fee margin). */
  TOKEN_OFFER: (amount: string, reserveCkb: string) => `Hub funds ${amount} · needs ${reserveCkb} CKB reserve`,
  PUTS_IN: "Your node puts in",
  MAX: "Max",
  /**
   * A token row the node may also fund with its own tokens (the hub's peerChannels; own-token-channel.ts): who funds the
   * new channel, as two choices, and what that changes behind its "?".
   */
  FUNDING_LABEL: (symbol: string) => `Who funds the ${symbol} channel`,
  FUND_HUB: "Hub funds it",
  FUND_OWN: (symbol: string) => `Your own ${symbol}`,
  /** A row the node funds itself: the line under it (the CKB reserve with the fee margin). */
  OWN_OFFER: (reserveCkb: string) => `Your node funds it · needs ${reserveCkb} CKB reserve`,
  /** What the node holds of the token on chain, and the hub's minimum, under the field. */
  OWN_HOLDS: (held: string, min: string) => `You hold ${held} on chain · at least ${min}`,
  OWN_READING: (symbol: string) => `Reading your ${symbol} on chain…`,
  OWN_READ_FAILED: (symbol: string) => `Could not read your ${symbol} on chain.`,
  READ_AGAIN: "Read again",
  OWN_TIP_LABEL: (symbol: string) => `About putting in your own ${symbol}`,
  /**
   * The trade-off, honestly: what the node can do with it, what the hub does not add, and the longer hold. The hold is
   * the token's, not this channel's: in a token with peerChannels the hub sizes every hold invoice of a swap to BTC for
   * the longest delay (84 epochs), whichever channel pays (ckbolt-hub docs/architecture.md, "Peer channels").
   */
  OWN_TIP: (symbol: string, tokenReserve: number): string[] => [
    `Your node opens this channel itself, with ${symbol} from its address on chain. It can then pay the hub up to what it put in, such as a swap from ${symbol} to BTC at once.`,
    `The hub adds no ${symbol}, so your node receives over it only what it has paid. Your node also keeps about ${tokenReserve} CKB in it as its reserve, back when the channel closes.`,
    `Because nodes may open their own ${symbol} channels, the hub plans every swap from ${symbol} to BTC for the longest safety delay, over the hub's channel or yours. If the hub stopped mid-swap, your payment could stay locked up to about 10 days before it comes back.`,
  ],
  CONTRIBUTION_ERROR: (min: string) => `Whole CKB, at least ${min}.`,
  /** Before the button: what the ticked rows need on chain, and what the node holds (null while it is read). */
  TOTAL: (needed: string, have: string | null) =>
    have === null ? `Needs ${needed} CKB on chain · reading your balance…` : `Needs ${needed} CKB on chain · you have ${have} CKB`,
  SHORT: (ckb: string) => `Not enough CKB on chain. Add ${ckb} CKB first.`,
  /** The one button. */
  OPEN: (count: number) => (count === 1 ? "Open a channel" : `Open ${count} channels`),
  OPENING_NOW: "Opening…",
  STOP: "Stop",
  STOP_TITLE: "Asks for no more channels. The one under way finishes.",
  /** Why the button waits (its title), when no line on the card says it already. */
  CHOOSE: "Tick at least one token first.",
  BUSY: "Wait until the node's current action finishes.",
  NO_BALANCE: "Wait until the node has read its CKB balance.",
  START_FIRST: "Start the node first.",
  CONNECT_FIRST: "Connect to the hub first.",
  /** Why a row cannot be ticked (its checkbox's title). */
  HAS_CHANNEL: (symbol: string) => `Your node already has a ${symbol} channel with the hub.`,
  HUB_SHORT: (symbol: string) => `The hub cannot fund a new ${symbol} channel right now. Try again later.`,
  ASKED: "Asked for. Its channel shows here soon.",
  IN_RUN: "Being opened now.",
  /** The run's line while it goes. */
  PROGRESS_ASKING: (symbol: string, index: number, total: number) => `Opening the ${symbol} channel, ${index} of ${total}…`,
  PROGRESS_WAITING: (symbol: string) => `Waiting until the ${symbol} channel is funded…`,
  /** The run's summary once it ended (hub-channel-rows.ts HubRunSummary). */
  SUMMARY: {
    allDone: (done: number) =>
      done === 1 ? "Channel asked for. It reads Ready after a few confirmations." : `${done} channels asked for. Each reads Ready after a few confirmations.`,
    someFailed: (done: number, total: number, failed: number) => `${done} of ${total} channels asked for. See the failed ${failed === 1 ? "row" : "rows"}.`,
    noneDone: (total: number) => (total === 1 ? "No channel opened. Its row says why." : "No channel opened. Each row says why."),
    stopped: (done: number, total: number) => `Stopped. ${done} of ${total} channels asked for.`,
  },
  /** requestHubChannel's sentence (kept in History's terms); `amount` and `own` are formatted with their symbol. */
  OPENING: (amount: string, own: string | null = null) =>
    `The hub is opening a channel of ${amount} to your node${own ? `, and your node put in ${own}` : ""}. It reads Ready after a few confirmations.`,
  /** openOwnTokenChannel's sentence: the node opened a channel to the hub with its own tokens. */
  OWN_OPENING: (amount: string) => `Your node is opening a channel of ${amount} to the hub. It reads Ready after a few confirmations.`,
  /**
   * The running node started before the hub served these tokens: fnn reads its token whitelist only at start, so it
   * would not take the hub's channel. Locking it and unlocking it again restarts it with the hub's whitelist.
   */
  RESTART: (symbols: string) => `Restart your node to accept ${symbols} channels: lock it, then unlock.`,
  /** The button beside that line: stops the node; the key form then asks for the password again. */
  LOCK: "Lock node",
  LOCK_BUSY: "Wait until the node's swaps finish.",
} as const;

/** Opening a channel with another node (peer-channel-form.tsx). */
export const PEER_CHANNEL_COPY = {
  TITLE: "Open with another node",
  LEAD: "A channel with another Fiber node. Swaps never use it.",
  TIP_LABEL: "About channels with other nodes",
  TIP: "Your node dials the node and funds the channel from its on-chain CKB. It works for payments to and through that node. The CKBolt hub takes payments only over channels it opened itself, so swaps never use this channel.",
  NODE_ID: "Node id",
  NODE_ID_PLACEHOLDER: "02… or 03…",
  ADDRESS: "WebSocket address",
  ADDRESS_PLACEHOLDER: "/dns4/…/tcp/443/wss",
  ADDRESS_TIP_LABEL: "About the address",
  ADDRESS_TIP: "A browser node dials WebSocket addresses only, and only TLS ones (/wss) from an https page. The node's operator lists it, such as /dns4/node.example/tcp/443/wss.",
  TOKEN: "Token",
  AMOUNT: "Channel amount",
  SUBMIT: "Open channel",
  OPENING_NOW: "Opening…",
  OPENING: (peer: string) => `Opening a channel with ${peer}. It reads Ready after a few confirmations.`,
  HOLDS: (ckb: string) => `Your node holds ${ckb} CKB on chain.`,
  /** `amount` with its symbol. */
  HOLDS_TOKEN: (amount: string) => `Your node holds ${amount} on chain.`,
} as const;

/** A CKB address the visitor gives for the node's CKB (destination-field.tsx), with their CKB wallet as a shortcut. */
export const DESTINATION_COPY = {
  PLACEHOLDER: (prefix: string) => `${prefix}1…`,
  CONNECT_WALLET: "Connect CKB wallet",
  USE_WALLET: (name: string) => `Use ${name}`,
  /** A wallet that gives no name of its own. */
  WALLET_FALLBACK_NAME: "my wallet",
  LOADING_WALLETS: "Loading wallets…",
  WALLET_TIP_LABEL: "About wallets on this page",
  WALLET_TIP:
    "JoyID and other wallets that open a popup cannot open where the node runs. Paste your address, or connect the wallet on the funding page first: it then shows here.",
  WALLET_UNREADABLE: "Your wallet did not give its address. Paste it instead.",
} as const;

/** The node's channels (channel-list.tsx). */
export const CHANNEL_LIST_COPY = {
  LABEL: "Channels",
  EMPTY: "No channels yet.",
  HUB: "CKBolt hub",
  SEND: "Send",
  RECEIVE: "Receive",
} as const;

/** The confirmation of a channel close (channel-list.tsx): where the node's share goes. */
export const CLOSE_COPY = {
  CLOSE: "Close",
  /** The Close button's accessible name: its visible word, then which channel. */
  CLOSE_LABEL: (asset: string, peer: string) => `Close the ${asset} channel with ${peer}`,
  CONFIRM: "Yes, close",
  KEEP: "Keep",
  TITLE: (asset: string, peer: string) => `Close the ${asset} channel with ${peer}?`,
  DESTINATION_LABEL: "Send the node's share to",
  TO_NODE: "This node",
  TO_NODE_NOTE: "Its own address",
  TO_WALLET: "My wallet",
  TO_WALLET_NOTE: "A CKB testnet address",
  WALLET_TIP_LABEL: "About closing to your wallet",
  WALLET_TIP:
    "When the close confirms, fnn pays the node's share of the channel straight to this address (shutdown_channel's close_script), so it never waits at the node. Use an address you control.",
  ADDRESS_LABEL: "Your CKB testnet address",
  NEEDS_ADDRESS: "Enter your address first.",
  /** The notice once fnn started the close. */
  CLOSING_TO_NODE: "Closing the channel cooperatively. Its share returns to the node's address once confirmed.",
  CLOSING_TO_WALLET: (address: string) => `Closing the channel cooperatively. Its share goes to ${address} once confirmed.`,
  HUB_PEER: "the CKBolt hub",
} as const;

/** Withdraw (withdraw-section.tsx): the node's on-chain CKB to the visitor's address. */
export const WITHDRAW_COPY = {
  OPEN: "Withdraw",
  TITLE: "Withdraw on-chain CKB",
  TIP_LABEL: "About withdrawing",
  TIP: "One CKB testnet transaction moves all the CKB at the node's address to yours, minus a small fee. The page opens the node key with your password to sign it, then wipes it. A token the node holds on chain, such as RUSD or cWBTC, is a choice of its own.",
  TITLE_TOKEN: (symbol: string) => `Withdraw on-chain ${symbol}`,
  ASSET_LABEL: "What to withdraw",
  AMOUNT: (ckb: string) => `Sends all ${ckb} CKB, minus a small fee.`,
  TOKEN_AMOUNT: (amount: string, symbol: string) => `Sends all ${amount} ${symbol}. The node pays the fee in CKB.`,
  CHANNELS_NOTE: "CKB in open channels is not included: close them first.",
  TOKEN_CHANNELS_NOTE: "Tokens in open channels are not included: close them first.",
  ADDRESS_LABEL: "To your CKB testnet address",
  PASSWORD_LABEL: "Node password",
  SUBMIT: (ckb: string) => `Withdraw ${ckb} CKB`,
  SUBMIT_TOKEN: (amount: string, symbol: string) => `Withdraw ${amount} ${symbol}`,
  PREPARING: "Preparing…",
  OPENING_KEY: "Opening the key…",
  SENDING: "Sending…",
  CANCEL: "Cancel",
  NEEDS_ADDRESS: "Enter your CKB testnet address first.",
  NEEDS_PASSWORD: "Enter the node password.",
  SENT: (ckb: string, address: string) => `Sent ${ckb} CKB to ${address}. It arrives once the transaction confirms.`,
  SENT_TOKEN: (amount: string, address: string) => `Sent ${amount} to ${address}. It arrives once the transaction confirms.`,
  FEE: "Fee",
  TRANSACTION: "Transaction",
  COPY_HASH: "Copy transaction hash",
  EXPLORER: "View on CKB Explorer (testnet)",
  LOOK_UP: "Look it up on CKB Explorer (testnet)",
  DONE: "Done",
} as const;

/**
 * Pay's requests, confirmed in the node (confirm-request.tsx): the popup's Confirm page, its window, and /app/fiber. The
 * node never pays because a page asked; the visitor confirms here.
 */
export const CONFIRM_COPY = {
  TITLE: "Confirm",
  LEAD_PAYMENT: "The app asks your node to pay.",
  LEAD_ON_CHAIN: "The app asks your node to send CKB on chain.",
  TIP_LABEL: "About confirming here",
  TIP: "A page of CKBolt asked your node for this. Nothing moves until you confirm it here, in your node. Unanswered, it is declined in two minutes.",
  AMOUNT: "Amount",
  TO: "To",
  UNKNOWN_PAYEE: "Not named",
  MAX_FEE: "Max fee",
  FEE: "Network fee",
  NOTE: "Note",
  EXPIRES: "Invoice expires",
  ROUTE: "Route",
  ROUTE_KIND: { direct: "Direct", hub: "Through the CKBolt hub" },
  ROUTE_TIP_LABEL: "About the route",
  ROUTE_TIP:
    "Direct: your node found its own path to the payee. Through the CKBolt hub: your node pays the hub, which finds the path on (trampoline routing). The payment stays locked to the same hash, so the hub cannot keep it: the payee gets it, or it comes back. The hub learns who you paid.",
  PASSWORD_LABEL: "Node password",
  NEEDS_PASSWORD: "Enter the node password.",
  PAY: (amount: string) => `Pay ${amount}`,
  SEND: (amount: string) => `Send ${amount}`,
  SENDING: "Sending…",
  DECLINE: "Decline",
  EMPTY: "Nothing to confirm.",
  WAITING: "The app waits for you to confirm a payment.",
  REVIEW: "Review",
  OUTCOME: {
    sent: "Sent. The app shows the result.",
    declined: "Declined. Nothing was sent.",
    expired: "Not confirmed in time. Nothing was sent.",
    failed: "It did not go through.",
  },
} as const;

/** What History holds and where it is kept, behind its "?" (the node page and the popup's History page). */
export const HISTORY_TIP =
  "Everything that moved money through this node: swaps from the app (the swap card, Pay's and Get paid's Lightning invoices), Pay's Fiber payments and on-chain sends, Get paid's Fiber invoices, channels and withdrawals. The node pays only an invoice the hub confirms for a waiting swap, or what you confirm here. Kept in this browser only, with no invoice or secret; a swap's status comes from the hub. Funds sent to the node's address are not listed: its balance shows them.";

/** The node's History on the node page (activity-panel.tsx; the popup's History page has its own lead). */
export const ACTIVITY_COPY = {
  TITLE: "History",
  LISTENING: "Listening",
  NOT_RUNNING: "Not running",
  LEAD: "Swaps, payments, channels, withdrawals.",
  TIP_LABEL: "About History",
  TIP: HISTORY_TIP,
  KEEP_OPEN: "Keep this page open: your node is still needed to finish a swap or a payment.",
  OPEN_APP: "Open the app",
} as const;

/** The node's address and how to fund it (node-address.tsx). */
export const NODE_ADDRESS_COPY = {
  TITLE: "CKB testnet address of the node",
  COPY: "Copy address",
  QR_ALT: "QR code of the node's CKB testnet address",
  FUND: "Fund this node",
  REFRESH: "Refresh balance",
  FUND_TIP_LABEL: "About funding the node",
  FUND_TIP: (label: string) =>
    `${label} opens a page in a new tab, where your CKB wallet (JoyID and others) signs a transfer of testnet CKB or RUSD to this address. Wallet popups cannot open where the node runs, which is isolated.`,
  FAUCET: "Or claim test CKB at",
  /** After "Get test cWBTC": where, and that it lands at this address. */
  TOKEN_FAUCET: (host: string) => `at ${host}, to this address.`,
} as const;

/** Where the node stands, as the node page and the wallet say it (node-status-notice.tsx). */
export const NODE_STATUS_COPY = {
  LOCKED: "Create or unlock the key to start.",
  STARTING: (version: string, mb: number) => `Starting the node: loading fiber-js ${version} (about ${mb} MB), then syncing…`,
  OTHER_TAB: "This node runs in another tab or window. Use that one, or close it and unlock here.",
  FAILED: "The node could not start. Reload the page and unlock again.",
  NOT_EXCLUSIVE: "No Web Locks here: keep the node open in one tab only.",
} as const;

/** What the node can move now, per token (liquidity-table.tsx). */
export const LIQUIDITY_COPY = {
  LABEL: "What your node can move now",
  ASSET: "Asset",
  SEND: "Send",
  RECEIVE: "Receive",
} as const;

/** Panels of the node page. */
export const FULL_PAGE_COPY = {
  OTHER_NODES: "Channels with other nodes",
} as const;

/** The node's History (history-list.tsx): a line per entry, its detail on demand. */
export const HISTORY_COPY = {
  /** A swap the app kept, by both its sides. */
  SWAP: (pay: string, receive: string) => `Swap: ${pay} → ${receive}`,
  SWAP_PAID: (amount: string) => `Swap: paid ${amount}`,
  SWAP_PAYMENT: (amount: string) => `Swap: payment of ${amount}`,
  SWAP_RECEIVED: (amount: string) => `Swap: received ${amount}`,
  SWAP_PAYOUT: (amount: string) => `Swap: payout of ${amount}`,
  /** A Fiber invoice paid from Pay. */
  PAID: (amount: string) => `Paid ${amount}`,
  PAYMENT: (amount: string) => `Payment of ${amount}`,
  /** A Fiber invoice made for Get paid. */
  REQUEST: (amount: string) => `Request for ${amount}`,
  RECEIVED: (amount: string) => `Received ${amount}`,
  CHANNEL_OPENING: (peer: string, amount: string) => `Opening channel with ${peer} · ${amount}`,
  CHANNEL_OPEN: (peer: string, amount: string) => `Channel with ${peer} · ${amount}`,
  CHANNEL_CLOSING: (peer: string, amount: string) => `Closing channel with ${peer} · ${amount}`,
  CHANNEL_CLOSED: (peer: string, amount: string) => `Closed channel with ${peer} · ${amount}`,
  WITHDREW: (amount: string) => `Withdrew ${amount}`,
  HUB: "the CKBolt hub",
  UNKNOWN_PEER: "a node",
  HASH: "Payment hash",
  TRANSACTION: "Transaction",
  CHANNEL_ID: "Channel",
  PEER: "Peer",
  FEE: "Fee",
  MAX_FEE: "Max fee",
  PAYEE: "Paid to",
  NOTE: "Note",
  VALID_UNTIL: "Valid until",
  SWAP_ID: "Swap id",
  AMOUNT: "Amount",
  /** The entry's token in its detail: the hub's display name (else the app's or the hub's name), with its symbol. */
  TOKEN: "Token",
  TOKEN_NAME: (name: string, symbol: string) => (name === symbol ? symbol : `${name} (${symbol})`),
  ROUTING_FEE: "Routing fee",
  REFUNDED_LINE: "Your payment went back to your wallet.",
  UNREACHABLE: "The hub cannot be reached right now.",
  UNKNOWN_TO_HUB: "The hub has no record of this swap.",
  LIGHTNING_LEG: "On Lightning",
  SATS: (sats: string) => `${sats} sats`,
  TO: "To",
  COPY: (what: string) => `Copy ${what.toLowerCase()}`,
  EXPLORER: "View on CKB Explorer (testnet)",
  FILTER_LABEL: "Show",
  FILTER: { all: "All", payments: "Payments", swaps: "Swaps", channels: "Channels", funds: "Funds" },
  EMPTY: "Nothing yet.",
  NONE_HERE: "Nothing of this kind yet.",
  MISSING: "This node has no record of it.",
} as const;

/** The node page's Diagnostics panel (diagnostics-panel.tsx): a JSON for Fiber developers, and route dry runs. */
export const DIAGNOSTICS_COPY = {
  TITLE: "Diagnostics",
  LEAD: "For Fiber developers looking into a payment: your node's version and channels as JSON. No keys, preimages, passwords or invoices.",
  COPY: "Copy diagnostics",
  READING: "Reading the node…",
  COPIED: "Copied. Paste it where the developer asked.",
  COPY_BLOCKED: "Copy blocked: select the text below instead.",
  READ_FAILED: (reason: string) => `Your node could not report: ${reason}`,
  NOT_SUPPORTED: "this node does not report diagnostics.",
  JSON_LABEL: "Diagnostics JSON",
  ROUTE_LABEL: "Check a route",
  ROUTE_HINT: "Paste a Fiber invoice. Your node only tries to find a route: nothing is paid, and nothing goes to History.",
  ROUTE_PLACEHOLDER: "fibt1…",
  ROUTE_SUBMIT: "Check route",
  ROUTE_CHECKING: "Checking…",
  ROUTE_RESULTS: "Route check",
  ROUTE_IN_JSON: "The outcome is in the next copy.",
  VIA: { direct: "Direct", trampoline: "Through the hub (trampoline)" } as const,
  ROUTE_OK: (fee: string) => `Route found, fee ${fee}`,
  ROUTE_FAILED: (error: string) => `No route: ${error}`,
  ROUTE_SKIPPED: {
    no_hub_node: "Not checked: the hub's Fiber node is not available now.",
    payee_is_hub: "Not needed: the invoice is the hub's own.",
  } as const,
} as const;
