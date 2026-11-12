# CKBolt

CKBolt links Bitcoin's Lightning Network and CKB's Fiber Network, so people can pay, get paid and swap between BTC,
CKB and tokens issued on CKB. A CKBolt hub runs a Lightning node (LND) and a Fiber node (fnn), prices each route, and
locks both legs of every swap to one SHA-256 payment hash with hold invoices: the recipient is paid and the hub settles,
or the payer is refunded.

> **Testnet only. Not audited.** Never point any part of this code at mainnet funds.

- Live testnet demo: <https://ckbolt.texlabs.org> (Bitcoin Mutinynet and CKB testnet, test money only)
- Testnet cWBTC faucet: <https://ckbolt-faucet.texlabs.org>
- Built by [TEX Labs](https://texlabs.org)

## What is in this repository

| Folder | What it holds |
| --- | --- |
| [`ckbolt-hub/`](ckbolt-hub/) | The hub (NestJS, TypeScript): swap engine, LND and fnn adapters, timing and pricing policy, REST API, a local devnet (bitcoind regtest, two LND, a CKB dev chain, two fnn), and a Docker Compose profile for the test networks |
| [`ckbolt-web/`](ckbolt-web/) | The web app (Next.js): the landing page, the app (Swap, Pay, Get paid), the visitor's browser Fiber node (fiber-js), the testnet guide, and a server-side proxy to the hub |

The HTTP contract between them is [`ckbolt-hub/src/interfaces/http/contract/`](ckbolt-hub/src/interfaces/http/contract/),
copied to [`ckbolt-web/lib/hub/contract.ts`](ckbolt-web/lib/hub/contract.ts).

## How a swap works

- **Lightning to Fiber** (`ln_to_fiber`): the user gives the hub a Fiber invoice (SHA-256 hash). The hub returns a
  Lightning hold invoice on the same hash. Once the user's payment is held, the hub pays the Fiber invoice; the payee's
  preimage settles the hub's Lightning hold.
- **Fiber to Lightning** (`fiber_to_ln`): the user gives the hub a Lightning invoice. The hub returns a Fiber hold invoice
  on the same hash. Once the user's TLC is held, the hub pays the Lightning invoice and settles the Fiber hold with the
  preimage it learns.

In both directions the hub never cancels the incoming leg while its payout is in flight or once a preimage is known, and
every payout is sized to finish before the incoming hold can expire. The rules, and why, are in
[ckbolt-hub/docs/phase-3-plan.md](ckbolt-hub/docs/phase-3-plan.md), section 3.

## Where to start a review

Code that keeps funds safe:

| Area | Where |
| --- | --- |
| Safety rules (settle, cancel, refund, resend) | [ckbolt-hub/docs/phase-3-plan.md](ckbolt-hub/docs/phase-3-plan.md), section 3 |
| Swap engine: each direction's flow, the processor that follows payouts, restart recovery | [ckbolt-hub/src/application/swaps/](ckbolt-hub/src/application/swaps/) |
| Timing: hold expiries, payout budgets, Fiber commitment delays | [ckbolt-hub/src/domain/timing/](ckbolt-hub/src/domain/timing/) |
| Quotes and prices | [ckbolt-hub/src/application/pricing/](ckbolt-hub/src/application/pricing/) |
| Node adapters (fnn JSON-RPC, LND) | [ckbolt-hub/src/infrastructure/fiber/](ckbolt-hub/src/infrastructure/fiber/), [ckbolt-hub/src/infrastructure/lightning/](ckbolt-hub/src/infrastructure/lightning/) |
| Browser Fiber node: keystore, signing, withdrawals | [ckbolt-web/lib/wallets/fiber-browser/](ckbolt-web/lib/wallets/fiber-browser/) |
| The web server's hub proxy: request guard (CSRF), rate limits | [ckbolt-web/app/api/hub/](ckbolt-web/app/api/hub/), [ckbolt-web/lib/hub/](ckbolt-web/lib/hub/) |

Background on the protocols (Fiber's Cross-Chain Hub, the fnn RPC, LND hold invoices):
[ckbolt-hub/docs/research/](ckbolt-hub/docs/research/). Architecture, API and error codes:
[ckbolt-hub/docs/architecture.md](ckbolt-hub/docs/architecture.md).

## Run it

Needs Node.js 22 or later; the devnet needs Docker.

```
# the hub: unit tests, then end-to-end tests on the local devnet
cd ckbolt-hub
npm install
npm test
npm --prefix devnet install && npm --prefix devnet run bootstrap
npm run test:e2e

# the web app: its Playwright suite (the hub is faked), then the app against a hub on the devnet
cd ../ckbolt-web
npm install
npm run build:test
npx playwright test
HUB_URL=http://127.0.0.1:8787 npx next start -p 3200
```

Step by step, including manual swaps against the devnet: [ckbolt-hub/docs/testing.md](ckbolt-hub/docs/testing.md).
On the test networks with real wallets: [ckbolt-hub/docs/testing-testnet.md](ckbolt-hub/docs/testing-testnet.md).

## Known limitations

- One hub, run by one operator. Hold invoices mean it cannot keep a payer's money without paying out, but it sets the
  prices and the liquidity, and it can be down.
- Lightning to Fiber payouts: an fnn payee can claim a TLC on chain with the preimage even after it expires. The hub
  force-closes the payout channel early when its peer still holds the TLC, so that claim lands while the Lightning
  hold is still open; only a public channel the hub opened to a router that is not the payee stays open. A payout over
  a channel the payee's node opened with a commitment delay of about 1.6 to 2.5 epochs is not covered yet;
  node-opened token channels are off on the public hub.
- The browser Fiber node keeps its key in the browser, encrypted with the visitor's password. It is meant for test
  money.

## Reporting problems

Bugs, confusing steps, wrong numbers: [open an issue](https://github.com/Tech-Expansion/CKBolt/issues/new/choose). A swap
id helps; testnet swaps hold no real value, so it is fine to post one.

How to work on the code, and the rules it follows: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Business Source License 1.1](LICENSE). You may read, copy, modify and run CKBolt, and run it on test networks for any
purpose, including as a service. Use with mainnet funds needs a license from TEX Labs. On 2029-11-11 the code becomes
available under the Apache License, Version 2.0.
