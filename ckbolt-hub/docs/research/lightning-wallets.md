# Visitor Lightning wallets on Mutinynet: research notes

Research date: **2026-10-23**. Scope: how a visitor of the public demo (Bitcoin side on Mutinynet, invoices `lntbs…`)
uses a real Lightning wallet to (a) pay the hub's hold invoice (BTC -> CKB, `ln_to_fiber`) and (b) hand the hub an
invoice for the payout (CKB -> BTC, `fiber_to_ln`). Read with [lnd.md](./lnd.md) §4 (Mutinynet facts) and §2.4/§6.4
(CLTV rules).

**Legend**
- **[V]** verified against source code or official docs, pinned to a tag or commit where possible
- **[T]** tested or measured on 2026-10-23 (live HTTP call, bundle build)
- **[I]** inferred: reasoning, arithmetic from verified constants, or secondary sources

**Link prefixes** (all read on 2026-10-23)
- `LBE/` = `https://github.com/getAlby/lightning-browser-extension/blob/v3.15.0/` (Alby browser extension)
- `HUB/` = `https://github.com/getAlby/hub/blob/v1.24.4/` (Alby Hub)
- `SDK/` = `https://github.com/getAlby/js-sdk/blob/v8.1.1/` (`@getalby/sdk`)
- `BC/` = `https://github.com/getAlby/bitcoin-connect/blob/v3.12.2/` (Bitcoin Connect; npm 3.12.3 has no git tag, the code was read at v3.12.2 and the bundle measured on npm 3.12.3)
- `FRS/` = `https://github.com/MutinyWallet/mutinynet-faucet-rs/blob/9bad44f170e538d7938e1612508d4e52bd21f936/` (faucet backend, master of 2026-10-11)
- `FFE/` = `https://github.com/MutinyWallet/mutinynet-faucet/blob/37b36b17744f0e3eceff123ed1f287c5a4156988/` (faucet frontend, master of 2026-10-20)
- `LDKN/` = `https://github.com/getAlby/ldk-node/blob/87ea53f2e1f32cc7487521776ae10f9e3850a891/` (Alby's ldk-node fork, v0.7.1, used by Alby Hub v1.24.4 through `ldk-node-go` 2026-10-21)
- `RL/` = `https://github.com/lightningdevkit/rust-lightning/blob/v0.2.7/lightning/src/` (the `lightning` crate version in that fork's `Cargo.lock`)

---

## 0. Summary

| Question | Answer |
| --- | --- |
| WebLN today | No versioned spec. [webln.guide](https://www.webln.guide) (GitBook) plus the types in `@webbtc/webln-types` 3.0.0 are the reference. Core: `enable`, `getInfo`, `sendPayment`, `makeInvoice`; optional `sendPaymentAsync`, `keysend`, `getBalance`, `lookupInvoice`, `signMessage`, `lnurl`, `request`, `on/off`. Errors are plain thrown `Error`s with free-text messages. [V] |
| Who implements it | In practice only the **Alby extension** (v3.15.0, 2026-09-17) on desktop. Other providers listed on webln.guide are mostly unmaintained or mobile in-app browsers. [V/I] |
| Alby extension on Mutinynet | Yes, by pasting an **NWC connection secret** of a Mutinynet wallet (Alby Hub run with `NETWORK=signet` and Mutinynet servers; Zeus with its embedded LDK node on Mutinynet). The extension never checks the network. Its **LND, Voltage and LNC connectors cannot pay from LND 0.21+** (they call RPCs removed in 0.21). [V] |
| Network check | WebLN `getInfo` has **no network field**, and the Alby extension drops it even when the wallet reports one. NWC `get_info` has `network` (`signet` for Mutinynet Alby Hub and Zeus) and `block_height` (Mutinynet is about 3.53 M, default signet about 328 k). cashu.me always answers `mainnet`. The reliable checks are the invoice prefix (`lntbs`) and the hub's own validation. [V][T] |
| NWC in the browser | `@getalby/sdk` 8.1.1 `NWCClient`: `payInvoice`, `makeInvoice`, `getInfo`, `lookupInvoice`. Reply timeout is a fixed **60 s**, so paying a hold invoice raises `Nip47ReplyTimeoutError` while the payment is still in flight. About **38 KB gzip**. [V][T] |
| Bitcoin Connect | v3.12.3 (MIT). Good modal, but about **233 KB gzip** (LNC + lit + sdk), its connector list is mostly mainnet custodial wallets, its Alby Hub button goes to Alby Cloud (mainnet), its LNC connector uses an RPC removed in LND 0.21, and its WebLN provider hides `network`. Its dependency `@getalby/lightning-tools` 8.2.0 does `import('crypto')`, which broke a plain browser build. [V][T] |
| Faucet | On-chain, "Pay invoice", "Open channel", "Test NWC" and Arkade need **GitHub login or L402** (L402 = pay about 1,000 **mainnet** sats). No login: `POST /api/bolt11` (60/day/IP) and the LNURL-withdraw endpoint. 1,000,000 sats per request and per IP/user/address per rolling 24 h. API is documented (`/llms.txt`, `/auth.md`, `/openapi.json`); scripts use the GitHub **device flow** (JWT valid 31 days). [V][T] |
| Faucet and hold invoices | It pays with `SendPaymentV2` and waits for a terminal state with no overall timeout, so it **does** pay a hold invoice and keep it in flight. The HTTP call sits behind Cloudflare, so the browser gets an error after about 100 s while the payment continues. [V code][I behaviour] |
| Hold-invoice payers | Alby Hub (LDK) waits for success or failure with no timeout and caps the route CLTV at **1008**; LND (faucet) at 2016. The hub's Mutinynet hold invoice needs **861 blocks** with fnn's default Fiber invoice, so an LDK payer can use at most one 80-block forwarding hop (the faucet). [V][I] |
| makeInvoice CLTV | Alby Hub (LDK 0.2.7): `min_final_cltv_expiry_delta` **42**, expiry 86,400 s. LND (faucet, tested live): **80**, 86,400 s. The hub accepts payout invoices up to about **796** blocks on Mutinynet. [V][T][I] |
| Verify on chain | Lightning payments are off-chain; mutinynet.com (mempool v3.3.2) shows funding/closing txs, nodes and public channels only. Payment proof = hub swap events, wallet history, and `sha256(preimage) == payment_hash`. [V] |
| **Recommendation** | Build a small **"Connect wallet" panel with NWC first (paste secret, `@getalby/sdk/nwc`) plus WebLN when `window.webln` exists**; skip Bitcoin Connect for the Mutinynet demo. Testers use **Alby Hub on Mutinynet in Docker** with a faucet channel. Details in §6. [I] |

---

## 1. WebLN

### 1.1 Spec status and provider API [V]

- Reference: [webln.guide](https://www.webln.guide) (GitBook, page index at [llms.txt](https://www.webln.guide/llms.txt)). No version number, no formal standard body. The type package [`@webbtc/webln-types`](https://www.npmjs.com/package/@webbtc/webln-types) **3.0.0** (2023-12-19, MIT, types only) is the de-facto interface. The old helper package `webln` 0.3.2 (2022-12) is legacy.
- Methods (from `@webbtc/webln-types` 3.0.0 `types/index.d.ts` and the reference pages):

| Method | Signature | Notes |
| --- | --- | --- |
| [`enable()`](https://www.webln.guide/building-lightning-apps/webln-reference/webln.enable) | `Promise<void>` | Asks the user to allow the site. Call before anything else. |
| `isEnabled()` (optional) | `Promise<boolean>` | |
| [`getInfo()`](https://www.webln.guide/building-lightning-apps/webln-reference/webln.getinfo) | `{ node: { alias, pubkey, color? }, version, supports: ("lightning"…)[], methods: string[] }` | **No network field.** |
| [`sendPayment(paymentRequest)`](https://www.webln.guide/building-lightning-apps/webln-reference/webln.sendpayment) | `{ preimage }` | Resolves only when the payment settles. |
| [`sendPaymentAsync(paymentRequest)`](https://www.webln.guide/building-lightning-apps/webln-reference/webln.sendpaymentasync) (optional) | `{}` | "The payment will only be initiated and will not wait for a preimage… useful when paying HOLD invoices… It's up to the receiver to check whether or not the invoice has been paid." Not on every provider. |
| [`makeInvoice(args)`](https://www.webln.guide/building-lightning-apps/webln-reference/webln.makeinvoice) | args `string \| number \| { amount?, defaultAmount?, minimumAmount?, maximumAmount?, defaultMemo? }` (sats); returns `{ paymentRequest }` | "These constraints are enforced by the client's provider, and therefore should not be completely trusted": decode and check the invoice. No expiry or CLTV parameter. |
| [`keysend({ destination, amount, customRecords? })`](https://www.webln.guide/building-lightning-apps/webln-reference/webln.keysend) (optional) | `{ preimage }` | Sender-chosen preimage. **Unusable for the swap**: the keysend onion carries the preimage, so the hub would learn it before paying out. [I] |
| `getBalance`, `lookupInvoice`, `signMessage`, `verifyMessage`, `lnurl`, `request("request.*")`, `on`/`off` | optional | Not needed for swaps. |

### 1.2 Error behaviour [V]

- The guide's [error handling page](https://www.webln.guide/building-lightning-apps/webln-reference/error-handling) only says calls throw on denial, cancel, connection and payment errors. There are **no error codes**.
- Alby extension: the in-page provider rejects with `new Error(<message>)` from the background script ([LBE/src/extension/providers/postMessage.ts](https://github.com/getAlby/lightning-browser-extension/blob/v3.15.0/src/extension/providers/postMessage.ts)). Known messages: `"User rejected"` and `"Prompt was closed"` ([LBE/src/common/constants.ts#L6-L7](https://github.com/getAlby/lightning-browser-extension/blob/v3.15.0/src/common/constants.ts#L6-L7)), `"Provider must be enabled before calling <method>"` ([providerBase.ts](https://github.com/getAlby/lightning-browser-extension/blob/v3.15.0/src/extension/providers/providerBase.ts)), and whatever the wallet returns, for example `"reply timeout: event <id>"` from the NWC client (§2.3).
- Rule for the web app [I]: a rejected `sendPayment` is **not** proof that nothing was paid. Only the hub's swap state is authoritative.

### 1.3 Alby extension v3.15.0 internals that matter [V]

Release v3.15.0, 2026-09-17, MIT ([releases](https://github.com/getAlby/lightning-browser-extension/releases)); Chrome Web Store and Firefox add-on links in its [README](https://github.com/getAlby/lightning-browser-extension/blob/v3.15.0/README.md).

- **Injection**: `window.webln` is injected by a page script that fires `webln:ready` on `window` ([LBE/src/extension/inpage-script/index.js#L17-L18](https://github.com/getAlby/lightning-browser-extension/blob/v3.15.0/src/extension/inpage-script/index.js#L17-L18)); `webln:enabled` fires after `enable()`. In Next.js, read it client-side after that event.
- **getInfo drops the network**: it returns `version: "Alby"`, `supports: ["lightning"]`, the connector's methods and `node: { alias, pubkey, color }` only ([LBE/src/extension/background-script/actions/ln/getInfo.ts](https://github.com/getAlby/lightning-browser-extension/blob/v3.15.0/src/extension/background-script/actions/ln/getInfo.ts)), even when the NWC wallet behind it reports `network`.
- **sendPaymentAsync**: always opens a confirmation prompt, then calls `connector.sendPayment` **without awaiting it** and returns `{}` ([actions/webln/sendPaymentAsyncWithPrompt.ts](https://github.com/getAlby/lightning-browser-extension/blob/v3.15.0/src/extension/background-script/actions/webln/sendPaymentAsyncWithPrompt.ts), [actions/ln/sendPaymentAsync.ts](https://github.com/getAlby/lightning-browser-extension/blob/v3.15.0/src/extension/background-script/actions/ln/sendPaymentAsync.ts): "it is the receiver's responsibility to check if they have received the payment"). Every connector lists it, including NWC ([connectors/nwc.ts#L48-L57](https://github.com/getAlby/lightning-browser-extension/blob/v3.15.0/src/extension/background-script/connectors/nwc.ts#L48-L57)).
- **sendPayment over NWC** calls `NWCClient.payInvoice` and waits ([nwc.ts#L143](https://github.com/getAlby/lightning-browser-extension/blob/v3.15.0/src/extension/background-script/connectors/nwc.ts#L143)); with a hold invoice held longer than 60 s it fails with the NWC reply timeout while the wallet keeps paying (§2.3).
- **makeInvoice** always opens a prompt; `amount` makes the amount read-only, `defaultMemo` pre-fills the memo ([actions/webln/makeInvoiceOrPrompt.ts](https://github.com/getAlby/lightning-browser-extension/blob/v3.15.0/src/extension/background-script/actions/webln/makeInvoiceOrPrompt.ts)). Over NWC it sends `make_invoice { amount: sats*1000, description: memo }` with **no expiry** ([nwc.ts#L126-L141](https://github.com/getAlby/lightning-browser-extension/blob/v3.15.0/src/extension/background-script/connectors/nwc.ts#L126)), so Alby Hub uses its 86,400 s default.
- **No network check anywhere**; invoices are decoded with `bolt11-signet` 1.4.1, which knows the `tbs` prefix, so `lntbs` invoices display correctly. [V]
- **Connectors offered** ([LBE/src/app/router/connectorRoutes.tsx#L239-L253](https://github.com/getAlby/lightning-browser-extension/blob/v3.15.0/src/app/router/connectorRoutes.tsx#L239-L253)): Alby Hub (NWC secret), LND (REST), Lightning Terminal (LNC), Core Lightning (Commando), LNbits, NWC, node distributions (Umbrel, StartOS, RaspiBlitz, myNode, Nirvati), BTCPay, Voltage, Blink, Bitcoin Jungle, LNDHub, Eclair.
- **LND-based connectors are broken on LND 0.21+**: the LND/Voltage connector pays with `POST /v1/channels/transactions` ([connectors/lnd.ts#L118, L164](https://github.com/getAlby/lightning-browser-extension/blob/v3.15.0/src/extension/background-script/connectors/lnd.ts#L118)) and the LNC connector with `lightning.sendPaymentSync` ([connectors/lnc.ts#L279, L325](https://github.com/getAlby/lightning-browser-extension/blob/v3.15.0/src/extension/background-script/connectors/lnc.ts#L279)). LND 0.21 removed both ([lnd.md §1.1](./lnd.md)). The faucet and the CKBolt hub run 0.21.4. A tester's own LND would have to be ≤ 0.20.x for these connectors. [V code][I effect]

### 1.4 Other WebLN providers in 2026 [V/I]

[webln.guide providers page](https://www.webln.guide/ressources/webln-providers): Alby, Joule, Kollider, kwh, OneKey (desktop); Blixt, BlueWallet, Breez, OneKey (mobile in-app browsers); Kiwi Browser.
- Joule's repo is gone (404 on GitHub) and kwh was last pushed in 2019. [V]
- None of the listed providers documents Mutinynet support. Blixt and BlueWallet are maintained (pushed Oct 2026) but run their own nodes and are not a desktop-browser path. [I]
- Practical answer: the **Alby extension connected to a Mutinynet wallet over NWC** is the only realistic WebLN provider for the demo. [I]

### 1.5 Connecting the Alby extension to a Mutinynet wallet

| Wallet behind the extension | Works? | How |
| --- | --- | --- |
| **Alby Hub, self-hosted on Mutinynet** | **Yes** [V config][I end to end] | Run Alby Hub with the Mutinynet env (§6.1). In Alby Hub: Connections, "Alby Browser Extension" (or a custom connection), copy the secret. In the extension: wallets menu, "+ Add", "Bring Your Own Wallet", "Find Your Wallet", "Nostr Wallet Connect" (or "Alby Hub"), paste ([Alby guide](https://guides.getalby.com/user-guide/browser-extension/link-wallet/alby-hub-via-nwc-link)). |
| Zeus (v13.2.3) with its embedded LDK node on Mutinynet, NWC service on | Probably [V code][I] | Zeus has an LDK backend with a `mutinynet` network option and esplora `https://mutinynet.com/api` ([utils/LdkNodeUtils.ts](https://github.com/ZeusLN/zeus/blob/v13.2.3/utils/LdkNodeUtils.ts)) and an NWC wallet service ([stores/NostrWalletConnectStore.ts](https://github.com/ZeusLN/zeus/blob/v13.2.3/stores/NostrWalletConnectStore.ts)). Not tested. |
| cashu.me with mint `https://cashu.mutinynet.com` | Experimental [V code][I] | cashu.me's NWC service supports `pay_invoice`, `make_invoice`, `get_info`, `get_balance`, `list_transactions`, `lookup_invoice` ([src/stores/nwc.ts#L76-L105](https://github.com/cashubtc/cashu.me/blob/eaed970bd5ae8bc40e9f376d73713295bf6fa72e/src/stores/nwc.ts#L76-L105)). Paying a hold invoice becomes a pending mint melt; untested. The mint is live (Nutshell 0.21.0, NUT-04/05 bolt11) [T]. |
| Your own LND on Mutinynet via the LND/Voltage/LNC connectors | **No** on LND ≥ 0.21 | Removed RPCs (§1.3). |
| "The Mutinynet faucet's NWC" | **No** | The faucet's "Test NWC" tile is an NWC **client**: you paste *your* wallet's secret and the faucet page sends `pay_invoice` / `multi_pay_invoice` for 21-sat faucet invoices ([FFE/src/components/NWC.tsx](https://github.com/MutinyWallet/mutinynet-faucet/blob/37b36b17744f0e3eceff123ed1f287c5a4156988/src/components/NWC.tsx)). It provides no wallet. [V] |
| Alby Cloud (`my.albyhub.com`), Alby account | No | Mainnet; no Mutinynet option found. [I] |
| NWC Faucet (`faucet.nwc.dev`) | No | Dummy sub-wallets of an Alby Hub; "Balances are not real and exist only inside the NWC Faucet". [V page][I] |

### 1.6 Telling a Mutinynet wallet from a mainnet one

- WebLN (any provider): impossible from `getInfo` (§1.1, §1.3). [V]
- NIP-47 `get_info.network` is `mainnet | testnet | signet | regtest` ([NIP-47 `get_info`](https://github.com/nostr-protocol/nips/blob/d47a2ec8aacb9d01ac00e6294ae77582f483ff68/47.md)):
  - Alby Hub returns its `NETWORK` (`signet` on Mutinynet; `bitcoin` is rewritten to `mainnet`), plus `block_height` and `block_hash`, **only if the connection has the `get_info` permission** ([HUB/nip47/controllers/get_info_controller.go#L73-L101](https://github.com/getAlby/hub/blob/v1.24.4/nip47/controllers/get_info_controller.go#L73-L101), [HUB/lnclient/ldk/ldk.go#L993-L1004](https://github.com/getAlby/hub/blob/v1.24.4/lnclient/ldk/ldk.go#L993-L1004)). [V]
  - Zeus LDK on Mutinynet: `signet` ([backends/LdkNode.ts#L238-L252](https://github.com/ZeusLN/zeus/blob/v13.2.3/backends/LdkNode.ts#L238-L252), [NostrWalletConnectStore.ts#L1931-L1962](https://github.com/ZeusLN/zeus/blob/v13.2.3/stores/NostrWalletConnectStore.ts#L1931-L1962)). [V]
  - cashu.me: always `network: "mainnet"`, `block_height: 1` ([nwc.ts#L93-L105](https://github.com/cashubtc/cashu.me/blob/eaed970bd5ae8bc40e9f376d73713295bf6fa72e/src/stores/nwc.ts#L93-L105)). [V]
- `block_height` separates Mutinynet from default signet: tips on 2026-10-23 12:05 UTC were Mutinynet **3,528,733**, default signet **327,618**, mainnet **972,772** (mempool APIs). The hub's `GET /v1/health` already returns `lightning.blockHeight` ([contract/responses.ts#L97](../../src/interfaces/http/contract/responses.ts)). [T]
- Recommended checks [I]:
  1. BTC -> CKB: just pay. A mainnet wallet cannot pay an `lntbs` invoice (LND refuses invoices of another network; LDK finds no route to an unknown node). Show the wallet's error, keep the swap view.
  2. CKB -> BTC: decode the returned invoice (`decodeBolt11` in `ckbolt-web/lib/bolt11.ts` already maps `lntbs` to `signet`) and refuse anything that is not the hub's network or not the quoted amount, before calling the hub. The hub validates again (`invoice_invalid`).
  3. NWC only: warn (do not block) when `get_info.network` is not `signet` or `block_height` is far from the hub's `blockHeight`; cashu.me would trip a hard block.

---

## 2. Nostr Wallet Connect (NIP-47) in the browser

### 2.1 Protocol status [V]

- NIP-47 was trimmed to a core in 2026: `pay_invoice`, `make_invoice`, `lookup_invoice`, `get_balance`, `get_info`, the info event, NIP-44/NIP-04 encryption, error codes `RATE_LIMITED, NOT_IMPLEMENTED, INSUFFICIENT_BALANCE, QUOTA_EXCEEDED, RESTRICTED, UNAUTHORIZED, INTERNAL, UNSUPPORTED_ENCRYPTION, OTHER`, plus `PAYMENT_FAILED` for `pay_invoice` and `NOT_FOUND` for `lookup_invoice` ([NIP-47 @ d47a2ec, 2026-10-22](https://github.com/nostr-protocol/nips/blob/d47a2ec8aacb9d01ac00e6294ae77582f483ff68/47.md)).
- Optional features moved to [nostr-wallet-connect/nwc](https://github.com/nostr-wallet-connect/nwc) (commit 2e2070d, 2026-10-20): 02 notifications (`payment_received`, `payment_sent`), 03 hold invoices (`make_hold_invoice` with `min_cltv_expiry_delta`, `hold_invoice_accepted`), 04 keysend, 05 history, 08 client-created connections, 13 budgets, among others.
- Connection string: `nostr+walletconnect://<wallet pubkey>?relay=<wss url>&secret=<32-byte hex>[&lud16=…]`. The secret is a spending key: treat it like a password and keep it out of logs and URLs.

### 2.2 Wallets on Mutinynet that can give an NWC connection string

| Wallet | NWC string on Mutinynet | `pay_invoice` on a hold invoice | `make_invoice` | Notes |
| --- | --- | --- | --- | --- |
| **Alby Hub v1.24.4, self-hosted** (LDK backend) | **Yes** [V] | Waits until success or failure, no timeout ([HUB/lnclient/ldk/ldk.go#L600-L713](https://github.com/getAlby/hub/blob/v1.24.4/lnclient/ldk/ldk.go#L600-L713)) | Yes; LDK default CLTV 42, expiry 86,400 s (§4.2) | The recommended tester wallet. Apache-2.0. |
| Alby Hub with an LND backend (`LN_BACKEND_TYPE=LND`) pointed at a Mutinynet LND | Yes [V README][I] | LND waits | Yes | Only for testers who already run LND. |
| Zeus v13.2.3, embedded LDK on Mutinynet | Probably [V code][I] | Its NWC handler uses a 120 s payment timeout constant ([NostrWalletConnectStore.ts#L82](https://github.com/ZeusLN/zeus/blob/v13.2.3/stores/NostrWalletConnectStore.ts#L82)); behaviour on a long hold not tested | Yes (rate limited to 5 per minute per connection) | Mobile; untested on Mutinynet. |
| cashu.me + `cashu.mutinynet.com` | Yes [V code] | Mint melt, pending while held [I] | Mint quote invoice from "Cashu LND" [I] | Reports `mainnet`; experimental. |
| Mutinynet faucet | **No** (it is an NWC client, §1.5) | | | |
| Coinos, Primal, Flash, Rizful, LNFi, Alby Cloud | No (mainnet services) [I] | | | Shown by Bitcoin Connect. |

### 2.3 Paying and making invoices over NWC with `@getalby/sdk` [V]

`@getalby/sdk` **8.1.1** (2026-10-21, MIT on npm; [release](https://github.com/getAlby/js-sdk/releases/tag/v8.1.1)). Import the subpath `@getalby/sdk/nwc` (exports map in its `package.json`).

```ts
import { NWCClient, Nip47ReplyTimeoutError, Nip47WalletError } from "@getalby/sdk/nwc";

const nwc = new NWCClient({ nostrWalletConnectUrl: secretFromUser }); // keep it in memory or sessionStorage
const info = await nwc.getInfo();         // { alias, pubkey, network, block_height, block_hash, methods, ... }

// BTC -> CKB: pay the hub's hold invoice, then follow the hub, not the wallet
try {
  await nwc.payInvoice({ invoice: swap.pay.invoice });  // resolves with { preimage } only after the hub settles
} catch (e) {
  if (!(e instanceof Nip47ReplyTimeoutError)) throw e;  // 60 s passed: the payment is probably still held
}

// CKB -> BTC: ask the wallet for the payout invoice
const tx = await nwc.makeInvoice({ amount: quoteSats * 1000, description: "CKBolt swap payout", expiry: 3600 });
// tx.invoice is the BOLT11; decode it and check network + amount before POST /v1/swaps
```

- **Timeouts**: every request has a publish timeout (5 s) and a reply timeout (**60 s**) ([SDK/src/nwc/NWCClient.ts#L909-L937](https://github.com/getAlby/js-sdk/blob/v8.1.1/src/nwc/NWCClient.ts#L909-L937)); `payInvoice` does not let the caller change them ([L514-L529](https://github.com/getAlby/js-sdk/blob/v8.1.1/src/nwc/NWCClient.ts#L514-L529)). The wallet service keeps paying after the client gives up (Alby Hub has no `expiration` tag support, per its README). [V]
- `make_invoice` params: `amount` (msat), `description`, `description_hash`, `expiry` (s), `metadata` ([SDK/src/nwc/types.ts#L215-L221](https://github.com/getAlby/js-sdk/blob/v8.1.1/src/nwc/types.ts#L215-L221)). There is no CLTV parameter. [V]
- Errors: `Nip47WalletError` (wallet answered with a NIP-47 code, `.code`), `Nip47ReplyTimeoutError`, `Nip47PublishTimeoutError`, `Nip47NetworkError` ([types.ts#L16-L38](https://github.com/getAlby/js-sdk/blob/v8.1.1/src/nwc/types.ts#L16-L38)). [V]
- A second `pay_invoice` for the same hash while the first is pending fails in LDK with `DuplicatePayment` ([LDKN/src/payment/bolt11.rs#L104-L114](https://github.com/getAlby/ldk-node/blob/87ea53f2e1f32cc7487521776ae10f9e3850a891/src/payment/bolt11.rs#L104-L114)), so an accidental retry does not pay twice. [V]
- One-click pairing with a self-hosted Alby Hub: `NWCClient.fromAuthorizationUrl("http://localhost:8029/apps/new", { name: "CKBolt", requestMethods: ["pay_invoice", "make_invoice", "get_info", "lookup_invoice"], maxAmount, budgetRenewal })` opens the hub's approval page in a popup and receives the connection by `postMessage` ([SDK/src/nwc/NWCClient.ts#L265-L345](https://github.com/getAlby/js-sdk/blob/v8.1.1/src/nwc/NWCClient.ts#L265-L345), [HUB/README.md "/apps/new deeplink options"](https://github.com/getAlby/hub/blob/v1.24.4/README.md)). The user must type their hub URL. [V code][I UX]
- Transport: WebSockets to the wallet's relay (Alby Hub default `wss://relay.getalby.com`, `wss://relay2.getalby.com`). ckbolt-web's CSP sets no `connect-src` today, so nothing blocks it; add the relays if a `connect-src` is introduced. [V]

### 2.4 Bitcoin Connect [V][T]

| Item | Value |
| --- | --- |
| Packages | `@getalby/bitcoin-connect` **3.12.3** and `@getalby/bitcoin-connect-react` 3.12.3 (npm, 2026-05-23; last GitHub release v3.12.2, 2026-02-18; repo active, pushed 2026-10-20). React peer `>=18.2.0`, so React 19.2 is accepted. |
| Licence | MIT |
| Dependencies | `@getalby/sdk ^8.0.3` (resolves 8.1.1), `@getalby/lightning-tools ^8.1.1` (resolves 8.2.0), `@lightninglabs/lnc-web 0.3.6-alpha`, `qrcode-generator`, `zustand`. |
| API | `init({ appName, filters, showBalance, persistConnection, providerConfig })`, `requestProvider()`, `launchModal()`, `launchPaymentModal({ invoice, onPaid, onCancelled })` returning `setPaid`, `connectNWC(url)`, `disconnect()`, `onConnected/onDisconnected`, components `Button`, `PayButton`, `Connect`, `Payment` ([BC/README.md](https://github.com/getAlby/bitcoin-connect/blob/v3.12.2/README.md)). Next.js: import client-side only (`next/dynamic`, `ssr: false`). It no longer sets `window.webln` by itself. |
| Connectors | Alby Hub (buttons: Alby Cloud = `https://my.albyhub.com/apps/new`, Alby Go, Connection Secret), Coinos, Flash, Primal, cashu.me, Rizful, generic NWC, LNFi, LNbits, LNC, plus the browser extension when `window.webln` exists ([BC/src/components/bc-connector-list.ts](https://github.com/getAlby/bitcoin-connect/blob/v3.12.2/src/components/bc-connector-list.ts), [pages/bc-alby-hub.ts#L55-L56](https://github.com/getAlby/bitcoin-connect/blob/v3.12.2/src/components/pages/bc-alby-hub.ts#L55-L56)). For Mutinynet only "Connection Secret", generic NWC, cashu.me and the extension are usable. |
| Network | Its NWC WebLN provider drops `network` from `getInfo` ([SDK/src/webln/NostrWeblnProvider.ts#L148-L170](https://github.com/getAlby/js-sdk/blob/v8.1.1/src/webln/NostrWeblnProvider.ts#L148-L170)); reach `provider.client.getInfo()` through `WebLNProviders.NostrWebLNProvider`. Its `sendPaymentAsync` fires `payInvoice` without waiting ([L208-L217](https://github.com/getAlby/js-sdk/blob/v8.1.1/src/webln/NostrWeblnProvider.ts#L208-L217)). |
| LNC connector | Pays with `lightning.sendPaymentSync` ([BC/src/connectors/LNCConnector.ts#L116](https://github.com/getAlby/bitcoin-connect/blob/v3.12.2/src/connectors/LNCConnector.ts#L116)), removed in LND 0.21. Loads `https://lightning.engineering/lnc-v0.3.6-alpha.wasm` at run time when used. |
| Bundle size [T] | esbuild 0.25.10, minified ESM, browser target, importing `init, launchModal, requestProvider, WebLNProviders`: **748,733 B raw / 238,885 B gzip** (lnc-web 311 KB, bitcoin-connect incl. lit/twind 246 KB, sdk 130 KB, lightning-tools 21 KB, qrcode 21 KB). For comparison `NWCClient` from `@getalby/sdk/nwc` alone: **111,211 B / 38,816 B gzip**. WebLN direct: 0 B (types only). |
| Build gotcha [T] | The browser build failed until `crypto` was marked external: `@getalby/lightning-tools` 8.2.0 contains `await import('crypto')` (from its L402 server utilities). Next.js may polyfill or fail on it; run `next build` before adopting. [I for Next.js] |

**Is Bitcoin Connect the better UX for this Next.js app?** [I]
- For a mainnet product, yes: a maintained, familiar modal with many wallets and a payment modal.
- For the Mutinynet demo, no. Most of its tiles lead to mainnet wallets that cannot pay `lntbs` invoices, its Alby Hub button opens Alby Cloud (mainnet), it adds about 233 KB gzip (LNC cannot be tree-shaken out of the modal), and it hides the network. A hand-made panel with two options (browser extension via WebLN, "paste NWC secret" via `@getalby/sdk/nwc`) costs about 38 KB gzip, shows only what works on Mutinynet, and lets the app handle the 60 s reply timeout as "payment held".

### 2.5 WebLN vs NWC vs Bitcoin Connect

| | WebLN (`window.webln`) | NWC (`@getalby/sdk/nwc`) | Bitcoin Connect |
| --- | --- | --- | --- |
| Needs | A desktop extension (Alby) connected to a Mutinynet wallet | A Mutinynet wallet with an NWC service; works on any browser and mobile | Same as its connectors |
| Bundle | 0 | ~38 KB gzip | ~233 KB gzip |
| Network visible | No | Yes (`network`, `block_height`; wallet-dependent) | No (unless you reach the inner client) |
| Hold-invoice payment | `sendPaymentAsync` returns at once; `sendPayment` waits, or errors after 60 s over NWC | `payInvoice` errors after 60 s while still paying | Same as underlying provider |
| Prompts | Extension confirms every payment and invoice (budgets can skip payment prompts) | None in the page; the wallet enforces the connection's budget | Modal |
| Mutinynet-only UI | Yes | Yes | No |

---

## 3. The Mutinynet faucet (faucet.mutinynet.com)

### 3.1 What it offers [V]

From the frontend tiles ([FFE/src/routes/index.tsx#L15-L43](https://github.com/MutinyWallet/mutinynet-faucet/blob/37b36b17744f0e3eceff123ed1f287c5a4156988/src/routes/index.tsx#L15-L43)), backend routes ([FRS/src/main.rs#L186-L232](https://github.com/MutinyWallet/mutinynet-faucet-rs/blob/9bad44f170e538d7938e1612508d4e52bd21f936/src/main.rs#L186-L232)) and the live [llms.txt](https://faucet.mutinynet.com/llms.txt), [auth.md](https://faucet.mutinynet.com/auth.md) and [openapi.json](https://faucet.mutinynet.com/openapi.json) [T]:

| Feature | Endpoint | Login | Notes |
| --- | --- | --- | --- |
| On-chain sats | `POST /api/onchain {sats, address}` | **Yes** | Max 1,000,000 per request; BIP21 accepted. |
| Pay a BOLT11 / LNURL / Lightning address | `POST /api/lightning {bolt11}` | **Yes** | Returns `{payment_hash}` only after the payment is final (§3.4). |
| Open a channel to you | `POST /api/channel {capacity, push_amount, pubkey, host?}` | **Yes** | Capacity ≤ 1,000,000; public channel; if `host` is omitted the faucet uses an existing peer connection ([FRS/src/channel.rs#L27-L100](https://github.com/MutinyWallet/mutinynet-faucet-rs/blob/9bad44f170e538d7938e1612508d4e52bd21f936/src/channel.rs#L27-L100)). Gives you inbound liquidity, plus spendable sats if you push. |
| Test NWC (zaps, keysends, multi-pay) | client-side + `/api/bolt11` | UI asks for login | It pays faucet invoices **from your wallet** (§1.5). |
| Arkade | `POST /api/arkade` | **Yes** | |
| Faucet invoice to pay back / test receive | `POST /api/bolt11 {amount_sats}` | **No** | 60 per IP per day. Live test: `lntbs10u…`, `min_final_cltv` **80**, expiry **86,400 s**, no route hints. [T] |
| LNURL-withdraw | `GET /api/lnurlw`, then `GET /api/lnurlw/callback?k1=…&pr=<bolt11>` | **No** (the UI shows it only after login) | `lnurl1dp68…utxd6` decodes to `https://faucet.mutinynet.com/api/lnurlw`; max 1,000,000 sats; k1 single-use, valid 600 s; 60 k1 per IP per day ([main.rs#L703-L800](https://github.com/MutinyWallet/mutinynet-faucet-rs/blob/9bad44f170e538d7938e1612508d4e52bd21f936/src/main.rs#L703-L800)). The callback pays any BOLT11 `pr` through the same code as `/api/lightning`. |
| Plug-in info | n/a | No | Faucet node `02465ed5be53d04fde66c9418ff14a5f2267723810176c9212b722e542dc1afb1b@45.79.52.207:9735` (437 active channels, forwards with `cltv_delta` 80 [T]); Cashu mint `https://cashu.mutinynet.com`; a Fedimint invite; refund address `refund@lnurl.mutinynet.com`. |

### 3.2 Limits [V]

- `MAX_SEND_AMOUNT` 1,000,000 sats per request ([main.rs#L172](https://github.com/MutinyWallet/mutinynet-faucet-rs/blob/9bad44f170e538d7938e1612508d4e52bd21f936/src/main.rs#L172)).
- 1,000,000 sats per identifier per rolling 24 h, checked for the IP, the GitHub user and (on-chain) the address at once; channel capacity counts against it ([FRS/src/payments.rs#L150-L169](https://github.com/MutinyWallet/mutinynet-faucet-rs/blob/9bad44f170e538d7938e1612508d4e52bd21f936/src/payments.rs#L150-L169)). Premium users are exempt. `GET /api/limits` (login) reports what is left.
- A failed Lightning payment releases its reservation; an ambiguous one (transport error) stays counted ([lightning.rs#L299-L320](https://github.com/MutinyWallet/mutinynet-faucet-rs/blob/9bad44f170e538d7938e1612508d4e52bd21f936/src/lightning.rs#L299-L320)).

### 3.3 API access from a script [V][T]

- Base URL `https://faucet.mutinynet.com` (Cloudflare in front: `Server: cloudflare`, `CF-RAY`) [T]. CORS allows only the faucet's own origin, so a browser app on another origin cannot read its responses ([main.rs#L278-L292](https://github.com/MutinyWallet/mutinynet-faucet-rs/blob/9bad44f170e538d7938e1612508d4e52bd21f936/src/main.rs)). Use it from scripts or the faucet page.
- Auth header: `Authorization: Bearer <JWT>` or `Authorization: L402 <token>:<preimage>` ([FRS/src/auth.rs#L373-L440](https://github.com/MutinyWallet/mutinynet-faucet-rs/blob/9bad44f170e538d7938e1612508d4e52bd21f936/src/auth.rs#L373)).
- **GitHub device flow** (JWT valid **31 days**). The source differs from `auth.md`: the faucet does not start the device flow, it exchanges a GitHub access token ([main.rs#L493-L570](https://github.com/MutinyWallet/mutinynet-faucet-rs/blob/9bad44f170e538d7938e1612508d4e52bd21f936/src/main.rs#L493-L570)):
  1. `GET https://faucet.mutinynet.com/auth/github/client_id` returns `{"client_id":"Ov23liIa6qfR9KtYHwUF"}` [T].
  2. `POST https://github.com/login/device/code` with `client_id=Ov23liIa6qfR9KtYHwUF&scope=user:email` (header `Accept: application/json`) returns `user_code`, `device_code`, `verification_uri` [T: device flow is enabled for this app].
  3. Approve the `user_code` at `https://github.com/login/device`; poll `POST https://github.com/login/oauth/access_token` with `client_id`, `device_code`, `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
  4. `POST https://faucet.mutinynet.com/auth/github/device` with `{"code":"<github access token>"}` returns `{"token":"<JWT>"}`. The faucet checks that the token was issued to its own OAuth app and that the primary e-mail is verified.
- **Web login**: `/auth/github` redirects back with `?token=` (JWT valid 24 h).
- **L402**: `POST /api/l402` returns `{invoice, token, claim}`; the invoice is a **mainnet** invoice (default 1,000 sats, `L402_INVOICE_AMOUNT`; the live price was not checked) valid 10 min; the credential lasts 24 h ([FRS/src/l402.rs#L14-L58](https://github.com/MutinyWallet/mutinynet-faucet-rs/blob/9bad44f170e538d7938e1612508d4e52bd21f936/src/l402.rs#L14-L58), [setup.rs#L113-L115](https://github.com/MutinyWallet/mutinynet-faucet-rs/blob/9bad44f170e538d7938e1612508d4e52bd21f936/src/setup.rs#L113-L115)).

### 3.4 Can the faucet pay a hold invoice and wait? [V code][I behaviour]

- `pay_lightning` sends `SendPaymentV2` with `timeout_seconds: 60` (time to start new attempts only), an explicit fee limit, `no_inflight_updates: true`, default `cltv_limit` (so LND's `max-cltv-expiry`, 2016 by default), then reads the stream until `SUCCEEDED` or `FAILED` with **no overall timeout** ([FRS/src/lightning.rs#L23, L336-L371](https://github.com/MutinyWallet/mutinynet-faucet-rs/blob/9bad44f170e538d7938e1612508d4e52bd21f936/src/lightning.rs#L336-L371)). A held HTLC therefore stays in flight until the hub settles or cancels.
- The request is synchronous and passes through Cloudflare, whose proxy read timeout is 100 s on standard plans. Expect the faucet page (or `curl`) to show an error (524) for holds longer than about 100 s, while LND keeps the payment going. The hub's swap status is the truth. [I]
- The same applies to the LNURL-withdraw callback, which awaits the payment before answering `{"status":"OK"}`.
- Not exercised live in this research (it needs a hub hold invoice on Mutinynet). [I]

---

## 4. Hold-invoice compatibility and CLTV

### 4.1 The hub's numbers on Mutinynet [V code][I arithmetic]

From `TIMING_PROFILES.mutinynet` (`src/common/constants/timing.constants.ts`): fast block 30 s, slow 45 s, `lndHoldExpiryDeltaBlocks` 18, `lnMarginBlocks` 20, `lnRouteBudgetBlocks` 160 (two LND hops of 80), `payerMaxCltv` 1008 (LDK), `maxFiberHops` 1, `fiberMarginMs` 10 min, `maxPayoutLockMs` 12 h.

- **BTC -> CKB hold invoice** (`planLnToFiber`): Fiber payout lock = user's Fiber invoice `final_expiry_delta` + 1 × 4 h + 10 min. With fnn's default and minimum 160 min: 410 min = 820 blocks; `cltv_expiry` = 820 + 18 + 20 + 3 = **861 blocks** (about 7.2 h). A Fiber invoice with a longer final delta makes the CLTV exceed 1008 and the hub refuses the quote.
- **CKB -> BTC payout invoice** (`planFiberToLn`): `cltv_limit` cap = floor(12 h / 45 s) = 960; needs invoice CLTV + 3 + 1 + 160 ≤ 960, so the payout invoice's `min_final_cltv_expiry_delta` may be up to about **796 blocks**.

### 4.2 Wallet behaviour

| Payer / payee | Pays a hold invoice and keeps it in flight | Route CLTV cap when paying | `makeInvoice` `min_final_cltv` | Default invoice expiry |
| --- | --- | --- | --- | --- |
| **Alby Hub v1.24.4 (LDK, ldk-node 0.7.1, lightning 0.2.7)** | **Yes**: waits for `PaymentSuccessful` / `PaymentFailed`, no timeout ([HUB/lnclient/ldk/ldk.go#L600-L713](https://github.com/getAlby/hub/blob/v1.24.4/lnclient/ldk/ldk.go#L600-L713)); LDK retries new routes for 50 s only ([LDKN/src/config.rs#L60](https://github.com/getAlby/ldk-node/blob/87ea53f2e1f32cc7487521776ae10f9e3850a891/src/config.rs#L60)) [V] | **1008**, hard-coded `MaxTotalCltvExpiryDelta: 1008` ([ldk.go#L640](https://github.com/getAlby/hub/blob/v1.24.4/lnclient/ldk/ldk.go#L640)) [V] | **42** = `MIN_FINAL_CLTV_EXPIRY_DELTA` = `HTLC_FAIL_BACK_BUFFER` (36 + 3) + 3, used because `Receive` passes none ([RL/ln/channelmanager.rs#L3099, L12599-L12643](https://github.com/lightningdevkit/rust-lightning/blob/v0.2.7/lightning/src/ln/channelmanager.rs#L3099), [RL/chain/channelmonitor.rs#L277-L330](https://github.com/lightningdevkit/rust-lightning/blob/v0.2.7/lightning/src/chain/channelmonitor.rs#L277-L330), [LDKN/src/payment/bolt11.rs#L546-L556](https://github.com/getAlby/ldk-node/blob/87ea53f2e1f32cc7487521776ae10f9e3850a891/src/payment/bolt11.rs#L546-L556), [ldk.go#L877](https://github.com/getAlby/hub/blob/v1.24.4/lnclient/ldk/ldk.go#L877)) [V] | 86,400 s when the request gives none, max 24 h ([HUB/lnclient/models.go#L258](https://github.com/getAlby/hub/blob/v1.24.4/lnclient/models.go#L258), [ldk.go#L72](https://github.com/getAlby/hub/blob/v1.24.4/lnclient/ldk/ldk.go#L72)) [V] |
| **LND 0.21.4** (faucet, Cashu mint's node, the hub) | Yes ([lnd.md §2](./lnd.md)) [V] | 2016 (`max-cltv-expiry`) [V] | 80 (`bitcoin.timelockdelta`); faucet invoice tested live [T] | 86,400 s [T] |
| Core Lightning | Yes, `pay` blocks until resolved [I] | 2016 (`max_htlc_cltv`, [lnd.md §2.4](./lnd.md)) [V] | not checked | |
| Zeus LDK backend | Probably; NWC handler timeout 120 s [I] | LDK default 1008 unless overridden [I] | 42 if it uses ldk-node's default [I] | |
| cashu.me via the Mutinynet mint | Melt goes pending; untested [I] | mint's LND, 2016 [I] | mint's LND, 80 [I] | mint quote expiry (unknown) |

### 4.3 What this means for LDK payers [I]

- LDK counts the invoice's final CLTV plus every forwarding hop's delta against 1008. With the hub's 861, an Alby Hub payer has **147 blocks** for forwarding hops. The faucet forwards with 80, so **Alby Hub -> faucet -> CKBolt hub (941) fits; any route with a second 80-block hop (1021) fails** with "no route".
- Operational rule: the CKBolt hub's LND must have a channel with the faucet node (inbound for BTC -> CKB, as [lnd.md §4.4](./lnd.md) already says), and tester wallets should have their channel with the faucet too. A direct tester-to-hub channel also works (861).
- LND payers (faucet) have 2016, so they can use longer routes.
- Every `makeInvoice` result seen (42, 80) is far below the hub's ~796 limit for payout invoices.
- After a hub cancel (refund) the payer sees `incorrect_or_unknown_payment_details` ([lnd.md §2.2](./lnd.md)); Alby Hub returns "received payment failed event: …".

---

## 5. Verifying a payment on Mutinynet

- Explorer: [mutinynet.com](https://mutinynet.com), a mempool instance (mempool v3.3.2 released 2026-10-23) with Lightning enabled. Pages: `/tx/<txid>`, `/address/<addr>`, `/lightning`, `/lightning/node/<pubkey>`, `/lightning/channel/<short_id>` (routes from [mempool lightning.routing.module.ts](https://github.com/mempool/mempool/blob/master/frontend/src/app/lightning/lightning.routing.module.ts)). API with `Access-Control-Allow-Origin: *`: `/api/blocks/tip/height`, `/api/tx/<txid>`, `/api/v1/lightning/nodes/<pubkey>`, `/api/v1/lightning/channels?public_key=<pk>&status=open`, `/api/v1/lightning/statistics/latest` [T].
- What it shows: faucet funding transactions, channel opens and closes, public channels with their policies (for example the faucet node: 437 active channels, `cltv_delta` 80 [T]). Lightning payments, HTLCs and unannounced channels are **not** visible on any explorer.
- How a tester proves a swap paid [I]:
  1. `GET /v1/swaps/:id/events` on the hub: `incoming_accepted`, `outgoing_succeeded`, `succeeded` (or `failed` with `refunded`).
  2. The wallet's history: Alby Hub "Transactions" shows the outgoing payment as pending while held, then settled with a preimage; or NWC `lookup_invoice` / `list_transactions`.
  3. Check `sha256(preimage) == payment_hash` of the invoice (the web app's `decodeBolt11` gives the hash).
  4. For channel or funding problems, look up the txid or node on mutinynet.com.

---

## 6. Recommendation and tester setup

### 6.1 Tester wallet: Alby Hub on Mutinynet (Docker, one-time, about 10 minutes) [V config][I flow]

Env names and values from [HUB/README.md#L254-L351](https://github.com/getAlby/hub/blob/v1.24.4/README.md) and [HUB/config/models.go#L26-L50](https://github.com/getAlby/hub/blob/v1.24.4/config/models.go#L26-L50). Image tag `ghcr.io/getalby/hub:v1.24.4` exists [T]; `rgs.mutinynet.com/snapshot/0` and `mutinynet.com/api` answer [T]. Port 8029 avoids ckbolt-web's 8080.

```bash
docker run -d --name albyhub-mutinynet --restart unless-stopped \
  -v albyhub-mutinynet:/data -e WORK_DIR=/data \
  -e NETWORK=signet \
  -e MEMPOOL_API=https://mutinynet.com/api \
  -e LDK_ESPLORA_SERVER=https://mutinynet.com/api \
  -e LDK_GOSSIP_SOURCE=https://rgs.mutinynet.com/snapshot \
  -p 127.0.0.1:8029:8080 ghcr.io/getalby/hub:v1.24.4
```

1. Open `http://localhost:8029`, set an unlock password, skip the Alby account. (`LDK_ESPLORA_SERVER` must be set: the default chain source is Alby's mainnet Electrum server.)
2. Peers, connect peer (`/peers/new`): `02465ed5be53d04fde66c9418ff14a5f2267723810176c9212b722e542dc1afb1b@45.79.52.207:9735`. Copy your node's pubkey from the node page.
3. On [faucet.mutinynet.com](https://faucet.mutinynet.com), sign in with GitHub, choose "Open channel", paste your pubkey (no host needed while connected), capacity 500,000, push 50 %. Wait for the channel in Alby Hub `/channels` (LDK waits for 6 confirmations, about 3 minutes). You now have about 250,000 sats to spend and about 250,000 inbound. Alby Hub accepts this announced channel because it sets an alias and listening address by default ([HUB/lnclient/ldk/ldk.go#L142-L168](https://github.com/getAlby/hub/blob/v1.24.4/lnclient/ldk/ldk.go#L142-L168), [LDKN/src/config.rs `may_announce_channel`](https://github.com/getAlby/ldk-node/blob/87ea53f2e1f32cc7487521776ae10f9e3850a891/src/config.rs#L316-L326)).
4. Connections, add a connection (`/apps/new`): name "CKBolt test", permissions `pay_invoice`, `make_invoice`, `get_info`, `lookup_invoice`, budget for example 300,000 sats. Copy the `nostr+walletconnect://…` secret.
5. Either paste it into the CKBolt app's NWC field (once built, §7), or connect the Alby extension: "+ Add", "Bring Your Own Wallet", "Nostr Wallet Connect", paste.

### 6.2 Test runs

- **BTC -> CKB**: create the swap, then "Pay with wallet" (NWC or WebLN), or paste the hold invoice into Alby Hub's Send page. The payment stays pending in Alby Hub until the hub settles. A wallet or extension "timeout" after 60 s is expected; do not pay again (LDK would refuse a duplicate anyway). Follow the swap page or `/v1/swaps/:id/events`.
- **CKB -> BTC**: "Create invoice with wallet" (`makeInvoice` with the quoted sats), or Alby Hub Receive with that amount, and give the `lntbs` invoice to the swap form. Without any wallet: `curl -X POST https://faucet.mutinynet.com/api/bolt11 -H 'Content-Type: application/json' -d '{"amount_sats": <quoted sats>}'` gives a faucet invoice (the payout then goes back to the faucet).
- **No wallet at all, BTC -> CKB**: pay the hold invoice with the faucet's "Pay invoice" tile (GitHub login). Ignore an error page after about 100 s; check the swap status. Script variant without login: `GET https://faucet.mutinynet.com/api/lnurlw` for a `k1`, then `GET https://faucet.mutinynet.com/api/lnurlw/callback?k1=<k1>&pr=<hold invoice>` (counts against the faucet's per-IP budget; use sparingly).

### 6.3 Hub prerequisites [I]

- The hub's Mutinynet LND has a channel **from** the faucet (inbound, so payers can reach it in one 80-block hop) and **to** the faucet (outbound, for payouts).
- Keep the Mutinynet profile's hold CLTV at or below 1008 (it is 861 with fnn's default Fiber invoice); otherwise only LND payers (faucet) can pay.

---

## 7. Integration notes for ckbolt-web [I]

- Add a client-only "Connect wallet" panel: "Browser wallet (WebLN)" when `window.webln` exists (listen for `webln:ready`), and "Paste NWC secret" (optionally "Connect my Alby Hub" through `fromAuthorizationUrl` with a user-entered hub URL). Load `@getalby/sdk/nwc` with a dynamic import so the landing page does not pay for it.
- Pay: prefer `webln.sendPaymentAsync` when `getInfo().methods` lists it; otherwise `sendPayment` / `payInvoice` without awaiting the result for UI state. Treat `Nip47ReplyTimeoutError`, `"reply timeout"` and `"Prompt was closed"` after confirmation as "maybe sent", and drive the UI from the hub's swap state only.
- Receive: `makeInvoice({ amount: quoteSats, defaultMemo })` (WebLN) or `makeInvoice({ amount: quoteSats * 1000, description, expiry })` (NWC); decode with `lib/bolt11.ts`, check network and amount, then create the swap.
- Network hint: with NWC, compare `get_info.network` and `block_height` with `/v1/health` `lightning.network` and `blockHeight`, and warn on mismatch rather than block (cashu.me reports `mainnet`).
- Store the NWC secret in memory or `sessionStorage`, never in the URL or logs; offer "Disconnect".
- Never use keysend for swaps (§1.1).

---

## 8. Open items and caveats

- Nothing in this note paid a CKBolt hold invoice on Mutinynet end to end; the hub's public Mutinynet deployment does not exist yet. Behaviour of Alby Hub, the faucet and Zeus while a hold lasts minutes is read from code. [I]
- Cloudflare's 100 s timeout on the faucet is a documented Cloudflare default, not measured here. [I]
- Zeus's embedded LDK on Mutinynet and cashu.me with the Mutinynet mint were not tried. [I]
- Bitcoin Connect inside Next.js 16 (Turbopack) was not built; only a plain esbuild browser build, which failed on `import('crypto')`. [T][I]
- The live L402 price and whether the faucet's LND sets a non-default `max-cltv-expiry` are unknown. [I]
- Mutinynet versus default signet cannot be told apart from an invoice prefix (both `lntbs`); an invoice from a default-signet node would pass the prefix check and fail at routing. [I]
