# Adding a token to the hub

A token (a CKB UDT) is configured in one place: its entry in `FIBER_ASSETS`, in the server's `hub.env`
([architecture.md, "Assets"](architecture.md#assets-fiber_assets) lists every field). fnn reads its own list of tokens,
`ckb.udt_whitelist` in `fnn/hub.yml` (fnn-hub) and `fnn/demo.yml` (fnn-demo). That list is generated from
`FIBER_ASSETS` and never edited by hand.

- **The generator**, `src/interfaces/cli/fnn-whitelist/`, rewrites only the `udt_whitelist` block of each file and keeps
  every other byte. It checks `FIBER_ASSETS` with the hub's own schema, prints a diff, and gives the same output when
  run twice. It refuses malformed input and then writes nothing. It ships in the hub image, as
  `dist/interfaces/cli/fnn-whitelist/main.js`.
- **The runbook script**, `deploy/testnet/add_token.py`, needs only Python 3 and Docker on the server. It adds one
  entry to `FIBER_ASSETS`, has the hub image check the result and regenerate the whitelists, backs up, restarts what
  changed, checks the result, and can open channels. It does a dry run unless you pass `--apply`. It never prints
  secrets: of `hub.env` it shows only `FIBER_ASSETS`.

What each node gets from an entry:

| Node | `auto_accept_amount` | So |
| --- | --- | --- |
| fnn-hub | the entry's `peerChannels.minAmount`; left out without `peerChannels` | It accepts on its own a channel a node opens to it in the token (see [Peer channels](#peer-channels-a-nodes-own-token-channel-to-the-hub)). Without `peerChannels` nobody can open a channel to the hub in the token |
| fnn-demo | `--demo-auto-accept ID=AMOUNT` if given, else the entry's `autoAcceptAmount` (which defaults to `inboundAmount`); left out when none is set | It accepts the channels fnn-hub opens to it |

Each entry's `args` is written as `"^<args>$"`, because fnn reads it as a regex. Its cell deps keep the files' style
(`type_id` or `cell_dep`).

## Before you start

1. **The hub image must contain the generator.** It is in every image built from this commit or later:
   `npm --prefix deploy run testnet -- sync`, then `testnet build hub`. With an older image the script stops with
   "Cannot find module ... fnn-whitelist" (and `testnet sync` warns that it could not regenerate; see
   [After every `testnet sync`](#after-every-testnet-sync) for the order the first time).
2. **`hub.env` must already use `FIBER_ASSETS`.** The testnet server does. A hub still on the legacy variables moves over first, as
   in [testing-testnet.md, section 6](testing-testnet.md#6-more-tokens-cwbtc-through-fiber_assets).
3. **Fund fnn-hub.** It needs the token for the channels it opens, and about 180 CKB on chain for each UDT channel it
   is part of. That includes channels nodes open to it (`peerChannels`): fnn-hub puts in no tokens there, but it locks
   its own CKB reserve.
4. Log in to the server and go to the kit: `ssh testnet-vps`, then `cd /opt/ckbolt/testnet`.

## Complete example: cWBTC on the testnet server

cWBTC (CCH Wrapped BTC) is an xUDT with 8 decimals at 1:1 with BTC: one base unit is one sat. The faucet gives testers
0.01 cWBTC (1,000,000 base units) per claim, so `peerChannels.minAmount` is set to one claim. That lets a tester open
their own cWBTC channel to the hub and pay cWBTC to BTC at once.

Write the entry to a file on the server, for example `/opt/ckbolt/testnet/cwbtc.json`:

```json
{
  "id": "CWBTC",
  "symbol": "cWBTC",
  "name": "CCH Wrapped BTC",
  "displayName": "Wrapped BTC (test)",
  "iconUrl": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiNmNzkzMWEiLz48cGF0aCBkPSJNMTEgOGg3YTQgNCAwIDAgMSAwIDhoLTd6bTAgOGg4YTQgNCAwIDAgMSAwIDhoLTh6IiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMi41Ii8+PC9zdmc+",
  "decimals": 8,
  "usdRule": "btc_parity",
  "typeScript": {
    "codeHash": "0x25c29dc317811a6f6f3985a7a9ebc4838bd388d19d0feeecf0bcd60f6c0975bb",
    "hashType": "type",
    "args": "0x9a1086531ed6dc69e0bd44cef5278e03faf3015b31aff60b08fb87663ce8507100000000"
  },
  "cellDeps": [
    { "outPoint": { "txHash": "0xbf6fb538763efec2a70a6a3dcb7242787087e1030c4e7d86585bc63a9d337f5f", "index": "0x0" }, "depType": "code" }
  ],
  "optionPremiumBps": 0,
  "inboundAmount": "10000000",
  "peerChannels": { "minAmount": "1000000" }
}
```

What the fields do:

- **`inboundAmount`**: 0.1 cWBTC, what the hub funds a browser node's inbound channel with.
- **`peerChannels.minAmount`**: 0.01 cWBTC, the smallest channel a node may open to the hub with its own cWBTC.
- **`iconUrl`**: an inline SVG (an orange disc with a white B), so the web app can show it without fetching from
  another host.
- **`displayName`**: replaces `name` in the web app.

1. **Dry run.** The testnet server already serves cWBTC, so `--replace` swaps its entry. A new token needs no `--replace`.

   ```bash
   python3 add_token.py cwbtc.json --replace
   ```

   It prints:

   - the `FIBER_ASSETS` ids before and after, and the new entry;
   - the hub image's check, `hub configuration ok: assets CKB, RUSD, CWBTC; peer channels: CWBTC from 1000000 base units`;
   - the diff of each whitelist. In `fnn/hub.yml` the cWBTC entry gains `auto_accept_amount: 1000000`;
   - what `--apply` would do.

   Nothing is changed. If the hub refuses the merged list (a bad field, a fee below the routing budgets,
   `FIBER_PEER_CHANNEL_COMMITMENT_DELAY_EPOCHS` set below 84 together with `peerChannels`, and so on), the script
   prints the reason and stops.

2. **Apply, and open the hub's cWBTC payout channel to bottle.** The channel needs 10 cWBTC in fnn-hub's wallet: bottle
   accepts 10 cWBTC and adds none.

   ```bash
   python3 add_token.py cwbtc.json --replace --apply \
     --open-channel 02b6d4e3ab86a2ca2fad6fae0ecb2e1e559e0b911939872a90abdda6d20302be71@/dns4/bottle.fiber.channel/tcp/8119/p2p/QmXen3eUHhywmutEzydCsW4hXBoeVmdET2FJvMX69XJ1Eo=1000000000
   ```

   In order, it:

   1. Copies `hub.env`, `fnn/hub.yml` and `fnn/demo.yml` into `backups/add-token-<UTC time>/` (owner-only), when it
      is about to write anything (a `--regenerate` that changes nothing makes no backup).
   2. Writes `FIBER_ASSETS` into `hub.env` as single-quoted JSON on one line, leaving every other line as it was.
   3. Writes the whitelists that changed.
   4. Restarts fnn-hub and fnn-demo, only those whose whitelist changed and that are running, and waits until they are
      healthy. fnn reads its whitelist only at start.
   5. Recreates the hub (`docker compose up -d --no-deps --force-recreate hub`). `restart` would keep the old
      `hub.env`.
   6. Checks, on the services that are running (a stopped one is reported as not checked; it reads the files when it
      starts; the hub's two checks need fnn-hub running too):
      - fnn-hub's `node_info.udt_cfg_infos` lists cWBTC with the expected auto-accept amount, and fnn-demo's lists it
        too;
      - `GET /v1/assets` lists cWBTC;
      - `GET /v1/fiber/node` gives its `peerChannels`.

      It calls the hub on the port Compose publishes on 127.0.0.1, with `X-CKBolt-Proxy-Secret` when `hub.env` sets
      `HUB_PROXY_SECRET`.
   7. Opens each `--open-channel` from fnn-hub, public, one at a time. It waits for each to be `ChannelReady` (up to
      `--wait-minutes`, 60 by default) before the next, because fnn funds UDT channels from the same token cells, and
      two at once fail with "can not find enough UDT owner cells". It skips a peer that already has a live channel in
      the token, and stops at the first channel that does not become ready.

   If a step after the writes fails, the script prints the commands that restore the backup.
3. **RUSD on fnn-demo.** The testnet server's RUSD entry has no `autoAcceptAmount`, so fnn-demo's RUSD threshold follows
   `inboundAmount` (20 RUSD; it was 10 RUSD before the generator). That still accepts the 60 RUSD demo channel. To keep
   10 RUSD, give RUSD's entry `"autoAcceptAmount": "1000000000"` (`python3 add_token.py rusd.json --replace --apply`),
   or pass `--demo-auto-accept RUSD=1000000000` on every run.
4. **Check from your machine:** `npm --prefix deploy run testnet:check`, then a swap
   (`npm --prefix deploy run testnet:smoke -- --asset CWBTC` once the smoke script knows the asset; otherwise the web
   app, [testing-testnet.md](testing-testnet.md), S12 with cWBTC).

## After every `testnet sync`

`testnet sync` never uploads the repo's `deploy/testnet/fnn/hub.yml` and `fnn/demo.yml` over the files fnn runs: it
puts them under `.sync-templates/fnn/` in the kit folder. They are generated from the example in `hub.env.example`, not
from the server's `hub.env` (which is never uploaded), so right after the upload the sync runs, in the kit folder:

```bash
python3 add_token.py --regenerate --apply --template-dir .sync-templates
```

It generates both files from the templates (so every line outside `udt_whitelist`, such as a new bootnode, reaches the
server) and the server's `FIBER_ASSETS`, then compares the result with the files fnn runs. Only where they differ does
it back up (the files as fnn ran them, and `hub.env`), write, and restart fnn-hub or fnn-demo; a sync that changes
nothing restarts nothing and makes no backup. It never touches `hub.env` and never recreates the hub. It refuses, and
writes nothing, when the new whitelist would leave out a token fnn has now (a channel in a token fnn no longer
whitelists cannot close after fnn restarts): put the token back in `FIBER_ASSETS`, or pass `--allow-drop` by hand once
no channel in it is left.

The sync skips the step, and says what to run by hand, while the server cannot run it. The files fnn runs then stay as
they were; only a file the server does not have yet (a new server) is copied from its template:

| The sync says | Why | Then |
| --- | --- | --- |
| skipped: no .env or hub.env on the server yet | before `testnet env` (a new server) | after `testnet env` and `testnet build hub`, run the command above |
| the hub image is not built on the server yet (warning) | before the first `testnet build` | `testnet build hub`, then the command above |
| the hub image on the server predates the whitelist generator (warning) | the image was built before the generator existed | the order below |
| skipped: the server's hub.env has no FIBER_ASSETS | the hub still runs on the legacy variables | nothing: the repo's whitelists are copied into place as they are |
| python3 is not installed on the server (warning) | the server has no Python 3 | install it, then the command above |

Any other failure (fnn-hub not healthy after its restart, the hub image refusing `hub.env`, a token left out, ...)
fails the sync with the script's output; the upload itself is done, and the files fnn runs change only if the script
says it wrote them (then it prints how to go back).

**The first deploy with this step** (the server's hub image does not have the generator yet):

1. `npm --prefix deploy run testnet -- sync`: uploads, then warns that the image predates the generator. `fnn/hub.yml`
   and `fnn/demo.yml` stay as the server had them.
2. `npm --prefix deploy run testnet -- build hub`.
3. On the server, in `/opt/ckbolt/testnet`: `python3 add_token.py --regenerate --apply --template-dir .sync-templates`.
4. `npm --prefix deploy run testnet -- up hub`: recreates the hub from the new image.

From then on `testnet sync` does step 3 itself. If you skip step 3, fnn keeps the whitelist it had; the repo's other
changes to `fnn/*.yml` wait in `.sync-templates/` until the step runs.

## The generator in the repo

```
npm run fnn-whitelist -- --assets-file fiber-assets.json --hub-yml deploy/testnet/fnn/hub.yml --demo-yml deploy/testnet/fnn/demo.yml          # diff only
npm run fnn-whitelist -- --hub-env deploy/testnet/hub.env --hub-yml deploy/testnet/fnn/hub.yml --demo-yml deploy/testnet/fnn/demo.yml --write
```

`--write` refuses, and writes nothing, when the new list would leave out a token a file whitelists now (a channel in a
token fnn no longer whitelists cannot close after fnn restarts); a dry run only notes it. Pass `--allow-drop` once no
channel in that token is left. `--out-dir` (what add_token.py uses) does not check: add_token.py compares with the files
fnn runs itself.

Options:

- **Where `FIBER_ASSETS` comes from**, exactly one of:
  - `--assets-file`: a file holding the JSON list;
  - `--hub-env`: an env file;
  - `--from-env`: this process's environment.
- **`--demo-auto-accept ID=AMOUNT[,ID=AMOUNT]`**: fnn-demo's amounts, where they should differ from `autoAcceptAmount`.
- **What to write**, at most one of:
  - `--write`: rewrites the changed files in place;
  - `--out-dir <folder>`: writes both files there and leaves the inputs alone (that is how `add_token.py` uses it).
- **`--check-config`**: also loads the whole hub configuration (`loadHubConfig`) from the environment, with the same
  `FIBER_ASSETS`.

Exit code 1 means refused. The reason goes to stderr, and nothing is written.

## Peer channels (a node's own token channel to the hub)

With `peerChannels` on an asset, a node can fund a channel to the hub with its own tokens and pay the hub over it
(fiber_to_ln) without first receiving the token in a swap. The hub adds no tokens: the node can send the hub what it put
in, and get back only what it sent.

**Why not the CKB way.** For CKB, the hub opens the channel and the browser node puts its own CKB in with
`accept_channel`. That is not possible for UDTs on fnn v0.9.1: a UDT funding transaction with tokens from the side that
accepts is broken there (fixed after v0.9.1 by nervosnetwork/fiber#1671). So the node opens the channel, and fnn-hub
accepts it with 0 tokens.

**What has to hold for the hub to be safe.** The channel's opener chooses its commitment delay D. fnn accepts any D from
1 to 84 epochs, fractions included. No RPC reports D, neither for a pending channel nor for an open one.

- **Early fail.** fnn fails a held TLC once `expiry < now + 2/3·D·4 h + 60 s`. It never adds a TLC whose expiry is less
  than 2/3·D away.
- **The race.** The hub's Lightning payout must be settled by the hub before that point. Otherwise the payer could
  delay its own Lightning payout, let fnn fail the Fiber TLC back to itself, and then take the payout.
- **What the hub assumes.** The hub cannot learn D, so it counts the longest, 84 epochs: the TLC fails at
  `expiry − 224 h − 60 s`.
- **Start-up check.** The hub refuses to start while any asset has `peerChannels` and
  `FIBER_PEER_CHANNEL_COMMITMENT_DELAY_EPOCHS` is not 84.
- **Hold size.** For the payment to be payable at all, the hold invoice's `final_expiry_delta` must leave the Lightning
  payout window after those 224 h. In an asset with `peerChannels`, every fiber_to_ln hold invoice is sized for it:
  224 h + 60 s + the Fiber margin + the payout window, about 237 h on Mutinynet. Fiber's limit is 14 days.
- **Refund.** A payment over a channel the payer opened that still leaves too little time is refunded with the reason
  "The payment came over a channel the payer opened ...".

**The cost.** If the hub went down mid-swap, a payment's TLC would stay held until fnn fails it:

| Channel | Held up to |
| --- | --- |
| Opened by the hub, D = 1 epoch | about 10 days |
| Opened by the payer with D = 84 epochs | about 13 hours |

The hub settles or refunds within minutes when it runs.

**Each such channel also costs fnn-hub CKB.** It locks its own CKB reserve of about 180 CKB until the channel closes.
`minAmount` is what someone must lock to make the hub lock that.

**The cap, and what it does not stop.** `FIBER_PEER_CHANNELS_MAX_OPEN` (default 10, `0` never offers) caps how many
such channels CKBolt's own UI leads nodes to open. On every `GET /v1/fiber/node` the hub counts, from fnn-hub's
`list_channels`, the channels a node opened to it (`is_acceptor` true, or not reported) in any asset with
`peerChannels`, in any state but closed: opening (negotiating included), ready or closing, all of these assets together.
At the cap or over it, every asset's `peerChannels` is `null`, as for an asset without peer channels, so the web app
stops offering "your own tokens". It is `null` as well when `list_channels` fails (the hub logs a warning): the hub
cannot then tell how much of its CKB is locked. Channels already open are not touched and keep working for swaps.

The cap does not limit fnn-hub. fnn v0.9.1 has no limit on how many channels it auto-accepts: its whitelist's
`auto_accept_amount` (`minAmount`) is the only check. Anyone running an fnn client can still open a channel to fnn-hub
directly with at least `minAmount` of the token, past the cap, and fnn-hub accepts it and locks another ~180 CKB. The
count then stays at or over the cap, so the UI keeps the offer hidden until channels close. Budget fnn-hub's CKB for
that, raise `minAmount` to make each such channel cost more, or remove `peerChannels` (and regenerate) to stop the
auto-accept altogether.

**What the web app sends to open one** (the contract is `PeerChannelsDto` in `src/interfaces/http/contract/responses.ts`):

1. Whitelist the token from `GET /v1/fiber/node` `assets[].udtWhitelist`. fnn's `open_channel` refuses a token the
   opener does not whitelist.
2. Connect to one of the hub's `addresses`.
3. Call `open_channel` with:
   - `pubkey`: the hub's `nodeId`;
   - `funding_udt_type_script`: the asset's `udtTypeScript`;
   - `funding_amount`: at least `peerChannels.minAmount`, as hex;
   - `public`: `false`.

   Leave `commitment_delay_epoch` and `tlc_expiry_delta` out (fnn's defaults: 1 epoch and 4 h). A larger delay needs
   `tlc_expiry_delta` of at least 2/3 of it on the opener's side, and the hub does not need it.

The opener needs the tokens in its own cells, and about 180 CKB for its side's reserve plus fees. Opening two UDT
channels at once from the same cells fails.
