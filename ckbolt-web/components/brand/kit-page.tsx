import { ArrowUpRight } from "lucide-react";
import {
  BRAND_ICONS_ZIP,
  BRAND_KIT_FORMATS,
  BRAND_KIT_VERSION,
  BRAND_CONTACT_EMAIL,
  BRAND_KIT_ZIP,
  BRAND_LOGOS_ZIP,
  BRAND_PAGE_PATH,
  ICON_FILES,
  ICON_HEAD_SNIPPET,
  LOGO_FILES,
  SOCIAL_CARDS,
  TOKEN_FILES,
  brandKitUpdatedLabel,
  fileNameOf,
  logoPngPath,
  logoSvgPath,
  type LogoFit,
} from "@/lib/brand/kit";
import { fileSizeLabel, publicText } from "@/lib/brand/file-size";
import { cn } from "@/lib/utils";
import {
  BrandLead,
  BrandSection,
  BrandTitle,
  Container,
  DownloadChip,
  Eyebrow,
  PillLink,
  SectionHeader,
} from "./ui";

/**
 * The brand kit (/brand-assets): every file of the kit with its own download, the three zips, the icons' <head> lines
 * and the design tokens, from the brand kit v1.0 design. Sizes come from the served files.
 */

const CONTENTS = [
  { id: "logos", name: "Logos", note: `${LOGO_FILES.length} SVG + ${LOGO_FILES.length} PNG` },
  { id: "icons", name: "Icons", note: "Favicon, app, PWA" },
  { id: "social", name: "Share cards", note: "1200 × 630" },
  { id: "tokens", name: "Tokens", note: "CSS + JSON" },
] as const;

export function BrandKitPage() {
  return (
    <>
      <Hero />
      <KitContents />
      <LogosSection />
      <IconsSection />
      <SocialSection />
      <TokensSection />
      <TermsSection />
    </>
  );
}

function Hero() {
  const kitSize = fileSizeLabel(BRAND_KIT_ZIP.path);
  return (
    <Container className="pt-32 lg:pt-40 pb-24 flex flex-col gap-8">
      <Eyebrow>Brand kit · {BRAND_KIT_VERSION}</Eyebrow>
      <BrandTitle>
        Every file.
        <br />
        One download.
      </BrandTitle>
      <BrandLead className="max-w-[680px]">
        Logos, icons, share cards and design tokens for CKBolt. Vector first, PNG where you need pixels.
      </BrandLead>
      <div className="flex flex-wrap gap-3">
        <PillLink href={BRAND_KIT_ZIP.path} download={fileNameOf(BRAND_KIT_ZIP.path)} srLabel={`, zip, ${kitSize}`}>
          Download everything
        </PillLink>
        <PillLink href={BRAND_PAGE_PATH} variant="outline">
          Read the guidelines
        </PillLink>
      </div>
      <p className="flex flex-wrap gap-x-6 gap-y-2 font-mono text-[13px] text-muted-foreground">
        <span>{BRAND_KIT_VERSION}</span>
        <span>Updated {brandKitUpdatedLabel()}</span>
        <span>
          {BRAND_KIT_ZIP.fileCount} files · {kitSize}
        </span>
        <span>{BRAND_KIT_FORMATS.join(" · ")}</span>
      </p>
    </Container>
  );
}

