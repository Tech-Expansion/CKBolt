# Working on CKBolt

Issues and pull requests are welcome. For a large change, open an issue first so we can agree on the approach.
Contributions are accepted under the repository's [license](LICENSE).

## Before a pull request

The hub (`ckbolt-hub/`):

```
npm run typecheck
npm test                              # unit tests, no network
npm --prefix devnet run typecheck     # the devnet scripts have their own tsconfig
npm run test:e2e                      # end-to-end on the local devnet, when the change touches a swap path
```

The web app (`ckbolt-web/`):

```
npm run typecheck
npm run build:test                    # the build the tests run against (with test hooks)
npx playwright test                   # unit, desktop and mobile; no test talks to a real hub
```

Run the web suite without `HUB_URL` in the shell. The Fiber node popup needs Document-Isolation-Policy, which
Playwright's bundled Chromium lacks; those tests skip themselves there and run in full with `PW_CHANNEL=chrome`.

## Hub rules

1. **Clean architecture.** Dependencies point inwards: `interfaces` -> `application` -> `domain`; `infrastructure`
   implements `application/ports`. Domain code is pure TypeScript (no Nest, no I/O, no clock reads). Services depend on
   port interfaces through injection tokens (`src/application/ports/tokens.ts`), never on concrete adapters.
2. **No hard-coding.** Every tunable comes from `HubConfig` (`src/config/hub.config.ts`, env vars in `.env.example`).
   Protocol facts are named constants in `src/common/constants/`. No magic numbers or strings inline.
3. **Reuse through `common`.** Anything used in more than one place goes to `src/common/utils` (functions) or
   `src/common/constants` (values).
4. **Clean code.** Small functions with one job, names that say what they do, early returns, no dead code, comments
   only for the why. Errors users can see are `HubError` subclasses with a plain sentence and an `API_ERROR_CODE`.
5. **RESTful API.** Versioned prefix `/v1`; resource nouns; POST creates and returns `201` with a `Location` header;
   correct status codes (400, 404, 409, 422, 429, 503); errors as `{ "error": { "code", "message" } }`; collections as
   `{ "data": [...] }`; amounts as decimal strings of base units; times as ISO 8601. The contract is
   `src/interfaces/http/contract/`.
6. **Scalable and flexible.** New assets, networks, price sources or nodes are added by config and a new adapter, not
   by editing the engine.
7. **Tests.** Every module has unit tests with the fakes in `test/fakes`, which behave like LND and fnn where it
   matters. Tests are written from the protocol and safety rules, not from the implementation.

### Safety rules the hub must keep

- The user creates the preimage. The hub learns it only from its outgoing payment, checks `sha256(preimage) == hash`,
  saves it, then settles the incoming leg. Settle retries until it succeeds.
- Never cancel the incoming leg while the outgoing payment is in flight or once a preimage is known.
- Cancel the incoming leg (refund) when the outgoing payment has definitely failed, or when the quote or timing no
  longer holds before paying out. A payout the paying node refuses at send time (nothing sent) is refunded at once.
- A payout the paying node has no record of is sent again at most `PAYOUT_MAX_RESENDS` times, and refunded only once it
  has stayed unknown for `PAYOUT_MISSING_CONFIRM_SECONDS` since the last send.
- Save every state transition before acting on it; on start-up, resume every open swap from the nodes' state.
- One payment hash per swap. Fiber invoices must use `hash_algorithm: sha256`.

### Node behaviour that is easy to get wrong

- fnn release builds: the minimum `final_expiry_delta` is 160 minutes (older docs say 16 hours).
- A Fiber invoice can say `Received` after its held TLC timed out: check `heldTlcs()` before trusting a hold.
- Right after `settle_invoice`, fnn still says `Received` with no committed TLC for a few tens of ms;
  `hasRemovingTlcs()` tells this apart from a timed-out TLC.
- Nodes expire a hold invoice in whole seconds by their own clock: `HOLD_INVOICE_EXPIRY_TOLERANCE_SECONDS` covers it.
- `LND_HOLD_EXPIRY_DELTA_BLOCKS` must equal `invoices.holdexpirydelta` in the hub LND's `lnd.conf`: LND cancels an
  accepted hold invoice that many blocks before its earliest HTLC expires.
- LND refuses to start a payment whose `cltv_limit` is not greater than the invoice's CLTV + 3; `minLnCltvLimit`
  (`common/utils/lightning.util.ts`) is the smallest limit it takes.
- fnn fails a held TLC 2/3 of its inbound channel's commitment delay before expiry, and the opener of that channel
  chooses the delay (1 to 84 epochs). Size a Lightning payout from each held TLC's own deadline
  (`fiberHeldTlcFailsAt`).
- fnn can report a payment `Failed` while a part is still out: payouts go in one part (`max_parts: 1`), a matching
  preimage is success, and a `Failed` payout is final only once no outbound TLC for the hash is still pending.
- fnn lets a payee claim the hub's TLC on chain with the preimage even after its expiry; the payout guard
  (`FIBER_PAYOUT_GUARD`) force-closes the payout channel early so that claim lands in time. Only a public channel the
  hub opened to a router that is not the payee stays open.

## Web app rules

1. Keep the site's visual language; follow [ckbolt-web/docs/style-guide.md](ckbolt-web/docs/style-guide.md).
2. Be honest in copy: label what is simulated, demo, planned or live; never say something works before it does; never
   call reference prices liquidity. Site copy is English.
3. Every behaviour or UI change comes with Playwright tests; rebuild and run the whole suite.
