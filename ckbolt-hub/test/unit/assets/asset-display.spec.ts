import { iconUrlProblem } from "../../../src/common/utils/icon-url.util";
import { assetRegistryOf, loadHubConfig } from "../../../src/config/hub.config";
import type { AssetDto } from "../../../src/interfaces/http/contract/responses";
import { API_PATH } from "../../support/hub-http";
import { CWBTC_ENTRY, RUSD_ENTRY, useAssetsHubs } from "./assets.fixtures";

/**
 * How the web app shows an asset (FIBER_ASSETS `displayName` and `iconUrl`): a display name of 1 to 64 characters
 * (trimmed) without control characters, and an icon that is an https URL (at most 2,048 characters, no user name or
 * password) or an inline SVG as a base64 data URL (at most 8,192 characters) holding nothing active and no outside
 * reference. GET /v1/assets gives both, null when unset.
 */

const SVG_PREFIX = "data:image/svg+xml;base64,";
const svgDataUrl = (svg: string): string => SVG_PREFIX + Buffer.from(svg, "utf8").toString("base64");
const PLAIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#f7931a"/></svg>';
const ICON = svgDataUrl(PLAIN_SVG);

/** An SVG of exactly `bytes` ASCII bytes: the plain shell with a comment filling the rest. */
const svgOfBytes = (bytes: number): string => {
  const shell = ['<svg xmlns="http://www.w3.org/2000/svg"><!--', "--></svg>"];
  return shell[0] + "x".repeat(bytes - shell.join("").length) + shell[1];
};
/** The data URL with base64's "=" padding left out, which decodes the same. */
const unpaddedSvgDataUrl = (svg: string): string => svgDataUrl(svg).replace(/=+$/, "");

/** An https URL of exactly `length` characters. */
const httpsUrlOfLength = (length: number): string => {
  const [head, tail] = ["https://cdn.example.com/", ".svg"];
  return head + "a".repeat(length - head.length - tail.length) + tail;
};

