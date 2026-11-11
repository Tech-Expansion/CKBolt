# Testing swaps on the real test networks, with real wallets

For the operator, on a Windows development machine. Bitcoin side: **Mutinynet** (a signet with 30 s blocks, invoices
`lntbs…`). CKB side: **CKB testnet** (invoices `fibt…`). The hub runs on the testnet server, `testnet-vps` in the
commands below (runbook: [`deploy/README.md`](../deploy/README.md)); you reach it through an SSH tunnel and run the web
app on this machine. The public demo at https://ckbolt.texlabs.org uses the same hub through the web server's proxy.
Local testing without real networks is in [`testing.md`](testing.md).

**Status, 2026-10-24.**
- Deployed on the testnet server: `testnet:check` reported 34 OK, 0 failing.
- `testnet:smoke` passed both ways:
  - BTC to CKB: 2,000 sats in, 1,091.23 CKB out, hash `164ebccd…621e`.
  - CKB to BTC: 1,113.38 CKB in, 2,000 sats out, hash `ac33a1d0…633d`.
  - Each swap completed in about 5 s, with `sha256(preimage) == payment hash`.
- Liquidity after setup:

  | Where | What |
  | --- | --- |
  | Lightning channel to the faucet node (replaced on 2026-10-25, see below) | 244,040 sats out (payouts), 250,000 in (testers paying the hub) |
  | Fiber | 1,000 CKB channels to the relays bottle and bracer, and 20,000 CKB to the demo node |
  | On-chain, fnn-hub | about 78,000 CKB, for inbound channels to browser nodes |
  | RUSD | added later that day, see below |
- RUSD, added the same day:
  - we sent 100 RUSD (from the RUSD faucet, with JoyID) and 100,000 CKB to fnn-hub;
  - a 60 RUSD channel to the demo node, 30 RUSD on each side;
  - browser nodes can ask for 20 RUSD inbound;
  - `testnet:smoke --asset RUSD` passed both ways: 2,000 sats to 1.60 RUSD, and 1.63 RUSD to 2,000 sats;
  - `testnet:check` then reported 38 OK, 0 warnings, 0 failing.
- The web app's live swap card (the same day, `ckbolt-web/docs/live-swap-ui.md`) replaced the old swap form. It has no
  demo wallet: every scenario below uses your own wallets. The hub's demo wallet stays for `testnet:smoke`.

**Changes, 2026-10-25** (after the first tests with Alby Hub):
- BTC to CKB from Alby Hub failed with `RouteNotFound`. LDK pays only routes of at most 1008 CLTV blocks and keeps
  80 of them for a random offset (rust-lightning `router.rs`); the hub's hold invoice needs 861 (fnn locks a payout at
  least 400 minutes, about 800 Mutinynet blocks). That leaves 67 blocks for the nodes in between: not even Megalith
  (144) fits. So:
  - **an Alby Hub wallet needs a channel of its own with the hub's LND** to pay BTC to CKB (section 2, step 5);
  - lnd-hub has a private channel with **Megalith**, the LSP Alby Hub wallets get their channels from: 220,000 sats,
    100,000 pushed to Megalith. Payouts to Alby Hub (CKB to BTC) go through it, and LND payers can pay through it
    (the hold invoices carry its route hint, `LN_INVOICE_ROUTE_HINTS=true`);
  - the hub counts LDK's 80 blocks when it sizes a hold invoice (`PAYER_ROUTE_BUDGET_BLOCKS`).
- The channel to the faucet node was closed; `testnet:check` reports 38 OK, 0 failing with the Megalith channel.
- The browser node puts the CKB you choose into the hub's channel ("Your node puts in", 1,200 CKB by default), so it
  can pay CKB to BTC at once. Since 2026-11-05 the node accepts the hub's CKB channel itself (`accept_channel`, its
  config sets `auto_accept_channel_ckb_funding_amount: 0`), so the amount is picked per request and needs no restart; an
  open channel keeps what went in, so to put in more you close it and ask again. The hub now opens 2 channels per node a
  day, and abandons an inbound channel the node has not accepted after `FIBER_INBOUND_ACCEPT_TIMEOUT_SECONDS` (10
  minutes), so a closed tab does not block a new request. It abandons only opens it made itself, and keeps them in its
  database (table `inbound_opens`, migration 6, applied when the hub starts), so an open still waiting from before a hub
  restart is abandoned too, 10 minutes after it was asked for. Only an open whose answer the hub never received waits
  for fnn's one-day funding timeout. The testnet hub runs this change; without it every channel the tab never
  accepted blocks that way. Opens made by a hub from before the record (schema 5) are
  not on it, so those still wait for fnn's timeout once.

