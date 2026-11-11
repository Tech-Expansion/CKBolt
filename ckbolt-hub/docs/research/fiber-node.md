# Operating a Fiber Network Node (fnn) from the CKBolt hub

Research date: 2026-10-23. Researched for a hub that swaps BTC on Lightning to and from CKB and CKB UDTs on Fiber, with both legs locked to one SHA-256 payment hash, using Fiber hold invoices.

**Pinned sources.** Unless stated otherwise, every code reference is to the latest stable release **v0.9.1**, tag `v0.9.1` = commit `9a561b3e7b786001488b61303a0663d9f4f22259`. Permalinks use `https://github.com/nervosnetwork/fiber/blob/v0.9.1/...`, shortened below to **`P/`**. Behavior on `main` after v0.9.1 (HEAD `2620b5b3`, 2026-10-19) is noted where it differs.

**Labels**
- **[V]**: verified from source code, config, tests or an official doc at the pinned ref.
- **[I]**: inferred from reading code paths, or not yet checked against a running node.
- **[D]**: stated in a doc only; the code was not checked, or the code disagrees with the doc.

---

## 0. What matters for the hub (summary)

1. **Hold invoices exist and fit the design.** Calling `new_invoice` with `payment_hash` and no `payment_preimage` creates a hold invoice. You must also pass `"hash_algorithm": "sha256"`; the default is `ckb_hash` (blake2b), and with it `settle_invoice` rejects a Lightning preimage with "Hash mismatch". [V]
2. **The incoming-TLC lifecycle is `Open → Received → Paid`, or `Cancelled`.** `settle_invoice` only works in `Received`. `cancel_invoice` also works in `Received` as long as no preimage is stored, even though the README says it only works in `Open`. [V]
3. **`get_payment` and `send_payment` return `payment_preimage` once a payment succeeds.** This was added in v0.9.0, so the hub needs fnn ≥ 0.9.0. [V]
4. **Push notifications exist but are off by default.** Enable them with `rpc.enabled_modules: [..., pubsub]`, then subscribe over WebSocket with `subscribe_store_changes` on the same port as HTTP RPC. Events: `PutCkbInvoiceStatus`, `PutPreimage`, `PutPaymentSession`, `PutAttempt`. There is no replay and no `Expired` event, so the hub must still poll to reconcile. [V]
5. **The real hold window is set by TLC expiry, not invoice expiry.** Once an invoice is `Received`, its invoice expiry no longer matters. The held TLC is auto-failed (`ExpiryTooSoon`) when `tlc.expiry < now + 2/3 × commitment_delay_epoch (default 160 min) + 60 s`. The minimum enforced `final_expiry_delta` is **160 minutes**, not the 16 hours the docs claim (§7.1). Use a large `final_expiry_delta`; Fiber's own Cross-Chain Hub (CCH) defaults to 60 h. [V]
6. **Always pass `tlc_expiry_limit` on outgoing Fiber payments.** The default is 14 days, and payers add a random expiry delta of 4 h × k. Without a limit, the hub's outgoing Fiber TLC can outlive its Lightning hold invoice. Fiber's own CCH caps the outgoing route at half the remaining incoming time (§7.2). [V]
7. **SHA-256 payments need an invoice.** A payment made with `payment_hash` + `target_pubkey` and no invoice, or a keysend payment, uses `ckb_hash`. The hub must pay merchants through their invoice, and should reject any invoice whose `hash_algorithm` is not `sha256`. [V]
8. **Fiber already ships a reference hub.** The CCH (`cch` module, `send_btc`, `receive_btc`) does the same hash-lock swap for a wrapped-BTC UDT against LND, and its expiry rules and recovery code are a blueprint (§2.7). [V]
9. **Version risk.** v0.10.0-rc1 (2026-09-25) moves new channels to a "full payment hash" commitment lock. Per the CHANGELOG, new channels require both peers to support it and nodes no longer open Legacy channels, and the RC needs a fresh database. Plan to pin v0.9.1 and track 0.10 (§7.8). [V/D]

---

## 1. Releases, networks, running a node

### 1.1 Releases [V]
Source: `gh release list -R nervosnetwork/fiber`.

