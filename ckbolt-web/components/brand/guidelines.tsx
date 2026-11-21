import type { ReactNode } from "react";
import { Zap } from "lucide-react";
import { SiteLink } from "@/components/site-link";
import { APP_PAGE_PATH } from "@/lib/wallets/fiber-browser/constants";
import {
  BRAND_KIT_PAGE_PATH,
  BRAND_KIT_ZIP,
  GUIDE_LOGOS,
  fileNameOf,
  logoPngPath,
  logoSvgPath,
} from "@/lib/brand/kit";
import { fileSizeLabel } from "@/lib/brand/file-size";
import { cn } from "@/lib/utils";
import { BrandLockup, BrandMark } from "./brand-mark";
import {
  BrandLead,
  BrandSection,
  BrandTag,
  BrandTitle,
  Container,
  DownloadChip,
  Eyebrow,
  HATCH_BACKGROUND,
  PillLink,
  SectionHeader,
} from "./ui";

/**
 * The brand guidelines (/brand): the mark, color, type, interface, voice and usage, from the brand kit v1.0 design.
 * Every logo shown is the kit's own file; only the "don't" examples draw the lockup inline, to misuse it on purpose.
 */

const SECTIONS = [
  { id: "logo", name: "Logo" },
  { id: "color", name: "Color" },
  { id: "type", name: "Typography" },
  { id: "interface", name: "Interface" },
  { id: "voice", name: "Voice" },
  { id: "usage", name: "Usage" },
] as const;

const sectionNumber = (i: number) => String(i + 1).padStart(2, "0");

export function BrandGuidelines() {
  return (
    <>
      <Hero />
      <OnThisPage />
      <LogoSection />
      <ColorSection />
      <TypeSection />
      <InterfaceSection />
      <VoiceSection />
      <UsageSection />
      <KitPanel />
    </>
  );
}

function Hero() {
  const kitSize = fileSizeLabel(BRAND_KIT_ZIP.path);
  return (
    <Container className="pt-32 lg:pt-40 pb-24 lg:pb-32">
      <div className="flex flex-wrap items-center gap-16">
        <div className="flex-[999_1_560px] min-w-0 flex flex-col gap-8">
          <Eyebrow>Brand guidelines · v1.0</Eyebrow>
          <BrandTitle>
            One mark.
            <br />
            Ink on paper.
          </BrandTitle>
          <BrandLead className="max-w-[620px]">
            How CKBolt looks, sounds and shows up. For anyone writing, building or presenting about payments between
            Lightning and CKB.
          </BrandLead>
          <div className="flex flex-wrap gap-3">
            <PillLink href={BRAND_KIT_ZIP.path} download={fileNameOf(BRAND_KIT_ZIP.path)} srLabel={`, zip, ${kitSize}`}>
              Download the brand kit
            </PillLink>
            <PillLink href={BRAND_KIT_PAGE_PATH} variant="outline">
              Browse all files
            </PillLink>
          </div>
        </div>
        <div className="flex-[1_1_380px] min-w-0 max-w-[520px]">
          <figure
            className={cn(
              "relative aspect-square border border-foreground/10 flex items-center justify-center",
              HATCH_BACKGROUND,
            )}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- the kit's own file, as supplied */}
            <img src={logoSvgPath("ckbolt-mark")} alt="The CKBolt mark" className="w-[52%] h-auto" />
            <figcaption className="absolute left-4 top-3.5 font-mono text-xs text-muted-foreground">
              fig. 01 — the mark
            </figcaption>
            <span className="absolute right-4 bottom-3.5 font-mono text-xs text-muted-foreground" aria-hidden="true">
              hexagon · fold · notch
            </span>
          </figure>
        </div>
      </div>
    </Container>
  );
}

