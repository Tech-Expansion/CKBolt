/**
 * The brand kit (v1.0) that /brand and /brand-assets present: every file sits under public/brand/ exactly as the kit
 * supplies it, and the three zips are the kit's own downloads. Sizes are read from the files when a page builds
 * (`fileSizeLabel`, lib/brand/file-size.ts), so they cannot drift from what is served.
 */

export const BRAND_PAGE_PATH = "/brand";
export const BRAND_KIT_PAGE_PATH = "/brand-assets";
/** Where the kit page was first published; it redirects to BRAND_KIT_PAGE_PATH (next.config.mjs). */
export const BRAND_KIT_OLD_PATH = "/brand/kit";

export const BRAND_KIT_VERSION = "v1.0";
/** When the kit's files last changed (ISO date). */
export const BRAND_KIT_UPDATED = "2026-11-18";

/** Where the kit's files are served, under public/. */
export const BRAND_FILES_PATH = "/brand";

export const BRAND_KIT_ZIP = { path: `${BRAND_FILES_PATH}/ckbolt-brand-kit.zip`, fileCount: 36 } as const;
export const BRAND_LOGOS_ZIP = `${BRAND_FILES_PATH}/ckbolt-logos.zip`;
export const BRAND_ICONS_ZIP = `${BRAND_FILES_PATH}/ckbolt-icons.zip`;

/** The file kinds the kit holds, as the kit page lists them. */
export const BRAND_KIT_FORMATS = ["SVG", "PNG", "ICO", "JSON", "CSS"] as const;

const LOGO_SVG = `${BRAND_FILES_PATH}/logo/svg`;
const LOGO_PNG = `${BRAND_FILES_PATH}/logo/png`;
const ICONS = `${BRAND_FILES_PATH}/icons`;
const SOCIAL = `${BRAND_FILES_PATH}/social`;
const TOKENS = `${BRAND_FILES_PATH}/tokens`;

/** How a logo preview is sized in its box: by width (lockups, wordmarks) or by height (stacked lockups, marks). */
export type LogoFit = "wide" | "stacked" | "mark" | "wordmark";

export interface LogoFile {
  /** The kit's file name without its extension. */
  id: string;
  name: string;
  use: string;
  /** Drawn for Ink: shown on an Ink box. */
  reversed: boolean;
  fit: LogoFit;
  /** The PNG's width in pixels (every logo has a PNG). */
  pngWidth: number;
}

export const LOGO_FILES: readonly LogoFile[] = [
  { id: "ckbolt-logo", name: "Primary", use: "Horizontal lockup, Ink", reversed: false, fit: "wide", pngWidth: 2400 },
  { id: "ckbolt-logo-reversed", name: "Primary, reversed", use: "For Ink and dark photos", reversed: true, fit: "wide", pngWidth: 2400 },
  { id: "ckbolt-logo-stacked", name: "Stacked", use: "Square and narrow spaces", reversed: false, fit: "stacked", pngWidth: 1200 },
  { id: "ckbolt-logo-stacked-reversed", name: "Stacked, reversed", use: "Square spaces on Ink", reversed: true, fit: "stacked", pngWidth: 1200 },
  { id: "ckbolt-mark", name: "Mark", use: "Avatars, small spaces", reversed: false, fit: "mark", pngWidth: 1024 },
  { id: "ckbolt-mark-reversed", name: "Mark, reversed", use: "Avatars on Ink", reversed: true, fit: "mark", pngWidth: 1024 },
  { id: "ckbolt-mark-line", name: "Line mark", use: "Diagrams, line-icon sets", reversed: false, fit: "mark", pngWidth: 1024 },
  { id: "ckbolt-wordmark", name: "Wordmark", use: "Text-only placements", reversed: false, fit: "wordmark", pngWidth: 2000 },
  { id: "ckbolt-wordmark-reversed", name: "Wordmark, reversed", use: "Text-only on Ink", reversed: true, fit: "wordmark", pngWidth: 2000 },
];

