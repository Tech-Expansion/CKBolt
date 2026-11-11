import { ICON_URL_RULE } from "../constants/assets.constants";

/** Characters of standard base64 (with padding), the only encoding an inline icon may use. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Why an inline SVG icon is refused, or null when it is a harmless SVG within the size cap. */
function svgDataUrlProblem(value: string): string | null {
  if (value.length > ICON_URL_RULE.MAX_DATA_URL_LENGTH) return `must be at most ${ICON_URL_RULE.MAX_DATA_URL_LENGTH} characters as a data URL`;
  const encoded = value.slice(ICON_URL_RULE.SVG_DATA_URL_PREFIX.length);
  if (encoded.length === 0 || !BASE64.test(encoded)) return "must carry the SVG as base64 after the comma";
  const svg = Buffer.from(encoded, "base64").toString("utf8");
  if (!ICON_URL_RULE.SVG_START.test(svg)) return "must be an SVG image (<svg ...>)";
  if (ICON_URL_RULE.SVG_FORBIDDEN.test(svg)) return "must be a plain SVG: no scripts, event handlers, embedded documents or outside references";
  return null;
}

/** Why an https icon URL is refused, or null when it is a plain https URL within the length cap. */
function httpsUrlProblem(value: string): string | null {
  if (value.length > ICON_URL_RULE.MAX_URL_LENGTH) return `must be at most ${ICON_URL_RULE.MAX_URL_LENGTH} characters`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an https URL or an SVG data URL";
  }
  if (url.protocol !== ICON_URL_RULE.HTTPS_PROTOCOL) return `must use https or be an inline SVG (${ICON_URL_RULE.SVG_DATA_URL_PREFIX}...)`;
  if (url.username || url.password) return "must not carry a user name or password";
  return null;
}

/**
 * Why an asset's icon URL (FIBER_ASSETS `iconUrl`) is refused, or null when it is usable: an https URL, or an inline SVG
 * as a base64 data URL under the size cap with nothing active in it (ICON_URL_RULE).
 */
export const iconUrlProblem = (value: string): string | null =>
  value.startsWith(ICON_URL_RULE.SVG_DATA_URL_PREFIX) ? svgDataUrlProblem(value) : httpsUrlProblem(value);