function OnThisPage() {
  return (
    <nav aria-label="On this page" className="border-y border-foreground/10">
      <Container className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
        {SECTIONS.map((section, i) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="flex flex-col gap-1.5 py-6 text-foreground hover:text-muted-foreground transition-colors"
          >
            <span className="font-mono text-xs text-muted-foreground">{sectionNumber(i)}</span>
            <span className="text-lg">{section.name}</span>
          </a>
        ))}
      </Container>
    </nav>
  );
}

function eyebrowFor(id: (typeof SECTIONS)[number]["id"]): string {
  const i = SECTIONS.findIndex((s) => s.id === id);
  return `${sectionNumber(i)} — ${SECTIONS[i].name}`;
}

const LOGO_GROUND = { card: "bg-card", ink: "bg-foreground", secondary: "bg-secondary" } as const;

/** How each logo sits in its 260px card: lockups and wordmarks by width, stacked lockups and marks by height. */
const GUIDE_LOGO_SIZE: Readonly<Record<string, string>> = {
  "ckbolt-logo": "w-[78%] max-w-[340px] h-auto",
  "ckbolt-logo-reversed": "w-[78%] max-w-[340px] h-auto",
  "ckbolt-logo-stacked": "h-[82%] w-auto",
  "ckbolt-mark": "h-[72%] w-auto",
  "ckbolt-mark-line": "h-[72%] w-auto",
  "ckbolt-wordmark": "w-[70%] h-auto",
};

const LOGO_RULES = [
  { label: "Clear space", text: "x on every side, where x is ¾ of the mark’s height." },
  { label: "Minimum size", text: "Lockup 96 px / 20 mm wide. Mark 16 px / 5 mm." },
  { label: "Proportions", text: "Wordmark cap height is 62% of the mark. Gap is ¼ of the mark." },
  { label: "Wordmark", text: "Instrument Sans Medium, −2.5% tracking, outlined. Never retype it." },
] as const;