## 1. Every session: tunnel, web app, readiness

1. **Tunnel**: in a window you keep open, run `ssh -N -L 18787:127.0.0.1:18787 testnet-vps`. Check it with
   `curl http://127.0.0.1:18787/v1/health`: `"status":"ok"`, Lightning `signet`, Fiber `testnet`.
2. **Web app** (PowerShell, in `ckbolt-web`):
   ```
   $env:HUB_URL="http://127.0.0.1:18787"; $env:BTC_SIGNET_ESPLORA_URL="https://mutinynet.com/api"; npm run dev -- -p 3200
   ```
   Open http://localhost:3200/app. It opens on Swap with the live card ("Swap", tagged Testnet; real quotes from the
   hub) and its wallet chips **Connect Lightning** and **Connect Fiber**. Use `http://localhost`, not an https address:
   the browser Fiber node dials the hub at `ws://`, which only an http page on localhost may do.
3. **Readiness** (in `ckbolt-hub`): run `npm --prefix deploy run testnet:check`. Expect no FAIL. Each WARN line names
   the next command; a warning about liquidity means swaps in that direction or asset may be refused until it is fixed.

## 2. One-time wallet setup

**Lightning: Alby Hub on Mutinynet, in Docker** (about 10 minutes):

```
docker run -d --name albyhub-mutinynet --restart unless-stopped -v albyhub-mutinynet:/data -e WORK_DIR=/data -e NETWORK=signet -e MEMPOOL_API=https://mutinynet.com/api -e LDK_ESPLORA_SERVER=https://mutinynet.com/api -e LDK_GOSSIP_SOURCE=https://rgs.mutinynet.com/snapshot -p 127.0.0.1:8029:8080 ghcr.io/getalby/hub:v1.24.4
```

1. Open http://localhost:8029, set a password, and skip the Alby account.
2. On the Node page, **Advanced**, **Connect Peer**, and connect Megalith, the node the faucet opens channels from:
   `03e30fda71887a916ef5548a4d02b06fe04aaa1a8de9e24134ce7f139cf79d7579@64.23.192.68:9736`. Copy your node's pubkey.
   - If the faucet answers "peer ... is not online", connect again right before asking it.
   - This channel lets you receive (CKB to BTC payouts come through Megalith). To pay the hub (BTC to CKB) you need
     step 5 as well.
3. Open a channel to your node from the faucet:
   - At https://faucet.mutinynet.com, log in with GitHub, choose **Open channel**, paste the pubkey and set capacity
     300,000 with push 50 % (150,000): the pushed half lets you pay (BTC to CKB), the rest lets you receive.
   - The faucet allows 1,000,000 sats per 24 h per GitHub user and IP, counting on-chain, channels and Lightning
     together. The hub's own funding used 670,000 of one day.
   - The channel is ready after 6 confirmations, about 3 minutes.
4. In Connections, create a connection named "CKBolt test":
   - Permissions: `pay_invoice`, `make_invoice`, `get_info`, `lookup_invoice`.
   - Budget: for example 100,000 sats.
   - Copy the `nostr+walletconnect://…` secret. **It spends your wallet**: paste it only into the app. The app keeps it
     in memory, never sends it to the hub, and forgets it on Disconnect. Alby Hub shows it only once: if it is lost,
     create another connection and delete the old one.
5. A channel with the hub's LND, so Alby Hub can pay BTC to CKB (it cannot through Megalith, see "Changes, 2026-10-25"):
   - On the Node page, **Advanced**, **Connect Peer**: the hub's Lightning address (`pubkey@host:port`), as the
     testnet guide shows it (https://ckbolt.texlabs.org/app/guide#hub).
   - The hub's operator then opens a channel to your node with a push (your Alby Hub cannot be dialled, so it must
     connect first): `lncli openchannel --node_key=<your pubkey> --local_amt=30000 --push_amt=20000 --private` in
     lnd-hub. It is ready after about 3 minutes; the pushed sats are what you can pay with.