| Tag | Date (UTC) | Notes |
|---|---|---|
| **v0.9.1** | 2026-09-11 | Latest stable. Assets: `fnn_v0.9.1-{x86_64,aarch64}-linux-portable`, `x86_64-linux`, `{x86_64,aarch64}-darwin-portable`, `x86_64-windows` (`.tar.gz`). [release](https://github.com/nervosnetwork/fiber/releases/tag/v0.9.1) |
| v0.10.0-rc1 | 2026-09-25 | Prerelease. "does not yet support upgrades from older versions". [release](https://github.com/nervosnetwork/fiber/releases/tag/v0.10.0-rc1) |
| v0.9.0 | 2026-08-06 | Unified DB migration, on-chain TLC settlement, CCH recovery and more. `fnn-migrate` is removed (migration is built into `fnn`). |
| v0.8.0 / v0.8.1 | 2026-04-03 / 04-15 | Breaking RPC change: `peer_id` became `pubkey` everywhere. JSON types moved to the `fiber-json-types` crate. |

Docker images: `nervos/fiber:<tag>` and `ghcr.io/nervosnetwork/fiber:<tag>` ([P/docker/README.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/docker/README.md)). [V]

### 1.2 Networks [V]
`fiber.chain` takes `mainnet`, `testnet`, or a path to a CKB chain-spec file for devnet ([P/crates/fiber-lib/src/fiber/config.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/config.rs), field `chain`). Invoice currency follows the network, and `new_invoice` rejects any other currency ([P/crates/fiber-lib/src/rpc/invoice.rs#L169-L184](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/rpc/invoice.rs#L169-L184)):

| Network | `currency` | Invoice prefix |
|---|---|---|
| Mainnet | `Fibb` | `fibb…` |
| Testnet | `Fibt` | `fibt…` |
| Devnet | `Fibd` | `fibd…` |

Bundled configs: [P/config/testnet/config.yml](https://github.com/nervosnetwork/fiber/blob/v0.9.1/config/testnet/config.yml) and [P/config/mainnet/config.yml](https://github.com/nervosnetwork/fiber/blob/v0.9.1/config/mainnet/config.yml). The devnet template is [P/tests/nodes/deployer/config.yml](https://github.com/nervosnetwork/fiber/blob/v0.9.1/tests/nodes/deployer/config.yml), which uses `chain: dev.toml`.

### 1.3 How to run [V]
- **Installer:** `curl -sSfL https://raw.githubusercontent.com/nervosnetwork/fiber/v0.9.1/tools/install/install.sh | bash`. Run this way (bootstrap mode) it defaults to testnet. Mainnet requires `NETWORK=mainnet CKB_RPC_URL=...`. Windows: `install.ps1`. ([P/README.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/README.md), [P/tools/install/README.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/tools/install/README.md))
- **Binary:** put the key in `<dir>/ckb/key`: a single line, 64 hex characters, no `0x` (export with `ckb-cli account export ...`, then `head -n1`). Then run `FIBER_SECRET_KEY_PASSWORD='...' RUST_LOG=info ./fnn -c config.yml -d <dir>`. On first start the key file is encrypted with that password, and every later start needs the same password.
- **Docker:** `docker run -e FIBER_SECRET_KEY_PASSWORD=... -v ./fiber-node:/fiber -p 8228:8228 nervos/fiber:v0.9.1`. The entrypoint copies the testnet config when `/fiber/config.yml` is missing; set `FIBER_CONFIG_TEMPLATE=/usr/local/share/fiber/config/mainnet/config.yml` to start from mainnet instead. The image also ships `fnn-cli`. ([P/docker/docker-entrypoint.sh](https://github.com/nervosnetwork/fiber/blob/v0.9.1/docker/docker-entrypoint.sh))
- **Ports:** P2P `8228`, RPC `8227` (bound to `127.0.0.1` by default).
- **Logs:** `RUST_LOG=info,fnn=debug` style filters.

### 1.4 `config.yml` keys that matter
Every key can also be set as a CLI flag or env var, for example `FIBER_BOOTNODE_ADDRS`, `RPC_LISTENING_ADDR`, `CKB_NODE_RPC_URL`.

| Key | Testnet default (bundled) | Notes |
|---|---|---|
| `fiber.listening_addr` | `/ip4/0.0.0.0/tcp/8228` | P2P. `main` adds `listening_addrs` (multiple listen addresses). |
| `fiber.bootnode_addrs` | `/ip4/54.179.226.154/tcp/8228/p2p/Qmes1EBD4yNo9Ywkfe6eRw9tG1nVNGLDmMud1xJMsoYFKy`, `/ip4/16.163.7.105/tcp/8228/p2p/QmdyQWjPtbK4NWWsvy8s69NGJaQULwgeQDT5ZpNDrTNaeV` | Used for peer discovery only; you cannot open channels to them. [V] ([testnet config L10-12](https://github.com/nervosnetwork/fiber/blob/v0.9.1/config/testnet/config.yml#L10-L12), [P/docs/network-nodes.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/docs/network-nodes.md)) |
| `fiber.announce_listening_addr`, `fiber.announced_addrs` | `true`, empty | Set `announced_addrs: ["/ip4/<public-ip>/tcp/8228"]` so other nodes can connect to the hub. |
| `fiber.announced_node_name` | unset | Shown in the graph and on the dashboard. |
| `fiber.chain` | `testnet` | Or `mainnet`, or a chain-spec path. |
| `fiber.scripts` | FundingLock and CommitmentLock (type-id cell deps) | Already filled in for testnet and mainnet. Do not edit. |
| `fiber.open_channel_auto_accept_min_ckb_funding_amount` | 100 CKB | Inbound channel requests at or above this are auto-accepted. |
| `fiber.auto_accept_channel_ckb_funding_amount` | 99 CKB (98 occupied + 1 fee) | What this node adds when it auto-accepts. Public nodes set 250 CKB. |
| `fiber.tlc_expiry_delta`, `tlc_min_value`, `tlc_fee_proportional_millionths` | 4 h, 0, 1000 (0.1 %) | Defaults for this node's channels. |
| `rpc.listening_addr` | `127.0.0.1:8227` | See §1.5. |
| `rpc.enabled_modules` | `cch,channel,graph,payment,info,invoice,peer` (+`watchtower` with that feature) | **Add `pubsub`** for WebSocket notifications. `admin` and `dev` are opt-in. [V] ([P/crates/fiber-lib/src/rpc/config.rs#L3-L6](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/rpc/config.rs#L3-L6)) |
| `rpc.biscuit_public_key` | unset | Required when RPC binds to a public address. |
| `rpc.cors_enabled`, `cors_allowed_origins` | false | Not needed for a server-side hub. |
| `ckb.rpc_url` | `https://testnet.ckbapp.dev/` | Mainnet template uses `http://127.0.0.1:8114/` and expects you to supply a trusted node. |
| `ckb.udt_whitelist` | RUSD (testnet), USDI (mainnet) | See §3. |
| `ckb.tx_tracing_polling_interval_ms` | 4000 | |
| `services` | `[fiber, rpc, ckb]` | Add `cch` to run the built-in Cross-Chain Hub. |

### 1.5 RPC exposure and auth [V]
- fnn **refuses to start** if `rpc.listening_addr` is public and no `biscuit_public_key` is set. "Public" includes `0.0.0.0`; private ranges (10/8, 172.16/12, 192.168/16) and loopback are allowed ([P/crates/fiber-lib/src/rpc/mod.rs#L251-L291](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/rpc/mod.rs#L251-L291)).
- **Docker Compose:** binding `0.0.0.0:8227` in the fnn container fails without Biscuit. Options:
  - Give the container a static IP on the compose network and bind to it.
  - Set `biscuit_public_key`.
  - Bind to a hostname, since the address is resolved with `to_socket_addrs`. A service name resolving to a private IP should pass the check. [I]
- **Auth:** Biscuit tokens go in `Authorization: Bearer <base64>` ([P/docs/biscuit-auth.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/docs/biscuit-auth.md)). Hub-relevant rules:

  | Methods | Required fact |
  |---|---|
  | `new_invoice`, `cancel_invoice`, `settle_invoice` | `write("invoices")` |
  | `get_invoice`, `parse_invoice` | `read("invoices")` |
  | `send_payment` | `write("payments")` |
  | `get_payment` | `read("payments")` |
  | `subscribe_store_changes` | `internal("store_changes")` |

  ([P/crates/fiber-lib/src/rpc/biscuit.rs#L94-L141](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/rpc/biscuit.rs#L94-L141))

### 1.6 Node wallet and testnet funding [V/D]
- **The wallet is the `ckb/key` account** (secp256k1-blake160). Funding transactions are signed by fnn. `node_info.default_funding_lock_script` shows the lock script, and `ckb-cli util key-info --privkey-path ckb/key` shows the address.
- **No balance RPC.** fnn has no wallet-balance RPC; query the CKB node or indexer instead (`get_cells_capacity`). [I]
- **External funding.** As an alternative, `open_channel_with_external_funding` + `submit_signed_funding_tx` let an external wallet fund channels. [V]
- **Testnet faucets** ([P/docs/public-nodes.md#L146-L160](https://github.com/nervosnetwork/fiber/blob/v0.9.1/docs/public-nodes.md#L146-L160), [fiber.world network resources](https://www.fiber.world/docs/quick-start/network-resources)):

  | Asset | Faucet | Notes |
  |---|---|---|
  | CKB | https://faucet.nervos.org | Per-claim amount not verified. |
  | RUSD | https://testnet0815.stablepp.xyz/faucet | Claim with a wallet such as JoyID, then transfer to the node address. |
  | cWBTC (for CCH testing) | https://faucet-cwbtc.ckb.dev | |

- **Amount per channel.** A 499 CKB channel needs about **561 CKB** in the wallet: 499 + 61 (change cell) + fee ([public-nodes.md L146-150](https://github.com/nervosnetwork/fiber/blob/v0.9.1/docs/public-nodes.md#L146-L150)). [D]

### 1.7 Resources
- **No official CPU, RAM or disk requirements** in the README, docs or the fiber.world run-a-node page. [V absence]
- **Storage:** RocksDB under `<dir>/fiber/store`.
- **Estimate:** 1–2 vCPU, 1–2 GB RAM and a few GB of SSD is plenty for a hub-sized node. The gossip graph is small (tens of nodes). [I]
- **Backups:** the store holds channel state and must be backed up ([P/docs/notes/backup-guide.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/docs/notes/backup-guide.md)).
- **Upgrades:** close channels before upgrades that lack a supported migration (README "Testnet compatibility issues").

---

## 2. JSON-RPC API (hub-relevant subset)

Reference: [P/crates/fiber-lib/src/rpc/README.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/rpc/README.md). The README is generated from the doc comments in `crates/fiber-json-types/src/*.rs`. There is also a rendered OpenRPC site at https://fiber-rpc-docs.vercel.app/ (`openrpc-json-generator/`) and the fiber.world API reference. **The README is not always accurate; the code wins where they disagree (§7.9).**

### 2.0 Wire format [V]
- **Transport.** JSON-RPC 2.0 over HTTP POST to `http://host:8227/`. WebSocket uses the same port (jsonrpsee server). CCH connects with `ws://` and `http://` on the same host:port ([P/crates/fiber-lib/src/cch/config.rs#L145-L158](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/cch/config.rs#L145-L158)).
- **Params.** An **array with one object**: `"params": [ { ... } ]`. Methods without parameters take `[]`.
- **Numbers.** `u64` and `u128` are **0x-prefixed hex strings**, e.g. `"amount": "0x5f5e100"`, `"expiry": "0xe10"`. Booleans and strings are plain JSON.
- **`Hash256`.** 0x hex, 32 bytes. Accepted without `0x` too.
- **`Pubkey`.** 33-byte compressed key, hex **without** `0x`. Accepted with `0x` too.
- **Enums.** `Currency`: `"Fibb" | "Fibt" | "Fibd"`. `HashAlgorithm`: `"ckb_hash" | "sha256"`.
- **`Script`.** CKB JSON form: `{code_hash, hash_type: "type"|"data"|"data1"|"data2", args}`.

Example taken from the e2e test ([P/tests/bruno/e2e/hold-invoice-cancel-failure/06-new-hold-invoice.bru](https://github.com/nervosnetwork/fiber/blob/v0.9.1/tests/bruno/e2e/hold-invoice-cancel-failure/06-new-hold-invoice.bru)), with `hash_algorithm` and `udt_type_script` added for the hub:
```json
{"jsonrpc":"2.0","id":1,"method":"new_invoice","params":[{
  "amount":"0x5f5e100","currency":"Fibt","description":"ckbolt swap",
  "payment_hash":"0x<sha256(preimage)>","hash_algorithm":"sha256",
  "expiry":"0xe10","final_expiry_delta":"0x5265c00",
  "udt_type_script":{"code_hash":"0x1142…d21a","hash_type":"type","args":"0x878f…439b"}}]}
```
In this example `final_expiry_delta` `0x5265c00` = 24 h in ms. `udt_type_script` is optional; omit it for a CKB invoice.

### 2.1 Invoice module

#### `new_invoice` [V]
Params: `NewInvoiceParams` ([P/crates/fiber-json-types/src/invoice.rs#L119-L167](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-json-types/src/invoice.rs#L119-L167)). Logic: [P/crates/fiber-lib/src/rpc/invoice.rs#L169-L287](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/rpc/invoice.rs#L169-L287).

| Field | Type | Semantics |
|---|---|---|
| `amount` | u128 hex, **required** | **Shannons** for CKB (1 CKB = 10^8). Base units of the UDT when `udt_type_script` is set; RUSD and USDI use 8 decimals per the docs' examples. |
| `currency` | `Fibb`/`Fibt`/`Fibd`, required | Must match the node's chain. |
| `payment_preimage` | Hash256, optional | Regular invoice; the node settles automatically. |
| `payment_hash` | Hash256, optional | **Hold invoice.** The TLC is accepted and held until `settle_invoice`. Setting both fields is an error (`BothPaymenthashAndPreimage`). With neither, the node generates a random preimage. |
| `hash_algorithm` | `"ckb_hash"` (default) / `"sha256"` | **Use `sha256` for Lightning interop.** `sha256` is plain SHA-256 of the 32-byte preimage ([P/crates/fiber-types/src/invoice.rs#L363-L381](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-types/src/invoice.rs#L363-L381)). |
| `expiry` | u64 hex, **seconds**, optional | Invoice expiry. **If omitted the invoice never expires** (`is_expired()` is false without the attribute; [L853-L866](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-types/src/invoice.rs#L853-L866)). Payers reject expired invoices. |
| `final_expiry_delta` | u64 hex, **milliseconds**, optional | Default = minimum = `MIN_TLC_EXPIRY_DELTA` = 1 epoch × 4 h × 2/3 = **9,600,000 ms (160 min)**. Maximum = `MAX_PAYMENT_TLC_EXPIRY_LIMIT` = **14 days** ([rpc/invoice.rs#L242-L255](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/rpc/invoice.rs#L242-L255), [fiber/config.rs#L53-L58](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/config.rs#L53-L58)). The doc comment saying "Minimal value is 16 hours" is **wrong** for v0.9.1. The value is written into the invoice as attribute `final_htlc_minimum_expiry_delta`. |
| `udt_type_script` | Script, optional | UDT invoice. The payer must route over channels of that UDT. On receipt the channel's UDT must equal the invoice's ([channel.rs `try_to_settle_down_tlc`](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/channel.rs#L1435-L1452)). |
| `description`, `fallback_address` | string, optional | |
| `allow_mpp` | bool, optional | Needs the node's MPP feature. Adds a `payment_secret`. |
| `allow_trampoline_routing` | bool, optional | Needed if payers will use `hop_hints`. |

Result: `{ invoice_address: "fibt1…", invoice: CkbInvoice }`.
- `CkbInvoice` is `{currency, amount, signature, data: {timestamp (ms), payment_hash, attrs: [...]}}`.
- `attrs` are snake_case single-key objects, e.g. `{"hash_algorithm":"sha256"}`, `{"final_htlc_minimum_expiry_delta":"0x927c00"}`, `{"expiry_time":"0xe10"}`, `{"payee_public_key":"02…"}`, `{"udt_script":"0x<molecule>"}`.
- **Errors:** `"invoice already exists"`, so a payment hash can be used for only one invoice per node.

#### `parse_invoice` [V]
- Params: `{invoice: "fib…"}`.
- Result: `{invoice: CkbInvoice}`.
- Accepts unsigned invoices (`from_str_allowing_unsigned`); `send_payment` requires a signed one.
- Use it to read `payment_hash`, `amount`, the `hash_algorithm` attribute, `udt_script`, `payee_public_key` and the expiry attributes before paying.

#### `get_invoice` [V]
- Params: `{payment_hash}`.
- Result: `{invoice_address, invoice, status}`.
- The stored status is returned, except that **`Open` is reported as `Expired` when the invoice is past its expiry**. `Expired` is computed on read and never stored ([rpc/invoice.rs#L302-L325](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/rpc/invoice.rs#L302-L325)).

#### `CkbInvoiceStatus` lifecycle [V unless marked]

| Status | When |
|---|---|
| `Open` | Created by `new_invoice` ([store insert_invoice](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/store/store_impl/mod.rs#L1272-L1303)). |
| `Received` | A TLC set that fully pays the invoice has arrived (one TLC with amount ≥ invoice amount, or for MPP the parts summing to the total) and the invoice was `Open` and not expired ([P/crates/fiber-lib/src/fiber/settle_tlc_set_command.rs#L134-L161, L345-L351](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/settle_tlc_set_command.rs#L134-L161)). For a hold invoice this happens right after the TLC is committed. For a regular invoice it is a brief intermediate state. Overpayment is accepted for non-MPP invoices (`tlc.amount >= required`). |
| `Paid` | The fulfilling `RemoveTlc` has been applied in the channel ([P/crates/fiber-lib/src/fiber/channel.rs#L1925-L1930](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/channel.rs#L1925-L1930)). |
| `Cancelled` | Set by `cancel_invoice`; any held TLCs are then failed with `InvoiceCancelled`. |
| `Expired` | Reported only on read for an `Open` invoice past `timestamp + expiry`. Incoming TLCs are rejected with `InvoiceExpired`. |

**Gotcha [I].** If a held TLC of a `Received` invoice is failed by expiry (§7.1), no code path moves the invoice out of `Received`: the only `update_invoice_status` writes are to Received, Paid and Cancelled. `get_invoice` would then still say `Received` while no TLC is held, and a later `settle_invoice` would succeed (it stores the preimage) without any funds arriving. **Before revealing anything, or treating a hold as safe, the hub should confirm the TLC is still present** in `list_channels[].pending_tlcs` (match `payment_hash`, check `expiry`), and should treat only `Paid` as final.

#### `settle_invoice` [V]
- Params: `{payment_hash, payment_preimage}`. Result: `{}` (null-ish).
- Logic ([P/crates/fiber-lib/src/fiber/network.rs#L4400-L4451](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/network.rs#L4400-L4451)):
  - Checks `hash_algorithm(invoice).hash(preimage) == payment_hash`; on failure returns `"Hash mismatch"`.
  - Requires status **`Received`**. Otherwise it returns one of: `Invoice is still open`, `already cancelled`, `already expired`, `already paid`, `not found`.
  - Stores the preimage, notifies the watchtower (so the TLC can still be claimed on-chain after a force close) and triggers `SettleReceivedHoldTlcSet`.
- The call returns **before** the TLC is actually removed. Wait for `Paid` via `get_invoice` or the `PutCkbInvoiceStatus` event.

#### `cancel_invoice` [V]
- Params: `{payment_hash}`. Result: `{invoice_address, invoice, status}`; status should be `Cancelled`.
- The README says it only works on `Open`. **The code also allows `Expired`, and `Received` if no preimage is stored**. It rejects `Paid`, `Cancelled`, and `Received` with a stored preimage (`PaymentPreimageAlreadyExists`) ([P/crates/fiber-lib/src/fiber/network.rs#L4453-L4490](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/network.rs#L4453-L4490)).
- Held TLCs are failed back with `InvoiceCancelled`. The e2e test cancels after `Received` and the payer's `get_payment.failed_error` shows `InvoiceCancelled` ([P/tests/bruno/e2e/hold-invoice-cancel-failure](https://github.com/nervosnetwork/fiber/tree/v0.9.1/tests/bruno/e2e/hold-invoice-cancel-failure)).

### 2.2 Payment module

#### `send_payment` [V]
Params: `SendPaymentCommandParams` ([P/crates/fiber-json-types/src/payment.rs#L166](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-json-types/src/payment.rs#L166)). Validation: [P/crates/fiber-lib/src/fiber/payment.rs#L380-L560](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/payment.rs#L380-L560).

| Field | Semantics |
|---|---|
| `invoice` | Encoded invoice. It must be signed and not expired. The invoice supplies `target_pubkey`, `amount`, `payment_hash`, `udt_script`, `hash_algorithm` and the final expiry. Any explicit field that conflicts with the invoice is an error ("… does not match the invoice"). |
| `target_pubkey` | Required when there is no invoice. |
| `amount` | Shannons, or UDT base units. Without a UDT, the amount must be `< u64::MAX`. |
| `payment_hash` | Required when there is no invoice and `keysend` is off. **Without an invoice the hash algorithm is `ckb_hash`**, and keysend uses `blake2b(preimage)` ([L495-L503](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/payment.rs#L495-L503); `hash_algorithm()` [L572-L583](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/payment.rs#L572-L583)). |
| `udt_type_script` | UDT payment. Taken from the invoice if present. |
| `keysend` | Spontaneous payment. Cannot be combined with an invoice or a `payment_hash`. |
| `dry_run` | Builds a route and fee without sending. Use it as a preflight; CCH does. |
| `max_fee_amount` | **Clamped to `min(max_fee_amount, amount × max_fee_rate / 1000)`** ([L432-L441](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/payment.rs#L432-L441)). |
| `max_fee_rate` | Per thousand, default **5** (0.5 %) ([L50](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/payment.rs#L50)). To allow more fee you must raise both fields. |
| `final_tlc_expiry_delta` | **Ignored** when the invoice carries `final_htlc_minimum_expiry_delta`, which every fnn-made invoice does ([L453-L475](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/payment.rs#L453-L475)). Without an invoice the default is 1 day. Valid range is 160 min to 14 days. |
| `tlc_expiry_limit` | Maximum total route expiry in ms. **Default 14 days.** The hub should always set it (§7.2). |
| `timeout` | Seconds. Accepted and stored, but no code in v0.9.1 enforces it [I]. Do not rely on it; the hub needs its own deadline logic. |
| `max_parts` | MPP, 1..24. **`max_parts: 1` is refused for an invoice that allows MPP** (`invalid max_parts`, [payment.rs L315-L320](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/payment.rs#L308-L324)); an invoice allows MPP when its `feature` attribute lists `BASIC_MPP_OPTIONAL` or `BASIC_MPP_REQUIRED` (`new_invoice` with `allow_mpp`, which also adds `payment_secret`). [V] |
| `trampoline_hops`, `hop_hints`, `custom_records` (≤ 2048 B), `allow_self_payment` | Advanced options. `allow_self_payment` is for rebalancing. |

Result (same shape for `get_payment`): `{payment_hash, payment_preimage?, status, created_at (ms), last_updated_at (ms), failed_error?, fee, custom_records?}`. `routers` is only present in **debug builds**: `#[cfg(debug_assertions)]` at [P/crates/fiber-json-types/src/payment.rs#L88](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-json-types/src/payment.rs#L88).
- `send_payment` returns right away (status usually `Created`) and the payment continues asynchronously.
- **Idempotency.** A second `send_payment` with the same hash fails while the session is `Created`, `Inflight` or `Success`. A retry is allowed only after `Failed` with no attempt in flight ([L2184-L2200](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/payment.rs#L2184-L2200)). Use `payment_hash` as the idempotency key.

#### `get_payment` [V]
- Params: `{payment_hash}`.
- `PaymentStatus`: `Created → Inflight → Success | Failed`.
- **The result includes `payment_preimage` once a successful attempt exists.** It is set in `impl From<PaymentSession> for SendPaymentResponse` from `attempts().filter(is_success).find_map(|a| a.preimage)` ([P/crates/fiber-lib/src/fiber/payment.rs#L627-L634](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/payment.rs#L627-L634)), with the field declared at [P/crates/fiber-json-types/src/payment.rs#L63-L67](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-json-types/src/payment.rs#L63-L67).
- The field was added in v0.9.0 (commit `3ac7f2a5`, #1512); v0.8.x does not have it.
- `failed_error` carries decoded final-hop errors such as `InvoiceCancelled`, `HoldTlcTimeout`, `IncorrectOrUnknownPaymentDetails`, `ExpiryTooSoon`.

#### `list_payments` (since v0.8.0) [V]
- Params: `{status?, limit? (default 15), after? (payment_hash cursor)}`.
- Result: `{payments: [GetPaymentCommandResult], last_cursor}`.

#### `build_router` / `send_payment_with_router`
Manual routes, mainly for rebalancing. Not needed for the hub's first version.

### 2.3 Channel module [V]

#### `open_channel`
Params ([P/crates/fiber-json-types/src/channel.rs#L93](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-json-types/src/channel.rs#L93)):
- **Required:** `pubkey` (the peer must already be connected) and `funding_amount`. The funding amount is shannons, or UDT base units when `funding_udt_type_script` is set.
- **Channel shape:** `public` (default true), `one_way`, `funding_udt_type_script`, `shutdown_script`.
- **Commitment and fees:** `commitment_delay_epoch` (default 1 epoch ≈ 4 h), `commitment_fee_rate`, `funding_fee_rate`.
- **TLC policy:** `tlc_expiry_delta` (default 4 h, minimum 160 min), `tlc_min_value`, `tlc_fee_proportional_millionths`.
- **In-flight limits:** `max_tlc_value_in_flight` (default u128::MAX) and `max_tlc_number_in_flight` (default 125). Neither can be changed after the channel opens.

Result: `{temporary_channel_id}`.

Reserve rules:
- **CKB channel:** the funder's `funding_amount` includes the reserve. 98 CKB of commitment-cell occupancy plus 1 CKB of shutdown fee are not spendable; this becomes 99 + 1 in the `main`/0.10 V1 lock. A 499 CKB funding shows `local_balance` 400 CKB ([public-nodes.md L45-L53](https://github.com/nervosnetwork/fiber/blob/v0.9.1/docs/public-nodes.md#L45-L53); [`get_funding_and_reserved_amount`](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/channel.rs#L5233-L5267)).
- **UDT channel:** the whole UDT amount is usable, and the CKB reserve for the UDT cell occupancy comes from the wallet on top.

#### `accept_channel`
- Params: `{temporary_channel_id, funding_amount, shutdown_script?, max_tlc_value_in_flight?, max_tlc_number_in_flight?, tlc_min_value?, tlc_fee_proportional_millionths?, tlc_expiry_delta?}`.
- Result: `{channel_id}`.
- Only needed when the request was not auto-accepted.

#### `list_channels`
- Params: `{pubkey?, include_closed?, only_pending?}`.
- Each `Channel` has:
  - **Identity:** `channel_id`, `is_public`, `is_acceptor`, `is_one_way`, `channel_outpoint`, `pubkey` (the peer), `funding_udt_type_script`.
  - **State:** `state` = `{state_name, state_flags}`, e.g. `NegotiatingFunding`, `CollaboratingFundingTx`, `SigningCommitment`, `AwaitingTxSignatures`, `AwaitingChannelReady`, **`ChannelReady`**, `ShuttingDown`, `Closed`, `Stale`.
  - **Balances:** **`local_balance`, `offered_tlc_balance`, `remote_balance`, `received_tlc_balance`** (hex u128, already net of reserve).
  - **TLCs:** **`pending_tlcs`**, a list of `{id, amount, payment_hash, expiry (absolute ms), forwarding_channel_id, forwarding_tlc_id, status}`.
  - **Other:** `latest_commitment_transaction_hash`, `created_at`, `enabled`, `tlc_expiry_delta`, `tlc_fee_proportional_millionths`, `shutdown_transaction_hash`, `failure_detail`.

#### `shutdown_channel`
- Params: `{channel_id, close_script?, fee_rate?, force?}`. `close_script` must be secp256k1-blake160; `fee_rate` defaults to 1000 shannons/KW. `force: true` closes unilaterally, and funds are then delayed by `commitment_delay_epoch`.

#### Other channel methods
- `update_channel`: `{channel_id, enabled?, tlc_expiry_delta?, tlc_minimum_value?, tlc_fee_proportional_millionths?}`.
- `abandon_channel`: for channels that are not Ready.
- `open_channel_with_external_funding` and `submit_signed_funding_tx`: external wallet funding.

### 2.4 Peer module [V]
- **`connect_peer`:** `{address? (multiaddr), pubkey?, save?, addr_type?}`. Connecting by pubkey alone needs the address to be in the synced graph, so the first connection should pass the address. Returns an error on failure (since v0.8.0).
- **`list_peers`:** `[]` → `{peers: [{pubkey, address}]}`.
- **`disconnect_peer`:** `{pubkey}`.

### 2.5 Info and graph [V]
- **`node_info`:** `[]` →
  - Identity: `version`, `commit_hash`, `pubkey`, `features`, `node_name`, `addresses`, `chain_hash`.
  - Channel acceptance: `open_channel_auto_accept_min_ckb_funding_amount`, `auto_accept_channel_ckb_funding_amount`, `default_funding_lock_script`.
  - TLC defaults: `tlc_expiry_delta`, `tlc_min_value`, `tlc_fee_proportional_millionths`.
  - Counts: `channel_count`, `pending_channel_count`, `peers_count`.
  - `udt_cfg_infos` (the node's UDT whitelist).
  - Numbers are hex.
- **`graph_nodes`:** `{limit?, after?}` → `{nodes: [NodeInfo], last_cursor}`. `NodeInfo` holds `node_name, version, addresses, features, pubkey, timestamp, chain_hash, auto_accept_min_ckb_funding_amount, udt_cfg_infos`.
- **`graph_channels`:** `{limit?, after?}` → `{channels: [ChannelInfo], last_cursor}`. `ChannelInfo` holds `channel_outpoint, node1, node2, created_timestamp, update_info_of_node1/2 {timestamp, enabled, outbound_liquidity?, tlc_expiry_delta, tlc_minimum_value, fee_rate}, capacity, chain_hash, udt_type_script`.

### 2.6 Notifications: WebSocket `subscribe_store_changes` [V]
- **Module:** `pubsub`, **not enabled by default** ([P/crates/fiber-lib/src/rpc/pubsub.rs#L70-L95](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/rpc/pubsub.rs#L70-L95); registered at [rpc/mod.rs#L401-L410](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/rpc/mod.rs#L401-L410)). It is not listed in the RPC README.
- **Methods:** subscribe with `subscribe_store_changes` and params `[]`; notifications arrive as `store_changes`; unsubscribe with `unsubscribe_store_changes`. This is the same mechanism standalone CCH uses ([P/crates/fiber-lib/src/cch/actor.rs#L2507-L2560](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/cch/actor.rs#L2507-L2560)).
- **Payload:** serde externally tagged `StoreChange` ([P/crates/fiber-lib/src/store/store_impl/mod.rs#L468-L487](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/store/store_impl/mod.rs#L468-L487)):
  - `{"PutCkbInvoiceStatus":{"payment_hash":"0x…","invoice_status":"Received"}}`
  - `{"PutPreimage":{"payment_hash":"0x…","payment_preimage":"0x…"}}`
  - `{"PutPaymentSession":{"payment_hash":"0x…","payment_session":{…internal…},"payment_preimage":"0x…"|null}}`. `payment_session` uses the internal format, which may change between versions; read `status` from `get_payment` instead.
  - `{"PutAttempt":{"payment_hash":"0x…","attempt_status":"Created|Inflight|Retrying|Success|Failed"}}`
- **Caveats:**
  - Events are live only, with no history or replay. On (re)connect, reconcile by polling `get_invoice` / `get_payment` for open orders; CCH reconnects every 5 s and re-tracks orders.
  - There is **no `Expired` event** (expiry is computed on read) and no event when a held TLC times out (§2.1 gotcha).
  - The stream carries **every preimage** the node learns, which is why Biscuit gates it behind `internal("store_changes")`. Keep the socket on a private network.
  - On restart, an already-stored preimage that is inserted again still emits `PutPreimage` ([store_impl/mod.rs#L1329-L1346](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/store/store_impl/mod.rs#L1329-L1346)).

### 2.7 CCH module (Fiber's built-in Cross-Chain Hub) [V]
Methods: `send_btc {btc_pay_req, currency}`, `receive_btc {fiber_pay_req}`, `get_cch_order {payment_hash}`. Order statuses: `Pending → IncomingAccepted → OutgoingInFlight → OutgoingSuccess → Success | Failed`.
- **Scope:** CCH only swaps BTC against a **wrapped-BTC UDT at 1:1** (`wrapped_btc_type_script_args`, 8 decimals) and talks to **LND** over gRPC. It can run in-process (`services: [..., cch]`) or standalone (`cch.fiber_rpc_url`).
- **SHA-256 enforcement:** CCH creates its Fiber hold invoices with `HashAlgorithm::Sha256` and rejects non-SHA-256 Fiber invoices (`CKBInvoiceIncompatibleHashAlgorithm`) ([P/crates/fiber-lib/src/cch/actor.rs#L1335-L1345 and L1798-L1803](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/cch/actor.rs#L1798-L1803)).
- **Defaults** ([P/crates/fiber-lib/src/cch/config.rs#L5-L18](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/cch/config.rs#L5-L18)):

  | Setting | Default |
  |---|---|
  | Order expiry | 36 h |
  | BTC final CLTV | 360 blocks (~60 h) |
  | CKB final TLC delta | 60 h |
  | Minimum outgoing invoice expiry | 6 h |
  | Fee | 100 sat base + 3000 ppm |
  | Outgoing routing fee cap | 80 % of the CCH fee |

- **Expiry rules** ([P/docs/specs/cch-expiry-dependency.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/docs/specs/cch-expiry-dependency.md)): the outgoing final delta must be < ½ of the incoming final delta. At dispatch time the outgoing route is capped at ½ of the remaining incoming time: `tlc_expiry_limit` on Fiber, `cltv_limit` on LND.
- **Use for CKBolt:** a design and code reference, and a possible liquidity source for wrapped-BTC routes. It does not handle native CKB or RUSD pricing.

---

## 3. UDT support

### 3.1 Whitelist config [V]
`ckb.udt_whitelist` is a list of `UdtArgInfo` entries:
```yaml
- name: RUSD
  script: { code_hash: 0x…, hash_type: type, args: 0x… }   # args is a REGEX (unanchored), e.g. "0x.*" on devnet
  cell_deps:
    - type_id: { code_hash: 0x…545950455f4944, hash_type: type, args: 0x… }   # or: cell_dep: { out_point: {tx_hash, index}, dep_type }
  auto_accept_amount: 1000000000   # inbound UDT channel auto-accepted when funding >= this
```
- **Matching** is by code_hash + hash_type, plus a regex match on args ([P/crates/fiber-lib/src/ckb/config.rs#L182-L207](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/ckb/config.rs#L182-L207)).
- **Rejection:** `open_channel` and `accept_channel` reject UDT scripts that are not in the **local** whitelist ("Invalid UDT type script").
- **Advertising:** each node publishes its whitelist in `udt_cfg_infos` (`node_info`, `graph_nodes`).

### 3.2 Default whitelisted UDTs [V]
| Network | Name | code_hash | hash_type | args | cell dep (type_id args) | auto_accept_amount |
|---|---|---|---|---|---|---|
| Testnet | **RUSD** | `0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a` | type | `0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b` | `0x97d30b723c0b2c66e9cb8d4d0df4ab5d7222cbb00d4a9a2055ce2e5d7f0d8b0f` | 1,000,000,000 (10 RUSD) in the bundled config. Public nodes use 2,000,000,000 (20 RUSD). |
| Mainnet | **USDI** | `0xbfa35a9c38a676682b65ade8f02be164d48632281477e36f8dc2f41f79e56bfc` | type | `0xd591ebdc69626647e056e13345fd830c8b876bb06aa07ba610479eb77153ea9f` | `0x9105ea69838511ca609518d27855c53fed1b5ffaff4cfb334f58b40627d211c4` | 10,000,000 (0.1 USDI) |

Sources: [testnet config L88-99](https://github.com/nervosnetwork/fiber/blob/v0.9.1/config/testnet/config.yml#L88-L99), [mainnet config L106-118](https://github.com/nervosnetwork/fiber/blob/v0.9.1/config/mainnet/config.yml#L106-L118), [P/docs/network-nodes.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/docs/network-nodes.md). Both tokens use 8 decimals per the docs' examples, e.g. "0x5f5e100 (100,000,000) = 1 RUSD". [D]

**Mainnet status [D]:** "The public nodes' CKB addresses do not hold any USDI yet, so UDT channels cannot be created at this time" (network-nodes.md, last edited 2026-05-10). Check this again on the dashboard.

### 3.3 Opening and funding a UDT channel [V/D]
1. Connect to the peer.
2. Call `open_channel` with `funding_amount` (UDT base units) and `funding_udt_type_script`. The node's wallet must hold the UDT cells **and** enough CKB for the UDT cell occupancy reserve plus fees.
3. The peer auto-accepts if the funding is at least its `auto_accept_amount` for that UDT; otherwise it must call `accept_channel`.
4. Public testnet nodes accept ≥ 20 RUSD and **contribute 0 RUSD**. The opener therefore gets outbound RUSD liquidity only, and **no inbound RUSD** (example in [public-nodes.md L534-L581](https://github.com/nervosnetwork/fiber/blob/v0.9.1/docs/public-nodes.md#L534-L581)).
5. A UDT invoice or payment must name the same UDT script. A TLC that arrives on a channel of a different asset is rejected.

offckb's notes on fnn 0.9.0 devnet say UDT channels are not auto-accepted there, and that the acceptor must hold its own UDT cells, otherwise it fails with "can not find enough UDT owner cells". `main` has a related fix, "build complete dual-funded UDT transactions (#1671)". [D]

### 3.4 Channels another node opens to this node (checked 2026-11-07 against `v0.9.1`) [V]
Researched for letting browser nodes fund their own token channel to the hub (FIBER_ASSETS `peerChannels`, docs/add-token.md).

- **Auto-accept decision** ([network.rs L1665-L1697](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/network.rs#L1665-L1697), `handle_peer_message`, `ChannelInitialization`):
  - **UDT channel:** accepted when `is_udt_type_auto_accept(script, funding_amount)` holds. That needs a whitelist entry with `auto_accept_amount` at or below the funding ([contracts.rs L454-L461](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/ckb/contracts.rs#L454-L461)). An entry without `auto_accept_amount` is never auto-accepted.
  - **CKB channel:** accepted only when `auto_accept_channel_ckb_funding_amount > 0` **and** the funding is at least `open_channel_auto_accept_min_ckb_funding_amount`. The kit's fnn-hub sets the former to 0, so no node can open a CKB channel to it; the hub has no `accept_channel` logic of its own.
  - **What auto-accept puts in:** `funding_amount: 0` for a UDT channel whatever the config says, and `auto_accept_channel_ckb_funding_amount` for CKB.
- **The acceptor's CKB reserve.** Even with 0 tokens, accepting a UDT channel reserves the occupied capacity of the acceptor's UDT output from its own wallet (`get_funding_and_reserved_amount`, [channel.rs L5233-L5266](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/channel.rs#L5233-L5266), called from `create_inbound_channel`, network.rs L6034-L6122). The funding builder skips UDT input collection when the local token amount is 0 ([funding_tx.rs L390-L398](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/ckb/funding/funding_tx.rs#L382-L398)), so the acceptor needs CKB, not token cells.
- **Dual-funded UDT channels** (the acceptor adds tokens with `accept_channel`) are broken in v0.9.1. Upstream fixed output ordering, witness size and cell deps after it ("fix: build complete dual-funded UDT transactions", nervosnetwork/fiber#1671, merged into `develop` on 2026-09-29, closes #1663, #1667, #1669). So a browser node cannot add its own tokens to a channel the hub opens, as it does with CKB; it has to open the channel itself.
- **The opener's commitment delay.**
  - **Range:** `on_open_channel_msg` ([network.rs L7235-L7291](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/network.rs#L7235-L7291)) runs `check_open_channel_parameters`, which takes any well-formed `EpochNumberWithFraction` from 1 to 84 epochs ([fee.rs L273-L296](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/fee.rs#L273-L296)). Fractions are allowed.
  - **No check on the acceptor's side:** `create_inbound_channel` does not compare the delay with the acceptor's `tlc_expiry_delta`. Only the opener runs `check_tlc_delta_with_epochs` (network.rs L5847-L5852 and L5967-L5972), which requires the opener's `tlc_expiry_delta` to be at least 2/3 of the delay. With fnn's default of 4 h, that caps D at 1.5 epochs, but a modified opener can skip it.
  - **Not visible:** no RPC reports the delay. The `Channel` of `list_channels` has no such field, and a pending inbound channel (`pending_accept_channel_to_rpc`, rpc/channel.rs L105-L137) shows even less.
- **How the delay acts on TLCs.**
  - **At add time:** `check_tlc_expiry` refuses a TLC whose expiry is before `now + 2/3·D` (`tlc_expiry_delay`) or at least `now + 14 days` ([channel.rs L7401-L7438](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/channel.rs#L7401-L7438)). It runs for a TLC from the peer (L1812) and for one this node sends (L2130), so the payer's own node refuses to send one too.
  - **While held:** every 60 s, a held TLC that is not forwarded is failed with `ExpiryTooSoon` once `expiry < now + 2/3·D + 60 s` (L2977-L3008).
  - **Offered TLCs:** an offered TLC within 2/3·D of its expiry force-closes the channel (L3018-L3040).
- **What it means for a swap paid over a peer channel.**
  - **Where the TLC fails:** at the earliest `expiry − 2/3·D − 60 s`. A payer choosing D = 84 makes that `expiry − 224 h − 60 s`.
  - **Safety:** the hub may pay out on Lightning only with a `cltv_limit` whose slow-block time ends, with margin, before that point *for the largest D possible*. Otherwise the payer delays its Lightning payout until fnn has failed the Fiber TLC back to it, then settles: the hub pays and cannot collect.
  - **Payability:** the hold invoice's `final_expiry_delta` (a floor on the payer's expiry, `is_tlc_expire_too_soon`, fiber-types invoice.rs L869-L876) must exceed 224 h + 60 s + margin + the payout window. That fits under the 14-day maximum.
  - **The payer's side:** the payer's random expiry delta is a whole number of 4 h steps, at least one, within `tlc_expiry_limit` (graph.rs L2009-L2163), so a hold delta up to 14 days − 4 h stays payable.
- **Pending limits:** fnn caps channels waiting for acceptance, globally and per peer (`check_pending_channel_limit`, network.rs L6130-L6155). Ready channels are not capped, so every peer channel in a token with `auto_accept_amount` costs the acceptor its CKB reserve until the channel closes.

---

## 4. Testnet

### 4.1 Public nodes [V/D]
Channels can be opened to these.

| Name | Pubkey | Native TCP | Browser WSS | Auto-accept |
|---|---|---|---|---|
| fiber-testnet-public-**bottle** | `02b6d4e3ab86a2ca2fad6fae0ecb2e1e559e0b911939872a90abdda6d20302be71` | `/dns4/bottle.fiber.channel/tcp/8119/p2p/QmXen3eUHhywmutEzydCsW4hXBoeVmdET2FJvMX69XJ1Eo` | `…/tcp/443/wss/…` | ≥ 499 CKB (adds 250 CKB) or ≥ 20 RUSD (adds 0) |
| fiber-testnet-public-**bracer** | `0291a6576bd5a94bd74b27080a48340875338fff9f6d6361fe6b8db8d0d1912fcc` | `/dns4/bracer.fiber.channel/tcp/8119/p2p/QmbKyzq9qUmymW2Gi8Zq7kKVpPiNA1XUJ6uMvsUC4F3p89` | `…/tcp/443/wss/…` | same |

- **Mainnet public nodes:** `03a8d7da…adc6b` (ca) and `033a69e5…028f9` (tokyo), each requiring ≥ 499 CKB.
- **Bootnodes** (`thrall.fiber.channel` and `onyxia.fiber.channel`, which match the IPs in the config) are for discovery only.
- **Testnet `chain_hash`:** `0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606`.

Sources: [fiber.world network resources](https://www.fiber.world/docs/quick-start/network-resources) (endpoints checked 2026-08-17), [P/docs/network-nodes.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/docs/network-nodes.md), [P/docs/public-nodes.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/docs/public-nodes.md).

### 4.2 Explorer, dashboard, faucets [V/D]
- **Fiber dashboard:** https://dashboard.fiber.channel/nodes (source: [nervosnetwork/fiber-dashboard](https://github.com/nervosnetwork/fiber-dashboard)). Its backend has an HTTP API: `/nodes_hourly`, `/channels_by_node_id`, `/node_udt_infos`, `/channel_state`, and more. The public host of that API was not checked.
- **CKB testnet explorer:** https://explorer.nervos.org/aggron, as listed by fiber.world.
- **Faucets:** see §1.6.

### 4.3 Getting connected and routable [V/I]
1. Start with the bundled testnet config. Bootnodes give peer discovery and gossip graph sync (`sync_network_graph` defaults to true).
2. Call `connect_peer` with `address` + `pubkey` of bottle or bracer.
3. Call `open_channel` with ≥ 499 CKB and `public: true`. The public node adds 250 CKB, which gives the hub **151 CKB of inbound** CKB liquidity after reserve.
4. Wait for `ChannelReady` (the funding transaction is tracked to 4 confirmations [I], `CKB_TX_TRACING_CONFIRMATIONS = 4`). Payments can fail with "Failed to build route" until gossip has spread; the docs say to retry after a short wait. [D]
5. **The hub needs public channels to be payable.** Payers find routes from the gossip graph, and fnn invoices carry no route hints (hop hints are a payer-side option that needs `allow_trampoline_routing`). Set `announced_addrs` so users can open channels directly to the hub. [I]
6. **Liquidity per direction:**

   | Swap direction | Hub's Fiber role | Liquidity needed |
   |---|---|---|
   | BTC → CKB/RUSD | Pays out on Fiber | Outbound on Fiber; it comes from the hub's own funding. |
   | CKB/RUSD → BTC | Receives on Fiber | Inbound on Fiber. For RUSD, public nodes add none: get it from users or LPs opening channels to the hub, from the hub paying RUSD out first, or from rebalancing. |

---

## 5. Devnet / local setup in the Fiber repo [V]

### 5.1 The repo's own harness
These are bash scripts for Linux and macOS.
- **Prerequisites:** `ckb` (CI pins **0.202.0**), `ckb-cli`, Rust (`rust-toolchain.toml`), `nc`, Node.js (for Bruno). For the CCH tests: `bitcoind` 27.0, `lnd` v0.18.0-beta, `jq` ([P/.github/workflows/e2e.yml](https://github.com/nervosnetwork/fiber/blob/v0.9.1/.github/workflows/e2e.yml)).
- **One command:** `REMOVE_OLD_STATE=y ./tests/nodes/start.sh e2e/<case>` ([P/tests/nodes/start.sh](https://github.com/nervosnetwork/fiber/blob/v0.9.1/tests/nodes/start.sh)). It:
  1. runs `tests/deploy/init-dev-chain.sh` ([file](https://github.com/nervosnetwork/fiber/blob/v0.9.1/tests/deploy/init-dev-chain.sh)): `ckb init -c dev`, copies `tests/nodes/deployer/dev.toml` as the chain spec, enables the `IntegrationTest` RPC module, starts `ckb run --indexer`, transfers CKB from the deployer key to nodes 1–3 with `ckb-cli`, and mines with `generate-blocks.sh`.
  2. runs `tests/deploy/deploy.sh`, which runs `tests/deploy/udt-init` (Rust). That step issues simple-UDT and xUDT tokens to the node accounts and **generates each node's `config.yml`** from `tests/nodes/deployer/config.yml`, with RPC on 21713+N, P2P on 8343+N, the UDT whitelist and the `cch` service on node 3 ([P/tests/deploy/udt-init/src/main.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/tests/deploy/udt-init/src/main.rs)).
  3. runs `cargo build`, then starts `fnn -d 1|2|3` with `FIBER_SECRET_KEY_PASSWORD=password<N>`. The bootnode is added for `e2e/router-pay`, and LND is set up for the `cross-chain-hub*` cases.
- **Contracts on devnet do not need a deployment transaction.** They are baked into the devnet genesis as `genesis.system_cells` in `tests/nodes/deployer/dev.toml`: `auth`, `funding-lock`, `commitment-lock`, `simple_udt`, `xudt_rce`, binaries in `tests/deploy/contracts/` ([P/tests/deploy/contracts/README.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/tests/deploy/contracts/README.md)). The node config's `fiber.chain: dev.toml` lets fnn find them in genesis.
- **Running the tests:** `cd tests/bruno && npm exec -- @usebruno/cli@1.20.0 run e2e/<case> -r --env test`. Endpoints come from `tests/bruno/environments/test.bru`: `NODE{1,2,3}_RPC_URL=http://127.0.0.1:2171{4,5,6}`, CKB at `:8114`, LND at `:8080` and `:8180`.
- **Hub-relevant e2e cases:**
  - `hold-invoice-cancel-failure`
  - `invoice-ops`
  - `3-nodes-transfer`, also run with `--env-var HASH_ALGORITHM=sha256`
  - `udt`, `udt-router-pay`
  - `cross-chain-hub`, `cross-chain-hub-separate`
  - `watchtower/force-close-mpp` (an MPP hold invoice)

**Caveat [V]:** the harness builds **debug** fnn. Debug builds use `MILLI_SECONDS_PER_EPOCH = 2 s` (so `MIN_TLC_EXPIRY_DELTA` ≈ 1.3 s), `DEFAULT_HOLD_TLC_TIMEOUT = 20 s` and `CHECK_CHANNELS_INTERVAL = 3 s`, against 4 h, 120 s and 60 s in release builds ([fiber/config.rs#L43-L77](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/config.rs#L43-L77), [network.rs#L183-L188](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/network.rs#L183-L188)). Debug builds also include `routers` in payment results. Hub timing tests should use release binaries.

### 5.2 offckb (alternative, cross-platform Node CLI) [V]
- **Fiber support** was added in ckb-devrel/offckb commit `2054548` (2026-08-24, "@offckb/cli 0.5.0"). **npm `latest` is still 0.4.13**, which has no Fiber support; 0.5.0 exists only as canary builds (`0.5.0-canary-3a208ce`).
- **Commands:** `offckb node --fiber`, or `offckb node` followed by `offckb fiber start [--nodes N] [--daemon]`. Status, logs and cleanup: `offckb fiber status|logs|clean`.
- **Node layout:** node N uses CKB account N+2, RPC port 21713+N and P2P port 8343+N.
- **fnn binary:** downloads the release binary of **fnn 0.9.0**; use `--binary-path` for another one.
- **Contracts:** the Fiber contracts are in the devnet genesis, so an old devnet must be rebuilt with `offckb clean`.
- **UDT:** the sUDT and xUDT issued by account 19 are whitelisted.

Source: [ckb-devrel/offckb README "Run a Fiber Devnet"](https://github.com/ckb-devrel/offckb#fiber-devnet).

### 5.3 What the hub's devnet stack needs [I]
- A CKB devnet whose genesis includes the Fiber contracts (offckb canary or the Fiber harness).
- Two or more release fnn nodes: the hub plus a "user/merchant" node.
- bitcoind regtest with two LND nodes. `tests/deploy/lnd-init/setup-lnd.sh` creates `lnd-bob` and `lnd-ingrid` and opens a channel between them.
- The Fiber harness has **no docker-compose**. The hub repo would need its own compose (or scripts) around these pieces.

---

## 6. Client libraries [V]

| Package | Version (npm, 2026-10-23) | What it is | Fit for the hub |
|---|---|---|---|
| `@nervosnetwork/fiber-js` | 0.9.1 (2026-09-11) | A **WASM fnn node** that runs in the browser or Node, with the same command set via `invokeCommand`. It is not an HTTP client. ([P/fiber-js/README.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/fiber-js/README.md)) | No, for a server hub. Possibly useful for in-browser user nodes later. |
| `@fiber-pay/sdk` (+ `node`, `runtime`, `cli`) | 0.3.2 (2026-08-24) | Community (RetricSu/fiber-pay), MIT. Typed `FiberRpcClient` covering peers, channels, payments, invoices including cancel and settle for hold invoices, and graph. Also Biscuit helpers and polling monitors. Targets fnn 0.9.x; peer dependency `@nervosnetwork/fiber-js ~0.9.0` (optional). | Usable; check the field mapping against v0.9.1. |
| `@ckb-ccc/fiber` | canary only (`0.0.0-canary-20260505020844`) | CCC "Fiber SDK" (`FiberSDK({endpoint})`), camelCase over HTTP. Its typings make **`paymentPreimage` required** in `NewInvoiceParamsLike`, and some types are pre-0.8 (e.g. `hashAlgorithm: number` in attributes). | Not suitable for hold invoices as typed: fnn errors if both preimage and hash are sent. [I from .d.ts] |
| `fnn-cli` (Rust, in repo) | 0.9.1 | Official CLI and REPL (`-u URL --auth-token`). | Ops and debugging. |

**Recommendation [I]:** write a thin typed JSON-RPC client in the hub. It needs about 15 methods, all taking `params: [obj]`, with u64/u128 encoded as hex strings (BigInt ↔ `0x…`). The WS subscription can use any JSON-RPC WS client. Optionally generate types from the OpenRPC spec (`cd openrpc-json-generator && cargo run`).

---

## 7. Limitations and risks for a swap hub

### 7.1 How long a hold can last [V]
Applies when the hub is the **receiver** (CKB/RUSD → BTC).

**When the incoming TLC is accepted.** fnn rejects the incoming TLC if `tlc.expiry < now + invoice.final_htlc_minimum_expiry_delta` ([P/crates/fiber-lib/src/fiber/channel.rs#L1698-L1701](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/channel.rs#L1698-L1701)). Its expiry, set by the payer, is `now + final_expiry_delta + random k × 4 h` with k ≥ 1, bounded by the payer's `tlc_expiry_limit` ([P/crates/fiber-lib/src/fiber/graph.rs#L1994-L2085, L2150-L2163](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/graph.rs#L2150-L2163)).

**While the invoice is `Open`.** The TLC is held until `min(invoice timestamp + expiry, tlc.expiry)` ([channel.rs#L1327-L1405](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/channel.rs#L1327-L1405)). This only matters for partial MPP sets: a complete set moves the invoice to `Received` at once.

**Once `Received`.** The hold timeout is ignored ([network.rs#L4016-L4021](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/network.rs#L4016-L4021)). Every 60 s the channel actor fails any received, non-forwarded TLC whose expiry is within the force-close margin ([channel.rs#L2976-L3008](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/channel.rs#L2976-L3008); `tlc_expiry_delay` at [L5301-L5306](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/channel.rs#L5301-L5306)). The condition is:
```
tlc.expiry < now + 2/3 × commitment_delay_epoch(of that inbound channel) + 60 s    → fail with ExpiryTooSoon
```
**The commitment delay belongs to the inbound channel, and its opener chooses it [V].** `commitment_delay_epoch` is an `open_channel` parameter (default 1 epoch). On a channel a peer opens to this node, fnn accepts any well-formed value from 1 to 84 epochs (`MIN/MAX_COMMITMENT_DELAY_EPOCHS`, [fee.rs `check_open_channel_parameters`](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/fee.rs#L211-L300), called for inbound channels at [network.rs L7251](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/network.rs#L7240-L7262)); auto-accept does not check it against the node's own `tlc_expiry_delta`. The early-fail margin is `floor(epochs × 4 h × 2 / 3) + 60 s` (`tlc_expiry_delay`, [channel.rs L5301-L5306](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/channel.rs#L5301-L5306)): 160 min + 60 s at 1 epoch, **224 h + 60 s at 84 epochs**. `list_channels` does not report the delay; `is_acceptor: true` says the peer opened the channel (and so chose it). The hub therefore assumes fnn's default for channels it opened and, unless configured otherwise (`FIBER_PEER_CHANNEL_COMMITMENT_DELAY_EPOCHS`), the 84-epoch maximum for channels a peer opened.

**Effective hold window** = `tlc.expiry − arrival − ~160 min − ≤ 60 s` on a channel with the default delay. It is **at least `final_expiry_delta − 160 min`**, and for fnn payers usually 4 h or more longer because of the random delta. With the default `final_expiry_delta` (160 min), the guaranteed window is about 0. **Set `final_expiry_delta` to the hold time you need plus 160 min plus a margin.** CCH uses 60 h; for an interactive swap, 6–24 h is reasonable.

**In practice.** Read the actual `pending_tlcs[].expiry` from `list_channels` and size the outgoing Lightning payment's `cltv_limit` from it.

**Regular MPP (non-hold) invoices** hold partial sets for at most `DEFAULT_HOLD_TLC_TIMEOUT` = 120 s ([config.rs#L73-L77](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/config.rs#L73-L77)).

### 7.2 Timelock coordination Lightning ↔ Fiber [V for Fiber, I for the policy]
**BTC → CKB.** The hub holds a Lightning hold invoice and pays a Fiber invoice.
- Pass `tlc_expiry_limit` on `send_payment`. Otherwise the default 14-day limit plus the random 4 h × k delta can make the hub's outgoing Fiber TLC outlive the Lightning HTLC. The recipient could then claim on Fiber after the Lightning HTLC has expired.
- Rule: `tlc_expiry_limit ≤ (LN incoming HTLC remaining time − settle margin) / 2`, as CCH does.
- Also check that the merchant invoice's `final_htlc_minimum_expiry_delta` fits under that limit.
- When an outgoing (offered) TLC gets close to expiry, fnn **force-closes** that channel ([channel.rs#L3019-L3030](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/channel.rs#L3019-L3030)).

**CKB → BTC.** The hub holds a Fiber hold invoice and pays a Lightning invoice.
- Pay Lightning with `cltv_limit` well inside the remaining window of the held Fiber TLC (§7.1).
- Call `settle_invoice` as soon as the preimage is known.
- Confirm the invoice reaches `Paid`.

### 7.3 Payment size and TLC limits [V]

| Limit | Value | Source |
|---|---|---|
| CKB amount | `< u64::MAX` shannons per payment and per channel funding | payment.rs L296-L301; channel.rs L5246-L5252 |
| `max_tlc_value_in_flight` | Default u128::MAX; each side sets its own at open time and it cannot be changed later | channel.rs L314 |
| `max_tlc_number_in_flight` | Default 125 | channel.rs L316 |
| `tlc_min_value` | Default 0 | |
| MPP | At most 24 parts | `PAYMENT_MAX_PARTS_LIMIT` |
| Payment attempts | `DEFAULT_PAYMENT_TRY_LIMIT` = 5 | network.rs L140 |

**In practice the limit is channel liquidity**, i.e. how much the public nodes have toward the destination. Testnet public channels are sized around 151–400 CKB unless larger channels are opened. Public-node in-flight settings were not checked.

### 7.4 Fees [V]
- **Forwarding fee:** proportional only, `tlc_fee_proportional_millionths` with default 1000 = 0.1 % per hop and **no base fee** (`calculate_tlc_forward_fee`, [P/crates/fiber-lib/src/fiber/fee.rs#L169-L174](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/fee.rs#L169-L174)). The fee is charged on the outbound channel's settings.
- **Example from the docs:** 1 CKB over 2 hops cost 200,100 shannons.
- **Payer fee cap:** 0.5 % by default (§2.2).
- **On-chain:** funding and closing transaction fees; `shutdown_channel fee_rate` defaults to 1000 shannons/KW.

### 7.5 Channel reserve [V]
- **CKB channels:** 98 CKB (99 in the 0.10 V1 lock) of commitment-cell occupancy plus 1 CKB of shutdown fee per funding side cannot be spent off-chain.
- **UDT channels:** need CKB on top for cell occupancy.
- **Auto-accepting nodes:** add only 99 CKB by default, i.e. zero spendable inbound. Public nodes add 250 CKB, i.e. 151 inbound.

### 7.6 Routing reliability [D/I]
- The network is small (a handful of public nodes).
- Expect "Failed to build route" right after channels become ready, until gossip has spread.
- Always run `dry_run` first.
- MPP and trampoline routing exist (`BASIC_MPP_REQUIRED`, `TRAMPOLINE_ROUTING_REQUIRED` features seen on public nodes).
- The README still calls the implementation "work-in-progress … use it with caution".

### 7.7 Restart behavior [V]
- **Hold TLC records survive restarts.** They are persisted with `insert_payment_hold_tlc` ([channel.rs#L4619-L4644](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/channel.rs#L4619-L4644)).
- **Recovery runs every 60 s and on startup** through `CheckChannels → retry_hold_tlc_sets` ([network.rs#L3961-L3991](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/network.rs#L3961-L3991)):
  - A hold set whose preimage is already stored is settled.
  - A hold set past `hold_expire_at` is timed out, but this is ignored when the invoice is `Received`, where only TLC expiry applies.
- **Stored state survives:** invoices, statuses, preimages and payment sessions are in RocksDB.
- **In-memory state is lost:** `send_after` timers and WebSocket subscribers. The hub must reconnect and re-poll.
- **Channel recovery:** reestablishment after a restart has been hardened since v0.9.0. A `Stale` channel state exists for database restores.

### 7.8 Version and compatibility risks [V/D]

| Change | Status | Impact on the hub |
|---|---|---|
| v0.8.0: `peer_id` → `pubkey` | Released | Old docs and SDKs break. |
| v0.8.0: snake_case enum values | Released | Old docs and SDKs break. |
| v0.9.0: `payment_preimage` in `get_payment` | Released | Required by the hub. |
| v0.10.0-rc1: new channels require the "full payment hash" commitment lock; Legacy channels are no longer opened | RC; needs a new DB; migration lands in a later release | A 0.10 hub may be unable to open channels with 0.9.x peers, and vice versa. Move in step with the public nodes. |
| `main` fixes after v0.9.1: "reject invoices for a different payment network" (#1698), "scope invoice settlement to local payments" (#1672), "forward custom_records in send_payment_with_router" | Unreleased | Track them. |

### 7.9 Places where the docs are wrong (code wins) [V]

| Topic | Doc says | v0.9.1 code |
|---|---|---|
| `new_invoice.final_expiry_delta` minimum | "16 hours" (README, json-types doc comment) | **160 min** (`MIN_TLC_EXPIRY_DELTA`, 9,600,000 ms). The docs' own example invoice shows `0x927c00`. |
| `cancel_invoice` | "only when invoice is in status `Open`" | Also `Received` without a preimage, and `Expired`. |
| `accept_channel` / `Channel.tlc_expiry_delta` default | "1 day" | 4 h (`DEFAULT_TLC_EXPIRY_DELTA`; `0xdbba00` in the docs' own example output). |
| `new_invoice` examples in public-nodes.md | use `"final_cltv": "0x28"` | No such field; it is silently ignored. |
| pubsub module | missing from the RPC README | Exists (`subscribe_store_changes`). |
| `send_payment.timeout` | "payment will be cancelled" after it | No enforcement found [I]. |

**This repo's own README** also says "Fiber's minimum expiry is 16 hours". That line should be corrected (§7.1).

---

## 8. Open questions to settle on testnet
1. **Payer-side expiry choice.** Do the wallets users pay from (fnn-based wallets, fiber-js nodes) actually add the random 4 h × k delta? This sets the real hold window.
2. **Public node limits.** What `max_tlc_value_in_flight` do bottle and bracer use, and how much liquidity do they have? This gives the practical maximum swap size.
3. **`Received` after TLC timeout.** Confirm that `get_invoice` stays `Received` after a held TLC times out (§2.1 gotcha), and decide the hub's guard.
4. **Same-hash auto-settle.** If the hub ever pays and receives the same hash on one fnn node, does a stored outgoing preimage auto-settle the incoming hold invoice within 60 s? `retry_hold_tlc_sets` settles any hold set whose preimage is in the store. [I]
5. **WebSocket notification rate and payload size.** Check under load how big `PutPaymentSession` messages are.
6. **v0.10 interoperability.** Once 0.10.0 is final, check whether 0.9.1 ↔ 0.10 channels can be opened.
7. **Mainnet USDI liquidity.** Is there any mainnet USDI liquidity at public nodes yet? Check the dashboard `/nodes_by_udt`.

---

## Appendix A: source index (v0.9.1)
- RPC docs: [P/crates/fiber-lib/src/rpc/README.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/rpc/README.md)
- JSON types: [P/crates/fiber-json-types/src/invoice.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-json-types/src/invoice.rs), [payment.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-json-types/src/payment.rs), [channel.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-json-types/src/channel.rs)
- Invoice RPC: [P/crates/fiber-lib/src/rpc/invoice.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/rpc/invoice.rs)
- Settle and cancel, hold timeouts: [P/crates/fiber-lib/src/fiber/network.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/network.rs) (L3961–4060, L4400–4490)
- TLC hold and expiry: [P/crates/fiber-lib/src/fiber/channel.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/channel.rs) (L1325–1402, L1698, L1925, L2976–3030)
- Received transition: [P/crates/fiber-lib/src/fiber/settle_tlc_set_command.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/settle_tlc_set_command.rs)
- Payment validation and preimage: [P/crates/fiber-lib/src/fiber/payment.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/payment.rs)
- Constants: [P/crates/fiber-lib/src/fiber/config.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/fiber/config.rs)
- Pub/sub: [P/crates/fiber-lib/src/rpc/pubsub.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/rpc/pubsub.rs), [store_impl/mod.rs](https://github.com/nervosnetwork/fiber/blob/v0.9.1/crates/fiber-lib/src/store/store_impl/mod.rs)
- CCH: [P/crates/fiber-lib/src/cch/](https://github.com/nervosnetwork/fiber/tree/v0.9.1/crates/fiber-lib/src/cch), [P/docs/specs/cross-chain-htlc.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/docs/specs/cross-chain-htlc.md), [P/docs/specs/cch-expiry-dependency.md](https://github.com/nervosnetwork/fiber/blob/v0.9.1/docs/specs/cch-expiry-dependency.md)
- Devnet harness: [P/tests/nodes/start.sh](https://github.com/nervosnetwork/fiber/blob/v0.9.1/tests/nodes/start.sh), [P/tests/deploy/](https://github.com/nervosnetwork/fiber/tree/v0.9.1/tests/deploy), [P/tests/bruno/e2e/](https://github.com/nervosnetwork/fiber/tree/v0.9.1/tests/bruno/e2e)
- Changelog (`main`): https://github.com/nervosnetwork/fiber/blob/2620b5b3fdca082092ce57797d0c22b65c33af59/CHANGELOG.md
- External: [fiber.world docs](https://www.fiber.world/docs), [network resources](https://www.fiber.world/docs/quick-start/network-resources), [toolchain](https://www.fiber.world/docs/build/toolchain), [fiber-pay](https://github.com/RetricSu/fiber-pay), [offckb](https://github.com/ckb-devrel/offckb), [fiber-dashboard](https://github.com/nervosnetwork/fiber-dashboard)