function LogoSection() {
  return (
    <BrandSection id="logo" className="gap-16">
      <SectionHeader
        eyebrow={eyebrowFor("logo")}
        title="A hexagon, folded into a C."
        lead="The notch points inward: value arriving from another network. The fold is the hub, where both sides of a payment lock to one hash."
      />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))] gap-4">
        {GUIDE_LOGOS.map((logo) => (
          <div key={logo.id} className="flex flex-col border border-foreground/10 bg-card">
            <div className={cn("h-[260px] p-8 flex items-center justify-center", LOGO_GROUND[logo.ground])}>
              {/* eslint-disable-next-line @next/next/no-img-element -- the kit's own file, as supplied */}
              <img src={logoSvgPath(logo.id)} alt="" className={GUIDE_LOGO_SIZE[logo.id]} />
            </div>
            <div className="flex flex-wrap justify-between items-center gap-3 px-5 py-4 border-t border-foreground/10">
              <span className="text-lg font-medium">{logo.label}</span>
              <span className="flex gap-2">
                <DownloadChip href={logoSvgPath(logo.id)} label="SVG" fileName={fileNameOf(logoSvgPath(logo.id))} />
                {logo.png ? (
                  <DownloadChip href={logoPngPath(logo.id)} label="PNG" fileName={fileNameOf(logoPngPath(logo.id))} />
                ) : null}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-4">
        <div className="flex-[3_1_520px] min-w-0 min-h-[340px] p-10 flex items-center justify-center border border-foreground/10 bg-card bg-[linear-gradient(to_right,rgb(8_5_3/0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgb(8_5_3/0.05)_1px,transparent_1px)] bg-[size:24px_24px]">
          <div className="relative p-12 outline outline-1 outline-dashed outline-muted-foreground bg-background">
            {/* eslint-disable-next-line @next/next/no-img-element -- the kit's own file, as supplied */}
            <img
              src={logoSvgPath("ckbolt-logo")}
              alt="The CKBolt logo with its clear space marked x on every side"
              className="block w-[300px] max-w-full h-auto"
            />
            <span className="absolute left-1/2 top-3.5 -translate-x-1/2 font-mono text-xs text-muted-foreground" aria-hidden="true">
              x
            </span>
            <span className="absolute left-[18px] top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground" aria-hidden="true">
              x
            </span>
          </div>
        </div>
        <dl className="flex-[2_1_360px] min-w-0 flex flex-col border-t border-foreground">
          {LOGO_RULES.map((rule) => (
            <div key={rule.label} className="flex flex-col gap-1.5 py-5 border-b border-foreground/10">
              <dt className="font-mono text-[13px] text-muted-foreground">{rule.label}</dt>
              <dd className="text-[17px] leading-[1.55]">{rule.text}</dd>
            </div>
          ))}
        </dl>
      </div>
    </BrandSection>
  );
}

interface Swatch {
  name: string;
  hex: string;
  use: string;
  /** Text on the swatch: Paper on dark swatches, Ink on light ones. */
  dark: boolean;
  bordered?: boolean;
}

const CORE_SWATCHES: readonly Swatch[] = [
  { name: "Ink", hex: "#080503", use: "Text, logo, primary buttons", dark: true },
  { name: "Paper", hex: "#FAFAF9", use: "Page ground", dark: false, bordered: true },
  { name: "Card", hex: "#FFFFFF", use: "Cards, inputs", dark: false, bordered: true },
];

const NEUTRAL_SWATCHES: readonly Swatch[] = [
  { name: "Secondary", hex: "#F3F2EE", use: "Quiet fills", dark: false },
  { name: "Muted", hex: "#ECEBE7", use: "Tracks, disabled", dark: false },
  { name: "Accent", hex: "#E7E4DD", use: "Hover fills", dark: false },
  { name: "Border", hex: "#DAD7D0", use: "Solid borders", dark: false },
  { name: "Text muted", hex: "#5E534A", use: "Body, captions", dark: true },
];

const WARM_SCALE: readonly { step: string; hex: string; dark: boolean }[] = [
  { step: "900", hex: "#080503", dark: true },
  { step: "700", hex: "#433830", dark: true },
  { step: "500", hex: "#7B6F66", dark: true },
  { step: "400", hex: "#A89C92", dark: false },
  { step: "200", hex: "#D3CCC7", dark: false },
];

const STATE_COLORS = [
  {
    name: "Fiber",
    badge: "Settled",
    hexes: ["#007654", "#00BA87", "#E0F9ED"],
    note: "Settled payments, live nodes, success. Bright is for dots and charts only.",
    tone: "fiber",
  },
  {
    name: "Pending",
    badge: "Held",
    hexes: ["#9A5B00", "#EFA831", "#FFF2D8"],
    note: "Quotes waiting, HTLCs held, anything in flight.",
    tone: "pending",
  },
  {
    name: "Error",
    badge: "Refunded",
    hexes: ["#E40014", "#E40014", "#FFEFEE"],
    note: "Failed legs and refunds. Use for icons and text 18 px or larger.",
    tone: "error",
  },
] as const;

const CONTRASTS = [
  { pair: "Ink on Paper", ratio: "19.4 : 1" },
  { pair: "Text muted on Paper", ratio: "7.1 : 1" },
  { pair: "Fiber on Fiber soft", ratio: "5.1 : 1" },
  { pair: "Pending on Pending soft", ratio: "4.9 : 1" },
] as const;

function SwatchCard({ swatch, large }: { swatch: Swatch; large: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-col justify-between p-5",
        large ? "min-h-[200px]" : "min-h-[120px]",
        swatch.dark ? "text-background" : "text-foreground",
        swatch.bordered && "border border-foreground/10",
      )}
      style={{ backgroundColor: swatch.hex }}
    >
      <span className="font-mono text-xs opacity-75">{swatch.use}</span>
      <span className="flex flex-col gap-1">
        <span className={cn("tracking-[-0.02em]", large ? "text-[30px]" : "text-xl")}>{swatch.name}</span>
        <span className="font-mono text-[13px]">{swatch.hex}</span>
      </span>
    </div>
  );
}

