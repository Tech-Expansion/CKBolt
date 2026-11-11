import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import { expect, test } from "@playwright/test";
import { HISTORY_COPY } from "../../components/app/fiber-node/copy";
import { tokenForAsset } from "../../lib/hub/assets";
import type { AssetDto } from "../../lib/hub/contract";
import { DISPLAY_NAME_MAX_LENGTH, ICON_URL_RULE, safeDisplayName, safeIconUrl, tokenIcons, tokenLook } from "../../lib/token-display";
import { PAY_TOKENS } from "../../lib/tokens";

/*
 * Names and icons from the hub (GET /v1/assets `displayName` and `iconUrl`, the hub's FIBER_ASSETS): checked again in the
 * page before use (https or an inline SVG only, the hub's length caps, a plain SVG), and the fallbacks: the app's name and
 * icon for a token it knows (lib/tokens.ts), then the hub's name or the symbol and the initials.
 */

const svg = (markup: string) => `${ICON_URL_RULE.SVG_DATA_URL_PREFIX}${Buffer.from(markup, "utf8").toString("base64")}`;
/** cWBTC's icon as docs/add-token.md configures it on testnet-vps: an orange disc with a white B. */
const CWBTC_ICON = svg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#f7931a"/><path d="M11 8h7a4 4 0 0 1 0 8h-7zm0 8h8a4 4 0 0 1 0 8h-8z" fill="none" stroke="#fff" stroke-width="2.5"/></svg>',
);

const asset = (overrides: Partial<AssetDto> = {}): AssetDto => ({
  id: "CWBTC",
  symbol: "cWBTC",
  name: "CCH Wrapped BTC",
  displayName: null,
  iconUrl: null,
  decimals: 8,
  directions: ["ln_to_fiber", "fiber_to_ln"],
  minSats: "1000",
  maxSats: "100000",
  liquidity: { lightningSats: "5000000", fiberAmount: "100000000000000" },
  ...overrides,
});

test.describe("the hub's icon URL, checked again in the page", () => {
  test("an https URL or a plain inline SVG passes; the SVG keeps its exact text", () => {
    expect(CWBTC_ICON.length).toBeLessThanOrEqual(ICON_URL_RULE.MAX_DATA_URL_LENGTH);
    expect(safeIconUrl(CWBTC_ICON)).toBe(CWBTC_ICON);
    expect(safeIconUrl("https://icons.example.org/cwbtc.svg")).toBe("https://icons.example.org/cwbtc.svg");
    // An XML declaration and a comment may come first, as the hub allows.
    const withProlog = svg('<?xml version="1.0"?><!-- drawn for CKBolt --><svg viewBox="0 0 1 1"></svg>');
    expect(safeIconUrl(withProlog)).toBe(withProlog);
    // Unpadded base64 decodes as well.
    const unpadded = svg("<svg viewBox='0 0 2 2'/>").replace(/=+$/, "");
    expect(safeIconUrl(unpadded)).toBe(unpadded);
  });

  test("anything else is refused: other schemes and data types, credentials, spaces, lengths over the hub's caps", () => {
    for (const bad of [
      null,
      undefined,
      42,
      "",
      "http://icons.example.org/cwbtc.svg",
      "javascript:alert(1)",
      "//icons.example.org/cwbtc.svg",
      "/tokens/cwbtc.svg",
      "ftp://icons.example.org/cwbtc.svg",
      "https://user:pass@icons.example.org/cwbtc.svg",
      "https://icons.example.org/cw btc.svg",
      "https://icons.example.org/‮cwbtc.svg",
      "data:image/png;base64,iVBORw0KGgo=",
      "data:image/svg+xml,<svg></svg>",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      `${ICON_URL_RULE.SVG_DATA_URL_PREFIX}not base64!`,
      `${ICON_URL_RULE.SVG_DATA_URL_PREFIX}`,
      svg("<html><body>not an svg</body></html>"),
    ]) {
      expect(safeIconUrl(bad), String(bad)).toBeNull();
    }
    // Lengths: the hub's caps, to the character.
    const https = (length: number) => `https://icons.example.org/${"a".repeat(length - "https://icons.example.org/".length)}`;
    expect(safeIconUrl(https(ICON_URL_RULE.MAX_URL_LENGTH))).toBe(https(ICON_URL_RULE.MAX_URL_LENGTH));
    expect(safeIconUrl(https(ICON_URL_RULE.MAX_URL_LENGTH + 1))).toBeNull();
    const padded = (length: number) => {
      const base = '<svg viewBox="0 0 1 1"></svg>';
      // Grow the SVG with spaces until its data URL is `length` characters (base64 grows 4 per 3 bytes).
      let markup = base;
      while (svg(markup).length < length) markup = markup.replace("</svg>", " </svg>");
      return svg(markup);
    };
    const atCap = padded(ICON_URL_RULE.MAX_DATA_URL_LENGTH - 3);
    expect(atCap.length).toBeLessThanOrEqual(ICON_URL_RULE.MAX_DATA_URL_LENGTH);
    expect(safeIconUrl(atCap)).toBe(atCap);
    const over = padded(ICON_URL_RULE.MAX_DATA_URL_LENGTH + 1);
    expect(over.length).toBeGreaterThan(ICON_URL_RULE.MAX_DATA_URL_LENGTH);
    expect(safeIconUrl(over)).toBeNull();
  });

  test("an inline SVG with anything active or outside in it is refused (defence in depth: icons are only <img>)", () => {
    for (const markup of [
      '<svg><script>alert(1)</script></svg>',
      '<svg onload="alert(1)"></svg>',
      '<svg><foreignObject><div/></foreignObject></svg>',
      '<svg><image href="https://tracker.example/p.png"/></svg>',
      '<svg><use xlink:href="https://evil.example/s.svg#x"/></svg>',
      '<svg><rect style="fill:url(https://evil.example/x)"/></svg>',
      '<svg><a href="#x"><rect/></a></svg>',
      '<svg><set attributeName="onclick" to="alert(1)"/></svg>',
      '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>',
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg></svg>',
      "<svg><text>&#106;avascript</text></svg>",
      "<svg><style>@import url(x.css);</style></svg>",
    ]) {
      expect(safeIconUrl(svg(markup)), markup).toBeNull();
    }
    // A reference inside the image (#fragment) is fine.
    const internal = svg('<svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/></svg>');
    expect(safeIconUrl(internal)).toBe(internal);
  });
});

