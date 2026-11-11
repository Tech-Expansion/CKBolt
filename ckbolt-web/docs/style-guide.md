# Style guide

How the site and the app look and read. Follow it for any new section, page, control or copy. The design comes from a
v0 template, and the original template's design is kept: add content in its patterns, do not invent new visual language.

## Stack

- Next.js 16 (App Router), React 19, TypeScript 5.
- Tailwind 4 through `@tailwindcss/postcss`, CSS-first theming with `@theme inline` in `app/globals.css`; there is no
  `tailwind.config`.
- shadcn "new-york" pieces (`components/ui/`), Radix popover, slot and tabs, `cn()` in `lib/utils.ts`, lucide-react icons.
- Wallets: the app's one wallet is the visitor's Fiber node (the header's popup); `@ckb-ccc/connector-react` only funds
  it (`/app/fiber/fund`) and picks a withdrawal's address. There are no wallet panels on `/app`.

## Type

| Role | Font | Class |
| --- | --- | --- |
| Body | Instrument Sans (`--font-instrument`) | `font-sans` (default) |
| Display headings, big figures | Instrument Serif 400 (`--font-instrument-serif`) | `font-display` |
| Labels, tags, code, small captions | JetBrains Mono (`--font-jetbrains`) | `font-mono` |

- H1 (hero): `text-[clamp(3rem,6.6vw,7rem)] font-display leading-[0.9] tracking-tight`. On `/app`: `text-4xl lg:text-6xl`.
- H2: `text-4xl lg:text-6xl font-display tracking-tight mb-8`, two short lines split by `<br />`, the second in
  `<span className="text-muted-foreground">`. The roadmap uses `text-stroke` on its second line.
- Lead: `text-xl text-muted-foreground leading-relaxed`. Body: `text-muted-foreground leading-relaxed`.
- Big numbers: `font-display ... tabular-nums [overflow-wrap:anywhere]`, unit in a smaller muted span.

## Colour

Warm monochrome in OKLCH (`app/globals.css`): `--background oklch(0.985 0.002 90)`, `--foreground oklch(0.12 0.01 60)`,
`--muted-foreground oklch(0.45 0.02 60)`, `--border oklch(0.88 0.01 90)`, `--destructive`. No dark theme.

- Surfaces, text, borders and buttons stay monochrome. Use foreground opacities: `/5` row dividers, `/10` default
  borders, `/15` inputs and tags, `/20` outline buttons, `/30` the eyebrow line; fills `bg-foreground/[0.02]`,
  `[0.03]`, `[0.04]`. Primary buttons stay black pills; the landing page has no status colour.
- Secondary text: `text-muted-foreground`. Small text on translucent or busy backgrounds needs enough contrast (axe runs
  in the tests); use `text-foreground/70` there.
- The only decorative accent is Bitcoin orange `#f7931a` (the Lightning badge on token icons).
- Corners are square except pill buttons (`rounded-full`) and the scrolled navigation bar (`rounded-2xl`).

### Status colours

Decision (2026-10-27): more colour in the app, so states are easy to tell apart at a glance. Colour carries
state only, never decoration, and every coloured state keeps its words (a dot or a badge is never the only signal).
Four tones (`lib/status-tone.ts`, `StatusTone`), each with tokens in `app/globals.css`:

| Tone | Means | Text | Bright (dots, rules) | Soft (fills) |
| --- | --- | --- | --- | --- |
| `ok` | alive, ready, done (also Fiber's identity) | `--fiber oklch(0.50 0.11 165)` | `--fiber-bright oklch(0.70 0.15 165)` | `--fiber-soft oklch(0.96 0.03 165)` |
| `pending` | in progress, waiting, needs a look; Testnet | `--pending oklch(0.53 0.12 65)` | `--pending-bright oklch(0.78 0.15 75)` | `--pending-soft oklch(0.965 0.04 85)` |
| `error` | failed | `--destructive` | `--destructive` | `--destructive-soft oklch(0.965 0.02 25)` |
| `off` | locked, stopped, not set up, closed | `--muted-foreground` | `foreground/30` | none |

- The bright tokens are never text: they fail contrast on the background. Text on `--destructive-soft` stays
  `foreground` (destructive on it is 4.26:1).
- Shared pieces (`components/app/status.tsx`): `StatusDot` (pending pulses, still under reduced motion),
  `StatusBadge` (a tag in the tone, with an optional dot), `StatusNotice` (a 2px left rule in the bright tone, an icon,
  foreground text) and `statusRule` (a channel card's left rule). The mappings from state to tone are pure functions in
  `lib/status-tone.ts` (node phase, channel state, swap step and outcome, the node's activity, the hub), tested in
  `tests/unit/fiber-wallet-popup.spec.ts`.
- Where it shows: the header's Fiber node button (dot, and a faint green outline while running), the popup's state and
  Testnet badges, Ready and opening channels, the node's activity, notices (done, failed, waiting), the swap card's
  wallet chips (not connected is `off`; a step the visitor takes, such as a channel for this swap, is `pending`; only a
  failure is `error`), its progress steps and result, Pay's and Get paid's results, the node's History, and the hub's
  status.

## Landing section anatomy

```tsx
<section id="name" ref={sectionRef} className="relative py-24 lg:py-32 border-t border-foreground/10">
  <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
    <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground mb-6">
      <span className="w-8 h-px bg-foreground/30" />
      Eyebrow
    </span>
    <h2 className="text-4xl lg:text-6xl font-display tracking-tight mb-8">
      First line.
      <br />
      <span className="text-muted-foreground">Second line.</span>
    </h2>
    ...
  </div>
</section>
```

- Variants: roadmap and FAQ use `py-32 lg:py-40`; the hero uses `max-w-[1600px]`; the problem section has
  `bg-foreground/[0.02]`; metrics use `border-y`; How it works is inverted (`bg-foreground text-background`, muted parts
  `background/50`).
- Grids with hairlines: `grid ... gap-px bg-foreground/10`, cells `bg-background p-8 lg:p-12`. Cards:
  `p-6 border border-foreground/10 hover:border-foreground/20`. Columns: `border-t border-foreground pt-6`. Rows:
  `border-b border-foreground/5 last:border-b-0`. Chips: `px-3 py-1.5 border border-foreground/10 text-sm`.
- Reveal on scroll: an `IntersectionObserver` (threshold 0.1, cards 0.2) sets `isVisible` once; classes
  `transition-all duration-700` with `opacity-0 translate-y-4|8` until visible; stagger with `transitionDelay`.
- Motion: anything that loops or auto-advances checks `motionPaused()` and listens for `MOTION_EVENT` (`lib/motion.ts`);
  canvases use `startCanvasLoop`; marquees carry `data-marquee` and `data-marquee-copy` so they wrap when motion is off.
- Call to action: `Button asChild` with `bg-foreground hover:bg-foreground/90 text-background px-8 h-14 text-base
  rounded-full group` and an `ArrowRight` that moves on hover; outline variant `h-14 px-8 rounded-full
  border-foreground/20 hover:bg-foreground/5`.

Section order today (`app/page.tsx`): Navigation, Hero, Problem and solution (`#problem`), Solution and impact on CKB
(`#impact`), Lightning today (`#prices`), Use cases (`#features`), How it works (`#how-it-works`), Architecture
(`#architecture`), Roadmap (`#roadmap`), FAQ (`#faq`), Contact, Footer.

## App UI patterns

- Primitives in `components/app/ui.tsx`: `Panel({title, step, aside})` (bordered, mono step number, display title),
  `Tag` (mono, square, bordered), `Row({label, value, note})` inside a `<dl>`, `CopyButton`, `onRadioGroupKeyDown`.
- Layout: `grid lg:grid-cols-[minmax(0,1fr)_420px] gap-6 lg:gap-10 items-start`; the right column is sticky.
- Buttons: primary `bg-foreground text-background rounded-full h-12 px-6 text-sm font-medium hover:bg-foreground/90
  disabled:opacity-40 disabled:cursor-not-allowed`; secondary `border border-foreground/20 rounded-full h-12 px-6`;
  `pillButton` (`h-10`), `smallBtn` (`h-8 text-xs`); text buttons `min-h-10 px-3 text-sm text-muted-foreground`.
- Inputs: square, `border border-foreground/15 bg-background h-11 px-3 font-mono text-xs focus:border-foreground
  focus-visible:ring-2 focus-visible:ring-foreground/25`; amount inputs `h-14 font-display text-3xl tabular-nums`. Every
  input has a `<label htmlFor>`, `aria-invalid` and `aria-describedby` pointing at its error `<p className="text-sm
  text-destructive">`.
- Popovers: `PopoverContent align="end" aria-label="..." className="w-80 p-0 rounded-none border-foreground/15"`, a mono
  header row, list buttons with `aria-pressed`.
- Token icons: `TokenIcon` is decorative (`aria-hidden`) and always sits next to the symbol as text; `lightning` adds the
  orange badge. It takes the icons to try in order (the hub's `iconUrl`, then the app's own in `public/tokens`), shows
  each only as `<img src>`, moves to the next when one fails to load, and shows the symbol's initials when none does.
  A token's name beside its symbol is the hub's `displayName`, else the app's, else the hub's name
  ([fiber-wallet-popup.md](fiber-wallet-popup.md#tokens-from-the-hub-the-udt-whitelist), `lib/token-display.ts`).
- Swap card ([live-swap-ui.md](live-swap-ui.md)): a token picker on the Fiber side, a flip button between the boxes;
  the route follows the pair. At most 25 visible words at rest, no sentence over 12 words, every explanation behind a
  "?" (`InfoTip`) or the "How it works" dialog. Pay and Get paid are cards in the same pattern
  ([pay-get-paid.md](pay-get-paid.md)); a Lightning invoice to pay shows as a QR code with Copy and "Open in wallet".
- Page intros: `PageIntro` (`components/app/page-intro.tsx`), an eyebrow, the H1 and one lead line; detail goes in its
  optional "?".
- The Fiber node popup ([fiber-wallet-popup.md](fiber-wallet-popup.md)): a square panel (`border-foreground/15`,
  380 × 600 px from `sm`, a full-height sheet on a phone) with a display title, its state badge, a Testnet tag and
  Close. From `sm` its title bar moves it anywhere in the window (a faint grip in the bar's left padding is its Move
  button; a double click puts it back), and it stays where it was left; the sheet does not move. Inside, Home (what a
  swap can move, on-chain CKB, the hub, a 2 × 2 grid of large icon buttons, the latest History) and one sub-page per
  button under a top bar with Back and the page's title, History and Confirm among them; no bottom bar. The header's
  node button is a pill like the swap card's wallet chips, with the same status dot.

## Accessibility conventions

- Radio groups: `role="radiogroup"` with a label, `role="radio" aria-checked`, roving `tabIndex`,
  `onKeyDown={onRadioGroupKeyDown}`.
- Tabs: Radix with `forceMount` and `data-[state=inactive]:hidden`, so switching keeps what was typed. The Fiber node
  popup's pages stay mounted the same way (`hidden`); opening one moves focus to its title, Back returns it to the
  button that opened it.
- Status areas: `aria-live="polite"`; notices `role="status"`; FAQ uses `aria-expanded`, `aria-controls`, `hidden`.
- A panel that moves (the Fiber node popup, [fiber-wallet-popup.md](fiber-wallet-popup.md#moving-the-popup)): its title
  bar drags it (pointer capture, cursor `grab`, never from a control in the bar), and a Move button before its other
  controls takes the arrow keys (Shift for big steps) and Home (back to its place), with how in its `title`. It stays
  inside the viewport, and its place is a per-viewer convenience in localStorage. No animation.
- A disabled control says why in its `aria-label` or `title`. Scrollable code blocks get `role="region" tabIndex={0}`.
- Motion that answers a click (a dialog's or popover's fade and zoom, the mode tabs' colour change) is `motion-safe:`:
  with reduced motion it happens at once. Axe then never reads a colour halfway through a fade, which fails contrast
  although the colours at rest pass.
- Tests run axe (WCAG 2.0/2.1 A and AA) on the landing page and every app tab; serious and critical findings fail.
- Test ids are kebab-case nouns. The tabs: `mode-receive`, `mode-pay`, `mode-swap`, and `hub-unavailable`,
  `hub-checking`, `hub-degraded` for the hub's state. The live swap card ([live-swap-ui.md](live-swap-ui.md), Test ids
  and One wallet): `swap-card`, `swap-pay-box`, `swap-receive-box`, `swap-amount`, `swap-receive-amount`,
  `swap-token-pay`, `swap-token-receive`, `swap-flip`, `swap-details`, `swap-quote-timer`, `swap-primary`, `swap-error`,
  `swap-own-invoice`, `swap-ln-invoice` (the pasted Lightning invoice), `swap-ln-invoice-scan`, `swap-hold-invoice`,
  `swap-hold-qr`, `swap-hold-copy`, `swap-hold-open`, `swap-webln`, `wallet-button-fiber`, `wallet-dialog-fiber`,
  `swap-progress`, `swap-step-<n>`, `swap-result`, `swap-manual-invoice`, `swap-banner`, `how-it-works`, `info-tip`
  (every "?"). The public demo adds `swap-step-help`, `swap-report`, the guide's `testnet-guide*` and its hub card's
  `wallet-lightning-channel*` ([live-swap-ui.md](live-swap-ui.md), Public demo additions). Pay: `pay-card`,
  `pay-input`, `pay-scan`, `pay-kind`, `pay-preview`, `pay-token`, `pay-amount`, `pay-confirm`, `pay-waiting`,
  `pay-result`, `pay-error`, `pay-new`, `pay-route`; Get paid: `request-card`, `request-form`, `request-amount`, `request-asset`,
  `request-note`, `request-create`, `request-view`, `request-tabs`, `request-tab-lightning`, `request-tab-fiber`,
  `request-lightning`, `request-lightning-line`, `request-fiber`, `request-countdown`, `request-paid`, `request-payment`,
  `request-new`, `request-reset` ([pay-get-paid.md](pay-get-paid.md), Test ids). The header's Fiber node uses `fiber-wallet-*`
  ([fiber-wallet-popup.md](fiber-wallet-popup.md), Fiber node (current)): its Confirm page `fiber-wallet-confirm*`, its
  History `fiber-wallet-history`, `fiber-wallet-history-list`, `history-entry` (with `data-kind`, `data-status`,
  `data-key`), `history-entry-detail`, `history-entry-token`, and on the app's results `history-entry-view` (View in History).

## Copy

- English, en-US formatting, sentence-case headings, short declarative sentences.
- Honesty labels: `Existing`, `Planned`, `Testnet`, `Live` (a step the hub runs now), "Live on testnet", "Live testnet
  demo" (the site's name for stage 3), `Stage N`,
  `Simulated`, `Demo`, `Assumed`, "Indicative quote",
  "(unsigned, not payable)", "Illustrative. No transaction is created." Roadmap statuses `Done`, `Now`, `Next`,
  `Planned`.
- Errors say what is wrong, then what to do: "Use a testnet Fiber invoice." "Try again in a minute."
- Layers: "CKB L1", "CKB L2", "Bitcoin L2".
- No em dashes in prose; use colons, semicolons and commas. "—" only as an empty-value placeholder. "…" for loading text
  and input placeholders. In JSX write apostrophes as `&apos;`.
- Numbers: `lib/format.ts` (`fmtAmount`, `fmtRate`, `fmtSats`), `lib/quote.ts` (`formatUsd`, `formatAsset`),
  `lib/amount.ts` (`formatBaseUnits` for exact base units, `parseAmountInput` is locale aware). Dates:
  `toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })`.
