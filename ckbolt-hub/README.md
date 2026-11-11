# ckbolt-hub

The CKBolt hub swaps BTC on Lightning and CKB tokens on CKB's Fiber Network, in both directions. It runs next to an LND
node and a Fiber node (fnn) and locks both legs of every swap to one SHA-256 payment hash with hold invoices: the user is
paid and the hub settles, or the user is refunded. Stage 3 of the CKBolt roadmap: live swaps on testnet.

A project by [TEX Labs](https://texlabs.org). The web app is [ckbolt-web](../ckbolt-web/), in the same repository.

- Plan, status, protocol and safety rules: [docs/phase-3-plan.md](docs/phase-3-plan.md)
- Architecture, REST API and error codes: [docs/architecture.md](docs/architecture.md)
- How to test everything (unit, devnet, end-to-end, the web app against the hub, manual swaps):
  [docs/testing.md](docs/testing.md)
- Local devnet: [devnet/README.md](devnet/README.md)
- Public testnet demo (Mutinynet + CKB testnet), compose profile and runbook: [deploy/README.md](deploy/README.md)
- Research notes: [docs/research/](docs/research/)

## Quick start (development)

Needs Node.js 22 or later; the devnet needs Docker.

```
npm install
npm run typecheck
npm test                        # unit tests, no network
```

Against real nodes on the local devnet:

```
npm --prefix devnet install     # once
npm --prefix devnet run up      # start the devnet with its saved state (first time: npm --prefix devnet run bootstrap)
cp devnet/hub.env .env          # the hub reads .env at start-up; variables already set in the environment win
npm run build
npm run start:prod              # node dist/main, on HUB_HOST:HUB_PORT (127.0.0.1:8787 by default)
curl http://127.0.0.1:8787/v1/health
npm run test:e2e                # end-to-end tests on the devnet (they start their own hub in-process)
```

## API

REST, versioned under `/v1`: `GET /health`, `GET /assets`, `POST /quotes`, `GET /quotes/:id`, `POST /swaps`,
`GET /swaps/:id`, `GET /swaps/:id/events`, and the demo wallet's `POST /demo/invoices` and `POST /demo/payments`.
Amounts are decimal strings of base units; errors are `{ "error": { "code", "message" } }`. The contract is
`src/interfaces/http/contract/`; the table with status codes is in [docs/architecture.md](docs/architecture.md).

## Status

Both swap directions for CKB and RUSD work end to end on the local devnet: through the API, the end-to-end tests and the
web app's live mode, with refunds and restart recovery. The public testnet demo is live: the web app at
https://ckbolt.texlabs.org, and the hub on a testnet server (Mutinynet + CKB testnet) that the web server reaches
through its proxy; the runbook is [deploy/README.md](deploy/README.md). Testnet only; never point it at mainnet funds.