describe("iconUrlProblem", () => {
  describe("takes", () => {
    it.each([
      ["a plain https URL", "https://cdn.example.com/icons/cwbtc.svg"],
      ["an https URL with a port, query and fragment", "https://cdn.example.com:8443/i.png?v=2#top"],
      ["an https URL with an IP host", "https://203.0.113.7/icon.png"],
      ["an https URL of exactly 2,048 characters", httpsUrlOfLength(2_048)],
      ["a plain inline SVG", ICON],
      ["an inline SVG with an XML declaration and comments first", svgDataUrl('<?xml version="1.0" encoding="UTF-8"?>\n<!-- by hand -->\n<!-- v2 --><svg viewBox="0 0 1 1"/>')],
      ["an inline SVG with leading white space and an upper-case tag", svgDataUrl("  \n<SVG viewBox='0 0 1 1'></SVG>")],
      ["an inline SVG whose svg tag ends right after its name", svgDataUrl("<svg><rect width='1' height='1'/></svg>")],
      ["a gradient referenced by fragment, url(#id)", svgDataUrl('<svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/></svg>')],
      ["a use element pointing at a fragment, href=#id unquoted", svgDataUrl("<svg><use href=#a /></svg>")],
      ["attributes that only contain 'on' inside a word", svgDataUrl('<svg version="1.1"><polygon points="0,0 1,1" stroke-linejoin="round"/></svg>')],
      ["the svg namespace URL (an xmlns is no reference)", svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"/>')],
    ])("%s", (_label, value) => {
      expect(iconUrlProblem(value)).toBeNull();
    });

    it("takes an inline SVG of exactly 8,192 characters", () => {
      // 6,124 bytes encode to 8,168 base64 characters ending in "=="; without the padding 8,166, + 26 of prefix = 8,192.
      const url = unpaddedSvgDataUrl(svgOfBytes(6_124));

      expect(url.length).toBe(8_192);
      expect(iconUrlProblem(url)).toBeNull();
    });

    // The rule refuses only references that are not #fragments; these are the ordinary, quoted way to write one.
    it.each([
      ["href=\"#id\" (quoted fragment)", '<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="a" d="M0 0h1v1z"/></defs><use href="#a"/></svg>'],
      ["xlink:href=\"#id\" (quoted fragment)", '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>'],
      ["url('#id') (quoted fragment)", "<svg><rect fill=\"url('#g')\"/></svg>"],
      ["xlink:href='#id' (single-quoted fragment)", "<svg><use xlink:href='#a'/></svg>"],
      ['url("#id") (double-quoted fragment)', "<svg><rect fill='url(\"#g\")'/></svg>"],
      ["href =\"#id\" (space before =)", '<svg><use href ="#a"/></svg>'],
      ["url( #id) (space inside the brackets)", '<svg><rect fill="url( #g)"/></svg>'],
      // XML allows white space on both sides of "=", and CSS inside url( ): still a quoted #fragment.
      ["href= \"#id\" (space after =)", '<svg><use href= "#a"/></svg>'],
      ["href = \"#id\" (spaces around =)", '<svg><use href = "#a"/></svg>'],
      ["url( '#id') (space before the quote)", "<svg><rect fill=\"url( '#g')\"/></svg>"],
    ])("takes a fragment reference written as %s", (_label, svg) => {
      expect(iconUrlProblem(svgDataUrl(svg))).toBeNull();
    });

    it("takes a plain icon that reuses a shape with <use href=\"#x\"/> and fills with url(#g)", () => {
      const icon =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g"><stop offset="0" stop-color="#f7931a"/></linearGradient>' +
        '<path id="x" d="M4 4h24v24H4z"/></defs><use href="#x"/><rect width="8" height="8" fill="url(#g)"/></svg>';

      expect(iconUrlProblem(svgDataUrl(icon))).toBeNull();
    });
  });

  describe("refuses", () => {
    it.each([
      ["an empty string", ""],
      ["text that is no URL", "cwbtc icon"],
      ["a relative path", "/icons/cwbtc.svg"],
      ["plain http", "http://cdn.example.com/cwbtc.svg"],
      ["ftp", "ftp://cdn.example.com/cwbtc.svg"],
      ["a javascript: URL", "javascript:alert(1)"],
      ["a file: URL", "file:///etc/passwd"],
      ["an https URL with a user name", "https://alice@cdn.example.com/cwbtc.svg"],
      ["an https URL with a user name and password", "https://alice:secret@cdn.example.com/cwbtc.svg"],
      ["an https URL of 2,049 characters", httpsUrlOfLength(2_049)],
      ["a PNG data URL", `data:image/png;base64,${Buffer.from("\x89PNG\r\n\x1a\n").toString("base64")}`],
      ["an SVG data URL that is not base64", `data:image/svg+xml;utf8,${PLAIN_SVG}`],
      ["an SVG data URL with an upper-case scheme", ICON.replace("data:", "DATA:")],
      ["an SVG data URL with nothing after the comma", SVG_PREFIX],
      ["an SVG data URL with characters outside base64", `${SVG_PREFIX}PHN2Zz4-PC9zdmc_`],
      ["a base64 payload that is not an SVG", svgDataUrl("<html><body>hi</body></html>")],
      ["a base64 payload that only starts like an svg element", svgDataUrl("<svgx></svgx>")],
      ["a base64 payload with text before the svg element", svgDataUrl("hello <svg/>")],
      ["a base64 payload with a DOCTYPE before the svg element", svgDataUrl('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>')],
    ])("%s", (_label, value) => {
      expect(iconUrlProblem(value)).toEqual(expect.any(String));
    });

    it("refuses an inline SVG of 8,193 characters, saying so", () => {
      // 6,125 bytes encode to 8,168 characters ending in "="; without it 8,167, + 26 = 8,193.
      const url = unpaddedSvgDataUrl(svgOfBytes(6_125));

      expect(url.length).toBe(8_193);
      expect(iconUrlProblem(url)).toBe("must be at most 8192 characters as a data URL");
    });

    it("explains an http URL and a credential", () => {
      expect(iconUrlProblem("http://cdn.example.com/i.svg")).toMatch(/must use https/);
      expect(iconUrlProblem("https://a:b@cdn.example.com/i.svg")).toBe("must not carry a user name or password");
    });

    it.each([
      ["a script element", "<svg><script>alert(1)</script></svg>"],
      ["a script element in upper case", "<svg><SCRIPT>alert(1)</SCRIPT></svg>"],
      ["a foreignObject", "<svg><foreignObject><div>x</div></foreignObject></svg>"],
      ["an iframe", "<svg><iframe src='x'></iframe></svg>"],
      ["an embed", "<svg><embed src='x'/></svg>"],
      ["an object", "<svg><object data='x'></object></svg>"],
      ["a DOCTYPE after the svg element", "<svg><!DOCTYPE svg></svg>"],
      ["an ENTITY declaration", '<svg><!ENTITY x "y"></svg>'],
      ["an onload handler", "<svg onload='alert(1)'/>"],
      ["an onclick handler with spaces before =", "<svg><rect onclick  = 'alert(1)'/></svg>"],
      ["an onmouseover handler in upper case", "<svg><rect ONMOUSEOVER='x'/></svg>"],
      ["a javascript: link", "<svg><a href='javascript:alert(1)'><text>x</text></a></svg>"],
      ["a javascript: value anywhere", "<svg><text>javascript:void(0)</text></svg>"],
      ["an href to another host", '<svg><image href="https://evil.example/x.png"/></svg>'],
      ["an xlink:href to another host", '<svg><image xlink:href="http://evil.example/x.png"/></svg>'],
      ["an unquoted href to another host", "<svg><image href=https://evil.example/x.png /></svg>"],
      ["an href to a data URL", '<svg><image href="data:image/png;base64,AAAA"/></svg>'],
      ["a url() to another host", "<svg><rect fill='url(https://evil.example/p.svg#g)'/></svg>"],
      ["a quoted url() to another host", '<svg><rect style="fill:url(\'//evil.example/p.svg\')"/></svg>'],
      ["an @import", "<svg><style>@import 'https://evil.example/s.css';</style></svg>"],
      // Links, the animations that can set an href, and character references (which can spell anything above).
      ["a link, even to a fragment", '<svg><a href="#x"><text>x</text></a></svg>'],
      ["a link without attributes", "<svg><a><text>x</text></a></svg>"],
      ["a link in upper case on a new line", "<svg><A\nclass='l'><text>x</text></A></svg>"],
      ["a set element", '<svg><rect><set attributeName="fill" to="red"/></rect></svg>'],
      ["a set element that sets an href", '<svg><a><set attributeName="href" to="https://evil.example/"/></a></svg>'],
      ["an animate element", '<svg><rect><animate attributeName="opacity" from="0" to="1" dur="1s"/></rect></svg>'],
      ["an animate element in upper case", '<svg><rect><ANIMATE attributeName="opacity" to="1"/></rect></svg>'],
      ["an animateTransform", '<svg><rect><animateTransform attributeName="transform" type="rotate" to="90"/></rect></svg>'],
      ["an animateMotion", '<svg><rect><animateMotion path="M0 0L1 1" dur="1s"/></rect></svg>'],
      ["a decimal character reference", "<svg><text>&#65;</text></svg>"],
      ["a hex character reference", "<svg><text>&#x41;</text></svg>"],
      ["a javascript: link spelt with a character reference and set by animation", '<svg><a><set attributeName="href" to="&#106;avascript:alert(1)"/><text>x</text></a></svg>'],
      ["a character reference alone spelling javascript:", '<svg><rect class="&#106;avascript:x"/></svg>'],
    ])("an inline SVG with %s", (_label, svg) => {
      expect(iconUrlProblem(svgDataUrl(svg))).toBe("must be a plain SVG: no scripts, event handlers, embedded documents or outside references");
    });
  });
});

/* ------------------------------------------------------------------------------------------ FIBER_ASSETS */

const TESTNET = { CKB_NETWORK: "testnet" };
const withAssets = (entries: unknown[]) => loadHubConfig({ ...TESTNET, FIBER_ASSETS: JSON.stringify(entries) });
const cwbtcWith = (display: Record<string, unknown>) => withAssets([RUSD_ENTRY, { ...CWBTC_ENTRY, ...display }]);
const assetOf = (display: Record<string, unknown>, id = "CWBTC") => assetRegistryOf(cwbtcWith(display)).get(id);

describe("FIBER_ASSETS displayName and iconUrl", () => {
  it("puts both on the asset, the display name trimmed", () => {
    expect(assetOf({ displayName: "  Wrapped Bitcoin (cWBTC)  ", iconUrl: ICON })).toMatchObject({
      id: "CWBTC",
      name: "CCH Wrapped BTC",
      displayName: "Wrapped Bitcoin (cWBTC)",
      iconUrl: ICON,
    });
  });

  it("leaves both off an asset that sets neither, and off CKB", () => {
    const config = cwbtcWith({ displayName: "Wrapped Bitcoin", iconUrl: ICON });
    const [ckb, rusd] = assetRegistryOf(config).list();

    expect(ckb).not.toHaveProperty("displayName");
    expect(ckb).not.toHaveProperty("iconUrl");
    expect(rusd).not.toHaveProperty("displayName");
    expect(rusd).not.toHaveProperty("iconUrl");
  });

  it("takes either one alone", () => {
    expect(assetOf({ displayName: "Wrapped Bitcoin" })).not.toHaveProperty("iconUrl");
    expect(assetOf({ iconUrl: "https://cdn.example.com/cwbtc.svg" })).not.toHaveProperty("displayName");
  });

  it.each([
    ["64 characters", "W".repeat(64)],
    ["64 characters with spaces around them", `  ${"W".repeat(64)}\t`],
    ["one character", "W"],
    ["symbols and non-Latin letters", "₿ Wrapped — 比特币"],
    ["a no-break space (U+00A0, just past the C1 range)", "Wrapped\u00a0Bitcoin"],
  ])("takes a display name of %s", (_label, displayName) => {
    expect(assetOf({ displayName })?.displayName).toBe(displayName.trim());
  });

  describe("refuses, naming FIBER_ASSETS", () => {
    it.each([
      ["an empty display name", { displayName: "" }],
      ["a display name of spaces only", { displayName: "   " }],
      ["a display name of 65 characters", { displayName: "W".repeat(65) }],
      ["a display name with a line break inside", { displayName: "Wrapped\nBitcoin" }],
      ["a display name with a NUL", { displayName: "Wrapped\u0000Bitcoin" }],
      ["a display name with a bell", { displayName: "\u0007Wrapped" }],
      ["a display name with DEL", { displayName: "Wrapped\u007f" }],
      ["a display name with an escape sequence", { displayName: "\u001b[31mWrapped" }],
      ["a display name that is a number", { displayName: 5 }],
      ["an http icon", { iconUrl: "http://cdn.example.com/cwbtc.svg" }],
      ["a PNG data icon", { iconUrl: "data:image/png;base64,iVBORw0KGgo=" }],
      ["an icon with a script", { iconUrl: svgDataUrl("<svg><script>alert(1)</script></svg>") }],
      ["an inline icon over 8,192 characters", { iconUrl: unpaddedSvgDataUrl(svgOfBytes(6_125)) }],
      ["an https icon over 2,048 characters", { iconUrl: httpsUrlOfLength(2_049) }],
      ["an icon that is no string", { iconUrl: { url: ICON } }],
      ["a misspelt key", { iconURL: ICON }],
    ])("%s", (_label, display) => {
      expect(() => cwbtcWith(display)).toThrow(/^Invalid hub configuration: FIBER_ASSETS/);
    });

    it("names the entry, the field and the reason", () => {
      expect(() => cwbtcWith({ iconUrl: "http://cdn.example.com/cwbtc.svg" })).toThrow(/FIBER_ASSETS\.1\.iconUrl: must use https/);
      expect(() => cwbtcWith({ displayName: "a\u0007b" })).toThrow(/FIBER_ASSETS\.1\.displayName: must not contain control characters/);
    });

    // Unicode's control characters (category Cc) are U+0000-U+001F and U+007F-U+009F; U+0085 is NEXT LINE.
    it.each([
      ["NEXT LINE (U+0085)", "Wrapped\u0085Bitcoin"],
      ["the C1 control sequence introducer (U+009B)", "\u009b31mWrapped"],
      ["U+0080, the first of the C1 range", "Wrapped\u0080Bitcoin"],
      ["U+009F, the last of the C1 range", "Wrapped\u009fBitcoin"],
    ])("a display name with the C1 control character %s", (_label, displayName) => {
      expect(() => cwbtcWith({ displayName })).toThrow(/^Invalid hub configuration: FIBER_ASSETS/);
    });

    // Inside the name: at either end trim() removes them first, as it does a trailing "\n".
    it.each([
      ["LINE SEPARATOR (U+2028)", "Wrapped\u2028Bitcoin"],
      ["PARAGRAPH SEPARATOR (U+2029)", "Wrapped\u2029Bitcoin"],
    ])("a display name with a %s inside it", (_label, displayName) => {
      expect(() => cwbtcWith({ displayName })).toThrow(/FIBER_ASSETS\.1\.displayName: must not contain control characters/);
    });
  });
});

/* ------------------------------------------------------------------------------------------- GET /v1/assets */

describe("GET /v1/assets: displayName and iconUrl", () => {
  const hubs = useAssetsHubs();

  it("gives the configured display name and icon, and null where an asset sets none (CKB always)", async () => {
    const hub = await hubs.start({
      FIBER_ASSETS: JSON.stringify([
        { ...RUSD_ENTRY, iconUrl: "https://cdn.example.com/rusd.png" },
        { ...CWBTC_ENTRY, displayName: " Wrapped Bitcoin (cWBTC) ", iconUrl: ICON },
      ]),
    });
    const { data } = (await hub.http().get(API_PATH.ASSETS).expect(200)).body as { data: AssetDto[] };

    expect(data.map(({ id, name, displayName, iconUrl }) => ({ id, name, displayName, iconUrl }))).toEqual([
      { id: "CKB", name: "Nervos CKB", displayName: null, iconUrl: null },
      { id: "RUSD", name: "RUSD stablecoin", displayName: null, iconUrl: "https://cdn.example.com/rusd.png" },
      { id: "CWBTC", name: "CCH Wrapped BTC", displayName: "Wrapped Bitcoin (cWBTC)", iconUrl: ICON },
    ]);
  });

  it("gives null for both on every asset when FIBER_ASSETS sets neither", async () => {
    const hub = await hubs.start();
    const { data } = (await hub.http().get(API_PATH.ASSETS).expect(200)).body as { data: AssetDto[] };

    expect(data.map(({ id, displayName, iconUrl }) => [id, displayName, iconUrl])).toEqual([
      ["CKB", null, null],
      ["RUSD", null, null],
      ["CWBTC", null, null],
    ]);
  });
});