function KitContents() {
  return (
    <nav aria-label="Kit contents" className="border-y border-foreground/10">
      <Container className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
        {CONTENTS.map((c) => (
          <a
            key={c.id}
            href={`#${c.id}`}
            className="flex justify-between items-baseline gap-3 py-6 pr-6 text-foreground hover:text-muted-foreground transition-colors"
          >
            <span className="text-lg">{c.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{c.note}</span>
          </a>
        ))}
      </Container>
    </nav>
  );
}

const ROW_PREVIEW_SIZE: Readonly<Record<LogoFit, string>> = {
  wide: "w-[86%] h-auto",
  stacked: "h-[84%] w-auto",
  mark: "h-[76%] w-auto",
  wordmark: "w-[80%] h-auto",
};

function LogosSection() {
  return (
    <BrandSection id="logos" className="gap-12">
      <SectionHeader
        eyebrow="01 — Logos"
        title="Logos"
        action={
          <PillLink href={BRAND_LOGOS_ZIP} download={fileNameOf(BRAND_LOGOS_ZIP)} variant="outline" size="md" srLabel=", zip">
            All logos · {fileSizeLabel(BRAND_LOGOS_ZIP)}
          </PillLink>
        }
      />
      <div>
        <ul className="border-t border-foreground">
          {LOGO_FILES.map((logo) => (
            <li
              key={logo.id}
              className="flex flex-wrap items-center gap-x-8 gap-y-4 py-5 border-b border-foreground/10"
            >
              <div
                className={cn(
                  "w-44 h-[88px] shrink-0 flex items-center justify-center border border-foreground/10",
                  logo.reversed ? "bg-foreground" : "bg-card",
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- the kit's own file, as supplied */}
                <img src={logoSvgPath(logo.id)} alt="" className={ROW_PREVIEW_SIZE[logo.fit]} />
              </div>
              <div className="flex-[1_1_240px] min-w-0 flex flex-col gap-1">
                <span className="text-lg font-medium">{logo.name}</span>
                <span className="text-[15px] text-muted-foreground">{logo.use}</span>
              </div>
              <span className="flex-[1_1_200px] font-mono text-[13px] text-muted-foreground">{logo.id}</span>
              <div className="flex flex-wrap gap-2">
                <DownloadChip
                  href={logoSvgPath(logo.id)}
                  label={`SVG · ${fileSizeLabel(logoSvgPath(logo.id))}`}
                  fileName={fileNameOf(logoSvgPath(logo.id))}
                />
                <DownloadChip
                  href={logoPngPath(logo.id)}
                  label={`PNG · ${logo.pngWidth} px`}
                  fileName={fileNameOf(logoPngPath(logo.id))}
                />
              </div>
            </li>
          ))}
        </ul>
        <p className="pt-6 text-sm text-muted-foreground">
          PNGs have transparent backgrounds. The wordmark is outlined, so no font install is needed.
        </p>
      </div>
    </BrandSection>
  );
}

function IconsSection() {
  return (
    <BrandSection id="icons" tone="tint" className="gap-12">
      <SectionHeader
        eyebrow="02 — Icons"
        title="Favicons and app icons"
        action={
          <PillLink href={BRAND_ICONS_ZIP} download={fileNameOf(BRAND_ICONS_ZIP)} variant="outline" size="md" srLabel=", zip">
            All icons · {fileSizeLabel(BRAND_ICONS_ZIP)}
          </PillLink>
        }
      />
      <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-4">
        {ICON_FILES.map((icon) => (
          <li key={icon.path} className="flex flex-col border border-foreground/10 bg-card">
            <div className="h-40 flex items-center justify-center bg-secondary">
              {/* eslint-disable-next-line @next/next/no-img-element -- the kit's own file, as supplied */}
              <img src={icon.path} alt="" width={icon.previewPx} height={icon.previewPx} />
            </div>
            <div className="flex flex-col gap-2.5 px-[18px] py-4 border-t border-foreground/10">
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">{icon.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{icon.spec}</span>
              </div>
              <div>
                <DownloadChip
                  href={icon.path}
                  label={`${icon.format} · ${fileSizeLabel(icon.path)}`}
                  fileName={fileNameOf(icon.path)}
                />
              </div>
            </div>
          </li>
        ))}
      </ul>
      <div className="border border-foreground/10 bg-card">
        <div className="flex justify-between gap-4 px-5 py-3 border-b border-foreground/10 font-mono text-xs text-muted-foreground">
          <span>head.html</span>
          <span>paste into &lt;head&gt;</span>
        </div>
        <pre
          role="region"
          tabIndex={0}
          aria-label="Icon lines for a page's head"
          className="m-0 p-5 overflow-x-auto font-mono text-sm leading-[1.7] text-foreground"
        >
          {ICON_HEAD_SNIPPET}
        </pre>
      </div>
    </BrandSection>
  );
}

function SocialSection() {
  return (
    <BrandSection id="social" className="gap-12">
      <SectionHeader
        eyebrow="03 — Share cards"
        title="Share cards"
        lead="Open Graph and X cards at 1200 × 630. Set as og:image and twitter:image; the light card matches the site."
      />
      <div className="flex flex-wrap gap-4">
        {SOCIAL_CARDS.map((card) => (
          <div key={card.name} className="flex-[1_1_440px] min-w-0 flex flex-col border border-foreground/10 bg-card">
            {/* eslint-disable-next-line @next/next/no-img-element -- the kit's own file, as supplied */}
            <img src={card.png} alt={card.alt} width={1200} height={630} className="block w-full h-auto" />
            <div className="flex flex-wrap justify-between items-center gap-3 px-5 py-4 border-t border-foreground/10">
              <span className="font-medium">{card.name}</span>
              <span className="flex gap-2">
                <DownloadChip href={card.png} label={`PNG · ${fileSizeLabel(card.png)}`} fileName={fileNameOf(card.png)} />
                <DownloadChip href={card.svg} label="SVG" fileName={fileNameOf(card.svg)} />
              </span>
            </div>
          </div>
        ))}
      </div>
    </BrandSection>
  );
}

const FONT_LINKS = [
  { name: "Instrument Sans", href: "https://fonts.google.com/specimen/Instrument+Sans" },
  { name: "JetBrains Mono", href: "https://fonts.google.com/specimen/JetBrains+Mono" },
] as const;

function TokensSection() {
  const css = publicText(TOKEN_FILES.css).trimEnd();
  return (
    <section id="tokens" className="scroll-mt-24 bg-foreground text-background">
      <Container className="py-24 lg:py-32 flex flex-wrap gap-14">
        <div className="flex-[1_1_380px] min-w-0 flex flex-col gap-6">
          <Eyebrow onInk>04 — Tokens</Eyebrow>
          <h2 className="text-4xl lg:text-6xl font-display tracking-tight leading-none">Design tokens</h2>
          <p className="max-w-[460px] text-lg leading-relaxed text-background/60">
            The same values the site runs on: neutrals, the warm scale, state colors, type and radius. Drop the CSS into
            any project, or feed the JSON to your design tool.
          </p>
          <div className="flex flex-wrap gap-3">
            <PillLink href={TOKEN_FILES.css} download={fileNameOf(TOKEN_FILES.css)} variant="paper" size="md">
              {fileNameOf(TOKEN_FILES.css)}
            </PillLink>
            <PillLink href={TOKEN_FILES.json} download={fileNameOf(TOKEN_FILES.json)} variant="outline-on-ink" size="md">
              {fileNameOf(TOKEN_FILES.json)}
            </PillLink>
          </div>
          <div className="flex flex-col gap-2.5 pt-4 text-[15px] text-background/60">
            <span>Fonts are free on Google Fonts:</span>
            {FONT_LINKS.map((font) => (
              <a
                key={font.name}
                href={font.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-background underline underline-offset-4 w-fit"
              >
                {font.name}
                <ArrowUpRight className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden="true" />
              </a>
            ))}
          </div>
        </div>
        <div className="flex-[1_1_520px] min-w-0 border border-background/10">
          <div className="flex justify-between px-5 py-3 border-b border-background/10 font-mono text-xs text-background/55">
            <span>{fileNameOf(TOKEN_FILES.css)}</span>
            <span>{fileSizeLabel(TOKEN_FILES.css)}</span>
          </div>
          <pre
            role="region"
            tabIndex={0}
            aria-label="The design tokens as CSS variables"
            className="m-0 p-5 overflow-x-auto font-mono text-[13px] leading-[1.75] text-background/85"
          >
            {css}
          </pre>
        </div>
      </Container>
    </section>
  );
}

const MAY = [
  "Link to CKBolt or show that your wallet, shop or app supports it",
  "Write, present or teach about CKBolt",
  "Use the files exactly as supplied",
] as const;

const MAY_NOT = [
  "Suggest TEX Labs partners with, endorses or audits you",
  "Put the mark inside your own logo or product name",
  "Edit, recolor or redraw the logo",
] as const;

function TermsList({ ok, title, items }: { ok: boolean; title: string; items: readonly string[] }) {
  return (
    <div className="flex-[1_1_420px] min-w-0 border-t border-foreground">
      <h3 className={cn("py-3.5 font-mono text-xs border-b border-foreground/10", ok ? "text-fiber" : "text-destructive")}>
        {title}
      </h3>
      <ul>
        {items.map((item) => (
          <li key={item} className="flex gap-3.5 py-4 border-b border-foreground/10">
            <span className={cn("font-mono text-xs pt-1", ok ? "text-fiber" : "text-destructive")} aria-hidden="true">
              {ok ? "✓" : "✗"}
            </span>
            <span className="text-[17px] leading-normal">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TermsSection() {
  return (
    <BrandSection id="terms" className="gap-12">
      <SectionHeader
        eyebrow="05 — Using the brand"
        title="Fair use, plainly."
        lead={
          <>
            The kit is here so people can talk about CKBolt accurately. For anything beyond the list below, ask first:{" "}
            <a href={`mailto:${BRAND_CONTACT_EMAIL}`} className="text-foreground underline underline-offset-4">
              {BRAND_CONTACT_EMAIL}
            </a>
            .
          </>
        }
      />
      <div className="flex flex-wrap gap-8">
        <TermsList ok title="YOU CAN" items={MAY} />
        <TermsList ok={false} title="PLEASE DON’T" items={MAY_NOT} />
      </div>
    </BrandSection>
  );
}
