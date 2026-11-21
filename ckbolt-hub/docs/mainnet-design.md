# Mainnet design: costs the testnet does not charge

Status: design only (security review H11, November 2026). Nothing here is built. It covers what the review listed as
mainnet work: what a free option costs the hub, inbound channels nobody uses, and per-client caps that cost nothing to
get around. Each part ends with what to build, and in which order.

## 1. The free option

**Today.** A quote lasts `QUOTE_TTL_SECONDS` (180). A swap locks it with hold invoices on both legs and costs nothing to
create. The hub charges a flat `FEE_BPS` (50) whatever the lock time. Unpaid swaps are capped per client
(`SWAP_MAX_UNPAID_PER_CLIENT`, 5) and in total (`SWAP_MAX_UNPAID`, 50).

**What it costs on mainnet.** Two things, both free to the user:

- **Unpaid swaps.** Each one reserves its payout and leaves a hold invoice on the hub's nodes until its quote expires.
  Fifty clients, or one client with fifty addresses, can keep the hub from quoting at all.
- **Held payouts.** A payee can take the payout and hold it as long as the payout lock allows (`MAX_PAYOUT_LOCK_MINUTES`;
  96 h on the mainnet profile), watching the price. This is an option the hub writes for free. Its value grows with
  volatility and with the square root of the lock time.

**Design.**

1. **A premium priced by lock time.** The fee becomes `FEE_BPS + premium(lock)`, where the premium grows with the square
   root of the payout lock time the payout invoice asks for. It is scaled by a per-asset volatility setting:
   - stablecoins about 0;
   - CKB and BTC: set from 30-day realised volatility, reviewed monthly.

   The quote shows the premium as its own line. A payout invoice that asks for a long lock costs more, and a short one
   costs about today's fee. The cap on lock time stays as a hard limit.
2. **A prepayment for unpaid swaps, only if abuse shows up.** It is a small non-refundable payment, a few hundred sats or
   the equivalent, made before the hub creates the hold invoices, and credited against the swap's fee if the swap
   completes. It makes swap spam cost money instead of addresses. It adds a step for honest users, so it starts off, with
   a setting, and the monitor alerts when unpaid swaps reach their cap.
3. **Shorter quotes on mainnet** for volatile assets (60 to 120 s). Stablecoins keep the longer quote.

## 2. Inbound channels nobody uses

**Today.** The hub opens a private Fiber channel to a visitor's node, funded with the hub's CKB or token, so the node can
receive. It caps how many a client and a node may get, but it never closes one, so the hub's capital stays locked in
channels that are never used.

**Design.**

- **Track the last payment over each inbound channel** (the last TLC added or settled). The hub already lists its
  channels (`list_channels`).
- **Close idle channels cooperatively:**
  - after `INBOUND_IDLE_CLOSE_DAYS`, with no payment and nothing on the visitor's side (the hub's own funds come back);
  - after a longer `INBOUND_IDLE_CLOSE_FUNDED_DAYS` when the visitor holds a balance (their balance goes to them on
    chain).

  Force-close only when the peer has been offline for longer than that, since a force close costs a commitment delay.
- **Tell the visitor.** The browser node's History shows "The hub closed an unused channel" with what came back. The
  guide says how long an unused channel stays open.
- **Watch it.** The monitor alerts when the capital in inbound channels passes a threshold.

## 3. Per-client caps that cost nothing to get around

**Today.** A client is an IPv4 address or an IPv6 /64. A VPS with a /48, or a rotating proxy, gives anyone thousands of
clients, and every cap per client multiplies with them. The caps for everyone together bound the damage, but they also
stop honest users once someone fills them.

**Design.**

- **Tie scarce things to cost, not to identity.** Inbound channels and unpaid swaps are the scarce things. The prepayment
  (1.2) and closing idle channels (2) make abuse cost money or end by itself, so the caps can stay generous.
- **Count channel requests per node id** too, with a signed challenge from the node's key. A node id costs little, but it
  must stay online to receive the channel.
- **Group repeat offenders by /48** for IPv6 when one /64 after another hits the cap within a short window.

## 4. Order of work

1. Premium by lock time (1.1), since it is pure pricing: domain, config and quote display.
2. Idle channel close (2), since it frees capital and needs no user change.
3. Monitor alerts for unpaid swaps at their cap and for locked capital.
4. Prepayment (1.2) and the per-node-id cap (3), when the alerts show they are needed.

**Fiber LSP.** Fiber's coming LSP support (nervosnetwork/fiber PR #1623, still open) keeps a wallet's channels on a
server and its keys in the wallet. A CKBolt hub that also serves as an LSP would hold the channels it funds and know when
they go idle, which makes part 2 simpler. It would also let the web app drop the heavy in-browser node.
