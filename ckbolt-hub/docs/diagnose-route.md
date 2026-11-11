# Diagnosing a Fiber route (A → Hub → B)

For answering a Fiber developer who asks for `node_info` from every node and `list_channels` for each hop of a
payment, here for two problems seen on testnet:

- a Fiber payment between two browser nodes, each with only a **private** channel to the hub, fails with
  `no path found`;
- the hub cannot send more than about 500 CKB to the public Fiber network (it has only two public channels of about
  901 CKB, to bottle and bracer).

Two tools, both read-only:

| Tool | Where | What it gives |
| --- | --- | --- |
| **Diagnostics** panel | ckbolt-web, `/app/fiber`, panel 06 (while the node runs) | **Copy diagnostics**: the browser node's `node_info` and `list_channels` (closed channels too) as JSON; **Check a route**: `send_payment` dry runs of a pasted Fiber invoice, directly and through the hub (`trampoline_hops`) |
| `scripts/diagnose-route.ts` | this repo | the hub's `node_info` and `list_channels`, both browser exports side by side, a hop-by-hop check for an amount, the hub's public channels, and hub-side keysend dry runs; a table and a JSON report |

A browser node has no RPC anyone outside its tab can reach, so its data leaves the page only through Copy diagnostics.
The JSON holds no key, preimage, password or invoice text: amounts are decimal strings of base units (shannons, or the
token's base units; CKB and RUSD have 8 decimals).

Nothing here pays or changes a channel. Every `send_payment` goes out with `dry_run: true`: fnn builds the route and its
fee and keeps no payment session. The script refuses any other method than `node_info`, `list_channels`, `graph_nodes`
and dry-run `send_payment`.

## 1. Export from both browsers

On each browser (A, the payer; B, the payee):

1. Open the app with the node, `http://localhost:3200/app/fiber` (or the site), and unlock the node. Wait until it reads
   **Running** and the hub reads **Connected**.
2. Optional, on A only: in **Diagnostics**, paste B's Fiber invoice (B makes one in **Get paid**) into **Check a route**
   and press **Check route**. It shows two outcomes: **Direct** (A's own path search) and **Through the hub
   (trampoline)**, each "Route found, fee …" or "No route: <fnn's error>". Nothing is paid and nothing goes to History.
   The second reads "Not checked" (`trampolineSkipped: "no_hub_node"`) when the page has no live hub node id: a kept
   one is never probed.
3. Press **Copy diagnostics**. The JSON is on the clipboard and shown under the button (select it by hand if the browser
   blocks the clipboard). It includes the route check from step 2.
4. Save it as `payer.json` (A) or `payee.json` (B) and send it to whoever runs the script.

The JSON (`kind: "ckbolt-fiber-diagnostics"`, `schemaVersion: 1`) has `generatedAt`, `network`, `app.fiberJsVersion`,
`hubNodeId`, `nodeInfo` (version, commit, node id, features if reported, chain hash, auto-accept amounts, TLC settings,
counts, `udtCfgInfos`), `channels.list` (channel id, peer node id, `withHub`, state and flags, `isPublic`, asset CKB or
UDT with its script, `localBalance`, `remoteBalance`, `offeredTlcBalance`, `receivedTlcBalance`, any reserve fields,
pending TLC count, `createdAt`) and `routeCheck`. fnn 0.9.1's `list_channels` has no reserve field: its balances are
already net of the reserve (about 99 CKB per CKB channel side).

## 2. Run the script through the tunnel

The testnet compose does not publish fnn-hub's RPC (container port 8227) on the VPS host: only the hub reaches it, as
`http://fnn-hub:8227` on the compose network, without a token (checked 2026-11-05). Tunnel to the container's address
instead. On the VPS, read it (it can change when the container is recreated):

```
ssh testnet-vps 'docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}" ckbolt-testnet-fnn-hub-1'
```

Then open the tunnel in a window you keep open (172.20.0.5 on 2026-11-05):

```
ssh -N -L 18227:<fnn-hub container IP>:8227 testnet-vps
```

Check the tunnel:

```
curl -s -X POST http://127.0.0.1:18227 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"node_info","params":[]}'
```

Then, in `ckbolt-hub` (tsx is fetched by npx; no package.json change):

```
npx tsx scripts/diagnose-route.ts --rpc http://127.0.0.1:18227 --payer payer.json --payee payee.json --amount 600
npx tsx scripts/diagnose-route.ts --rpc http://127.0.0.1:18227 --payer payer.json --payee payee.json --amount 10 --asset RUSD
npx tsx scripts/diagnose-route.ts --rpc http://127.0.0.1:18227 --amount 600 --public-amount 600   # the public-network question
npx tsx scripts/diagnose-route.ts --help
```

| Option | Meaning |
| --- | --- |
| `--rpc` | the hub fnn RPC (env `FIBER_RPC_URL`; default `http://127.0.0.1:18227`) |
| `--token` | fnn RPC Biscuit token if the node needs one (env `FIBER_RPC_TOKEN`) |
| `--payer`, `--payee` | the browser exports from step 1 (either may be left out) |
| `--payee-pubkey` | B's node id when there is no payee file |
| `--amount` | whole units, e.g. `600` or `12.5` |
| `--asset` | `CKB` (default), `RUSD`, a UDT name the hub's `node_info` lists, or `code_hash:hash_type:args` |
| `--public-amount` | also dry-run a keysend of this amount from the hub to each public channel peer (bottle, bracer) |
| `--public-target` | a public node id to dry-run to instead (repeatable) |
| `--include-closed` | list the hub's closed channels too |
| `--no-dry-run` | skip every dry run |
| `--out` | the report path (default `./diagnose-route-<time>.json`) |

## 3. Reading the output

- **Nodes**: the version of A, the hub and B (and fiber-js for the browsers). Different versions get a note.
- **Hops, paying direction A → Hub → B**, each row with its channel, state, `public`, balance, what it needs and `ok`:
  - A's `local_balance` in A↔Hub (from A's export) and the hub's `remote_balance` in the same channel (they should
    match): needs the amount **plus the 0.5 % max fee** (the web Pay tab's cap, fnn's default `max_fee_rate`);
  - the hub's `local_balance` in Hub↔B: needs the amount (the hub keeps its forwarding fee);
  - B's `remote_balance` (from B's export): needs the amount.
  - `ok` is yes only for a `ChannelReady` channel with enough balance. "no CKB channel" means no channel in that asset.