**CKB for the browser Fiber node**:
- Your node needs CKB at its own address for what it puts into the hub's CKB channel when it accepts it: "Your node
  puts in" on the node page, 1,200 CKB by default (99 of it stays as the channel's reserve), plus 1 CKB for fees. It
  can pay CKB to BTC from that at once.
- The amount is read when you ask: the node accepts the hub's channel with it a moment after the hub opens it (keep the
  tab open until the page says the hub is opening the channel). An open channel keeps what went in; to put in more,
  close it (its CKB returns to the node's address), then ask again. The hub opens 2 channels per node a day.
- A RUSD channel takes only its reserve from the node: about 180 CKB.
- Claim testnet CKB at https://faucet.nervos.org into your JoyID testnet address. You then send it to the node from the
  node page (section 3, S3).

**Optional: your own Fiber node** for S6 to S9: Fiber Studio (Windows, fnn 0.9.0) or fnn, on CKB testnet. Like the
browser node, it needs a channel the hub opened to it.
- Fund it with about 300 CKB at http://localhost:3200/app/fiber/fund?address=<its ckt1… address> (JoyID signs).
- Connect it to the hub's node: `curl http://127.0.0.1:18787/v1/fiber/node` lists the hub's `addresses.p2p`; give one
  to your node's `connect_peer`.
- Ask the hub for inbound, as the node page does (Git Bash):
  `curl -X POST http://127.0.0.1:18787/v1/fiber/inbound-channels -H 'content-type: application/json' -d '{"nodeId":"<your node id, no 0x>","asset":"CKB"}'`.
  `curl http://127.0.0.1:18787/v1/fiber/inbound-channels/<node id>` shows it Opening, then Ready.
- Payout invoices must use `hash_algorithm` sha256 (fnn's default `ckb_hash` is refused) and currency `Fibt`.

## 3. Scenarios

Do them in order. Keep each swap at **20,000 sats or less** (the hub's `SWAP_MAX_SATS`). One **Swap** button runs each
swap; its dialog shows five steps: an invoice from the receiving wallet, "Swap locked with the hub", the payment from
the paying wallet, "The hub pays you", "Complete". **Hide** keeps it running behind "Swap in progress · View". Note the
swap id under the result's **Details** and check the evidence in section 4.

| # | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| S1 | **Connect your Lightning wallet** | In /app, **Connect Lightning**, paste the NWC secret from section 2, **Connect** | The chip shows your wallet with its status dot; the dialog names Bitcoin signet. No request carries the secret (DevTools, Network) |
| S2 | **The card asks for what is missing** | BTC to CKB, type 2,000 in You pay | The receive box shows the quoted CKB and the quote's countdown. The button reads **Connect Fiber wallet**. **How it works** and each "?" explain the rest |
| S3 | **Set up the browser Fiber node** (Chrome or Edge) | Open http://localhost:3200/app/fiber. **Create node** with a password, then **Back up the key**. Fund it: **Fund this node** opens the funding page in a new tab, where JoyID signs through CCC; pick **Channel with the CKBolt hub** (about 1,300 CKB). **Connect to the hub**, then **Ask for 2,000 CKB inbound**. Keep this tab open from now on. Back in /app: **Connect Fiber**, **Browser node** | The node shows its address and balance; the connection reads Connected. The hub's channel shows Opening, then Ready after a few CKB confirmations (a few minutes). In /app the Fiber dialog lists Send about 1,101 CKB and Receive about 1,901 CKB |
| S3b | **Put more CKB into the channel** (after S3) | Fund the node with more CKB. In the channel list, **Close** the hub's channel and wait until its CKB is back at the node's address. Set **Your node puts in** to the amount (or **Max**), **Open a channel with the hub** | No restart. The notice says the hub is opening the channel and what your node put in. The new channel turns Ready; the Fiber dialog's Send is the amount less 99 CKB |
| S4 | **BTC to CKB into the browser node** | BTC to CKB, 2,000 sats, **Swap** | The steps run in seconds to **Swap complete**; Details shows `sha256(preimage) = payment hash` checked. On the node page "Can send" grows and Activity lists the invoice as paid. An NWC timeout after 60 s reads "Sent; waiting for the hub": do **not** pay again |
| S5 | **CKB to BTC from the browser node** (after S3) | Flip (⇅) to CKB to BTC; pay about 800 CKB, less than the Fiber dialog's Send (below the hub's minimum the button names it). **Swap** | **Swap complete**. Alby Hub shows the sats received; on the node page "Can send" drops |
| S6 | **BTC to CKB into your own node** (optional, section 2) | **Connect Fiber**, **Own node**. BTC to CKB, 2,000 sats. In your node make a sha256 invoice for exactly the amount the "?" next to **Your Fiber invoice** names; paste it there before the quote expires. **Swap** | Step 1 reads "Your pasted invoice"; **Swap complete**; your node shows the invoice paid |
| S7 | **CKB to BTC from your own node** (after S6) | Own node, CKB to BTC, about 600 CKB, **Swap** | Step 3 shows the hub's `fibt` hold invoice (QR code, **Copy invoice**). Pay it from your node (Fiber Studio, or fnn `send_payment`); the dialog moves on by itself to **Swap complete** |
| S8 | **Refund, BTC to CKB** (the payout cannot arrive) | As S6, but stop your node after pasting the invoice, then **Swap** | Your Lightning wallet pays; the hub cannot pay your node and cancels the held payment. The dialog ends in **Refunded: your payment went back to your wallet**, the hub's reason under Details. Alby Hub shows the payment failed; the sats stay |
| S9 | **Refund, CKB to BTC** (the payout cannot arrive) | As S7, but when step 3 shows the hold invoice, stop Alby Hub (`docker stop albyhub-mutinynet`), then pay it from your node. Start Alby Hub again afterwards | The payout fails; the hub cancels the held Fiber payment: **Refunded: your payment went back to your wallet**, and your node keeps its CKB |
| S10 | **Expired quote** | Type an amount and let the countdown in You receive reach zero | It reads Expired and the button **Refresh quote**; pressing it gets a new quote, and the button reads **Swap** again. Nothing is paid |
| S11 | **A mainnet wallet is refused** (if you have one) | **Connect Lightning** with the NWC secret of a mainnet wallet | Refused in the dialog with "This wallet is on Bitcoin mainnet. CKBolt swaps test money only: …". The chip still reads **Connect Lightning** |
| S12 | **RUSD with the browser node** (after S3) | On the node page, **Ask for 20 RUSD inbound**: the node needs about 180 CKB at its address for its side's reserve. Once Ready, pick RUSD with the token button in /app and do S4 (2,000 sats is about 1.60 RUSD), then S5 with about 1 RUSD | Complete both ways; the amounts are in RUSD (8 decimals), and the Fiber dialog lists RUSD |

Without your own node, S8 can be tried with the browser node: as S4, and close the node tab as soon as "Swap locked with
the hub" is done. If the payout was quicker, the swap simply completes.

## 4. Evidence for each swap

- **On the page**: the progress dialog's steps, and under the result's **Details** the swap id, payment hash and
  preimage, with `sha256(preimage) = payment hash` checked in the page (a refund shows the hub's reason there).
- **From the hub**, through the tunnel:
  - `curl http://127.0.0.1:18787/v1/swaps/<id>` gives the state, both legs and the payment hash.
  - `curl http://127.0.0.1:18787/v1/swaps/<id>/events` lists the events with times.
- **The hash lock**: once a swap succeeds, its preimage is public. Check that it opens the hash:
  `node -e "console.log(require('crypto').createHash('sha256').update(Buffer.from(process.argv[1],'hex')).digest('hex'))" <preimage>`
  must print the payment hash.
- **Wallets**: Alby Hub's transaction list, and the Activity panel on /app/fiber.
- **Hub logs**: `npm --prefix deploy run testnet -- logs hub --tail 200`. A line with `needs attention` is an alert (see
  the runbook, section 9).

## 5. How it behaves, and limits

- Payments are hold invoices: the hub holds your payment, pays out, and collects your payment only with the preimage the
  payout revealed. If the payout fails, the hub cancels the hold and your wallet gets the payment back.
- **The browser node pays over the channel the hub opened to it**, whose safety delay the hub knows: it receives first
  (S4), then pays from that balance (S5). **In a token with `peerChannels`** in `FIBER_ASSETS` it can also pay over a
  channel it opens to the hub with its own tokens (a cWBTC faucet claim, for example). The hub counts the longest
  safety delay for such a channel and sizes that token's hold invoices for it ([add-token.md](add-token.md), "Peer
  channels"). The node page offers this for a token whose `peerChannels` the hub turns on (off on the public hub for now).
- Limits:
  - 20,000 sats per swap;
  - 5 unpaid swaps per visitor;
  - inbound channels: 1 per node and 2 per visitor per day, 10 open in total (`FIBER_INBOUND_*` in the server's
    `hub.env`).
- An NWC payment of a hold invoice answers "timeout" after 60 s while it stays held. The page then says "Sent; waiting
  for the hub" and follows the hub. It never pays twice.
- Mutinynet and the default signet share a genesis hash, so the app cannot tell them apart by network alone. It also
  compares block heights and warns when they differ.
- RUSD liquidity is small: 30 RUSD a side with the demo node, and 20 RUSD per inbound channel. To add more:
  - claim more at the RUSD faucet with JoyID;
  - send it to fnn-hub from `http://localhost:3200/app/fiber/fund?address=<fnn-hub address>` (the runbook's hand step 2);
  - raise `DEPLOY_FIBER_DEMO_CHANNEL_RUSD`, then run `testnet channels`.

## 6. More tokens: cWBTC through FIBER_ASSETS

The hub serves the UDTs that `FIBER_ASSETS` in the server's `hub.env` lists (CKB is built in). Without it, it serves CKB
and RUSD exactly as before: the old `UDT_RUSD_SCRIPT`, `UDT_CWBTC_SCRIPT` and `FIBER_INBOUND_RUSD_AMOUNT` keep working.
cWBTC (CCH Wrapped BTC) is an xUDT with 8 decimals at 1:1 with BTC: 1 base unit is 1 sat, so it runs with no option
premium.

`FIBER_ASSETS` is the only place a token is configured. fnn's whitelists (`fnn/hub.yml`, `fnn/demo.yml`) are generated
from it, and `add_token.py` on the server does the whole change: it validates, regenerates, restarts what changed,
checks, and can open channels. The runbook, with a complete cWBTC example, is [add-token.md](add-token.md). For a hub
that is not on `FIBER_ASSETS` yet:

1. **Move `hub.env` to `FIBER_ASSETS`.** Remove `FIBER_INBOUND_RUSD_AMOUNT` (RUSD's `inboundAmount` replaces it; the hub
   refuses to start with both) and add one line. Single quotes keep the JSON intact for Docker Compose.

   ```env
   FIBER_ASSETS='[{"id":"RUSD","symbol":"RUSD","name":"RUSD stablecoin","decimals":8,"usdRule":"usd_peg","typeScript":{"codeHash":"0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a","hashType":"type","args":"0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b"},"cellDeps":[{"typeId":{"codeHash":"0x00000000000000000000000000000000000000000000000000545950455f4944","hashType":"type","args":"0x97d30b723c0b2c66e9cb8d4d0df4ab5d7222cbb00d4a9a2055ce2e5d7f0d8b0f"}}],"inboundAmount":"2000000000","autoAcceptAmount":"1000000000"}]'
   ```

   RUSD keeps the global fee and premium. Each entry can also set:

   - `feeBps`, `optionPremiumBps`, `minSats` and `maxSats`;
   - `peerChannels`, `displayName` and `iconUrl` (new in this version).

   The schema is in [architecture.md](architecture.md#assets-fiber_assets).
2. **Update the image and the kit,** in this order the first time:
   1. `npm --prefix deploy run testnet -- sync`. After the upload it runs `python3 add_token.py --regenerate --apply --template-dir .sync-templates`
      on the server; the first time it only warns that the hub image predates the whitelist generator.
   2. `testnet build hub`.
   3. On the server, in `/opt/ckbolt/testnet`: `python3 add_token.py --regenerate --apply --template-dir .sync-templates`. It writes fnn's
      whitelists from the server's `FIBER_ASSETS` and restarts fnn-hub and fnn-demo where they changed.
   4. `testnet up hub`. `testnet compose -- restart hub` does not read a changed `hub.env`; `up` recreates the
      container.
3. **Add cWBTC on the server** with [add-token.md](add-token.md): `ssh testnet-vps`, `cd /opt/ckbolt/testnet`,
   `python3 add_token.py cwbtc.json`, then the same with `--apply`.
   - **Funding:** fnn-hub needs cWBTC (the faucet at https://faucet-cwbtc.ckb.dev) for its payout channel. It also
     needs about **180 CKB on chain for every UDT channel** it is part of, inbound and peer channels included.
   - **Channels:** the payout channel to bottle or bracer (they auto-accept 10 cWBTC and add none) can be opened in the
     same run, with `--open-channel <pubkey>@<multiaddr>=1000000000`.
4. **Check:**
   - `GET /v1/assets` lists CWBTC with its liquidity (and its `displayName` and `iconUrl` when set);
   - `GET /v1/fiber/node` gives each UDT's `udtWhitelist`, its `peerChannels`, and `inbound.amounts.CWBTC`;
   - `npm --prefix deploy run testnet:check` reports no failure.
5. **Later syncs** keep the whitelists: the sync uploads the repo's copies as templates only, regenerates from them and
   the server's `hub.env`, and restarts fnn-hub only where the result differs from what it runs
   ([add-token.md, "After every `testnet sync`"](add-token.md#after-every-testnet-sync)).

A browser node takes a cWBTC channel only once its config whitelists cWBTC: the web app builds that entry from
`GET /v1/fiber/node` (`assets[].udtWhitelist`). S12 then works with cWBTC as with RUSD:

1. Ask for cWBTC inbound. The node needs about 180 CKB at its address for its side's reserve.
2. Swap 2,000 sats to about 1,990 cWBTC base units, and back.

With `peerChannels` on cWBTC, a node holding faucet cWBTC can instead open its own cWBTC channel to the hub (at least
`peerChannels.minAmount`) and pay cWBTC to BTC at once. The hub offers that while nodes have fewer such channels open
than `FIBER_PEER_CHANNELS_MAX_OPEN` (10 by default, in `hub.env`); at the cap `GET /v1/fiber/node` gives
`peerChannels: null` and the web app shows only the hub-funded channel (or no cWBTC row without `inboundAmount`).

## 7. When something is off

| Symptom | Check, then do |
| --- | --- |
| The Swap tab shows the simulated form, with L1 wallet buttons, instead of the live card | The tunnel or `HUB_URL`. `curl http://127.0.0.1:3200/api/hub/v1/health` must answer the hub's health |
| Health is `degraded` | It names the node. Run `npm --prefix deploy run testnet:check` and follow its `next:` line |
| "Not enough CKB to send", or "Your node cannot send this much yet." | Do S4 first (receive), then pay a smaller amount |
| The browser node cannot connect | The page must be `http://localhost:3200`. Check `GET /v1/fiber/node` lists a `ws` address, and that port 8228 on the testnet server is reachable |
| The inbound channel stays Opening | CKB testnet confirmations take minutes. Check the node holds about 99 CKB for its reserve |
| A swap stays held for long | Watch `/v1/swaps/<id>/events` and the hub logs. The hub resolves every swap before its time limits; ask before acting by hand |
| Not enough liquidity for a direction | `testnet:check` shows each direction. `npm --prefix deploy run testnet -- balance` rebuilds Lightning inbound (faucet invoices, 60 per day) |
| A Fiber payment fails with `no path found`, or a Fiber developer asks for `node_info` and `list_channels` | [diagnose-route.md](diagnose-route.md): **Copy diagnostics** on each node page (panel 06), then `scripts/diagnose-route.ts` next to the hub's node |

Operator commands (status, logs, restart, re-deploy after a code change, backups): [`deploy/README.md`](../deploy/README.md).
