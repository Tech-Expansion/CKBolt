export type DecimalMark = "." | ",";

/** The decimal mark of the browser's locale ("," in Vietnamese or German, "." in English). */
export function localeDecimalMark(): DecimalMark {
  try {
    return new Intl.NumberFormat().formatToParts(1.5).find((p) => p.type === "decimal")?.value === "," ? "," : ".";
  } catch {
    return ".";
  }
}

/**
 * Reads an amount typed by a person, in either convention: "1,234.5" or "1.234,5",
 * and a decimal comma ("5,5", "0,001"). The one ambiguous shape, a single separator
 * followed by exactly three digits after a non-zero lead ("1,250" or "1.250"), is
 * read with the locale's decimal mark: 1.25 where "," is the decimal mark, 1250
 * where "." is. Callers should show the value as read. Returns null for empty or
 * malformed text, such as mixed groupings ("1,5.3").
 */
export function parseAmountInput(raw: string, decimalMark: DecimalMark = "."): number | null {
  const normalized = normalizeAmountInput(raw, decimalMark);
  if (normalized === null) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * The amount a person typed (read as parseAmountInput reads it) as a plain decimal string with "." as its mark and no
 * grouping, such as "1234.5"; null for empty or malformed text. Exact, for amounts that must not pass through a float.
 */
export function normalizeAmountInput(raw: string, decimalMark: DecimalMark = "."): string | null {
  const s = raw.trim().replace(/[\s_']/g, "");
  if (!s) return null;
  if (!/^[\d.,]+$/.test(s)) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: the last one is the decimal mark, the other must group thousands.
    const decimalIsComma = lastComma > lastDot;
    const intPart = s.slice(0, decimalIsComma ? lastComma : lastDot);
    const fracPart = s.slice((decimalIsComma ? lastComma : lastDot) + 1);
    const grouping = decimalIsComma ? /^(0|[1-9]\d{0,2}(\.\d{3})*)$/ : /^(0|[1-9]\d{0,2}(,\d{3})*)$/;
    if (!grouping.test(intPart) || !/^\d+$/.test(fracPart)) return null;
    normalized = `${intPart.replace(/[.,]/g, "")}.${fracPart}`;
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const count = s.split(sep).length - 1;
    const groups = sep === "." ? /^[1-9]\d{0,2}(\.\d{3})+$/ : /^[1-9]\d{0,2}(,\d{3})+$/;
    if (count > 1) {
      // "1.234.567" or "1,234,567": only valid as thousands groups.
      if (!groups.test(s)) return null;
      normalized = s.split(sep).join("");
    } else if (groups.test(s)) {
      // "1,250" / "1.250": thousands unless the locale writes decimals with this mark.
      normalized = sep === decimalMark ? s.replace(sep, ".") : s.replace(sep, "");
    } else {
      normalized = s.replace(sep, ".");
    }
  } else {
    normalized = s;
  }
  if (!/^\d*\.?\d*$/.test(normalized) || normalized === ".") return null;
  return normalized;
}

/** Whole satoshis. Separators can only group thousands here ("50,000", "50.000", "50 000"). */
export function parseSatsInput(raw: string): number | null {
  const s = raw.trim().replace(/[\s_']/g, "");
  if (/^\d+$/.test(s)) return Number(s);
  if (/^[1-9]\d{0,2}(,\d{3})+$/.test(s) || /^[1-9]\d{0,2}(\.\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ""));
  return null;
}

/** Base units (1e-8 for CKB) as an exact decimal string, without exponent notation. */
export function formatBaseUnits(units: bigint, decimals = 8): string {
  const neg = units < BigInt(0);
  const s = (neg ? -units : units).toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

/** Largest amounts the prototype will quote, to keep numbers and invoices well formed. */
export const LIMITS = {
  maxTokenAmount: 1e12,
  maxSats: 2_100_000_000_000_000,
  maxUsd: 1e9,
};