- **Hub's public channels**: peer, name and version from the hub's gossip graph, state, and the hub's local and remote
  balance. A single-part payment to the public network can carry at most the largest local balance, less fees and the
  next hops' own limits; with two channels of about 901 CKB funding (about 802 CKB spendable after reserve, less
  whatever has already moved) and the public nodes' own channels behind them, the limit seen near 500 CKB is expected
  if those next hops have less outbound liquidity. The dry runs to bottle and bracer show where it stops.
- **Dry runs from the hub**: a keysend of the amount to B (tests the Hub → B leg over the private channel; the hub's own
  channels are always usable to it) and, with `--public-amount`, to each public peer. `ok` with a fee, or fnn's error.
- **A's own route check**: copied from A's export when step 2 was done. `Direct: No route: … no path found` with
  `Through the hub (trampoline): Route found` means the payee is invisible to path search (its only channel is
  private) but reachable through the hub.
- **Notes**: what was not checked and why, and the private-channel and public-capacity conclusions.

The JSON report (`kind: "ckbolt-route-diagnosis"`) holds the same: `nodes`, `hubNodeInfo`, `hops`,
`hubPublicChannels`, `hubPublicCapacity`, `dryRuns`, `payerRouteCheck`, `payeeRouteCheck`, `notes`. It lists only the
hub's channels with A, with B and its public ones, not other visitors' channels.

## 4. What to send to the Fiber developer

1. `payer.json` and `payee.json` (both browsers' Copy diagnostics, A's with the route check).
2. The script's JSON report and its printed tables.
3. If every hop has enough (all `ok` yes) and it still fails, the logs from the minutes around one failed attempt, with
   its time (UTC) and the payment hash (Check a route's JSON has it under `routeCheck.target.paymentHash`):
   - **Browser nodes (fiber-js WASM)**: fiber-js logs to the browser console of the tab that runs the node, at level
     `info` (`FIBER_LOG_LEVEL` in ckbolt-web `lib/wallets/fiber-browser/constants.ts`). Open DevTools on `/app/fiber`
     (or the popup's window), Console, enable "Preserve log", tick "Verbose" if needed, reproduce, then right-click the
     console and "Save as…". Workers' logs appear in the same console.
   - **Hub fnn**: the `fnn-hub` container's log on the VPS, e.g. `npm --prefix deploy run testnet -- logs fnn-hub --tail 2000`
     (as for `logs hub` in `docs/testing-testnet.md`), or `docker compose -f deploy/testnet/docker-compose.yml logs --since 30m fnn-hub`.
     Its level comes from `RUST_LOG` in the compose file (`info` by default; `RUST_LOG=info,fnn=debug` for more,
     `docs/research/fiber-node.md`).
   - **Hub app** (only if a swap was involved): `npm --prefix deploy run testnet -- logs hub --tail 200`.

The exports and the report hold node ids, channel ids and balances (public on chain), never keys or preimages. Logs
can hold more: read them before sending.
