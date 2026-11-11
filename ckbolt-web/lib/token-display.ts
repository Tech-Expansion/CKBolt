import type { AssetDto } from "./hub/contract";
import type { Token } from "./tokens";

/**
 * How a token is shown: the name and icon the hub's operator set for it (GET /v1/assets `displayName` and `iconUrl`,
 * the hub's FIBER_ASSETS), else the app's own (lib/tokens.ts), else the hub's name or symbol and the symbol's initials.
 * So a token the hub adds shows with its own name and icon and no web change. The hub checks both fields; the page
 * checks them again here before using them, and shows an icon only as an image (`<img src>`, components/app/token-icon.tsx),
 * never by inlining its markup.
 */

/**
 * What an icon URL may be, as the hub's ICON_URL_RULE (ckbolt-hub `src/common/constants/assets.constants.ts`, compared
 * in tests/unit/token-display.spec.ts): an https URL, or a small inline SVG as a base64 data URL. An inline SVG needs no
 * request, so it also shows on the cross-origin isolated node page (COEP require-corp), which blocks images from hosts
 * that send no Cross-Origin-Resource-Policy header; such an icon falls back to the next one.
 */
export const ICON_URL_RULE = {
  HTTPS_PROTOCOL: "https:",
  MAX_URL_LENGTH: 2_048,
  SVG_DATA_URL_PREFIX: "data:image/svg+xml;base64,",
  MAX_DATA_URL_LENGTH: 8_192,
  SVG_START: /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i,
  /**
   * What an inline SVG must not contain (the hub's deny-list). A browser runs none of it in an <img>, which is how the
   * page shows it; this is defence in depth, not a sanitizer.
   */
  SVG_FORBIDDEN:
    /<script|<foreignObject|<iframe|<embed|<object|<a[\s>]|<set[\s>]|<animate|<!DOCTYPE|<!ENTITY|&#|\bon[a-z]+\s*=|javascript:|(?<![\w-])(?:xlink:)?href\s*=(?!\s*["']?\s*#)|url\((?!\s*["']?\s*#)|@import/i,
} as const;

/** The longest display name the hub takes (its ASSET_DISPLAY_NAME_MAX_LENGTH). */
export const DISPLAY_NAME_MAX_LENGTH = 64;

/** Standard base64, padded or not: the only encoding an inline icon may use. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Control characters, and the bidirectional overrides and isolates that could make a name read as another. */
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
const WHITESPACE = /\s/;

function decodeBase64(encoded: string): string | null {
  try {
    return atob(encoded);
  } catch {
    return null;
  }
}

/** An inline SVG icon within the size cap that decodes to a plain SVG, or null. */
function safeSvgDataUrl(value: string): string | null {
  if (value.length > ICON_URL_RULE.MAX_DATA_URL_LENGTH) return null;
  const encoded = value.slice(ICON_URL_RULE.SVG_DATA_URL_PREFIX.length);
  if (!BASE64.test(encoded)) return null;
  const svg = decodeBase64(encoded);
  if (svg === null || !ICON_URL_RULE.SVG_START.test(svg) || ICON_URL_RULE.SVG_FORBIDDEN.test(svg)) return null;
  return value;
}

/** A plain https URL within the length cap (no user name or password, no spaces), or null. */
function safeHttpsUrl(value: string): string | null {
  if (value.length > ICON_URL_RULE.MAX_URL_LENGTH || WHITESPACE.test(value) || UNSAFE_CHARACTERS.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== ICON_URL_RULE.HTTPS_PROTOCOL || url.username || url.password) return null;
  return url.href;
}

/**
 * The hub's icon URL when the page may use it: an https URL of at most 2,048 characters, or an inline SVG
 * (`data:image/svg+xml;base64,...`) of at most 8,192 that decodes to a plain SVG. Anything else (another scheme, another
 * data type, too long, unreadable) is null, and the token shows the app's icon or its initials instead.
 */
export function safeIconUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.startsWith(ICON_URL_RULE.SVG_DATA_URL_PREFIX) ? safeSvgDataUrl(value) : safeHttpsUrl(value);
}

/** The hub's display name when the page may show it: 1 to 64 characters once trimmed, none of them a control or bidi override. */
export function safeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length > 0 && name.length <= DISPLAY_NAME_MAX_LENGTH && !UNSAFE_CHARACTERS.test(name) ? name : null;
}

/** How a token looks wherever the app names it beside its symbol. */
export interface TokenLook {
  symbol: string;
  /** The hub's display name, else the app's name for a token it knows, else the hub's name, else the symbol. */
  name: string;
  /** Icons to try in order (the hub's, then the app's own); when none loads, the symbol's initials show. */
  icons: string[];
}

const sameSymbol = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The app's token of that symbol, if it knows one. */
export const knownToken = (symbol: string, known: readonly Token[]): Token | undefined => known.find((t) => sameSymbol(t.symbol, symbol));

/** The icons of a token to try in order: the hub's (already checked), then the app's own. */
export const tokenIcons = (token: Pick<Token, "icon" | "iconUrl">): string[] => [token.iconUrl, token.icon].filter((src): src is string => !!src);

/**
 * How the hub's asset looks: its display name and icon when the hub set them (checked again here), else the app's
 * token of the same symbol, else the hub's name and the initials. `asset` undefined (the hub has not listed it yet):
 * the app's token, else the symbol alone.
 */
export function tokenLook(
  symbol: string,
  asset: Pick<AssetDto, "name" | "displayName" | "iconUrl"> | undefined,
  known: readonly Token[],
): TokenLook {
  const app = knownToken(symbol, known);
  const hubName = typeof asset?.name === "string" ? asset.name.trim() : "";
  const name = safeDisplayName(asset?.displayName) ?? app?.name ?? (hubName || symbol);
  return { symbol, name, icons: tokenIcons({ iconUrl: safeIconUrl(asset?.iconUrl) ?? undefined, icon: app?.icon }) };
}