/** A state pill as the app shows it. Error text stays Ink: red on its soft tint is under 4.5 : 1. */
const STATE_PILL = {
  fiber: { pill: "bg-fiber-soft text-fiber", dot: "bg-fiber-bright" },
  pending: { pill: "bg-pending-soft text-pending", dot: "bg-pending-bright" },
  error: { pill: "bg-destructive-soft text-foreground", dot: "bg-destructive" },
} as const;

function StatePill({ tone, children }: { tone: keyof typeof STATE_PILL; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-2 px-2.5 py-1 rounded-full font-mono text-xs", STATE_PILL[tone].pill)}>
      <span className={cn("w-1.5 h-1.5 rounded-full", STATE_PILL[tone].dot)} aria-hidden="true" />
      {children}
    </span>
  );
}

function ColorSection() {
  return (
    <BrandSection id="color" tone="tint">
      <SectionHeader
        eyebrow={eyebrowFor("color")}
        title="Ink on paper. Color only for state."
        lead="Every surface is a warm neutral, taken straight from the product. Green, amber and red appear only when a payment is settled, held or refunded."
      />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-4">
        {CORE_SWATCHES.map((s) => (
          <SwatchCard key={s.name} swatch={s} large />
        ))}
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-4">
        {NEUTRAL_SWATCHES.map((s) => (
          <SwatchCard key={s.name} swatch={s} large={false} />
        ))}
      </div>
      <div className="flex flex-col gap-4">
        <Eyebrow>Warm scale — charts and illustration</Eyebrow>
        <div className="flex flex-wrap">
          {WARM_SCALE.map((w) => (
            <div
              key={w.step}
              className={cn(
                "flex-[1_1_120px] h-24 p-3.5 flex flex-col justify-between font-mono text-xs",
                w.dark ? "text-background" : "text-foreground",
              )}
              style={{ backgroundColor: w.hex }}
            >
              <span>Warm {w.step}</span>
              <span>{w.hex}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <Eyebrow>State colors — never decoration</Eyebrow>
        <div className="flex flex-wrap gap-4">
          {STATE_COLORS.map((state) => (
            <div key={state.name} className="flex-[1_1_300px] min-w-0 flex flex-col border border-foreground/10 bg-card">
              <div className="flex h-[72px]" aria-hidden="true">
                <div className="flex-[2]" style={{ backgroundColor: state.hexes[0] }} />
                <div className="flex-1" style={{ backgroundColor: state.hexes[1] }} />
                <div className="flex-1" style={{ backgroundColor: state.hexes[2] }} />
              </div>
              <div className="p-5 flex flex-col gap-3.5">
                <div className="flex justify-between items-center gap-3">
                  <span className="text-lg font-medium">{state.name}</span>
                  <StatePill tone={state.tone}>{state.badge}</StatePill>
                </div>
                <div className="font-mono text-xs leading-[1.7] text-muted-foreground">{state.hexes.join(" · ")}</div>
                <div className="text-[15px] leading-[1.55] text-muted-foreground">{state.note}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-x-8">
        {CONTRASTS.map((c) => (
          <div key={c.pair} className="flex justify-between gap-3 py-4 border-t border-foreground">
            <dt>{c.pair}</dt>
            <dd className="font-mono text-[13px]">{c.ratio}</dd>
          </div>
        ))}
      </dl>
    </BrandSection>
  );
}

const TYPE_SCALE: readonly { role: string; spec: string; sample: ReactNode }[] = [
  {
    role: "Display",
    spec: "96 / 0.92 · −2.5%",
    sample: <span className="font-display text-[clamp(3rem,6.6vw,6rem)] tracking-tight leading-[0.92]">Pay, get paid, swap.</span>,
  },
  {
    role: "Heading",
    spec: "60 / 1 · −2.5%",
    sample: (
      <span className="font-display text-[clamp(2rem,4.2vw,3.75rem)] tracking-tight leading-none">
        Lightning and CKB can’t pay each other.
      </span>
    ),
  },
  {
    role: "Figure",
    spec: "96 / 1 · −3%",
    sample: (
      <span className="font-display text-[clamp(3rem,6.6vw,6rem)] tracking-[-0.03em] leading-none tabular-nums">
        17,420 <span className="text-[0.42em] text-muted-foreground">nodes</span>
      </span>
    ),
  },
  { role: "Title", spec: "18 / 28 · Medium", sample: <span className="text-lg font-medium">Hash-locked by design</span> },
  {
    role: "Lead",
    spec: "24 / 39 · Text muted",
    sample: (
      <span className="text-[clamp(1.1875rem,1.7vw,1.5rem)] leading-relaxed text-muted-foreground">
        Each payment completes on both sides, or the payer is refunded.
      </span>
    ),
  },
  {
    role: "Body",
    spec: "16 / 26",
    sample: (
      <span className="leading-relaxed text-muted-foreground">
        CKBolt runs a Lightning node and a Fiber node, prices each route, and locks both sides to one SHA-256 hash.
      </span>
    ),
  },
  { role: "Label", spec: "Mono 14 / 20", sample: <Eyebrow>Problem and solution</Eyebrow> },
  {
    role: "Data",
    spec: "Mono 12 · caps",
    sample: (
      <span className="font-mono text-xs tracking-[0.02em] text-muted-foreground">
        REFERENCE PRICES · AFTER 1% ASSUMED HUB COSTS
      </span>
    ),
  },
];

function TypefaceCard({
  mono,
  weights,
  glyphs,
  name,
  use,
}: {
  mono: boolean;
  weights: ReactNode;
  glyphs: ReactNode;
  name: string;
  use: string;
}) {
  const family = mono ? "font-mono" : "font-sans";
  return (
    <div className="flex-[1_1_420px] min-w-0 p-8 flex flex-col gap-6 border border-foreground/10 bg-card">
      <div className="flex justify-between items-start gap-4">
        <span className={cn(family, "text-[120px] leading-[0.9] tracking-[-0.03em]")} aria-hidden="true">
          Aa
        </span>
        <span className="font-mono text-xs text-muted-foreground text-right">{weights}</span>
      </div>
      <div className={cn(family, "text-xl leading-normal break-all")}>{glyphs}</div>
      <div className="flex flex-col gap-1.5 pt-5 border-t border-foreground/10">
        <span className="text-xl">{name}</span>
        <span className="text-[15px] leading-[1.55] text-muted-foreground">{use}</span>
      </div>
    </div>
  );
}

function TypeSection() {
  return (
    <BrandSection id="type">
      <SectionHeader
        eyebrow={eyebrowFor("type")}
        title="A grotesk to speak. A mono to label."
        lead="Instrument Sans carries every sentence at Regular, with Medium only for titles. JetBrains Mono marks what a machine produced: labels, prices, hashes, routes."
      />
      <div className="flex flex-wrap gap-4">
        <TypefaceCard
          mono={false}
          weights={
            <>
              Regular 400
              <br />
              Medium 500
            </>
          }
          glyphs={
            <>
              ABCDEFGHIJKLMNOPQRSTUVWXYZ
              <br />
              abcdefghijklmnopqrstuvwxyz
              <br />
              0123456789 ₿ → , .
            </>
          }
          name="Instrument Sans"
          use="Headlines, body, buttons, the wordmark. Google Fonts, OFL."
        />
        <TypefaceCard
          mono
          weights="Regular 400"
          glyphs={
            <>
              ABCDEFGHIJKLMNOPQRSTUVWXYZ
              <br />
              abcdefghijklmnopqrstuvwxyz
              <br />
              0x3f…a9 · 1,371 sats
            </>
          }
          name="JetBrains Mono"
          use="Section labels, tags, figures in tables, invoices, hashes. Google Fonts, OFL."
        />
      </div>
      <dl className="border-b border-foreground/10">
        {TYPE_SCALE.map((row) => (
          <div key={row.role} className="flex flex-wrap items-baseline gap-x-10 gap-y-3 py-7 border-t border-foreground/10">
            <dt className="flex-[0_0_200px] flex flex-col gap-1">
              <span className="font-medium">{row.role}</span>
              <span className="font-mono text-xs text-muted-foreground">{row.spec}</span>
            </dt>
            <dd className="flex-[1_1_480px] min-w-0">{row.sample}</dd>
          </div>
        ))}
      </dl>
    </BrandSection>
  );
}

const PROCESS_STEPS = [
  { title: "Pick a route", text: "Lightning to CKB, CKB to Lightning, or a swap." },
  { title: "Get one quote", text: "Both legs priced together, fees shown up front." },
  { title: "Pay from your wallet", text: "Any Lightning wallet or Fiber node." },
  { title: "Pay out first, then settle", text: "The hub pays the far side, then claims with the same hash." },
] as const;

function InterfaceSection() {
  return (
    <BrandSection id="interface" tone="ink">
      <SectionHeader
        onInk
        eyebrow={eyebrowFor("interface")}
        title="Pills to act. Squares to label."
        lead="Buttons are fully round. Tags, cards and icon boxes stay square, outlined with a 10% ink hairline. Icons are 1.5 px line icons. One dark section per page carries the process."
      />
      <div className="flex flex-wrap gap-4">
        <div className="flex-[1_1_480px] min-w-0 p-6 sm:p-10 flex flex-col gap-8 bg-background text-foreground">
          <span className="font-mono text-xs text-muted-foreground">ON PAPER</span>
          <div className="flex flex-wrap gap-3">
            <PillLink href={APP_PAGE_PATH} size="md">
              Try the demo
            </PillLink>
            <SiteLink
              href="/#features"
              className="inline-flex items-center h-12 px-7 rounded-full border border-foreground/20 hover:bg-foreground/5 transition-colors"
            >
              See use cases
            </SiteLink>
          </div>
          <div className="flex flex-wrap gap-2">
            <BrandTag>Any Lightning wallet</BrandTag>
            <BrandTag>CKBolt hub</BrandTag>
            <BrandTag>Any Fiber node</BrandTag>
          </div>
          <div className="flex gap-4 p-6 border border-foreground/10 bg-card">
            <span className="w-10 h-10 shrink-0 border border-foreground/10 flex items-center justify-center" aria-hidden="true">
              <Zap className="w-[18px] h-[18px]" strokeWidth={1.5} />
            </span>
            <span className="flex flex-col gap-1">
              <span className="text-lg font-medium">Lightning users can’t reach CKB</span>
              <span className="text-[15px] leading-[1.55] text-muted-foreground">
                Thousands of nodes and wallets, but no direct way to pay a CKB merchant.
              </span>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatePill tone="fiber">Settled</StatePill>
            <StatePill tone="pending">Held</StatePill>
            <span className="inline-flex items-center gap-2 h-8 px-3 rounded-full border border-foreground/15 text-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-fiber-bright" aria-hidden="true" />
              Fiber node
            </span>
          </div>
        </div>
        <div className="flex-[1_1_480px] min-w-0 p-6 sm:p-10 flex flex-col gap-2 border border-background/10">
          <span className="font-mono text-xs text-background/60">ON INK</span>
          <ol>
            {PROCESS_STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-6 py-[22px] border-b border-background/10">
                <span className="font-mono text-[13px] text-background/55 pt-1">{sectionNumber(i)}</span>
                <span className="flex flex-col gap-1">
                  <span className="text-[22px] tracking-[-0.01em]">{step.title}</span>
                  <span className="text-[15px] leading-relaxed text-background/60">{step.text}</span>
                </span>
              </li>
            ))}
          </ol>
          <div className="pt-6">
            <PillLink href={APP_PAGE_PATH} variant="paper" size="md">
              Open the app
            </PillLink>
          </div>
        </div>
      </div>
    </BrandSection>
  );
}

const VOICE_PRINCIPLES = [
  { name: "Plain", text: "Say what happens to the money. One idea per sentence." },
  { name: "Exact", text: "Numbers carry units, sources and dates. “1,371 sats”, not “tiny fees”." },
  { name: "Checkable", text: "Say what works today and what doesn’t. Stage 3 of 6 is a feature, not a caveat." },
] as const;

const WRITE_AVOID = [
  {
    write: "Each payment completes on both sides, or the payer is refunded.",
    avoid: "Trustless, seamless, instant cross-chain magic.",
  },
  { write: "Live testnet demo, stage 3 of 6.", avoid: "Launching soon on mainnet!" },
  {
    write: "1,371 sats on Lightning for 1,000 CKB, after 1% assumed hub costs.",
    avoid: "Swap at the best rates in crypto.",
  },
] as const;

const NAME_SPELLINGS = [
  { text: "CKBolt", ok: true },
  { text: "CKBOLT", ok: false },
  { text: "CK Bolt", ok: false },
  { text: "CKbolt", ok: false },
  { text: "Lightning · Fiber Network · CKB", ok: true },
] as const;

function VoiceSection() {
  return (
    <BrandSection id="voice">
      <SectionHeader
        eyebrow={eyebrowFor("voice")}
        title="Plain, exact, checkable."
        lead="We write like the product works: precisely, with nothing hidden. No hype words, no exclamation marks, no promises about mainnet dates."
      />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-4">
        {VOICE_PRINCIPLES.map((p, i) => (
          <div key={p.name} className="p-7 flex flex-col gap-3 border border-foreground/10 bg-card">
            <span className="font-mono text-xs text-muted-foreground">{sectionNumber(i)}</span>
            <span className="text-[28px] tracking-[-0.02em]">{p.name}</span>
            <span className="leading-relaxed text-muted-foreground">{p.text}</span>
          </div>
        ))}
      </div>
      <table className="w-full border-t border-foreground text-left">
        <thead>
          <tr className="border-b border-foreground/10 font-mono text-xs text-muted-foreground">
            <th scope="col" className="py-3.5 pr-8 font-normal w-1/2">
              WRITE
            </th>
            <th scope="col" className="py-3.5 font-normal w-1/2">
              AVOID
            </th>
          </tr>
        </thead>
        <tbody>
          {WRITE_AVOID.map((row) => (
            <tr key={row.write} className="border-b border-foreground/10 align-top text-lg sm:text-xl leading-[1.45]">
              <td className="py-[22px] pr-8">{row.write}</td>
              <td className="py-[22px] text-muted-foreground line-through decoration-destructive/60">
                <span className="sr-only">Avoid: </span>
                {row.avoid}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="flex flex-wrap gap-2" aria-label="How to write the name">
        {NAME_SPELLINGS.map((s) => (
          <li
            key={s.text}
            className={cn(
              "inline-flex items-center gap-2.5 px-3.5 py-2 border border-foreground/10 bg-card",
              !s.ok && "text-muted-foreground",
            )}
          >
            <span className={cn("font-mono text-xs", s.ok ? "text-fiber" : "text-destructive")} aria-hidden="true">
              {s.ok ? "✓" : "✗"}
            </span>
            <span className="sr-only">{s.ok ? "Write: " : "Not: "}</span>
            {s.text}
          </li>
        ))}
      </ul>
    </BrandSection>
  );
}

const USAGE_LOGO = "w-[220px] h-auto";

const USAGE_CASES: readonly { ok: boolean; text: string; ground: "card" | "ink"; art: ReactNode }[] = [
  {
    ok: true,
    text: "Ink on Paper or white",
    ground: "card",
    // eslint-disable-next-line @next/next/no-img-element -- the kit's own file, as supplied
    art: <img src={logoSvgPath("ckbolt-logo")} alt="The CKBolt logo in Ink on white" className="w-[240px] h-auto" />,
  },
  {
    ok: true,
    text: "Paper on Ink",
    ground: "ink",
    // eslint-disable-next-line @next/next/no-img-element -- the kit's own file, as supplied
    art: <img src={logoSvgPath("ckbolt-logo-reversed")} alt="The CKBolt logo in Paper on Ink" className="w-[240px] h-auto" />,
  },
  {
    ok: false,
    text: "Recolor it, even in Fiber green",
    ground: "card",
    art: <BrandLockup title="The CKBolt logo recolored green" className={cn(USAGE_LOGO, "text-fiber-bright")} />,
  },
  {
    ok: false,
    text: "Stretch, squash or rotate",
    ground: "card",
    art: (
      <BrandLockup title="The CKBolt logo stretched wide" className={USAGE_LOGO} style={{ transform: "scaleX(1.4)" }} />
    ),
  },
  {
    ok: false,
    text: "Fade it below 4.5 : 1",
    ground: "card",
    art: <BrandLockup title="The CKBolt logo faded to a pale gray" className={cn(USAGE_LOGO, "text-[#D3CCC7]")} />,
  },
  {
    ok: false,
    text: "Retype the wordmark in another font",
    ground: "card",
    art: (
      <span role="img" aria-label="The CKBolt mark with the name retyped in a serif font" className="flex items-center gap-3">
        <BrandMark className="w-10 h-auto" />
        <span className="text-[40px] font-bold italic" style={{ fontFamily: "Georgia, serif" }} aria-hidden="true">
          CKBolt
        </span>
      </span>
    ),
  },
];

function UsageSection() {
  return (
    <BrandSection id="usage" tone="tint">
      <SectionHeader
        eyebrow={eyebrowFor("usage")}
        title="Room to breathe. Nothing added."
        lead="Use the files as supplied. If a background is busy, put the logo on a Paper or Ink panel instead of changing the logo."
      />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-4">
        {USAGE_CASES.map((u) => (
          <div key={u.text} className="flex flex-col border border-foreground/10 bg-card">
            <div
              className={cn(
                "h-[200px] flex items-center justify-center overflow-hidden",
                u.ground === "ink" ? "bg-foreground" : "bg-card",
              )}
            >
              {u.art}
            </div>
            <div className="flex gap-3 items-baseline px-5 py-4 border-t border-foreground/10">
              <span className={cn("font-mono text-xs", u.ok ? "text-fiber" : "text-destructive")}>
                {u.ok ? "DO" : "DON’T"}
              </span>
              <span>{u.text}</span>
            </div>
          </div>
        ))}
      </div>
    </BrandSection>
  );
}

function KitPanel() {
  const kitSize = fileSizeLabel(BRAND_KIT_ZIP.path);
  return (
    <section className="border-t border-foreground/10">
      <Container className="py-24 lg:py-32">
        <div
          className={cn(
            "border border-foreground/10 p-[clamp(2rem,6vw,5rem)] flex flex-wrap justify-between items-end gap-10",
            HATCH_BACKGROUND,
          )}
        >
          <div className="flex flex-col gap-6 max-w-[720px]">
            <Eyebrow>Brand kit</Eyebrow>
            <h2 className="text-4xl lg:text-6xl font-display tracking-tight leading-none">Every file, ready to drop in.</h2>
            <p className="max-w-[560px] text-lg leading-relaxed text-muted-foreground">
              Logos in SVG and PNG, favicons, app icons, share cards and color tokens. {BRAND_KIT_ZIP.fileCount} files,{" "}
              {kitSize}.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <PillLink href={BRAND_KIT_ZIP.path} download={fileNameOf(BRAND_KIT_ZIP.path)} srLabel={`, zip, ${kitSize}`}>
              Download everything
            </PillLink>
            <PillLink href={BRAND_KIT_PAGE_PATH} variant="outline">
              Open the brand kit
            </PillLink>
          </div>
        </div>
      </Container>
    </section>
  );
}
