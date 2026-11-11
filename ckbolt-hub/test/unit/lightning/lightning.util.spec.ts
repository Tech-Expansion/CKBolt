import { BOLT11_PREFIXES } from "../../../src/common/constants/protocol.constants";
import { bolt11Network, satsToNumber } from "../../../src/common/utils/lightning.util";
import { makeBolt11 } from "./lightning.fixtures";

describe("bolt11Network", () => {
  it.each([
    ["regtest", "regtest"],
    ["signet", "signet"],
    ["testnet", "testnet"],
    ["mainnet", "mainnet"],
  ] as const)("reads a real %s invoice as %s", (network, expected) => {
    expect(bolt11Network(makeBolt11({ network, mtokens: "1000" }))).toBe(expected);
  });

  it("does not confuse lnbcrt with lnbc, or lntbs with lntb", () => {
    expect(bolt11Network("lnbcrt1pxyz")).toBe("regtest");
    expect(bolt11Network("lnbc1pxyz")).toBe("mainnet");
    expect(bolt11Network("lntbs1pxyz")).toBe("signet");
    expect(bolt11Network("lntb1pxyz")).toBe("testnet");
  });

  it("knows every prefix in BOLT11_PREFIXES", () => {
    for (const { prefix, network } of BOLT11_PREFIXES) expect(bolt11Network(`${prefix}1pxyz`)).toBe(network);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(bolt11Network("  LNTBS1PXYZ\n")).toBe("signet");
  });

  it.each(["", "fibt1qqq", "lnsb1pxyz", "lightning:lnbc1pxyz", "bc1qxyz"])("returns null for %p", (request) => {
    expect(bolt11Network(request)).toBeNull();
  });
});

describe("satsToNumber", () => {
  it("converts amounts a JS number holds exactly", () => {
    expect(satsToNumber(0n)).toBe(0);
    expect(satsToNumber(100_000n)).toBe(100_000);
    expect(satsToNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("throws RangeError for negative amounts and amounts that would lose precision", () => {
    expect(() => satsToNumber(-1n)).toThrow(RangeError);
    expect(() => satsToNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(RangeError);
  });
});