test.describe("the hub's display name, and how a token looks", () => {
  test("a display name: trimmed, 1 to 64 characters, no control characters or bidi overrides", () => {
    expect(safeDisplayName("  Wrapped BTC (test) ")).toBe("Wrapped BTC (test)");
    expect(safeDisplayName("x".repeat(DISPLAY_NAME_MAX_LENGTH))).toBe("x".repeat(DISPLAY_NAME_MAX_LENGTH));
    for (const bad of [null, undefined, 7, "", "   ", "x".repeat(DISPLAY_NAME_MAX_LENGTH + 1), "Wrapped\u0000BTC", "Wrapped\nBTC", "‮CTBW", "a⁦b"]) {
      expect(safeDisplayName(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  test("fallbacks: the hub's display name, else the app's name, else the hub's name, else the symbol; icons the hub's first", () => {
    // The hub set both: its name and its icon, then the app's own icon to fall back to.
    expect(tokenLook("cWBTC", asset({ displayName: "Wrapped BTC (test)", iconUrl: CWBTC_ICON }), PAY_TOKENS)).toEqual({
      symbol: "cWBTC",
      name: "Wrapped BTC (test)",
      icons: [CWBTC_ICON, "/tokens/cwbtc.svg"],
    });
    // Nothing from the hub: the app's name and icon for a token it knows.
    expect(tokenLook("cWBTC", asset(), PAY_TOKENS)).toEqual({ symbol: "cWBTC", name: "CCH Wrapped BTC (test)", icons: ["/tokens/cwbtc.svg"] });
    // RUSD has no local icon: the hub's alone, else none (initials).
    expect(tokenLook("RUSD", asset({ symbol: "RUSD", name: "RUSD stablecoin", iconUrl: "https://icons.example.org/rusd.svg" }), PAY_TOKENS).icons).toEqual([
      "https://icons.example.org/rusd.svg",
    ]);
    expect(tokenLook("RUSD", asset({ symbol: "RUSD", name: "RUSD stablecoin" }), PAY_TOKENS)).toEqual({ symbol: "RUSD", name: "Stable++ USD stablecoin", icons: [] });
    // A token the app does not know: the hub's name; with none (blank), the symbol.
    expect(tokenLook("xTEST", asset({ symbol: "xTEST", name: "Some test token" }), PAY_TOKENS)).toEqual({ symbol: "xTEST", name: "Some test token", icons: [] });
    expect(tokenLook("xTEST", asset({ symbol: "xTEST", name: "  " }), PAY_TOKENS).name).toBe("xTEST");
    // Before the hub lists it: the app's, else the symbol.
    expect(tokenLook("CKB", undefined, PAY_TOKENS)).toEqual({ symbol: "CKB", name: "Nervos CKB", icons: ["/tokens/ckb.svg"] });
    expect(tokenLook("NEWT", undefined, PAY_TOKENS)).toEqual({ symbol: "NEWT", name: "NEWT", icons: [] });
    // What the hub sends is checked again: a bad name or icon is left out, never shown.
    expect(tokenLook("cWBTC", asset({ displayName: "‮CTBWc", iconUrl: "javascript:alert(1)" }), PAY_TOKENS)).toEqual({
      symbol: "cWBTC",
      name: "CCH Wrapped BTC (test)",
      icons: ["/tokens/cwbtc.svg"],
    });
  });

  test("the app's token for a hub asset takes the hub's display name and icon, checked; without them it is the app's own", () => {
    const cwbtc = PAY_TOKENS.find((t) => t.symbol === "cWBTC")!;
    expect(tokenForAsset(asset(), PAY_TOKENS)).toBe(cwbtc);
    const shown = tokenForAsset(asset({ displayName: "Wrapped BTC (test)", iconUrl: CWBTC_ICON }), PAY_TOKENS);
    expect(shown).toMatchObject({ symbol: "cWBTC", name: "Wrapped BTC (test)", icon: "/tokens/cwbtc.svg", iconUrl: CWBTC_ICON, status: "Quoted 1:1 with BTC" });
    expect(tokenIcons(shown)).toEqual([CWBTC_ICON, "/tokens/cwbtc.svg"]);
    // An unknown token with the hub's display data: no web change needed to show it.
    const newt = tokenForAsset(asset({ id: "NEWT", symbol: "NEWT", name: "New token", displayName: "New Token (test)", iconUrl: CWBTC_ICON, decimals: 6 }), PAY_TOKENS);
    expect(newt).toMatchObject({ symbol: "NEWT", name: "New Token (test)", decimals: 6, iconUrl: CWBTC_ICON, status: "Not quoted" });
    expect(newt.icon).toBeUndefined();
    // A refused icon is not kept.
    expect(tokenForAsset(asset({ iconUrl: "http://icons.example.org/x.svg" }), PAY_TOKENS)).toBe(cwbtc);
  });

  test("History's token line: the name with its symbol, or the symbol alone when the name says nothing more", () => {
    expect(HISTORY_COPY.TOKEN_NAME("Wrapped BTC (test)", "cWBTC")).toBe("Wrapped BTC (test) (cWBTC)");
    expect(HISTORY_COPY.TOKEN_NAME("NEWT", "NEWT")).toBe("NEWT");
  });
});

/* ------------------------------------------------------------------------------- the same rule as the hub */

const HUB_REPO = path.resolve(__dirname, "../../../ckbolt-hub");
const ASSETS_CONSTANTS = path.join(HUB_REPO, "src/common/constants/assets.constants.ts");

/** Loads a hub source file as CommonJS, with its imports resolved from the hub repo. */
function loadHubModule(file: string): Record<string, unknown> {
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  });
  const module = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", outputText)(createRequire(file), module, module.exports);
  return module.exports;
}

test.describe("the icon rule matches the hub's (when ../ckbolt-hub is checked out)", () => {
  test.skip(!existsSync(ASSETS_CONSTANTS), "the sibling hub repo is not present");

  test("ICON_URL_RULE and the display name's cap are the hub's", () => {
    const hub = loadHubModule(ASSETS_CONSTANTS) as { ICON_URL_RULE: Record<string, unknown>; ASSET_DISPLAY_NAME_MAX_LENGTH: number };
    const asComparable = (rule: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(rule).map(([k, v]) => [k, v instanceof RegExp ? `${v.source}/${v.flags}` : v]));
    expect(asComparable(ICON_URL_RULE)).toEqual(asComparable(hub.ICON_URL_RULE));
    expect(DISPLAY_NAME_MAX_LENGTH).toBe(hub.ASSET_DISPLAY_NAME_MAX_LENGTH);
  });
});