export const logoSvgPath = (id: string) => `${LOGO_SVG}/${id}.svg`;
export const logoPngPath = (id: string) => `${LOGO_PNG}/${id}.png`;

/** The logos the guidelines show as cards, with the box each sits on. Line mark has no PNG there, as in the kit. */
export const GUIDE_LOGOS: readonly { id: string; label: string; ground: "card" | "ink" | "secondary"; png: boolean }[] = [
  { id: "ckbolt-logo", label: "Primary", ground: "card", png: true },
  { id: "ckbolt-logo-reversed", label: "Reversed", ground: "ink", png: true },
  { id: "ckbolt-logo-stacked", label: "Stacked", ground: "card", png: true },
  { id: "ckbolt-mark", label: "Mark", ground: "secondary", png: true },
  { id: "ckbolt-mark-line", label: "Line mark", ground: "card", png: false },
  { id: "ckbolt-wordmark", label: "Wordmark", ground: "card", png: true },
];

export interface IconFile {
  path: string;
  name: string;
  /** What the file is, in the kit's words ("SVG · 64"). */
  spec: string;
  format: "SVG" | "ICO" | "PNG";
  /** The preview's size in CSS pixels. */
  previewPx: number;
}

export const ICON_FILES: readonly IconFile[] = [
  { path: `${ICONS}/favicon.svg`, name: "Favicon", spec: "SVG · 64", format: "SVG", previewPx: 32 },
  { path: `${ICONS}/favicon.ico`, name: "Favicon", spec: "ICO · 16, 32, 48", format: "ICO", previewPx: 32 },
  { path: `${ICONS}/favicon-32.png`, name: "Favicon", spec: "PNG · 32 px", format: "PNG", previewPx: 32 },
  { path: `${ICONS}/apple-touch-icon.png`, name: "Apple touch icon", spec: "PNG · 180 px", format: "PNG", previewPx: 60 },
  { path: `${ICONS}/icon-192.png`, name: "PWA icon", spec: "PNG · 192 px", format: "PNG", previewPx: 64 },
  { path: `${ICONS}/icon-512.png`, name: "PWA icon", spec: "PNG · 512 px", format: "PNG", previewPx: 80 },
  { path: `${ICONS}/ckbolt-app-icon.png`, name: "App icon, dark", spec: "PNG · 1024 px", format: "PNG", previewPx: 96 },
  { path: `${ICONS}/ckbolt-app-icon-light.png`, name: "App icon, light", spec: "PNG · 1024 px", format: "PNG", previewPx: 96 },
];

/** What another site pastes into its <head> to use the icons (the kit's head.html). */
export const ICON_HEAD_SNIPPET = [
  '<link rel="icon" href="/favicon.ico" sizes="any">',
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
  '<meta name="theme-color" content="#FAFAF9">',
].join("\n");

export const SOCIAL_CARDS: readonly { name: string; png: string; svg: string; alt: string }[] = [
  { name: "Light", png: `${SOCIAL}/ckbolt-social-card.png`, svg: `${SOCIAL}/ckbolt-social-card.svg`, alt: "CKBolt share card, light" },
  { name: "Dark", png: `${SOCIAL}/ckbolt-social-card-dark.png`, svg: `${SOCIAL}/ckbolt-social-card-dark.svg`, alt: "CKBolt share card, dark" },
];

export const TOKEN_FILES = {
  css: `${TOKENS}/ckbolt-tokens.css`,
  json: `${TOKENS}/ckbolt-tokens.json`,
} as const;

/** Where to ask about any use the kit's fair-use list does not cover (TEX Labs' contact address on texlabs.org). */
export const BRAND_CONTACT_EMAIL = "contact@texlabs.org";

/** A path's file name, which a download keeps. */
export const fileNameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The kit's date as the page shows it ("Nov 18, 2026"). */
export function brandKitUpdatedLabel(): string {
  return new Date(`${BRAND_KIT_UPDATED}T00:00:00Z`).toLocaleDateString("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  });
}
