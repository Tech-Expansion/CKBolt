# LND side of the CKBolt swap hub: research notes

Research date: **2026-10-23**. Scope: the Lightning (LND) leg of a hub that swaps BTC on Lightning for CKB/UDT on Fiber,
with both legs locked to the same SHA-256 payment hash through hold invoices.

**Legend**
- **[V]** verified against source or official docs, pinned to a tag where possible
- **[T]** tested on a local regtest stack (LND v0.21.4-beta + bitcoind 29.4 in Docker) on 2026-10-23
- **[I]** inferred: reasoning, arithmetic from verified constants, or secondary sources

**Link prefixes**
- `L/` = `https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/`. Tag commit `390b2d2b7bdcc335c183962e483f5daeceb8f0e7`, reported by `getinfo` in the test.
- API docs: `https://lightning.engineering/api-docs/api/lnd/...`
- Related CKBolt notes: [fiber-node.md](./fiber-node.md) (Fiber RPC and TLC expiry) and [cch.md](./cch.md) (Fiber's built-in Cross-Chain Hub, which already bridges LND and Fiber).

---

## 0. Summary

| Topic | Recommendation |
| --- | --- |
| LND version | **v0.21.4-beta** (2026-10-01). It is the latest stable release. The v0.20.x line still gets patches (v0.20.5-beta). v0.21.5-beta.rc1 and v0.20.6-beta.rc1 came out on 2026-10-22. Pin `lightninglabs/lnd:v0.21.4-beta`. [V] |
| Node library | **`lightning` 13.1.7** (alexbosworth). It ships TypeScript types, needs Node ≥ 22, and supports LND v0.20.0 to v0.21.4. Tested end to end with hold invoices. `ln-service` 60.1.7 is a JS re-export of the same functions. Use raw `@grpc/grpc-js` only for RPCs the library lacks. [V][T] |
| Hub macaroon | Bake one with `info:read invoices:read invoices:write offchain:read offchain:write`. It is enough for every call in this report. Do not ship `admin.macaroon`. [T] |
| Demo network | **Mutinynet**, a custom signet with 30 s blocks. It has an active faucet with Lightning features (pay a BOLT11, open a channel to you, LNURL-withdraw), a Cashu mint, Alby Hub support, and a Voltage sandbox. CLTV values in blocks must be converted at 30 s per block (see §4.4). [V] |
| Local dev | Docker compose with bitcoind regtest and 2 LND nodes (§5). Tested. Polar v4.0.0 is fine as a GUI, but its built-in LND images stop at v0.20.0. [V][T] |
| Key safety rule | The user holds the preimage in both directions. The hub settles the incoming leg only with the preimage learned from the outgoing leg. It cancels the incoming leg only when the outgoing leg is **terminally failed**, and it never lets the incoming HTLC reach `expiry_height − 18` (where LND auto-cancels) while the outgoing leg can still succeed. See §6.4. |

---

## 1. LND release and hold-invoice API

### 1.1 Release status [V]

Source: GitHub releases API, queried 2026-10-23 ([releases page](https://github.com/lightningnetwork/lnd/releases)).

| Tag | Published (UTC) | Kind |
| --- | --- | --- |
| v0.21.5-beta.rc1 / v0.20.6-beta.rc1 | 2026-10-22 | pre-release |
| **v0.21.4-beta** | **2026-10-01** | **stable, "Latest"** |
| v0.20.5-beta | 2026-10-01 | stable (previous line) |
| v0.21.3-beta / v0.20.4-beta | 2026-09-02 | stable |
| v0.21.0-beta | 2026-06-05 | first 0.21 release |
| v0.20.0-beta | 2025-11-20 | |

v0.21.4 release binaries are built with go1.27.1 and include the `invoicesrpc` and `routerrpc` build tags (from the release body). The official Docker image `lightninglabs/lnd:v0.21.4-beta` exists for amd64 and arm64 (Docker Hub, pushed 2026-09-30). [V]

**0.21 changes that matter to the hub** ([L/docs/release-notes/release-notes-0.21.0.md#L285-L326](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/docs/release-notes/release-notes-0.21.0.md?plain=1#L285-L326)) [V]
- `lnrpc.SendPayment`, `SendPaymentSync`, `SendToRoute*`, `routerrpc.SendPayment` and `routerrpc.TrackPayment` were **removed**. Use `routerrpc.SendPaymentV2` and `TrackPaymentV2`. REST `POST /v1/channels/transactions` and related routes are gone too.
- `outgoing_chan_id` was removed from `SendPaymentRequest`. Use `outgoing_chan_ids`.
- `MinCLTVDelta` went from 18 to **24**. Invoices with a custom `cltv_expiry` below 24 are rejected. Tested: `addholdinvoice --cltv_expiry_delta 18` returns `CLTV delta of 18 must be greater than minimum of 24`. [V][T]
- 0.21.0 also fixed a shutdown race between the link and the invoice registry that could deadlock hodl subscriptions (release notes L85-L90). This is a reason to stay on ≥ 0.21.x.

### 1.2 Invoices sub-server: RPCs, REST routes and permissions [V]

Proto: [L/lnrpc/invoicesrpc/invoices.proto](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/lnrpc/invoicesrpc/invoices.proto). REST mapping: [L/lnrpc/invoicesrpc/invoices.yaml](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/lnrpc/invoicesrpc/invoices.yaml). Permissions: [L/lnrpc/invoicesrpc/invoices_server.go#L51-L74](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/lnrpc/invoicesrpc/invoices_server.go#L51-L74).

| RPC | REST | lncli | Macaroon | Notes |
| --- | --- | --- | --- | --- |
| `AddHoldInvoice` | `POST /v2/invoices/hodl` | `addholdinvoice` | `invoices:write` | Ties the invoice to the supplied hash. |
| `SettleInvoice` | `POST /v2/invoices/settle` | `settleinvoice` | `invoices:write` | Settles an **accepted** invoice. "If the invoice is already settled, this call will succeed", so it is idempotent. |
| `CancelInvoice` | `POST /v2/invoices/cancel` | `cancelinvoice` | `invoices:write` | Succeeds if the invoice is already canceled and fails if it is settled. |
| `LookupInvoiceV2` | `GET /v2/invoices/lookup?payment_hash=…` | `lookupinvoice <hash hex>` (tested) | `invoices:write` (sic) | Looks up by `payment_hash`, `payment_addr` or `set_id`. |
| `SubscribeSingleInvoice` | `GET /v2/invoices/subscribe/{r_hash}` | n/a | `invoices:read` | Server stream. "Initially the current invoice state is always sent out." |
| `HtlcModifier` | `POST /v2/invoices/htlcmodifier` | n/a | `invoices:write` | Not needed by the hub. |

API reference pages, all returning 200 on 2026-10-23:
[add-hold-invoice](https://lightning.engineering/api-docs/api/lnd/invoices/add-hold-invoice/),
[settle-invoice](https://lightning.engineering/api-docs/api/lnd/invoices/settle-invoice/),
[cancel-invoice](https://lightning.engineering/api-docs/api/lnd/invoices/cancel-invoice/),
[lookup-invoice-v2](https://lightning.engineering/api-docs/api/lnd/invoices/lookup-invoice-v2/),
[subscribe-single-invoice](https://lightning.engineering/api-docs/api/lnd/invoices/subscribe-single-invoice/).

**`AddHoldInvoiceRequest`** ([invoices.proto#L81-L131](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/lnrpc/invoicesrpc/invoices.proto#L81-L131)) [V]

| Field | Type | Meaning |
| --- | --- | --- |
| `memo` (1) | string | Description, unless `description_hash` is set. |
| `hash` (2) | bytes | SHA-256 payment hash. The preimage is unknown to LND. |
| `value` (3) / `value_msat` (10) | int64 | Amount in sat or msat. Mutually exclusive. |
| `description_hash` (4) | bytes | Used instead of `memo` for long descriptions. |
| `expiry` (5) | int64 | **Payment-request expiry in seconds. Default 86400 (24 h).** This is the time-based expiry of the *offer*, not the HTLC lock. |
| `fallback_addr` (6) | string | On-chain fallback. |
| `cltv_expiry` (7) | uint64 | **Final-hop CLTV delta in blocks.** Default = `bitcoin.timelockdelta` = **80** ([L/lnrpc/invoicesrpc/addinvoice.go#L407-L428](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/lnrpc/invoicesrpc/addinvoice.go#L407-L428), [L/chainreg/chainregistry.go#L127-L129](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/chainreg/chainregistry.go#L127-L129)). Minimum 24 ([L/routing/router.go#L58](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/routing/router.go#L58)). Maximum `MaxFinalCltvDelta` = 65535. |
| `route_hints` (8) | RouteHint[] | Manual hints. |
| `private` (9) | bool | Add hints for private channels. Needed if the hub's channels are unannounced. |

Response: `payment_request`, `add_index`, `payment_addr` ([L133-L156](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/lnrpc/invoicesrpc/invoices.proto#L133-L156)). Defaults were tested: a hold invoice with no `cltv_expiry` decodes to `cltv_expiry 80` and `expiry 86400`. [T]

**`SettleInvoiceMsg`** is `{ preimage: bytes }`. **`CancelInvoiceMsg`** is `{ payment_hash: bytes }`. `LookupInvoiceMsg` is a `oneof` of `payment_hash`, `payment_addr` or `set_id`, plus `lookup_modifier` ([L158-L203](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/lnrpc/invoicesrpc/invoices.proto#L158-L203)). [V]

### 1.3 Invoice states and the fields the hub reads [V][T]

`Invoice.InvoiceState` is `OPEN = 0`, `SETTLED = 1`, `CANCELED = 2`, `ACCEPTED = 3` ([L/lnrpc/lightning.proto#L3959-L3964](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/lnrpc/lightning.proto#L3959-L3964)). For a hold invoice:

```
OPEN --(full amount of HTLC(s) arrives, held)--> ACCEPTED --SettleInvoice(preimage)--> SETTLED
  |                                                 |
  +-- invoice `expiry` (seconds) passes --> CANCELED  +-- CancelInvoice / auto-cancel near CLTV --> CANCELED
```

- **Time-based expiry only cancels OPEN invoices.** The expiry watcher says "Don't force-cancel already accepted invoices" (keysend is the only exception) ([L/invoices/invoice_expiry_watcher.go#L308-L326](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/invoices/invoice_expiry_watcher.go#L308-L326)). After ACCEPTED, only block height matters (§2.5). [V]
- **Per-HTLC data** is in `InvoiceHTLC` ([lightning.proto#L4065-L4110](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/lnrpc/lightning.proto#L4065-L4110)): `chan_id`, `amt_msat`, `accept_height`, `accept_time`, **`expiry_height`** (absolute), and `state` (`ACCEPTED`/`SETTLED`/`CANCELED`). The hub's deadline must use the **minimum `expiry_height` over the invoice's HTLCs**. With MPP there can be several. [V]
- The invoice also carries `amt_paid_msat`, `cltv_expiry`, `payment_request` and `state`.
- MPP: partial HTLC sets are held for at most **120 s** (`DefaultHtlcHoldDuration`) waiting for the rest, then canceled ([L/invoices/invoiceregistry.go#L36-L38](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/invoices/invoiceregistry.go#L36-L38)). [V]
- An incoming HTLC is rejected with `ExpiryTooSoon` if `expiry < height + FinalCltvRejectDelta(19)` or `expiry < height + invoice.cltv_expiry` ([L/invoices/update.go#L292-L299](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/invoices/update.go#L292-L299)). [V]
- Observed stream for a settled swap: `OPEN` (initial snapshot), then `ACCEPTED` with `htlcs[0].expiry_height = 150` at height 107 with `cltv_expiry 40` (107 + 40 + 3 block padding), then `SETTLED`. A canceled swap goes `OPEN`, `ACCEPTED`, `CANCELED`. [T]

### 1.4 REST encoding rules (tested on v0.21.4) [T]

The proto comments say "base64" for `CancelInvoiceMsg.payment_hash` and `LookupInvoiceMsg.payment_hash`, and "base64url" for `SubscribeSingleInvoiceRequest.r_hash` ([invoices.proto#L74-L76, L170-L172, L196](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/lnrpc/invoicesrpc/invoices.proto#L167-L173)). Behaviour measured on the regtest node:

| Where the bytes go | Accepted | Rejected |
| --- | --- | --- |
| **URL path** (`/v2/invoices/subscribe/{r_hash}`, `/v2/router/track/{payment_hash}`) | base64url **with `=` padding** | unpadded base64url (`illegal base64 data at input byte 40`); std base64 with `%2F` (404); hex (`invalid hash length of 48`) |
| **Query string** (`/v2/invoices/lookup?payment_hash=`) | base64url **with padding** | std base64 even when percent-encoded (`illegal base64 data at input byte 0` for a hash starting `++/`); hex |
| **JSON body** | std base64, tested on `POST /v2/invoices/cancel` (`{"payment_hash":"++/77…8="}` canceled the invoice). The same protojson decoding is expected for `/hodl` (`hash`) and `/settle` (`preimage`). [I] | not tested |
| v1 path `/v1/invoice/{r_hash_str}` | hex | |

Response encodings differ by message:
- In `Invoice`, `r_hash`, `r_preimage` and `payment_addr` are std base64 (for example `"++/77/vv…8="`).
- In `Payment` (router stream), `payment_hash` and `payment_preimage` are **hex strings**, because those fields are proto `string`.
- `PayReq.payment_hash` (DecodePayReq) is hex.

Helper:

```ts
const b64url = (hex: string) => Buffer.from(hex, 'hex').toString('base64url') + '='; // 32 bytes -> 43 chars + '='
```

**Streaming over REST** [V][T]
- With plain HTTP, the response is chunked newline-delimited JSON. Each message is `{"result": {...}}` and errors are `{"error": {...}}`. Seen on `/v2/invoices/subscribe` and `/v2/router/send`.
- With WebSocket, open `wss://host:8080/<path>?method=POST|GET`, then send the request JSON as the first message. Browsers cannot set headers, so pass the macaroon as subprotocol `Grpc-Metadata-Macaroon+<hex>` ([L/docs/rest/websockets.md](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/docs/rest/websockets.md)).

### 1.5 Authentication [V][T]

- **gRPC**: TLS with LND's self-signed `tls.cert`, plus metadata `macaroon: <hex>`. **REST**: header `Grpc-Metadata-macaroon: <hex>` over HTTPS with the same cert ([L/docs/macaroons.md#L201-L218](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/docs/macaroons.md?plain=1#L201-L218)).
- The cert SANs are `localhost`, `127.0.0.1`, `::1`, the container IP, and any `--tlsextradomain` / `--tlsextraip`. For a remote hub, set `tlsextradomain` to the hostname the hub dials. [T]
- Default macaroons are `admin`, `readonly` and `invoice`. **`invoice.macaroon` does NOT allow paying.** It has `invoices:rw`, `address:rw` and `onchain:read` ([L/rpcserver.go#L192-L213](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/rpcserver.go#L192-L213)). [V]
- **Least-privilege hub macaroon** [T]: `lncli bakemacaroon info:read invoices:read invoices:write offchain:read offchain:write --save_to swap.macaroon`. This one macaroon ran `getWalletInfo`, `getChannelBalance`, `createHodlInvoice`, `subscribeToInvoice`, `settleHodlInvoice`, `cancelHodlInvoice`, `decodePaymentRequest`, `pay` and REST `/v2/router/send`. The `lightning` typings say `createHodlInvoice` needs `address:write`. In practice it does not unless you ask for a fallback address. [T]
- Permissions that need the `offchain` entity ([L/lnrpc/routerrpc/router_server.go#L91-L110](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/lnrpc/routerrpc/router_server.go#L91-L110), [L/rpcserver.go#L379-L381, L475-L477](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/rpcserver.go#L475-L477)): `SendPaymentV2` needs `offchain:write`. `TrackPaymentV2`, `EstimateRouteFee`, `ChannelBalance` and `DecodePayReq` need `offchain:read`. `GetInfo` needs `info:read`. [V]
- Optional hardening: bake per-method macaroons with `uri:/invoicesrpc.Invoices/AddHoldInvoice …` and add caveats `--timeout` or `--ip_address` ([L/cmd/commands/cmd_macaroon.go#L57-L81](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/cmd/commands/cmd_macaroon.go#L57-L81)). [V]

---

## 2. Paying a BOLT11 invoice from the hub

### 2.1 `routerrpc.SendPaymentV2` / `TrackPaymentV2` [V]

Proto: [L/lnrpc/routerrpc/router.proto#L30-L44, L191-L368](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/lnrpc/routerrpc/router.proto#L191-L368). REST mapping: [router.yaml](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/lnrpc/routerrpc/router.yaml). Docs: [send-payment-v2](https://lightning.engineering/api-docs/api/lnd/router/send-payment-v2/), [track-payment-v2](https://lightning.engineering/api-docs/api/lnd/router/track-payment-v2/).

| RPC | REST | Returns |
| --- | --- | --- |
| `SendPaymentV2(SendPaymentRequest)` | `POST /v2/router/send` | stream of `lnrpc.Payment` |
| `TrackPaymentV2(TrackPaymentRequest{payment_hash, no_inflight_updates})` | `GET /v2/router/track/{payment_hash}` | stream of `lnrpc.Payment`. Current state first. Payments are persisted, so this works after a restart. |
| `TrackPayments` | `GET /v2/router/payments` | all non-terminal payments |
| `EstimateRouteFee` | `POST /v2/router/route/estimatefee` | fee estimate (graph-based, or probe with `payment_request`) |

`SendPaymentRequest` fields the hub should set:

| Field | Hub usage |
| --- | --- |
| `payment_request` | the user's BOLT11 |
| `fee_limit_sat` / `fee_limit_msat` | **Always set.** The proto says that with 0, "only zero-fee routes will be considered", which usually fails with `FAILURE_REASON_NO_ROUTE`. |
| `timeout_seconds` | Time limit for *starting new attempts*. Default 60 s when 0. "Once HTLCs are in flight, the payment will not be aborted until the HTLCs are either settled or failed." |
| **`cltv_limit`** | Maximum total timelock of the route. Defaults to `--max-cltv-expiry` (2016). **This is the hub's main safety lever in the CKB→BTC direction** (§6.4). |
| `max_parts`, `max_shard_size_msat` | MPP; Boltz uses `max_parts = 6`. |
| `no_inflight_updates` | `true` to receive only the final update. |
| `outgoing_chan_ids`, `last_hop_pubkey` | Optional route pinning. |
| `cancelable` | Allows aborting the payment loop before the timeout. In-flight HTLCs can still settle. |
| `amp`, `allow_self_payment`, `dest_custom_records`, `time_pref` | Usually not needed. |

### 2.2 Payment status, failure reasons and the preimage [V][T]

- `Payment.status` is `IN_FLIGHT = 1`, `SUCCEEDED = 2`, `FAILED = 3`, `INITIATED = 4`. `UNKNOWN = 0` is deprecated and never returned ([lightning.proto#L4320-L4335](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/lnrpc/lightning.proto#L4320-L4335)).
- `PaymentFailureReason` ([lightning.proto#L4254-L4291](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/lnrpc/lightning.proto#L4254-L4291)):

  | Value | Meaning |
  | --- | --- |
  | `NONE` | not failed |
  | `TIMEOUT` | timeout reached with routes left to try |
  | `NO_ROUTE` | no route exists, or all failed permanently |
  | `ERROR` | non-recoverable error |
  | `INCORRECT_PAYMENT_DETAILS` | unknown hash, wrong amount or wrong final CLTV. Also what a **canceled hold invoice** looks like to the payer. |
  | `INSUFFICIENT_BALANCE` | not enough local balance |
  | `CANCELED` | payment was canceled |

- **Preimage**: when `status == SUCCEEDED`, `payment_preimage` is a hex string. The hub must check `sha256(preimage) == payment_hash` before using it. The REST stream returned `SUCCEEDED` with `payment_preimage` in one message when `no_inflight_updates` was true. [T]
- **Gotcha [T]**: a payer whose `--timeout 60s` passed while its HTLC sat in our hold invoice later showed `FAILED, reason: FAILURE_REASON_TIMEOUT` once we canceled. Do not read `TIMEOUT` as "the receiver never saw it". Only `status` is authoritative, and only `FAILED` is terminal.

### 2.3 `DecodePayReq` [V][T]

`GET /v1/payreq/{pay_req}` needs `offchain:read` ([decode-pay-req](https://lightning.engineering/api-docs/api/lnd/lightning/decode-pay-req/)). `PayReq` has `destination`, `payment_hash` (hex), `num_satoshis`, `num_msat`, `timestamp`, `expiry`, `description`, `description_hash`, `fallback_addr`, **`cltv_expiry`** (the recipient's min final CLTV), `route_hints`, `payment_addr`, `features` and `blinded_paths` ([lightning.proto#L4538-L4553](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/lnrpc/lightning.proto#L4538-L4553)).

Before paying, the hub must check:
- `payment_hash` equals the swap hash
- the amount equals the quote (reject zero-amount invoices, or pay `amt` explicitly)
- `timestamp + expiry` is not about to pass
- `cltv_expiry` plus the expected route deltas fits inside the `cltv_limit` budget (§6.4)

### 2.4 CLTV mechanics: how long a hold invoice can be held [V][T]

Constants in v0.21.4 ([L/lncfg/config.go#L20-L75](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/lncfg/config.go#L20-L75), [L/lncfg/invoices.go#L4-L9](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/lncfg/invoices.go#L4-L9), [L/routing/payment_session.go#L18-L20](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/routing/payment_session.go#L18-L20), [L/sample-lnd.conf#L1950-L1963, L480-L482](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/sample-lnd.conf#L1950-L1963)):

| Constant | Value | Meaning |
| --- | --- | --- |
| `bitcoin.timelockdelta` | 80 | Default invoice `cltv_expiry` and forwarding delta. |
| `MinCLTVDelta` | 24 | Minimum custom invoice `cltv_expiry`. |
| `BlockPadding` | 3 | The LND sender adds 3 blocks to the final CLTV. |
| `DefaultIncomingBroadcastDelta` | 16 | **Force-close** the channel with an incoming HTLC when 16 blocks are left *and we know the preimage*. |
| `DefaultFinalCltvRejectDelta` | 19 (16+3) | New exit-hop HTLCs closer than this to expiry are rejected. |
| **`invoices.holdexpirydelta`** | **18 (16+2)** | **LND auto-cancels an ACCEPTED hold invoice 18 blocks before the lowest HTLC `expiry_height`, so the channel is not force-closed.** It must stay > 16. Setting 0 disables it, and then the channel force-closes. The hub's `LND_HOLD_EXPIRY_DELTA_BLOCKS` must equal the hub LND's value (the hub accepts 18 or more). |
| `DefaultOutgoingBroadcastDelta` | 0 | Force-close on an outgoing HTLC at its expiry height. |
| `max-cltv-expiry` | 2016 | Maximum total route CLTV when paying. Default for `cltv_limit`. |

**What `cltv_expiry` on a hold invoice means**: the payer builds the route so that the HTLC reaching the hub has `expiry_height ≥ current_height + cltv_expiry (+3)`. The hub can hold that HTLC until `expiry_height − 18`. At that point LND cancels it on its own, and the hub can no longer settle even if it learns the preimage.

**Auto-cancel test** [T]: at height 107, a hold invoice with `cltv_expiry 40` was paid, giving HTLC `expiry_height 150`.
- At height 131 the state was `ACCEPTED`.
- At height 132 (= 150 − 18) the state was `CANCELED`.
- `num_active_channels` stayed 1 and there were no pending force-closes.

**Danger of holding near expiry** [V][I]
- If you disable or shrink `holdexpirydelta`, or LND is offline when the window arrives, the HTLC reaches the 16-block incoming broadcast window. If LND holds the preimage, it force-closes and claims on chain (fees, a channel lost, and a time-critical sweep).
- If you settle only after the payer's upstream node has started timing out, the upstream channels may force-close.
- If the hub learns the preimage after LND has auto-canceled, the hub has paid the outgoing leg and lost the incoming one.
- The hub therefore needs its **own deadline well before `expiry_height − 18`**, and it must keep the outgoing leg's worst-case resolution inside that deadline.

**Practical limits on `cltv_expiry`** [V][I]: payers cap the **total** route CLTV.
- LND `max-cltv-expiry` defaults to 2016.
- CLN `max_htlc_cltv` is 2016 ([ElementsProject/lightning v26.06.9 lightningd/options.c#L977](https://github.com/ElementsProject/lightning/blob/v26.06.9/lightningd/options.c#L977)).
- **LDK** `DEFAULT_MAX_TOTAL_CLTV_EXPIRY_DELTA` is **1008** ([rust-lightning v0.2.7 router.rs#L789](https://github.com/lightningdevkit/rust-lightning/blob/v0.2.7/lightning/src/routing/router.rs#L789)). This covers Alby Hub, ldk-node wallets and others.

Each hop adds its `timelockdelta` (40–144 typical on mainnet). Keep the hold invoice's `cltv_expiry` comfortably below about 1008 minus the route deltas, or some wallets cannot pay.

---

## 3. Node.js / TypeScript libraries

| | `lightning` | `ln-service` | raw `@grpc/grpc-js` + `@grpc/proto-loader` | raw REST (`fetch`/undici) |
| --- | --- | --- | --- | --- |
| Version (npm, 2026-10-23) | **13.1.7** (2026-10-21) | **60.1.7** (2026-10-21) | 1.14.6 (2026-10-08) / 0.8.1 | n/a |
| Maintainer / status | alexbosworth, releases weekly. Changelog 13.1.2: "Add support for LND 0.21.4 / 0.20.5". 13.1.0 fixed `outgoing_channel` after 0.21 removed `outgoing_chan_id`. | Same author. Depends on `lightning@13.1.7` and re-exports its methods. | Google gRPC. Protos are yours to pin. | none |
| LND support | 0.20.0–0.21.4 (README of ln-service) | same | anything you compile | anything |
| TypeScript | **built in** (`index.d.ts` for every method) | none. Its README says "For typescript-ready methods, check out … lightning" | via codegen (ts-proto, protoc-gen-ts) | hand-written |
| Node engine | ≥ 22 | ≥ 22 | ≥ 12 | ≥ 18 |
| Weekly downloads | 12,579 | 4,257 | 34.8 M | n/a |

Sources: npm registry metadata. [lightning CHANGELOG](https://github.com/alexbosworth/lightning/blob/b9423aba203db0530fd67bf3aa6f603955a020ab/CHANGELOG.md) and [ln-service README](https://github.com/alexbosworth/ln-service/blob/1f9940c94cff1fa6145ed02d340603ce6169117e/README.md), both pinned to the master commits of 2026-10-21. [V]

**Method map in `lightning` / `ln-service`** [V][T]

| Hub need | Method | LND call underneath |
| --- | --- | --- |
| create hold invoice | `createHodlInvoice({lnd, id: hashHex, tokens \| mtokens, cltv_delta, expires_at, description, is_including_private_channels})` | `addHoldInvoice` (`cltv_expiry`, `expiry` in seconds from `expires_at`) |
| watch it | `subscribeToInvoice({lnd, id})`, event `invoice_updated` with `is_held`, `is_confirmed`, `is_canceled`, `payments[].timeout` (= HTLC `expiry_height`) | `subscribeSingleInvoice` |
| settle / cancel | `settleHodlInvoice({lnd, secret})` / `cancelHodlInvoice({lnd, id})` | `settleInvoice` / `cancelInvoice` |
| poll / reconcile | `getInvoice({lnd, id})` | `lookupInvoice` |
| pay | `pay({lnd, request, max_fee, max_timeout_height, pathfinding_timeout, max_paths})` or the event emitter `subscribeToPayViaRequest(...)` (`confirmed` gives `secret`; `failed` gives `is_invalid_payment`, `is_route_not_found`, `is_pathfinding_timeout`, `is_insufficient_balance`) | `router.sendPaymentV2` |
| track after restart | `getPayment({lnd, id})`, `subscribeToPastPayment({lnd, id})` | `trackPaymentV2` |
| decode | `decodePaymentRequest({lnd, request})` returns `id`, `tokens`, `mtokens`, `cltv_delta`, `expires_at`, `destination`, `payment` | `decodePayReq` |
| balances | `getChannelBalance({lnd})` | `channelBalance` |

**Library gotchas found in source** ([subscribe_to_pay.js L20-L35, L270-L282, L400-L445](https://github.com/alexbosworth/lightning/blob/b9423aba203db0530fd67bf3aa6f603955a020ab/lnd_methods/offchain/subscribe_to_pay.js#L270-L282)) [V]
- If `max_fee` is omitted, the library sends `maxTokens = '4294967296'` sats as the fee limit, which is effectively unlimited. **Always pass `max_fee` or `max_fee_mtokens`.**
- `timeout_seconds` comes from `pathfinding_timeout` (ms) and defaults to **25 s**.
- `max_timeout_height` is an **absolute** height. The library turns it into `cltv_limit = max_timeout_height − current_height`. Use it for the CKB→BTC deadline.

**End-to-end test** against LND v0.21.4 with the least-privilege macaroon (script in §5.3) [T]:
- settle path: the `invoice_updated` events were not held, then `is_held` with `timeout: 150`, then `is_confirmed`. The payer got `confirmed` with `secret === preimage`.
- cancel path: the payer got `failed` with `{is_invalid_payment: true}`.
- outgoing `pay` with `max_fee: 5` returned a `secret` whose sha256 matched the invoice hash.

**Recommendation** [I]: use **`lightning`** for the TypeScript hub, with one `authenticatedLndGrpc({cert, macaroon, socket})` per node.
- Wrap it in a small `LightningPort` interface so tests can mock it.
- If you need fields the library hides (`HtlcModifier`, `TrackPayments`, `amp`, raw `cltv_limit`), add a thin `@grpc/grpc-js` client generated from the **v0.21.4-beta** protos for those calls only. `lightning` bundles its own protos too.
- Use REST for ops scripts and health checks, not for the swap engine. Its base64 rules (§1.4) are easy to get wrong.
- `ln-service` brings nothing extra and has no types.

---

## 4. Networks for a public live demo

### 4.1 LND support [V]

From sample-lnd.conf ([L/sample-lnd.conf#L655-L679](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/sample-lnd.conf#L655-L679)):
- `bitcoin.testnet` (testnet3)
- `bitcoin.testnet4`, added in LND 0.19.0 ([release-notes-0.19.0.md#L303-L304](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/docs/release-notes/release-notes-0.19.0.md?plain=1#L303-L304))
- `bitcoin.signet`
- `bitcoin.signetchallenge=<hex>` ("Connect to a custom signet network defined by this challenge") and `bitcoin.signetseednode`
- `bitcoin.regtest`, `bitcoin.simnet`

`bitcoin.active` is deprecated and ignored.

Bitcoin Core side: v31.1 still supports testnet3 but prints "Support for testnet3 is deprecated and will be removed in an upcoming release. Consider moving to testnet4" ([bitcoin v31.1 src/chainparamsbase.cpp#L20](https://github.com/bitcoin/bitcoin/blob/v31.1/src/chainparamsbase.cpp#L20), [init.cpp#L953-L955](https://github.com/bitcoin/bitcoin/blob/v31.1/src/init.cpp#L953-L955)). Third-party guides that say testnet3 was removed in v30 are wrong for v31.1. [V]

### 4.2 Lightning activity per network (mempool.space LN stats API, queried 2026-10-23) [V]

| Network | Latest snapshot date | Nodes | Channels | Capacity | Block time |
| --- | --- | --- | --- | --- | --- |
| **Mutinynet** (`mutinynet.com/api/v1/lightning/statistics/latest`) | **2026-10-23** (updated weekly; prior 2026-10-16) | 358 | 934 | 15,360 BTC (signet coins) | **30 s** |
| testnet3 (`mempool.space/testnet/...`) | 2026-05-28 (stale) | 6,088 | 4,302 | 432.6 BTC | ~10 min, with block storms |
| default signet (`mempool.space/signet/...`) | 2025-12-21 (stale) | 228 | 573 | 65.7 BTC | 10 min |
| testnet4 | no LN index on mempool.space (endpoint 404) | ? | ? | ? | ~10 min, 20-min min-difficulty rule |

testnet3 has the largest historical graph. Its stats stopped updating in May 2026 and its future is uncertain. Mutinynet is the only test network here with **current** LN statistics and an operator running LN services on it. [V][I]

### 4.3 Mutinynet facts [V]

- **Chain**: a custom signet with `signetchallenge=512102f7561d208dd9ae99bf497273e16f389bdbd6c4742ddb8e6b216e64fa2928ad8f51ae`, `addnode=45.79.52.207:38333`, `dnsseed=0` and `signetblocktime=30`. It needs **a fork of Bitcoin Core** (`benthecarman/bitcoin`, release `mutinynet-inq-template-hash`, 2026-05-17). Sources: [faucet frontend src/routes/index.tsx#L15-L19](https://github.com/MutinyWallet/mutinynet-faucet/blob/master/src/routes/index.tsx#L15-L19), [MutinyWallet/mutiny-net .env.mutinynet and Dockerfile](https://github.com/MutinyWallet/mutiny-net). The tip height on 2026-10-23 was 3,527,681.
- **Its own LND** runs `lightninglabs/lnd:v0.21.4-beta` with `--bitcoin.signet --bitcoin.node=bitcoind`, pointed at the forked bitcoind. It does **not** set `signetchallenge` in LND ([mutiny-net docker-compose.yml lnd service](https://github.com/MutinyWallet/mutiny-net/blob/master/docker-compose.yml)). The hub can copy this setup. Neutrino on Mutinynet is untested. [V][I]
- **Faucet** ([faucet.mutinynet.com](https://faucet.mutinynet.com), backend [mutinynet-faucet-rs](https://github.com/MutinyWallet/mutinynet-faucet-rs), active and upgraded to LND 0.21). The faucet repos have no release tags, so the links below point at `master` as read on 2026-10-23.
  - `POST /api/onchain`, `/api/lightning` (the faucet **pays any BOLT11**), `/api/channel` (the faucet **opens a channel to you**, "Inbound liquidity to you") and NWC/Arkade all need a **GitHub or L402 login**. `MAX_SEND_AMOUNT` is 1,000,000 sat per request.
  - `POST /api/bolt11` (the faucet creates an invoice so you can pay it back) and the LNURL-withdraw `lnurl1dp68gurn8ghj7enpw43k2apwd46hg6tw09hx2apwvdhk6tmpwp5j7mrww4excac7utxd6` need no login. `/api/bolt11` is limited to 60 requests per day per IP. Source: [src/main.rs#L172-L230](https://github.com/MutinyWallet/mutinynet-faucet-rs/blob/master/src/main.rs).
  - Faucet node: `02465ed5be53d04fde66c9418ff14a5f2267723810176c9212b722e542dc1afb1b@45.79.52.207:9735`. Also listed: the Cashu mint `https://cashu.mutinynet.com`, a Fedimint invite and refund address `refund@lnurl.mutinynet.com`.
  - The faucet pays with `SendPaymentV2` and waits for a terminal status (60 s attempt timeout). **It will pay a hold invoice and wait while the hub holds it** ([src/lightning.rs#L340-L370](https://github.com/MutinyWallet/mutinynet-faucet-rs/blob/master/src/lightning.rs)). [V code][I behaviour]
- **Wallets and services on Mutinynet**:
  - **Alby Hub** (v1.24.4, 2026-10-22) documents Mutinynet config: `NETWORK=signet`, `MEMPOOL_API=https://mutinynet.com/api`, `LDK_ESPLORA_SERVER=https://mutinynet.com/api`, `LDK_GOSSIP_SOURCE=https://rgs.mutinynet.com/snapshot`. It labels testnet "Not recommended - try Mutinynet" ([getAlby/hub README](https://github.com/getAlby/hub#mutinynet)). [V]
  - **Voltage** offers Mutinynet for node-backed sandboxes ([docs.voltage.cloud/dev-sandbox-mutinynet](https://docs.voltage.cloud/dev-sandbox-mutinynet)). [V]
  - Cashu wallets pointed at `cashu.mutinynet.com` should be able to pay invoices through the mint (not tested). [I]
  - Zeus (v13.2.3) handles signet/regtest in recent code, and in remote mode it can drive any LND you run. Mutinynet support in its embedded node is not verified. [I]
  - Phoenix publishes no testnet builds in its recent releases. Mutiny Wallet itself was shut down. [V/I]

### 4.4 Recommendation: Mutinynet for the public demo [I]

Why:
1. **Liquidity people can use.** Visitors can pay the hub's invoice from the faucet ("Pay invoice", GitHub login), from Alby Hub on Mutinynet, or through the Cashu mint. Visitors without a wallet get a working path, which no other test network offers.
2. **Inbound liquidity on request.** The faucet opens channels *to* the hub. The hub opens a channel to the faucet node for outbound.
3. **30 s blocks.** Channel opens confirm in minutes and demo timeouts finish in minutes rather than hours.
4. **Active upkeep.** Faucet backend and LND upgraded in Oct 2026, current LN stats, an esplora/mempool instance, and an RGS server.

**Caveats to design around**
- **Convert CLTV deltas at 30 s per block.** LND's fixed block margins shrink in wall-clock time: `holdexpirydelta` 18 = 9 min, and the default `cltv_expiry` 80 = 40 min. Fiber's legs are long in wall-clock time, so the LN hold invoice needs many more *blocks* (§6.4). Example: a Fiber outgoing TLC of at least 160 min + 4 h ([fiber-node.md](./fiber-node.md)) needs `cltv_expiry` ≈ 1,050 blocks on Mutinynet. That is above **LDK's 1008 total-CLTV cap**, so Alby Hub payers would fail, but the LND faucet (2016) can pay. Keep the Fiber side short: a direct hub→user Fiber channel and `tlc_expiry_limit` set on `send_payment`. Show the faucet as the main payer.
- Fiber's CCH hard-codes about 600 s per BTC block in its expiry checks ([cch.md](./cch.md)). Do not copy that constant to Mutinynet.
- Run the Mutinynet bitcoind fork on the hub's VPS, or use Voltage-hosted LND.
- Also provide a "demo payer" button backed by a second LND node you control. Faucet logins and third-party wallets are outside your control on demo day.

---

## 5. Local development: bitcoind regtest + 2 LND nodes

### 5.1 Images [V]

| Image | Tag | Notes |
| --- | --- | --- |
| `lightninglabs/lnd` | `v0.21.4-beta` | amd64/arm64. Entrypoint `lnd`. Volume `/root/.lnd`. Exposes 9735 and 10009 ([L/Dockerfile](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/Dockerfile)). |
| `lightninglabs/bitcoin-core` | `29.4` (also 30, 31.1) | Entrypoint passes `-…` args to `bitcoind`. Data dir `/home/bitcoin/.bitcoin`. LND 0.21.4 CI tests against bitcoind **29** ([L/.github/workflows/main.yml#L30](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/.github/workflows/main.yml#L30)), so 29.x is the safest regtest backend. |
| `polarlightning/lnd`, `polarlightning/bitcoind` | max `0.20.0-beta` / `30.0` | Polar's images trail. Polar **v4.0.0** (2026-01-06) supports LND up to v0.20.0 natively. To get 0.21.4 in Polar, use its [custom nodes](https://github.com/jamaljsr/polar/blob/master/docs/custom-nodes.md) with `lightninglabs/lnd:v0.21.4-beta`. |

LND does not need `-txindex`. It helps performance only ([L/docs/INSTALL.md#L437-L441](https://github.com/lightningnetwork/lnd/blob/v0.21.4-beta/docs/INSTALL.md?plain=1#L437-L441)). [V]

### 5.2 Minimal compose file (tested 2026-10-23) [T]

All three services were healthy within about 15 s. Run it from a directory named after the project. On Windows Git Bash, export `MSYS_NO_PATHCONV=1` before `docker compose exec … /root/...` paths.

This is the exact file that was tested. The LND flags are written out in each `command:` list because Compose cannot merge a YAML anchor into a list.

```yaml
name: ckbolt-ln-regtest

x-lnd-common: &lnd-common
  image: lightninglabs/lnd:v0.21.4-beta
  restart: unless-stopped
  depends_on: { bitcoind: { condition: service_healthy } }
  healthcheck:
    test: ["CMD", "lncli", "--network=regtest", "getinfo"]
    interval: 5s
    timeout: 5s
    retries: 30

services:
  bitcoind:
    image: lightninglabs/bitcoin-core:29.4
    restart: unless-stopped
    command: [-regtest, -server=1, -txindex=1, -rpcbind=0.0.0.0, -rpcallowip=0.0.0.0/0,
              -rpcuser=lnd, -rpcpassword=lnd, -zmqpubrawblock=tcp://0.0.0.0:28332,
              -zmqpubrawtx=tcp://0.0.0.0:28333, -fallbackfee=0.0002]
    volumes: [bitcoind:/home/bitcoin/.bitcoin]
    ports: ["127.0.0.1:18443:18443"]
    healthcheck:
      test: ["CMD", "bitcoin-cli", "-regtest", "-rpcuser=lnd", "-rpcpassword=lnd", "getblockchaininfo"]
      interval: 5s
      timeout: 5s
      retries: 20

  lnd-hub:
    <<: *lnd-common
    hostname: lnd-hub
    command: [--alias=hub, --tlsextradomain=lnd-hub,
      --bitcoin.regtest, --bitcoin.node=bitcoind,
      --bitcoind.rpchost=bitcoind:18443, --bitcoind.rpcuser=lnd, --bitcoind.rpcpass=lnd,
      --bitcoind.zmqpubrawblock=tcp://bitcoind:28332, --bitcoind.zmqpubrawtx=tcp://bitcoind:28333,
      --noseedbackup, --rpclisten=0.0.0.0:10009, --restlisten=0.0.0.0:8080,
      --listen=0.0.0.0:9735, --trickledelay=50, --debuglevel=info]
    volumes: [lnd-hub:/root/.lnd]
    ports: ["127.0.0.1:10009:10009", "127.0.0.1:8080:8080"]   # gRPC, REST

  lnd-user:
    <<: *lnd-common
    hostname: lnd-user
    command: [--alias=user, --tlsextradomain=lnd-user,
      --bitcoin.regtest, --bitcoin.node=bitcoind,
      --bitcoind.rpchost=bitcoind:18443, --bitcoind.rpcuser=lnd, --bitcoind.rpcpass=lnd,
      --bitcoind.zmqpubrawblock=tcp://bitcoind:28332, --bitcoind.zmqpubrawtx=tcp://bitcoind:28333,
      --noseedbackup, --rpclisten=0.0.0.0:10009, --restlisten=0.0.0.0:8080,
      --listen=0.0.0.0:9735, --trickledelay=50, --debuglevel=info]
    volumes: [lnd-user:/root/.lnd]
    ports: ["127.0.0.1:11009:10009", "127.0.0.1:8081:8080"]

volumes:
  bitcoind:
  lnd-hub:
  lnd-user:
```

Notes:
- `--noseedbackup` creates and unlocks the wallet automatically. **Dev only.**
- Macaroons are at `/root/.lnd/data/chain/bitcoin/regtest/admin.macaroon` and the cert at `/root/.lnd/tls.cert`. Copy them out with `docker compose cp lnd-hub:/root/.lnd/tls.cert .`.
- bitcoind 29+ creates no default wallet. Mine straight to an LND address with `generatetoaddress`, so bitcoind needs no wallet.

### 5.3 Scripted funding and channel open (tested) [T]

```bash
btc()  { docker compose exec -T bitcoind bitcoin-cli -regtest -rpcuser=lnd -rpcpassword=lnd "$@"; }
hub()  { docker compose exec -T lnd-hub  lncli --network=regtest "$@"; }
user() { docker compose exec -T lnd-user lncli --network=regtest "$@"; }
ADDR=$(hub newaddress p2tr | jq -r .address)
btc generatetoaddress 101 "$ADDR"                       # coinbase maturity
until hub getinfo | jq -e .synced_to_chain >/dev/null; do sleep 1; done
PK=$(user getinfo | jq -r .identity_pubkey)
hub connect "$PK@lnd-user:9735"
hub openchannel --node_key "$PK" --local_amt 5000000 --push_amt 2000000   # both sides get liquidity
btc generatetoaddress 6 "$ADDR"
# hold-invoice smoke test
PRE=$(openssl rand -hex 32); HASH=$(echo -n $PRE | xxd -r -p | sha256sum | cut -d' ' -f1)
PR=$(hub addholdinvoice $HASH --amt 10000 --cltv_expiry_delta 40 | jq -r .payment_request)
user payinvoice --force --fee_limit 100 "$PR" &        # blocks while held
hub lookupinvoice $HASH | jq .state                     # "ACCEPTED"
hub settleinvoice $PRE                                  # payer completes; or: hub cancelinvoice $HASH
# least-privilege macaroon for the hub service
hub bakemacaroon info:read invoices:read invoices:write offchain:read offchain:write --save_to /root/.lnd/swap.macaroon
```

The tested script parsed JSON with `python -c 'import json…'` because the test host had no `jq`. The `jq` calls above are the equivalent. Result: hub `channelbalance` 2,996,530 sat local and user 2,000,000 sat. The stack was torn down with `docker compose down -v` after testing.

The library test (`lightning@13.1.7`, `node test.mjs`) followed the flow in §3: `createHodlInvoice`, then `subscribeToInvoice`, a user `subscribeToPayViaRequest`, then `settleHodlInvoice` or `cancelHodlInvoice`, and finally a hub `pay`. All passed.

---

## 6. Prior art and safety rules

### 6.1 Boltz (`boltz-backend` v3.13.0, 2026-05-08) [V]

Prefix `B/` = `https://github.com/BoltzExchange/boltz-backend/blob/v3.13.0/`

- **Reverse swap (LN in → chain out), the same shape as our BTC→CKB.** The user makes the preimage. Boltz creates a hold invoice for the hash, waits for `ACCEPTED`, locks on chain, and settles the invoice only when the user reveals the preimage by claiming ([docs/lifecycle.md](https://github.com/BoltzExchange/boltz-backend/blob/v3.13.0/docs/lifecycle.md)).
  - Accepted handler: [B/lib/swap/LightningNursery.ts#L105-L190](https://github.com/BoltzExchange/boltz-backend/blob/v3.13.0/lib/swap/LightningNursery.ts#L105-L190).
  - Settle: [B/lib/swap/SwapNursery.ts#L966-L1020](https://github.com/BoltzExchange/boltz-backend/blob/v3.13.0/lib/swap/SwapNursery.ts#L966-L1020).
- **Hold invoice CLTV must outlast the other leg.** The hold invoice CLTV is the on-chain timeout converted to LN blocks, **+15 blocks** for same-chain swaps or **+25 %** for cross-chain ones ([B/lib/service/Service.ts#L1918-L1935](https://github.com/BoltzExchange/boltz-backend/blob/v3.13.0/lib/service/Service.ts#L1918-L1935)). `convertBlocks` uses block-time ratios ([B/lib/service/TimeoutDeltaProvider.ts#L84-L94](https://github.com/BoltzExchange/boltz-backend/blob/v3.13.0/lib/service/TimeoutDeltaProvider.ts#L84-L94)).
- **Invoice (offer) expiry is short.** By default it is half the reverse-swap timeout, in seconds ([B/lib/service/InvoiceExpiryHelper.ts#L6-L30](https://github.com/BoltzExchange/boltz-backend/blob/v3.13.0/lib/service/InvoiceExpiryHelper.ts#L6-L30)). Unpaid expired invoices are swept every 60 s ([B/lib/swap/InvoiceNursery.ts](https://github.com/BoltzExchange/boltz-backend/blob/v3.13.0/lib/swap/InvoiceNursery.ts)).
- **Submarine swap (chain in → LN out), the same shape as our CKB→BTC.** When paying the user's invoice, Boltz sets `cltvLimit = blocksLeftOnChainTimeout (converted to LN blocks) − cltvDelta`, with `cltvDelta = 20` by default.
  - Sources: [B/lib/service/TimeoutDeltaProvider.ts#L150-L200](https://github.com/BoltzExchange/boltz-backend/blob/v3.13.0/lib/service/TimeoutDeltaProvider.ts#L150-L200), [B/lib/Config.ts#L285-L290](https://github.com/BoltzExchange/boltz-backend/blob/v3.13.0/lib/Config.ts#L285-L290).
  - It aborts if the limit is below 2 (`PaymentHandler.ts` L117-L176).
  - When creating the swap, it checks routability: the route CLTV must fit before accepting the invoice (`getTimeoutInvoice`, L319-L404).
- **Payment call**: `SendPaymentV2` with `maxParts 6`, `timeoutSeconds 300`, `timePref 0.9`, an explicit `feeLimitSat` and `cltvLimit` ([B/lib/lightning/LndClient.ts#L57-L62, L407-L455](https://github.com/BoltzExchange/boltz-backend/blob/v3.13.0/lib/lightning/LndClient.ts#L407-L455)).
- **Expiry handling**: on on-chain timeout it refunds and marks the swap expired, re-reading state first to avoid double handling ([SwapNursery.ts#L1902-L1940](https://github.com/BoltzExchange/boltz-backend/blob/v3.13.0/lib/swap/SwapNursery.ts#L1902-L1940)). Optional miner-fee **prepay** hold invoice: on-chain funds are locked only once both invoices are held.

### 6.2 Lightning Loop (`loop` v0.35.2-beta, 2026-10-22) [V]

Prefix `P/` = `https://github.com/lightninglabs/loop/blob/v0.35.2-beta/`

- **Loop Out** (LN → chain): the client pays the server's swap invoice (held by the server) and a small **prepay / "no-show" invoice**. The prepay covers the server's on-chain cost if the client never sweeps ([Loop CLI docs](https://docs.lightning.engineering/lightning-network-tools/loop/the-loop-cli)).
  - The client **refuses to reveal the preimage** when fewer than `MinLoopOutPreimageRevealDelta = 20` blocks remain before the HTLC expiry ([P/loopout.go#L49-L51, L1027-L1028, L1474-L1494](https://github.com/lightninglabs/loop/blob/v0.35.2-beta/loopout.go#L1474-L1494)).
  - It raises sweep fees when ≤ 10 blocks remain (`DefaultSweepConfTargetDelta`).
- **Loop In** (chain → LN): the client validates the server's proposed expiry. It rejects anything farther than `MaxLoopInAcceptDelta = 1500` blocks (no locking funds for an arbitrary time) or nearer than `MinLoopInExpiryDelta = 100` ([P/loopin.go#L41-L53, L581-L594](https://github.com/lightninglabs/loop/blob/v0.35.2-beta/loopin.go#L581-L594)).
  - Server terms carry `MinCltvDelta` / `MaxCltvDelta` ([P/client.go#L621-L635](https://github.com/lightninglabs/loop/blob/v0.35.2-beta/client.go#L621-L635)).

### 6.3 Fiber CCH (already bridges LND and Fiber) [V via cch.md]

- Uses `AddHoldInvoice` with `cltv_expiry = 360` blocks ("60 hours (~10 min/block)").
- Fiber final expiry 60 h, order expiry 36 h, minimum outgoing invoice expiry 6 h.
- Lets the outgoing route use at most half of the remaining incoming budget.

Constants: [fiber cch/config.rs#L5-L12](https://github.com/nervosnetwork/fiber/blob/9a561b3e7b786001488b61303a0663d9f4f22259/crates/fiber-lib/src/cch/config.rs#L5-L12). Full analysis in [cch.md](./cch.md). Note the hard-coded 600 s/block. **The 60 h / 360 block values are mainnet-scale and give only about 3 h on Mutinynet.**

### 6.4 Safety rules for the CKBolt hub

Setup: the **end user generates the preimage P** in both directions, and both legs use `H = sha256(P)`.
- Fiber invoices must use `hash_algorithm: "sha256"`; see [fiber-node.md](./fiber-node.md).
- The hub only ever *learns* P from its outgoing leg, so it cannot settle early by mistake. The real risks are timing, the free option, and state loss.

**Direction A: BTC (LN, incoming) → CKB (Fiber, outgoing)**
1. Create the LN hold invoice with `cltv_expiry = C` and a short `expiry` equal to the quote validity (for example 2–10 min). Start the Fiber payment only after `ACCEPTED`, `amt_paid_msat ≥ quote`, and `min(htlcs[].expiry_height) − height ≥ C_required` (re-check; do not trust the invoice value). Also check the quote is still valid at `accept_time`. Otherwise cancel. [V+I]
2. Size C so that the worst-case Fiber outgoing lock ends before the LN auto-cancel point [I]:
   `C ≥ ceil(F_max / t_fast) + holdexpirydelta(18) + m_ln + 3`.
   - `F_max` = the Fiber payment's maximum TLC lock. Cap it with `send_payment.tlc_expiry_limit`. It is at least `final_expiry_delta (≥160 min) + k·4 h` per [fiber-node.md](./fiber-node.md).
   - `t_fast` = a pessimistic *fast* block interval: about 7.5 min on mainnet (Boltz uses +25 %), 0.5 min on Mutinynet (signer-paced).
   - `m_ln` ≥ 6 blocks on mainnet, ≥ 20 on Mutinynet.
3. Then check C against payer limits (LDK 1008 total, LND/CLN 2016). If C is too big, refuse the quote, or shorten the Fiber side (direct channel, smaller `tlc_expiry_limit`). [V+I]
4. On Fiber `Success`: verify `sha256(P) == H`, **persist P first**, then `SettleInvoice(P)`. Retry until it succeeds; it is idempotent. The hard deadline is `expiry_height − 18`. Alert well before that. [V]
5. On Fiber **terminal failure**: `CancelInvoice(H)` at once. **While the Fiber payment is still in flight, never cancel the LN invoice.** P could still appear, and you would pay CKB while refunding BTC. [V+I]

**Direction B: CKB (Fiber, incoming) → BTC (LN, outgoing)**
1. `DecodePayReq` the user's BOLT11 and check `payment_hash == H`, the amount, the invoice expiry, and `cltv_expiry` (the user's min final CLTV). [V]
2. Wait for the Fiber hold invoice to be received/held. Then `SendPaymentV2` with an explicit `fee_limit_*`, `timeout_seconds`, and **`cltv_limit = floor((T_fiber_in_deadline − now − m_f) / t_slow)`**. [I]
   - `t_slow` is a pessimistic *slow* block interval (for example 1.5 × nominal).
   - `m_f` covers Fiber's own early-fail window (fnn fails held TLCs about 160 min + 60 s before expiry per [fiber-node.md](./fiber-node.md)) plus settle latency.
   - Boltz does the same with a fixed 20-block margin.
   - If `cltv_expiry + typical route deltas > cltv_limit`, refuse the swap before the user locks CKB.
3. On `SUCCEEDED`: verify `sha256(payment_preimage) == H`, persist it, then `settle_invoice` on Fiber. On `FAILED`: `cancel_invoice` on Fiber. On `IN_FLIGHT`: keep waiting with `TrackPaymentV2`. `cltv_limit` guarantees a terminal state before the Fiber deadline. [V+I]

**Both directions**
- **Free option** ([Han, Lin, Yu, "On the optionality and fairness of Atomic Swaps", AFT'19](https://eprint.iacr.org/2019/896)) [I]:
  - In A, the user can delay settling the Fiber TLC until near its expiry. In B, the user can hold the LN HTLC until near `cltv_limit`.
  - In both cases the user then completes or aborts depending on the BTC/CKB price, while the hub's liquidity is locked.
  - Mitigations: short lock budgets (`tlc_expiry_limit`, `cltv_limit`), small per-swap caps, quote validity in minutes, a spread or fee that prices the option, per-user rate limits, and optionally a Loop-style non-refundable **prepay** for large swaps.
  - The hub cannot cancel an outgoing HTLC once it is sent, so the lock budget is the only real control.
- **Quote/order expiry**: the hold invoice `expiry` (seconds) equals the quote TTL. LND auto-cancels it if still OPEN. On late `ACCEPTED`, re-price or cancel. [V]
- **Idempotent, restart-safe state machine** [I, Boltz/CCH pattern]:
  - Persist every transition before acting.
  - On startup, `LookupInvoiceV2` every open swap hash and `TrackPaymentV2` every outgoing hash, then re-subscribe (`SubscribeSingleInvoice` sends the current state first).
  - Treat stream disconnects as normal.
- **Uniqueness**: one hash per swap, never reused. LND rejects a duplicate invoice hash. Reject swaps whose hash already exists on either network. [I]
- **Keep LND's protections on**: leave `invoices.holdexpirydelta` at 18 or higher (never ≤ 16). Never set it to 0. Monitor for `CANCELED` events the hub did not request (they mean the deadline logic failed). [V]
  The hub plans with `LND_HOLD_EXPIRY_DELTA_BLOCKS` (default 18), which must equal this setting in `lnd.conf`: a larger value in LND alone would cancel holds before the hub's payout lock ends.
- **Payments**: always set `fee_limit_*`. `lightning.pay` defaults to an unlimited fee. Use `max_parts` > 1 for larger amounts. Watch `INSUFFICIENT_BALANCE` and `NO_ROUTE` to drive rebalancing. [V]
- **Least privilege**: give the swap service only the macaroon from §1.5, bound by IP if possible. Keep `admin.macaroon` for ops only. [T]

---

## 7. Open items and caveats

- Fiber timing numbers (160 min minimum final delta, k·4 h padding, the early-fail margin, and the meaning of `DEFAULT_HOLD_TLC_TIMEOUT = 120 s` in release builds) come from [fiber-node.md](./fiber-node.md). They should be re-checked against a **release** fnn before freezing the `C` / `cltv_limit` formulas. [I]
- The Mutinynet faucet paying a hold invoice and waiting has not been exercised live. The code waits for a terminal status. [I]
- Whether Alby Hub (LDK) can pay hold invoices with `cltv_expiry` around 1,000 on Mutinynet depends on its route CLTV cap (LDK default 1008 total). Test it on Mutinynet before advertising it. [I]
- REST JSON bodies were tested with std base64 only. URL-safe base64 in bodies has not been tested. [T]
