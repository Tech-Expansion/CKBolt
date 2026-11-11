# A real Fiber wallet for CKBolt visitors: browser node, CCC funding, isolation, alternatives

Research date: **2026-10-23**. Written for the CKBolt "connect a real Fiber wallet" flow: a website visitor pays the hub's
Fiber hold invoice (`fiber_to_ln`) or receives a Fiber payout (`ln_to_fiber`) on CKB testnet, using a CKB wallet they
already have through CCC (`@ckb-ccc/connector-react`: JoyID, MetaMask, UTXO Global...).

Companion document: [`fiber-node.md`](./fiber-node.md) (fnn as a hub, RPC details). This document goes deeper on the
browser side and does not repeat it.

**Pinned sources.** Fiber code references are to tag **`v0.9.1`** = commit `9a561b3e7b786001488b61303a0663d9f4f22259`,
shortened to **`P/`** = `https://github.com/nervosnetwork/fiber/blob/v0.9.1/`. `develop` HEAD at research time:
`2620b5b3fdca082092ce57797d0c22b65c33af59` (2026-10-19), shortened to **`D/`**. Other repositories are pinned to the
commit read (listed in the appendix).

**Labels**
- **[V]**: verified on 2026-10-23 from source code at the pinned ref, a live endpoint, npm metadata, or official docs.
- **[V, test]**: verified by our own experiment on 2026-10-23 in headless Chromium **151.0.7922.34** (Playwright 1.55
  from `ckbolt-web`), against CKB testnet where stated. Method in the [appendix](#appendix-b-experiments-run).
- **[I]**: inferred from reading code paths, computed from code constants, or not checked against a running system.
- **[D]**: stated by a doc, issue or commit message only.

---

## 0. Answers in short

1. **fiber-js is a full fnn compiled to WASM** that runs in two Web Workers, talks to CKB over a public JSON-RPC URL, keeps
   its state in IndexedDB and dials peers over **WSS only**. npm latest is **0.9.1** (2026-09-11), built from the same
   commit as fnn v0.9.1. It started on CKB testnet in our test in 4.7 s (1.5 s on reload), connected to `bottle` over WSS
   in 0.5 s, created a SHA-256 hold invoice and cancelled it. [V, test]
2. **The app owns the keys.** `start()` takes the P2P key and the CKB key as raw bytes; fiber-js never stores or encrypts
   them. Reference apps keep them in plain `localStorage` (fiber.world labs, Fiber Wallet) or derive them from a password
   (scrypt) or a passkey (WebAuthn PRF) each session (`@fiber-pay/sdk`). Same keys + same IndexedDB prefix = same node
   after a reload. [V, V test]
3. **Funding from a CCC wallet works by a plain transfer.** The node's CKB address is a standard secp256k1-blake160 address
   of the CKB key (`node_info.default_funding_lock_script`), so any CCC signer, JoyID included, can send CKB or RUSD to it.
   The node then signs its own funding transactions. The alternative, **external funding** (the CCC wallet signs the
   funding transaction directly), exists since v0.8.0 but JoyID is disabled in the only reference wallet with the comment
   "the official version of fiber-js does not support it yet". [V]
4. **Minimums.** Public nodes `bottle`/`bracer` auto-accept a CKB channel from **499 CKB** funding (400 usable; they add
   250 CKB, giving 151 CKB inbound) and RUSD from **20 RUSD** (they add 0 RUSD). Every channel side, opener or acceptor,
   locks a reserve of **99 CKB** (CKB channel) or **180 CKB** (RUSD channel, computed). So even a receive-only visitor needs
   about 100 CKB on-chain at the node address. [V live `node_info` + code; 180 CKB is I]
5. **Browser node ↔ hub channel: yes, but only browser-initiated connections.** A WASM node cannot listen
   ("There is no listening_addr on wasm"), so the hub can never dial it. Once the browser has dialled the hub's **WSS**
   address, the session is bidirectional: the browser can open a channel to the hub, and the hub can `open_channel` to the
   browser node's pubkey while that tab stays connected. The hub needs a TLS proxy (`/dns4/<domain>/tcp/443/wss`) in
   front of fnn's WebSocket listener, which the current `deploy/testnet` stack does not have yet. [V code; I end to end]
6. **COOP `same-origin` breaks JoyID through CCC.** CCC's JoyID signer is popup-only and waits for `postMessage` from the
   popup while polling `popup.closed`. Under COOP `same-origin` the popup gets `opener = null` and the opener sees
   `closed = true` at once, so CCC rejects with `PopupCancelledError`. `same-origin-allow-popups` keeps the popup but loses
   isolation (no `SharedArrayBuffer`). **`Document-Isolation-Policy: isolate-and-credentialless`** gives isolation **and**
   working popups, but only in Chromium (Chrome/Edge 137 desktop, Chrome Android 146; not Firefox or Safari). [V, test]
7. **No mainstream CKB wallet speaks Fiber.** JoyID dropped Lightning and has no Fiber; UTXO Global and Neuron have none.
   The usable "real wallets" today are the desktop app **Fiber Studio** v1.1.2 (Windows/macOS/Linux, bundles fnn 0.9.0,
   creates SHA-256 invoices, pays invoices), a self-run **fnn**, and experimental web wallets (Fiber Wallet, CKB KeyWay,
   Polymeer). [V]
8. **Risk is moderate and mostly operational:** a 15 MB (6.9 MB gzip) bundle and 100 MB of shared buffers, no watchtower
   in the WASM node, slow gossip sync, a fiber-js `stop()` bug that can cut IndexedDB writes (fixed on `develop`, not
   released), the tab must stay open while a payment is in flight, and **fnn 0.10 refuses to open or accept channels with
   0.9.x peers**, so the hub, fiber-js and the public nodes must upgrade together. Estimate: **2 to 3 weeks** for one
   developer for a solid testnet flow. [V/I]

Recommendation: see [§6](#6-recommendation-for-ckbolt).

---

## 1. `@nervosnetwork/fiber-js`

### 1.1 Package and provenance [V]

| Fact | Value | Source |
|---|---|---|
| Latest version | **0.9.1**, published 2026-09-11 10:41 UTC | [npm](https://www.npmjs.com/package/@nervosnetwork/fiber-js), `npm view … time` |
| Built from | `gitHead` `9a561b3e…` = fnn **v0.9.1** | `npm view @nervosnetwork/fiber-js@0.9.1 gitHead` |
| Versions | 0.5.1 (2025-08-06) … 0.9.0-rc1..rc7, **0.9.0** (2026-08-06), **0.9.1**. No 0.10.x on npm, although `develop` already bumped `fiber-js` to v0.10.0-rc1 (commit `647a7203`, 2026-09-25). | npm, [D/fiber-js](https://github.com/nervosnetwork/fiber/tree/2620b5b3fdca082092ce57797d0c22b65c33af59/fiber-js) |
| Source | `fiber-js/` (TypeScript wrapper), `crates/fiber-wasm` (fnn as WASM), `crates/fiber-wasm-db-worker` (IndexedDB) | [P/fiber-js](https://github.com/nervosnetwork/fiber/tree/v0.9.1/fiber-js) |
| Licence | MIT (`package.json`) | [P/fiber-js/package.json](https://github.com/nervosnetwork/fiber/blob/v0.9.1/fiber-js/package.json) |
| Bundle | One ESM file `dist/index.js` of **15.06 MB** (WASM base64-inlined, workers inlined and started from `blob:` URLs); **6.9 MB gzip, 4.9 MB brotli**. Unpacked package 30.5 MB with the source map. | measured on the npm tarball |
| Runtime deps | `async-mutex`, `stream-browserify`; `yaml` is bundled for `getDefaultConfig` | `package.json` |

### 1.2 API [V]

Source: [P/fiber-js/src/index.ts](https://github.com/nervosnetwork/fiber/blob/v0.9.1/fiber-js/src/index.ts),
[P/fiber-js/README.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/fiber-js/README.md).

```ts
import { Fiber, randomSecretKey } from "@nervosnetwork/fiber-js";
const fiber = new Fiber(inputBufferSize?, outputBufferSize?);           // default 50 MiB each (SharedArrayBuffer)
const yaml = fiber.getDefaultConfig("testnet", "https://testnet.ckbapp.dev/"); // bundled v0.9.1 config, ckb.rpc_url replaced
await fiber.start(yaml, fiberKeyPair: Uint8Array, ckbSecretKey?: Uint8Array,
                  chainSpec?: string, logLevel = "info", databasePrefix = "/wasm");
await fiber.invokeCommand("node_info", []);                 // any exported method, params as an array with one object
await fiber.invokeCommand("send_payment", [{ invoice, tlc_expiry_limit, max_fee_amount }]);
await fiber.stop();                                          // terminates both workers
```

- **Constructor** ([L30-L36](https://github.com/nervosnetwork/fiber/blob/v0.9.1/fiber-js/src/index.ts#L14-L36)): creates
  the DB worker, the Fiber worker and two `SharedArrayBuffer`s of 50 MiB used as the DB IPC channel.
- **`start`** ([L48-L78](https://github.com/nervosnetwork/fiber/blob/v0.9.1/fiber-js/src/index.ts#L48-L78)): posts the
  config and keys to the workers and resolves when both report ready. `chainSpec` is only needed for a devnet chain spec.
- **`invokeCommand(name, args)`** ([L89-L121](https://github.com/nervosnetwork/fiber/blob/v0.9.1/fiber-js/src/index.ts#L89-L121)):
  serialised by a mutex; the worker calls `fiber.default[name](...args)`
  ([P/fiber-js/src/fiber.worker.ts#L33-L49](https://github.com/nervosnetwork/fiber/blob/v0.9.1/fiber-js/src/fiber.worker.ts#L33-L49)).
  Errors come back as strings such as `ErrorObject { code: ServerError(-32000), message: "…" }`. Numbers are 0x-hex, as
  in the fnn RPC.
- **Typed wrappers**: `openChannel`, `openChannelWithExternalFunding`, `submitSignedFundingTx`, `acceptChannel`,
  `abandonChannel`, `listChannels`, `shutdownChannel`, `updateChannel`, `graphNodes`, `graphChannels`, `nodeInfo`,
  `newInvoice`, `parseInvoice`, `getInvoice`, `cancelInvoice`, `sendPayment`, `getPayment`, `buildRouter`,
  `sendPaymentWithRouter`, `connectPeer`, `disconnectPeer`, `listPeers`.

**Methods the WASM node actually exports** ([P/crates/fiber-wasm/src/api.rs#L64-L296](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-wasm/src/api.rs#L64-L296)):

| Module | Methods | Notes |
|---|---|---|
| channel | `open_channel`, `accept_channel`, `abandon_channel`, `list_channels`, `shutdown_channel`, `update_channel`, `open_channel_with_external_funding`, `submit_signed_funding_tx` | |
| graph | `graph_nodes`, `graph_channels` | |
| info | `node_info` | |
| invoice | `new_invoice`, `parse_invoice`, `get_invoice`, `cancel_invoice`, **`settle_invoice`** | `settle_invoice` has no typed wrapper but works through `invokeCommand` [V, test] |
| payment | `send_payment`, `get_payment`, `build_router`, `send_payment_with_router` | **`list_payments` is missing**: `invokeCommand("list_payments")` throws `TypeError: … is not a function` [V, test] |
| peer | `connect_peer`, `disconnect_peer`, `list_peers` | |
| not available | `cch`, `pubsub` (`subscribe_store_changes`), `watchtower`, `admin`, `dev`, backup/restore | The page must poll `get_payment` / `get_invoice` / `list_channels`. |

### 1.3 Keys: provided by the app, never stored by fiber-js [V]

- `start()` receives `fiberKeyPair` (P2P identity, 32-byte secret) and `ckbSecretKey` (on-chain signing) as bytes.
  If either is omitted, the WASM node generates a **random** key and logs a warning
  ([P/crates/fiber-wasm/src/lib.rs#L111-L132](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-wasm/src/lib.rs#L111-L132)).
  A random key on every start means a new node identity and a database that no longer matches, so the app must persist
  or re-derive both keys.
- On WASM the CKB key lives only in memory (`wasm_secret_key`); the native path's encrypted `ckb/key` file and
  `FIBER_SECRET_KEY_PASSWORD` are not used ([P/crates/fiber-lib/src/ckb/config.rs#L116-L120](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/ckb/config.rs#L116-L162)).
- The node's on-chain wallet is the secp256k1-blake160 lock of that key: `get_default_funding_lock_script` =
  `Secp256k1Lock` with `blake160(pubkey)` args ([same file L155-L162](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/ckb/config.rs#L155-L162)).
  Our test node reported `code_hash 0x9bd7e06f…3cce8, hash_type type`, i.e. a normal `ckt1q…` address. [V, test]

How the reference apps keep the keys:

| App | Storage | Encrypted? | Source |
|---|---|---|---|
| fiber.world interactive labs | `localStorage["fiber-docs:wasm-quickstart-profile-v1"]` = `{fiberKey, ckbKey}` hex; "intended for Testnet development" | No | [fiber-docs quickstart L278-L312](https://github.com/nervosnetwork/fiber-docs/blob/d01342bcf70c65d2b53624b3c2fcebb3d4c6963b/components/tutorials/fiber-wasm-quickstart.tsx#L278-L312) |
| Fiber Wallet (joii2020) | P2P key in `localStorage["fiber-wallet-app:fiber-key-pair"]`; **no CKB key** (all funding is external, by the CCC wallet) | No | [client.ts L130-L139, L312-L331](https://github.com/joii2020/fiber-wallet/blob/a3df209c08e97d27c938f338ec25c693db736da3/apps/src/fiber/client.ts#L130-L139) |
| `@fiber-pay/sdk` `PasswordCredentialProvider` | Nothing stored but a random salt in IndexedDB; `scrypt(password, salt, N=2^14)` → 64 bytes = P2P key + CKB key; wiped on `lock()` | Derived, not stored | [password-credential-provider.ts](https://github.com/RetricSu/fiber-pay/blob/10d42d6e0f7051e5728c685006d4d9124469050d/packages/sdk/src/browser/password-credential-provider.ts) |
| `@fiber-pay/sdk` `PasskeyCredentialProvider` | Keys derived from the WebAuthn **PRF** extension output | Derived, not stored | [passkey-credential-provider.ts](https://github.com/RetricSu/fiber-pay/blob/10d42d6e0f7051e5728c685006d4d9124469050d/packages/sdk/src/browser/passkey-credential-provider.ts) |
| CKB KeyWay | P2P identity recovered from its backend; CKB signing by a Lit PKP (key never exported); **encrypted IndexedDB backup** uploaded on logout | Yes (backup) | [README](https://github.com/officialcmg/ckb-keyway/blob/1d15afd6be3b9031efcd3280309cc57ae773c5f5/README.md) |

`skipCkbKey: true` in fiber-pay (and Fiber Wallet's `undefined`) means "external funding only": the node still gets a
random in-memory CKB key, but it never holds funds.

### 1.4 Storage and persistence [V]

- **IndexedDB**, through the DB worker and the `idb` crate; one object store `main-store`
  ([P/crates/fiber-wasm-db-worker/src/db.rs#L220-L240](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-wasm-db-worker/src/db.rs#L220-L240)).
  The database name comes from `databasePrefix` (default `/wasm`). Values are stored **unencrypted**: no crypto code in
  `fiber-wasm*` crates. [V absence]
- **Reload**: with the same keys and the same prefix the node comes back with the same pubkey and its state; second
  start took 1.5 s against 4.7 s cold. [V, test] DB migrations auto-confirm in the browser
  ([lib.rs#L56-L61](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-wasm/src/lib.rs#L56-L61)).
- **No backup/export API** in the WASM exports. Clearing site data, a private window, or Safari's storage eviction loses
  channel state; the channel's funds then need the counterparty to close it. KeyWay implements its own encrypted backup.
- **Known bug in 0.9.1**: `stop()` terminates the workers immediately, which "could interrupt IndexedDB writes". Fixed on
  `develop` by [PR #1699](https://github.com/nervosnetwork/fiber/pull/1699) (merged 2026-10-19), **not released**. A tab
  close is equally abrupt, so the app should not stop the node during a channel or payment update. [V PR; I impact]
- **Multiple tabs**: nothing in fiber-js stops two tabs from starting the same node on the same database. The app must
  hold a Web Lock (or a BroadcastChannel election) before `start()`. [I]

### 1.5 Peers: outbound WSS only [V]

- **No listening on WASM**: `#[cfg(target_arch = "wasm32")] // There is no listening_addr on wasm, since it can't listen to anything`
  ([P/crates/fiber-lib/src/fiber/network.rs#L7719-L7721](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/network.rs#L7719-L7721)).
  The core team: "fiber wasm / fiber-js is not designed to support direct connections between two wasm nodes… wasm nodes
  are edge nodes. They are expected to connect to native Fiber nodes that are online 24/7"
  ([issue #1318](https://github.com/nervosnetwork/fiber/issues/1318), quake). [D]
- **Browsers on HTTPS can only dial `wss://`** multiaddrs, e.g.
  `/dns4/bottle.fiber.channel/tcp/443/wss/p2p/QmXen3eUHhywmutEzydCsW4hXBoeVmdET2FJvMX69XJ1Eo`. The bundled config's TCP
  bootnodes are useless in a browser; the README example replaces them with `thrall`/`onyxia` WSS bootnodes and sets
  `listening_addr: /ip4/127.0.0.1/tcp/8228`, `announce_listening_addr: false`
  ([P/fiber-js/README.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/fiber-js/README.md)).
- **Our test**: `connect_peer {address: bottle WSS}` → bottle in `list_peers` after **0.5 s**; the WSS bootnodes thrall
  and onyxia were connected too. [V, test]
- **Gossip sync is slow in the browser**: 15 s after connecting, `graph_nodes` returned **2** nodes and `graph_channels`
  21 channels [V, test]; issue [#1269](https://github.com/nervosnetwork/fiber/issues/1269) saw 4 nodes then 13 after
  5 minutes. So a fresh browser node cannot find multi-hop routes by itself. Workarounds: a **direct channel to the
  payee** (the hub), or **trampoline routing** through bottle as FiberSwap does: `send_payment {invoice, trampoline_hops:
  [bottle pubkey], max_fee_amount}`; `max_fee_amount` is mandatory with `trampoline_hops`
  ([P/crates/fiber-lib/src/fiber/payment.rs#L263-L292](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/payment.rs#L263-L292),
  [FiberSwap OrderPanel.tsx](https://github.com/humble-little-bear/fiber-swap-demo/blob/f1975e7c45145e619ddf879cfd461e9a3de7e45b/src/components/OrderPanel.tsx#L116-L130)).
- **Reconnects are slow**: `MaintainConnections` runs every 20 minutes and dials one random address
  ([issue #1330](https://github.com/nervosnetwork/fiber/issues/1330), open). The app should `connect_peer` to the hub
  explicitly on every start. [D/I]
- **To our own fnn**: fnn v0.9.1 listens for plain WebSocket on the P2P port (`reuse_port_for_websocket`, default true,
  [network.rs#L7686-L7716](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/network.rs#L7686-L7716)).
  Browsers need TLS in front of it: nginx stream/HTTP proxy per
  [P/docs/fiber-node-wss.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/docs/fiber-node-wss.md), plus
  `announced_addrs: [/ip4/<ip>/tcp/8228, /dns4/<domain>/tcp/443/wss]`. Any TLS terminator that proxies a WebSocket
  upgrade to `127.0.0.1:8228` should do (Caddy, Traefik). [V doc; I for non-nginx proxies]

### 1.6 Watching CKB [V]

- The node uses `ckb.rpc_url` (default `https://testnet.ckbapp.dev/`) as a plain JSON-RPC client, the same actor as native
  fnn, polling every `ckb.tx_tracing_polling_interval_ms` (4 s). It needs the **indexer** methods: calls found in
  `fiber-lib` are `get_transaction`, `get_cells`, `get_transactions`, `send_transaction`, `get_tip_block_number`,
  `get_live_cell`, `get_tip_header`, `get_block_by_number`. Contract cell deps are resolved by type ID through the same
  URL at start ([lib.rs#L184-L197](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-wasm/src/lib.rs#L184-L197)).
- CORS: `testnet.ckbapp.dev` and `testnet.ckb.dev` answer preflight with `Access-Control-Allow-Origin: *` and serve
  `get_indexer_tip`. [V, curl] CORS responses satisfy COEP, so they load on an isolated page. [V, test: node started]
- There is **no light client** inside fiber-js: the visitor trusts that RPC endpoint. A CKBolt-run CKB node or proxy is
  an option for production; for testnet the public one is fine.

### 1.7 Browser requirements [V]

| Requirement | Detail |
|---|---|
| `SharedArrayBuffer` | Needed by the constructor itself ([index.ts L33-L34](https://github.com/nervosnetwork/fiber/blob/v0.9.1/fiber-js/src/index.ts#L30-L36)). Exists only when `self.crossOriginIsolated === true`, which needs a secure context (HTTPS or `localhost`). |
| Isolation, option 1 | `Cross-Origin-Opener-Policy: same-origin` **and** `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`). MDN: only COOP `same-origin` qualifies ([MDN crossOriginIsolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)). |
| Isolation, option 2 | `Document-Isolation-Policy: isolate-and-credentialless` (or `isolate-and-require-corp`) ([Chrome blog](https://developer.chrome.com/blog/document-isolation-policy)). |
| Workers, WASM, IndexedDB, WebSocket | All modern browsers. Workers are created from `blob:` URLs, so a CSP `worker-src` must allow `blob:`. |
| Memory | 2 × 50 MiB shared buffers + WASM heap; heavy for low-end phones. [I] |

Browser support, from MDN browser-compat-data **8.1.7** (2026-10-22) [V]:

| Feature | Chrome | Chrome Android | Edge | Firefox | Safari / iOS |
|---|---|---|---|---|---|
| COOP / COEP `require-corp` | 83 | 83 | 83 | 79 | 15.2 |
| COEP `credentialless` | 96 | 96 | 96 | 119 (not Android) | **no** |
| `SharedArrayBuffer` (isolated) | 68 / 92 isolation-gated | 89 | 79 | 79 | 15.2 |
| `Document-Isolation-Policy` (experimental) | **137** | **146** | **137** | **no** | **no** |
| COOP `noopener-allow-popups` | 131 | 131 | 131 | no | 18.4 |

Mobile caveat: a background or locked tab is throttled or killed (iOS especially), which takes the node offline. [I]

### 1.8 Live smoke test of fiber-js 0.9.1 [V, test]

Headless Chromium 151, page served from `http://localhost`, CKB testnet via `testnet.ckbapp.dev`:

| Step | COOP/COEP page | Same, after reload | DIP page |
|---|---|---|---|
| `crossOriginIsolated` | true | true | true |
| `start()` | 4,676 ms | 1,485 ms | 1,497 ms |
| `node_info.version` | 0.9.1 | 0.9.1 (same pubkey) | 0.9.1 (same pubkey) |
| Default auto-accept | min **100 CKB** usable, contributes **99 CKB**; whitelist `RUSD` | same | same |
| `connect_peer` bottle (WSS) | 506 ms | 510 ms | 513 ms |
| `graph_nodes` / `graph_channels` after 15 s | 2 / 21 | 2 / 21 | 2 / 21 |
| `new_invoice` with `payment_hash` + `hash_algorithm: sha256` | `fibt1…`, status `Open`, `cancel_invoice` → `Cancelled` | same | same |
| `list_payments` | `TypeError` (not exported) | same | same |

Not tested (needs testnet funds and a WSS hub): channel opening, payments, settlement. Those paths are exercised daily by
the fiber.world labs and FiberSwap (below).

### 1.9 Example apps: how they start and fund a browser node

| App | Stack, fiber-js | Isolation | Keys | Funding | Paying / receiving |
|---|---|---|---|---|---|
| **fiber.world interactive labs** ([nervosnetwork/fiber-docs](https://github.com/nervosnetwork/fiber-docs/tree/d01342bcf70c65d2b53624b3c2fcebb3d4c6963b)) | **Next.js 16.2.6**, `@fiber-pay/sdk` 0.3.1 + fiber-js **0.9.1**, `transpilePackages`, `await import('@fiber-pay/sdk/browser')` | Per-route COOP/COEP in `next.config.mjs` `headers()` ([L6-L60](https://github.com/nervosnetwork/fiber-docs/blob/d01342bcf70c65d2b53624b3c2fcebb3d4c6963b/next.config.mjs#L6-L60)); reloads once when a client-side navigation arrives un-isolated ([quickstart L433-L449](https://github.com/nervosnetwork/fiber-docs/blob/d01342bcf70c65d2b53624b3c2fcebb3d4c6963b/components/tutorials/fiber-wasm-quickstart.tsx#L433-L449)) | `RawKeyCredentialProvider`, raw keys in `localStorage` | Shows the node's address; user claims at faucet.nervos.org; polls `get_cells_capacity` every 5 s ([channel lab L148-L190](https://github.com/nervosnetwork/fiber-docs/blob/d01342bcf70c65d2b53624b3c2fcebb3d4c6963b/components/tutorials/fiber-channel-payment.tsx#L148-L190)); `open_channel` to bottle | Labs for SHA-256 hold invoice, RUSD payment, multi-hop, close channel |
| **FiberSwap** ([humble-little-bear/fiber-swap-demo](https://github.com/humble-little-bear/fiber-swap-demo/tree/f1975e7c45145e619ddf879cfd461e9a3de7e45b), live at fiber-swap.retric.uk) | Vite + `@fiber-pay/react` 0.3.2, fiber-js **0.9.0** vendored in `public/` and loaded by an import map | COOP/COEP on every route (live headers checked) | fiber-pay `useFiberNode` (passkey / password / raw key) | Faucet page sends cWBTC to any CKB address; CKB from the Nervos faucet; channel opened from the fiber-pay panel | Pays CCH `send_btc` invoices with `trampoline_hops: [bottle]`; creates SHA-256 invoices for `receive_btc` |
| **Fiber Wallet** ([joii2020/fiber-wallet](https://github.com/joii2020/fiber-wallet/tree/a3df209c08e97d27c938f338ec25c693db736da3), live at fiber-wallet-apps.vercel.app) | Vite + CCC 1.1.x + fiber-js **0.8.1** | **DIP on Chromium (`dip.html`), COOP/COEP fallback (`coop.html`) for Firefox and others**, chosen by UA in `index.html` | P2P key in `localStorage`, no CKB key | **External funding** signed by the CCC wallet (secp256k1, OmniLock); **JoyID redirect signing implemented then disabled** (commit `a3df209`, 2026-04-30) | Pay invoice; receive with `hash_algorithm: sha256` |
| **CKB KeyWay** ([officialcmg/ckb-keyway](https://github.com/officialcmg/ckb-keyway/tree/1d15afd6be3b9031efcd3280309cc57ae773c5f5)) | Next.js; hosted fnn per user by default, browser node optional | COOP/COEP site-wide | Email OTP + Lit PKP | External funding signed by the PKP; requests 1,000 CKB channels to bottle/bracer | SDK passes `hash_algorithm`; demo UI invoices omit it (`ckb_hash`) |
| **Polymeer** (app.polymeer.xyz) | Vite PWA | Service worker injects COOP `same-origin` + COEP `credentialless`/`require-corp` and reloads | own | own | Experimental |
| **fiber-pay lab** ([RetricSu/fiber-pay](https://github.com/RetricSu/fiber-pay/tree/10d42d6e0f7051e5728c685006d4d9124469050d)) | Vite, `FiberNodeButton` | COOP/COEP + CORP `same-origin` on every route (`vercel.json`) | passkey / password / raw | Internal or external (CCC resolver `createCccExternalFundingResolver`) | |

`@fiber-pay/sdk`'s browser `ConfigBuilder` hard-codes a `ckb_auth` cell dep `0x5a528876…` for both networks, while the
official v0.9.1 testnet config uses `0x12c569a2…` (both transactions exist on testnet) and mainnet uses other code
hashes. Prefer `fiber.getDefaultConfig()` from fiber-js 0.9.1 and patch only bootnodes and listening fields. [V files and
chain; I impact]

---

## 2. Funding from the visitor's CCC wallet, channels with the hub, receiving

### 2.1 Two ways to fund

| | **A. Transfer to the node's address** | **B. External funding** |
|---|---|---|
| How | The connected CCC signer sends CKB (and RUSD) to `node_info.default_funding_lock_script`; the node then calls `open_channel` and signs its own funding inputs. CCC: `Transaction.from({outputs})`, `completeInputsByCapacity`, `completeFeeBy`, `signer.sendTransaction`; `@ckb-ccc/udt` for RUSD. [V API names in ckbolt-web's installed CCC] | `open_channel_with_external_funding {pubkey, funding_amount, shutdown_script, funding_lock_script[, funding_lock_script_cell_deps]}` returns the final unsigned funding tx; the CCC signer signs it once; `submit_signed_funding_tx` ([P/docs/external-funding.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/docs/external-funding.md)) |
| Wallets | Any CCC wallet, JoyID included (one popup on a page that keeps popups working, §3) | secp256k1 and OmniLock signers per Fiber Wallet; **JoyID disabled** ("the official version of fiber-js does not support it yet") [D commit message] |
| Where funds return on close | Set `shutdown_script` in `open_channel` to the visitor's wallet lock, so a cooperative close pays straight back to JoyID/MetaMask. The RPC doc says the default is the node's own secp256k1 lock; Polymeer's JoyID cooperative close paid to the wallet address ([issue #1314](https://github.com/nervosnetwork/fiber/issues/1314)). The `shutdown_channel.close_script` doc says only secp256k1 is supported "for now", so pass the wallet lock at **open** time. [D/I] | `shutdown_script` = wallet lock is part of the call |
| Extra on-chain cost | One transfer transaction; leftover CKB stays at the node address (sweep it back with a node-signed tx is not exposed; withdraw by a channel close or keep it for the next channel) [I] | None |
| Receiving channels (hub opens to the visitor) | Works: the browser node pays its own reserve when it auto-accepts | Not possible: `accept_channel` has no external-funding variant, so the acceptor's reserve must come from the node key |
| Complexity | Low | Medium; retries needed (`waiting for peer to send Init message`, `ChannelNotFound` while the peer collaborates, per Fiber Wallet) |

**Verdict:** start with **A**, done from a page where JoyID's popup works. Add B later for extension wallets if the extra
transfer becomes a UX problem.

### 2.2 Minimums and reserves

Code facts [V]: `MIN_OCCUPIED_CAPACITY` = 98 CKB, `DEFAULT_MIN_SHUTDOWN_FEE` = 1 CKB, so each side of a CKB channel locks
**99 CKB** that cannot be spent off-chain
([P/crates/fiber-lib/src/fiber/config.rs#L22-L36](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/config.rs#L22-L36)).
For a UDT channel the reserve is the occupied capacity of a cell with a 57-byte-args lock, the UDT type script and 16 bytes
of data, plus 1 CKB ([channel.rs#L5233-L5298](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/channel.rs#L5233-L5298));
for RUSD (32-byte type args) that is 8 + 90 + 65 + 16 = 179 → **180 CKB** per side [I, computed]. The acceptor must also
bring its reserve: `remote_reserved_ckb_amount < occupied_capacity` is rejected
([channel.rs#L6251-L6259](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/channel.rs#L6251-L6259)),
and the opener runs the same check on the acceptor's `AcceptChannel` ([channel.rs#L7855-L7865](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/channel.rs#L7855-L7865));
one-way channels do not change that. Auto-accept compares the opener's **usable** amount (`OpenChannel.funding_amount`
= funding minus reserve) with the threshold ([network.rs#L1665-L1690](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/network.rs#L1665-L1690)).

Live `node_info` of bottle and bracer (both **v0.9.1**, `9a561b3`) [V]: auto-accept threshold `0x9502f9000` = **400 CKB**
usable, contribution `0x5d21dba00` = **250 CKB**, UDT auto-accept **RUSD 20**, **cWBTC 10**.

| Purpose | Who opens | On-chain at the visitor's node address | Liquidity result |
|---|---|---|---|
| Pay CKB via public nodes | visitor → bottle | ≥ **499 CKB** + fee; ≈ **561 CKB** if the wallet keeps a change cell (61 CKB minimum) [D public-nodes.md] | 400 CKB outbound, 151 CKB inbound |
| Pay RUSD via public nodes | visitor → bottle | ≥ **20 RUSD** + **180 CKB** reserve + fee; the RUSD cell sent to the node itself carries ≈ 142 CKB of capacity [I] | 20+ RUSD outbound, 0 RUSD inbound |
| Pay CKB directly to the hub | visitor → hub | hub's threshold + 99 CKB (fnn default threshold 100 usable → ≥ 199 CKB) | hub decides its contribution |
| Receive CKB via bottle | visitor → bottle (same channel as above) | as above | ≤ 151 CKB minus fees can arrive |
| Receive CKB from the hub | hub → visitor node | **≈ 99 CKB + fee**, or ≥ ≈ 160 CKB if change is left [I]; hub funding must be ≥ 100 CKB usable (browser default threshold) | inbound = hub's funding minus its reserve |
| Receive RUSD from the hub | hub → visitor node | **≈ 180 CKB + fee** [I]; hub funding ≥ **10 RUSD** (browser default `auto_accept_amount` 1,000,000,000) | inbound = hub's RUSD funding |

On-chain fees on testnet are tiny (default 1,000 shannons/KW) and not the constraint. [I]

### 2.3 Browser node ↔ hub channel

1. **Hub prerequisites** (not in `deploy/testnet` today):
   - TLS proxy for WebSocket on 443 and `FIBER_ANNOUNCED_ADDRS` extended with `/dns4/<domain>/tcp/443/wss`.
   - `open_channel_auto_accept_min_ckb_funding_amount` and `auto_accept_channel_ckb_funding_amount` chosen on purpose:
     the contribution is inbound liquidity the hub gives every opener, so it is a griefing surface (cap it, rate-limit,
     close idle channels). Setting the contribution to `0` disables CKB auto-accept and the hub calls `accept_channel`
     itself ([network.rs#L1668-L1673](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/network.rs#L1665-L1690)).
   - An anchored `udt_whitelist` entry for RUSD with the `auto_accept_amount` the hub wants.
2. **Visitor opens to the hub** (`fiber_to_ln`, and CKB inbound for `ln_to_fiber`): browser `connect_peer {address: hub WSS}`
   then `open_channel {pubkey: hub, funding_amount, public: false, shutdown_script: wallet lock}`; wait for
   `ChannelReady` (funding tracked to 4 confirmations [I]). A private channel is enough because both ends own it and
   fnn adds owned channels to its local graph ([P/crates/fiber-lib/src/fiber/graph.rs#L619-L640](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/graph.rs#L619-L640)). [V code; I end to end]
3. **Hub opens to the visitor** (RUSD inbound, or CKB inbound without the visitor locking more): only while the visitor's
   tab is connected (the hub cannot dial a WASM node). The web app asks the hub (new API, rate-limited, bound to a quote)
   → hub `open_channel {pubkey: browser node, funding_amount, funding_udt_type_script?}` → the browser node auto-accepts if
   the amount clears its thresholds and its key holds the reserve. No `push_amount` exists, so the hub's funding is all
   the visitor's inbound. [V code; I end to end]
4. **Dual-funded UDT channels** (both sides add RUSD through `accept_channel`) are unreliable on v0.9.1: `develop` has the
   fix "build complete dual-funded UDT transactions (#1671)". Do not depend on them. [D]

### 2.4 Who must stay online, and when

- **`fiber_to_ln` (visitor pays the hub's hold invoice)**: the visitor's node sends the TLC and must stay online until the
  hub settles (the fulfil needs a commitment update signed by both). If the tab closes after the hub has paid Lightning,
  the hub holds the preimage and must get the TLC fulfilled before its expiry, or claim it on-chain by force-closing.
  The hub's swap engine should treat "payer offline after LN payout" as a first-class case. [I]
- **`ln_to_fiber` (hub pays the visitor's SHA-256 invoice)**: the visitor's node created the invoice and holds the
  preimage; it must be online when the hub pays and until the TLC settles. An offline browser node makes the owned
  channel go `Down` and the payout fails to route. [I]
- **No watchtower in the WASM node**: fiber-wasm only forwards events to a *standalone* watchtower if one is configured
  ([lib.rs#L239-L297](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-wasm/src/lib.rs#L239-L297));
  "The wasm node currently does not have a watchtower service" ([issue #1314](https://github.com/nervosnetwork/fiber/issues/1314)).
  After a force close the commitment cell stays until the visitor's node comes back to settle it, and a standalone
  watchtower with Biscuit auth does not work from WASM yet ([issue #1410](https://github.com/nervosnetwork/fiber/issues/1410)).
  Use cooperative close by default. [V/D]

---

## 3. COOP/COEP isolation and CCC wallet popups

### 3.1 How CCC's JoyID signer works [V]

`@ckb-ccc/joy-id` **1.2.6** (the version `@ckb-ccc/connector-react` 2.2.2 in ckbolt-web pulls in) is popup-only:
`createPopup` opens `window.open("")`, sets `popup.location.href` to `https://testnet.joyid.dev/...`, listens for a
`message` event from that origin and polls `popup.closed` every second, rejecting with `PopupCancelledError` when it
turns true ([ccc packages/joy-id/src/common/index.ts#L53-L114](https://github.com/ckb-devrel/ccc/blob/9ffef01a181751dacf1edde83ed43fcfb4646ded/packages/joy-id/src/common/index.ts#L53-L114)).
`connect()` and `signOnlyTransaction()` both use it ([ckb/index.ts#L101-L115, L254-L295](https://github.com/ckb-devrel/ccc/blob/9ffef01a181751dacf1edde83ed43fcfb4646ded/packages/joy-id/src/ckb/index.ts#L254-L295)).
The JoyID app sends no COOP header (only `X-Frame-Options: DENY`), so it cannot be iframed. [V, curl]
Extension wallets (UTXO Global, MetaMask through EIP-6963, OKX, UniSat…) talk through injected providers and their own
extension windows, which COOP does not affect. [I]

### 3.2 Experiment: a JoyID-style popup under each header set [V, test]

Opener on `http://localhost`, popup on `http://127.0.0.1` (cross-site), the exact `createPopup` sequence:

| Opener headers | `crossOriginIsolated` / SAB | Popup sees `window.opener` | Opener receives `postMessage` | `popup.closed` after 3 s | JoyID via CCC |
|---|---|---|---|---|---|
| none | false / no | present | yes | false | works, no Fiber |
| COOP `same-origin` + COEP `require-corp` | true / yes | **null** | **no** | **true** | **fails** (`PopupCancelledError` within 1 s) |
| COOP `same-origin` + COEP `credentialless` | true / yes | **null** | **no** | **true** | **fails** |
| COOP `same-origin-allow-popups` + COEP `require-corp` | **false / no** | present | yes | false | works, no Fiber |
| `Document-Isolation-Policy: isolate-and-credentialless` | **true / yes** | present | yes | false | **works, with Fiber** |

Second experiment, same origin [V, test]:
- A page with COOP/COEP opened in a **new tab** from a plain page: isolated, `opener` null, but a same-origin
  **`BroadcastChannel`** message reached the plain page.
- An **iframe** with COOP/COEP inside a plain page: **not** isolated. An iframe with **DIP** inside a plain page:
  isolated, `SharedArrayBuffer` available.

### 3.3 Workarounds

| Option | Isolation | JoyID popup | Browsers | Notes |
|---|---|---|---|---|
| COOP/COEP on the whole app | yes | **broken** | all | What FiberSwap, KeyWay, fiber-pay lab do; none of them uses a popup wallet. |
| COOP/COEP on a **separate route** (e.g. `/app/fiber`) only; CCC/JoyID on the other routes | yes, on that route | works on the other routes | all | fiber.world pattern. Do the funding transfer on a non-isolated page, the node on the isolated one. Next.js `<Link>` navigation does not fetch new headers: use a full navigation or the reload-once guard. Needs a bridge if both run at once (same-origin `BroadcastChannel` works [V, test]). |
| COOP `same-origin-allow-popups` | **no** | works | all | Not a solution: `SharedArrayBuffer` stays unavailable [V, test]. The 2021 idea to make it count for isolation never shipped. [I] |
| COEP `credentialless` | only with COOP `same-origin` | **broken** (COOP severs the popup) | Chrome 96, Firefox 119, not Safari | Only eases loading third-party subresources. |
| **`Document-Isolation-Policy: isolate-and-credentialless`** | yes | **works** | Chromium only (Chrome/Edge 137, Chrome Android 146) | Fiber Wallet's choice on Chromium, with COOP/COEP fallback elsewhere. Experimental status in MDN. |
| DIP **iframe** hosting the node inside the normal page | yes (the iframe) | works (parent page) | Chromium only | Needs `frame-ancestors 'self'` instead of ckbolt-web's current `'none'` and `X-Frame-Options: SAMEORIGIN` for that path; talk to it with `postMessage`. |
| Separate **subdomain** with COOP/COEP | yes | works on the main site | all | Cross-origin, so no `BroadcastChannel`/storage sharing; the isolated window cannot be referenced either. Communication would need a server relay. Not worth it. |
| Service worker injecting headers (coi-serviceworker, Polymeer) | yes | **broken** (same COOP) | all with SW | Only useful on hosts that cannot set headers. |
| JoyID **redirect** mode (`@joyid/common` `*WithRedirect`) | yes | not a popup | all | CCC does not offer it; the page unloads, so the WASM node stops mid-flow; Fiber Wallet disabled it for channel funding. |

### 3.4 Next.js 16 specifics for ckbolt-web [V/I]

- Per-route headers in `next.config.mjs` `headers()` work (fiber.world runs this on Next 16.2.6 with
  `transpilePackages: ['@fiber-pay/sdk', '@nervosnetwork/fiber-js']`). ckbolt-web is on Next 16.0.10 with one global
  header block; an isolated route needs its own entry. [V]
- Load fiber-js only on the client, only on that route: `await import('@nervosnetwork/fiber-js')` inside an effect, never
  at module scope (it creates workers and buffers in the constructor; 15 MB). [V fiber.world, fiber-pay]
- Client-side navigation into an isolated route keeps the old document's isolation state; detect
  `!crossOriginIsolated` and reload once (fiber.world), or link with a plain `<a href>`. [V]
- COEP `require-corp` blocks cross-origin subresources without CORP; `credentialless` (Chromium/Firefox) or DIP avoids
  that. Next's own assets and `@vercel/analytics` are same-origin. [I]
- The current CSP has no `worker-src`, so `blob:` workers are allowed; keep it that way or add `worker-src 'self' blob:`. [V]

---

## 4. Alternatives for a visitor

What CKBolt requires (from `src/interfaces/http/contract/requests.ts`): for `ln_to_fiber` the payout invoice must be
`fibt…`, carry exactly the quote's amount, `hash_algorithm: sha256`, a final expiry delta ≥ 160 min that the hub's
timing fits, and stay valid until the quote expires; for `fiber_to_ln` the visitor pays the hub's `fibt…` hold invoice.

| Option | Status (2026-10-23) | Pay CKBolt's hold invoice (`fiber_to_ln`) | Receive a payout (`ln_to_fiber`) | Fit |
|---|---|---|---|---|
| **Fiber Studio** ([chukwuma619/fiber-studio](https://github.com/chukwuma619/fiber-studio)) | **v1.1.2** (2026-09-07); Tauri; signed **Windows** `x64-setup.exe`, macOS, Linux; bundles **fnn 0.9.0**; testnet only [V] | Import a CKB key file (ckb-cli export; the wizard does not generate one), fund it, open a channel (to bottle/bracer, or to the CKBolt hub as a custom peer), paste the `fibt` invoice under Payments → send [V README] | Payments → create invoice: always `hash_algorithm: sha256`, user-set amount and expiry in hours, default final delta (160 min) ([rpc.rs#L509-L536](https://github.com/chukwuma619/fiber-studio/blob/c70665110c2bf1fe4046384b1a61a5dfe8c54a38/app/src-tauri/src/fnn/rpc.rs#L509-L536)); paste it into CKBolt; needs inbound liquidity [V] | **Best "real wallet" today.** JoyID users cannot import their key: they need a fresh key. |
| **Self-run fnn** | v0.9.1 binaries incl. `x86_64-windows`; `install.ps1` [V, see fiber-node.md §1.3] | `connect_peer`, `open_channel`, then `send_payment {invoice, tlc_expiry_limit}` via `fnn-cli` or curl | `new_invoice {amount, currency: "Fibt", hash_algorithm: "sha256", expiry}` | Developers only. |
| **Fiber Wallet** (fiber-wallet-apps.vercel.app) | Live; fiber-js **0.8.1**; demo by a core developer [V] | Paste invoice; channel funded externally by a CCC wallet (not JoyID) | Receive creates SHA-256 invoices with a fixed default amount [V code] | Demo quality; old fiber-js. |
| **CKB KeyWay** (ckbkeyway.dev) | Testnet, "experimental, unaudited"; hosted fnn per user (custodial) or browser node; SDK `@ckb-keyway/react` 0.2.4 [V] | Email login, activate a channel (1,000 CKB request), pay the pasted invoice | Demo UI invoices use the default `ckb_hash`, which CKBolt rejects; an SDK integration can pass `sha256` [V code] | Possible SDK integration; trust in a hosted node. |
| **Polymeer** (app.polymeer.xyz) | Experimental (repo last pushed 2026-07-25) [V] | Likely | Unknown | Not recommended. |
| **fiber.world labs / FiberSwap's embedded node** | Live [V] | Dev tools, not wallets | | Reference code only. |
| **JoyID** | Lightning removed 2026-08-18; no Fiber [V] | No | No | CCC signing only (on-chain). |
| **UTXO Global, Neuron** | No Fiber support found [I / V] | No | No | |
| Fiber WebLN-style browser extension | Proposal ([Talk t/10571](https://talk.nervos.org/t/10571), 2026-08-03) [V] | | | Future. |

---

## 5. Effort and risk of embedding a browser Fiber node in ckbolt-web

### 5.1 Work breakdown (one developer, testnet quality) [I]

| Piece | Days |
|---|---|
| Isolated route (`/app/fiber` or a DIP iframe), headers for DIP + COOP/COEP fallback, reload guard, browser capability check and fallback copy | 1 |
| Node lifecycle: lazy `import()`, config from `getDefaultConfig` (WSS bootnodes, hub WSS address), key handling (passkey/password via `@fiber-pay/sdk` or own WebCrypto + IndexedDB), single-tab Web Lock, start/stop, reconnect on load | 2–3 |
| Funding: show node address and QR, CCC transfer of CKB and RUSD from the connected wallet (on the non-isolated page or under DIP), balance polling, channel open with `shutdown_script` = wallet lock, `ChannelReady` progress | 2–3 |
| `fiber_to_ln`: pay the hold invoice (`send_payment` with `tlc_expiry_limit`, fee cap, trampoline fallback), poll `get_payment`, `beforeunload` guard while in flight | 1 |
| `ln_to_fiber`: create the SHA-256 invoice matching the quote, wait for the payout, inbound-liquidity request to the hub | 1–2 |
| Hub: WSS proxy and announced address, auto-accept policy, "open inbound channel to connected node" endpoint with limits, offline-payer handling, idle-channel closing | 2–3 |
| Close/withdraw (cooperative close), recovery copy, Playwright e2e on testnet (headless Chromium works [V, test]) | 2 |
| **Total** | **≈ 11–15 working days** |

`@fiber-pay/sdk` (MIT, used by fiber.world and FiberSwap) saves part of the node-lifecycle and funding work; raw fiber-js
keeps the dependency surface smaller. Either way pin exact versions.

### 5.2 What can break

| Risk | Severity | Evidence | Mitigation |
|---|---|---|---|
| **fnn 0.10 will not open or accept channels with 0.9.x peers** ("ONCHAIN_FULL_PAYMENT_HASH is required", "Cannot accept Legacy channel") | High, when 0.10 ships | [D/network.rs#L6254-L6266](https://github.com/nervosnetwork/fiber/blob/2620b5b3fdca082092ce57797d0c22b65c33af59/crates/fiber-lib/src/fiber/network.rs#L6254-L6266), [#L8515-L8524](https://github.com/nervosnetwork/fiber/blob/2620b5b3fdca082092ce57797d0c22b65c33af59/crates/fiber-lib/src/fiber/network.rs#L8515-L8524), [CHANGELOG L7-L12](https://github.com/nervosnetwork/fiber/blob/2620b5b3fdca082092ce57797d0c22b65c33af59/CHANGELOG.md) [V]; testnet graph already has 0.10.0-rc1 nodes, bottle/bracer still 0.9.1 [V] | Keep hub fnn and fiber-js on the same minor; upgrade both when bottle/bracer upgrade; existing channels keep working. |
| Isolation breaks JoyID popups | High for Firefox/Safari users | §3.2 [V, test] | DIP on Chromium; separate isolated route elsewhere; funding transfer outside the isolated page. |
| `stop()` cuts IndexedDB writes (0.9.1) | Medium | [PR #1699](https://github.com/nervosnetwork/fiber/pull/1699) unreleased [V] | Never stop during updates; upgrade to the release that carries #1699. |
| Tab closed or backgrounded mid-swap | Medium | §2.4 [I] | `beforeunload` warning, short Lightning legs, hub handles offline payers. |
| No watchtower; force-close settlement needs the node online | Medium (funds stuck, not lost, on testnet) | [#1314](https://github.com/nervosnetwork/fiber/issues/1314), [#1410](https://github.com/nervosnetwork/fiber/issues/1410) [V] | Cooperative close only; hub never force-closes visitor channels without need. |
| Browser state loss (cleared storage, private mode, Safari eviction) | Medium | no backup API [V] | Small amounts; explain; optional encrypted export like KeyWay. |
| Slow gossip, so routing fails | Medium | [V, test], [#1269](https://github.com/nervosnetwork/fiber/issues/1269), [#1316](https://github.com/nervosnetwork/fiber/issues/1316) | Direct channel to the hub; trampoline via bottle as fallback. |
| Slow reconnection | Low/Medium | [#1330](https://github.com/nervosnetwork/fiber/issues/1330) open [D] | Explicit `connect_peer` on load. |
| Two tabs on the same node | Medium | no guard in fiber-js [I] | Web Locks API. |
| Bundle 15 MB (6.9 MB gzip), 100 MB shared memory | Low/Medium | measured [V] | Lazy load on the Fiber route only; Chromium/desktop first. |
| Missing RPCs (`list_payments`, `pubsub`) | Low | [V, test] | Track payments in app state; poll. |
| Hub liquidity griefing through auto-accept contributions | Medium | design [I] | Caps, rate limits, hub-initiated channels bound to quotes. |
| Keys in plain browser storage | Low on testnet | reference apps [V] | Passkey (PRF) or password derivation. |

### 5.3 Version compatibility with fnn v0.9.1 [V]

- fiber-js **0.9.1** = fnn **v0.9.1** source; bottle and bracer run **0.9.1** (`9a561b3`); FiberSwap's browser node runs
  fiber-js 0.9.0 against them. Same-generation peers are compatible.
- Fiber Studio bundles fnn **0.9.0**; Fiber Wallet runs fiber-js **0.8.1**. Both open channels to 0.9.1 nodes in practice
  (live apps), but a cross-version matrix is not documented. [I]
- `@fiber-pay/react`/`sdk` 0.3.2 declare `@nervosnetwork/fiber-js ~0.9.0` as peer dependency. [V]
- `@ckb-ccc/fiber` (CCC's HTTP Fiber SDK) is still canary-only (`0.0.0-canary-20260330023358`). [V]

---

## 6. Recommendation for CKBolt

1. **Ship "bring your own Fiber node" first, with no browser node.** On the swap page, show the `fibt` hold invoice with
   QR/copy and accept a pasted SHA-256 payout invoice, and document **Fiber Studio** (Windows/macOS/Linux) and fnn as the
   supported real wallets. Hub work this needs anyway: channels to bottle/bracer, a WSS endpoint and
   `announced_addrs`, an inbound-liquidity policy. Cost: about 2–3 days.
2. **Then embed a browser Fiber node on its own route** (`/app/fiber`), as the "connect a real Fiber wallet" flow:
   - fiber-js **0.9.1** (or `@fiber-pay/sdk` 0.3.2), pinned, lazy-loaded.
   - Headers: `Document-Isolation-Policy: isolate-and-credentialless` on Chromium; COOP `same-origin` + COEP
     `require-corp` on the same route for other browsers; reload-once guard.
   - Keys: passkey (PRF) where supported, else password-derived; Web Lock against two tabs.
   - Funding: the visitor's CCC wallet sends CKB/RUSD to the node address from the normal, non-isolated `/app` page (so
     JoyID's popup works on every browser), then the node opens a **private channel straight to the hub over WSS** with
     `shutdown_script` = the visitor's wallet lock.
   - Paying (`fiber_to_ln`): the node pays the hold invoice over that channel.
   - Receiving (`ln_to_fiber`): CKB inbound from the hub's auto-accept contribution; RUSD inbound by a hub-opened RUSD
     channel while the tab is connected (visitor keeps ≈ 180 CKB at the node for the reserve).
   - Keep the tab open during a swap; cooperative close returns funds to the wallet.
3. **Do not** put COOP `same-origin` on the pages that use CCC/JoyID, **do not** rely on external funding with JoyID, and
   **do not** move to fiber-js/fnn 0.10 until bottle/bracer do.
4. Keep the existing custodial demo wallet as the "try it in 30 seconds" path; the browser node is the "real wallet"
   path for visitors willing to lock about 200–600 testnet CKB and wait for one channel open.

---

## 7. Open questions to check on testnet

1. Open a real channel from fiber-js 0.9.1 to the hub's fnn over WSS (Caddy or nginx), pay a SHA-256 hold invoice, settle
   it, close cooperatively with a JoyID `shutdown_script`. Measure time to `ChannelReady`.
2. Hub-initiated RUSD channel to a browser node: does auto-accept succeed with exactly 180 CKB + fee at the node address?
3. Does a 0.8.1/0.9.0 peer interoperate with the hub's 0.9.1 for channels and payments (Fiber Wallet, Fiber Studio)?
4. Firefox and Safari: confirm the JoyID popup failure under COOP (spec says yes) and fiber-js start under COOP/COEP.
5. Which release will carry PR #1699, and when do bottle/bracer move to 0.10?

---

## Appendix A: sources

**Fiber (pinned v0.9.1 unless noted)**
- fiber-js: [README](https://github.com/nervosnetwork/fiber/blob/v0.9.1/fiber-js/README.md), [src/index.ts](https://github.com/nervosnetwork/fiber/blob/v0.9.1/fiber-js/src/index.ts), [src/fiber.worker.ts](https://github.com/nervosnetwork/fiber/blob/v0.9.1/fiber-js/src/fiber.worker.ts), [src/default-config.ts](https://github.com/nervosnetwork/fiber/blob/v0.9.1/fiber-js/src/default-config.ts), npm [@nervosnetwork/fiber-js](https://www.npmjs.com/package/@nervosnetwork/fiber-js)
- WASM node: [crates/fiber-wasm/src/lib.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-wasm/src/lib.rs), [api.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-wasm/src/api.rs), [fiber-wasm-db-worker/src/db.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-wasm-db-worker/src/db.rs)
- Core: [network.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/network.rs), [channel.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/channel.rs), [fiber/config.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/config.rs), [ckb/config.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/ckb/config.rs), [payment.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/payment.rs), [graph.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/graph.rs), [fiber-json-types/src/channel.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-json-types/src/channel.rs)
- Docs: [external-funding.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/docs/external-funding.md), [fiber-node-wss.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/docs/fiber-node-wss.md), [config/testnet/config.yml](https://github.com/nervosnetwork/fiber/blob/v0.9.1/config/testnet/config.yml)
- develop: [CHANGELOG](https://github.com/nervosnetwork/fiber/blob/2620b5b3fdca082092ce57797d0c22b65c33af59/CHANGELOG.md), [network.rs full-payment-hash checks](https://github.com/nervosnetwork/fiber/blob/2620b5b3fdca082092ce57797d0c22b65c33af59/crates/fiber-lib/src/fiber/network.rs#L6254-L6266), [PR #1699](https://github.com/nervosnetwork/fiber/pull/1699)
- Issues: [#1318](https://github.com/nervosnetwork/fiber/issues/1318), [#1314](https://github.com/nervosnetwork/fiber/issues/1314), [#1410](https://github.com/nervosnetwork/fiber/issues/1410), [#1330](https://github.com/nervosnetwork/fiber/issues/1330), [#1269](https://github.com/nervosnetwork/fiber/issues/1269), [#1316](https://github.com/nervosnetwork/fiber/issues/1316), [#1315](https://github.com/nervosnetwork/fiber/issues/1315)
- Live: `node_info` of `bottle.fiber.channel:8227` and `bracer.fiber.channel:8227` (2026-10-23)

**Example apps**
- fiber.world docs/labs: [nervosnetwork/fiber-docs @ d01342b](https://github.com/nervosnetwork/fiber-docs/tree/d01342bcf70c65d2b53624b3c2fcebb3d4c6963b), live https://www.fiber.world/labs/browser-node
- `@fiber-pay/*`: [RetricSu/fiber-pay @ 10d42d6](https://github.com/RetricSu/fiber-pay/tree/10d42d6e0f7051e5728c685006d4d9124469050d), npm [@fiber-pay/sdk](https://www.npmjs.com/package/@fiber-pay/sdk), [@fiber-pay/react](https://www.npmjs.com/package/@fiber-pay/react) 0.3.2 (2026-08-24)
- FiberSwap: [humble-little-bear/fiber-swap-demo @ f1975e7](https://github.com/humble-little-bear/fiber-swap-demo/tree/f1975e7c45145e619ddf879cfd461e9a3de7e45b), https://fiber-swap.retric.uk
- Fiber Wallet: [joii2020/fiber-wallet @ a3df209](https://github.com/joii2020/fiber-wallet/tree/a3df209c08e97d27c938f338ec25c693db736da3) ([apps/vercel.json](https://github.com/joii2020/fiber-wallet/blob/a3df209c08e97d27c938f338ec25c693db736da3/apps/vercel.json), [apps/index.html](https://github.com/joii2020/fiber-wallet/blob/a3df209c08e97d27c938f338ec25c693db736da3/apps/index.html), [apps/vite.config.ts](https://github.com/joii2020/fiber-wallet/blob/a3df209c08e97d27c938f338ec25c693db736da3/apps/vite.config.ts))
- CKB KeyWay: [officialcmg/ckb-keyway @ 1d15afd](https://github.com/officialcmg/ckb-keyway/tree/1d15afd6be3b9031efcd3280309cc57ae773c5f5), npm [@ckb-keyway/react](https://www.npmjs.com/package/@ckb-keyway/react)
- Polymeer: [polymeerxyz/wallet @ 17cd3fc](https://github.com/polymeerxyz/wallet/blob/17cd3fc85b156611e09fabf6035520ac117df550/apps/web/src/sw.ts)
- Fiber Studio: [chukwuma619/fiber-studio v1.1.2](https://github.com/chukwuma619/fiber-studio/releases/tag/v1.1.2), [fnn version](https://github.com/chukwuma619/fiber-studio/blob/c70665110c2bf1fe4046384b1a61a5dfe8c54a38/app/src-tauri/src/fnn/mod.rs#L32)

**CCC / JoyID**
- [ckb-devrel/ccc @ @ckb-ccc/joy-id@1.2.6](https://github.com/ckb-devrel/ccc/tree/9ffef01a181751dacf1edde83ed43fcfb4646ded/packages/joy-id/src), npm [@ckb-ccc/connector-react](https://www.npmjs.com/package/@ckb-ccc/connector-react) 2.2.2, [@ckb-ccc/joy-id](https://www.npmjs.com/package/@ckb-ccc/joy-id) 1.2.6, [@ckb-ccc/fiber](https://www.npmjs.com/package/@ckb-ccc/fiber) (canary)

**Web platform**
- [Chrome: Document Isolation Policy](https://developer.chrome.com/blog/document-isolation-policy) (Chrome 137), [MDN crossOriginIsolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated), [MDN COOP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy), [web.dev COOP/COEP](https://web.dev/articles/coop-coep), `@mdn/browser-compat-data` 8.1.7

## Appendix B: experiments run

All on 2026-10-23 with Playwright 1.55 (`ckbolt-web/node_modules`) and headless Chromium 151.0.7922.34, from throwaway
Node scripts outside the repos (local HTTP server on a random high port, stopped at the end of each run).

1. **Popup test**: opener page served with each header set from §3.2; on click it runs `window.open("")`, sets
   `popup.location.href` to a page on another site that calls `window.opener.postMessage(...)`; after 3 s the opener
   records `crossOriginIsolated`, `SharedArrayBuffer`, received messages and `popup.closed`.
2. **Bridge test**: a plain page opens a COOP/COEP page in a new tab and listens on a `BroadcastChannel`; it also embeds a
   DIP iframe and a COOP/COEP iframe that report `crossOriginIsolated`.
3. **fiber-js smoke test**: the npm `@nervosnetwork/fiber-js@0.9.1` `dist/index.js` served same-origin to a COOP/COEP page
   and a DIP page; `getDefaultConfig("testnet", "https://testnet.ckbapp.dev/")` with WSS bootnodes; keys kept in
   `localStorage`; `start`, `node_info`, `connect_peer` bottle WSS, `graph_*` after 15 s, SHA-256 hold invoice create /
   get / cancel, `list_payments`, `settle_invoice`; then a second page load with the same keys and DB prefix.
