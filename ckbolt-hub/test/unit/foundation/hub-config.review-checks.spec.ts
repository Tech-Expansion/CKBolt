import { MS_PER_SECOND } from "../../../src/common/constants/protocol.constants";
import { TIMING_PROFILES, type TimingProfileName } from "../../../src/common/constants/timing.constants";
import { loadHubConfig } from "../../../src/config/hub.config";
import type { BtcNetwork } from "../../../src/domain/types";
import { readEnvExample } from "../../support/env-example";
import { TEST_PROXY_SECRET } from "../../support/proxy-secret";

/**
 * Start-up checks the November 2026 security review added to loadHubConfig (docs/security-review-2026-11.md):
 * H2 assertProxySecretWhenReachable, H5 assertTimingProfileMatchesNetwork, and H6's price settings with
 * assertEnoughPriceSources.
 */

const INVALID = /^Invalid hub configuration: /;

describe("HUB_HOST that other machines can reach needs HUB_PROXY_SECRET (security review H2)", () => {
  const OPEN_API_MESSAGE = /^Invalid hub configuration: HUB_HOST \(.*\) lets other machines reach the hub, so it needs HUB_PROXY_SECRET.*HUB_ALLOW_OPEN_API=true/;

  it.each(["127.0.0.1", "127.1.2.3", "::1", "localhost"])("starts on the loopback host %s without a secret", (host) => {
    expect(loadHubConfig({ HUB_HOST: host }).server).toMatchObject({ host, proxySecret: null });
  });

  it("starts on the default host (loopback) without a secret", () => {
    expect(loadHubConfig({}).server).toMatchObject({ host: "127.0.0.1", proxySecret: null });
  });

  const REACHABLE_HOSTS = [
    ["every interface", "0.0.0.0"],
    ["every IPv6 interface", "::"],
    ["a LAN address", "192.168.1.10"],
    ["a host name", "hub.example.com"],
  ];

  it.each(REACHABLE_HOSTS)("refuses to start on %s (%s) without a secret, naming the host and both ways out", (_label, host) => {
    const load = () => loadHubConfig({ HUB_HOST: host });
    expect(load).toThrow(OPEN_API_MESSAGE);
    expect(load).toThrow(`HUB_HOST (${host})`);
  });

  it.each(REACHABLE_HOSTS)("starts on %s (%s) with HUB_ALLOW_OPEN_API=true, serving without a secret", (_label, host) => {
    expect(loadHubConfig({ HUB_HOST: host, HUB_ALLOW_OPEN_API: "true" }).server).toMatchObject({ host, proxySecret: null });
  });

  it.each(REACHABLE_HOSTS)("starts on %s (%s) with a secret", (_label, host) => {
    expect(loadHubConfig({ HUB_HOST: host, HUB_PROXY_SECRET: TEST_PROXY_SECRET }).server).toMatchObject({ host, proxySecret: TEST_PROXY_SECRET });
  });

  it("counts a blank HUB_PROXY_SECRET as none", () => {
    expect(() => loadHubConfig({ HUB_HOST: "0.0.0.0", HUB_PROXY_SECRET: "  " })).toThrow(OPEN_API_MESSAGE);
  });

  it("refuses with HUB_ALLOW_OPEN_API=false said out loud", () => {
    expect(() => loadHubConfig({ HUB_HOST: "0.0.0.0", HUB_ALLOW_OPEN_API: "false" })).toThrow(OPEN_API_MESSAGE);
  });

  it("refuses an HUB_ALLOW_OPEN_API that is no boolean, naming it", () => {
    expect(() => loadHubConfig({ HUB_HOST: "0.0.0.0", HUB_ALLOW_OPEN_API: "maybe" })).toThrow(/^Invalid hub configuration: HUB_ALLOW_OPEN_API/);
  });

  it("documents HUB_ALLOW_OPEN_API in .env.example as false, and HUB_PROXY_SECRET as unset", () => {
    const documented = readEnvExample();
    expect(documented.HUB_ALLOW_OPEN_API).toBe("false");
    expect(documented.HUB_PROXY_SECRET).toBe("");
  });
});

describe("a mainnet Bitcoin network needs the mainnet timing profile (security review H5)", () => {
  const MAINNET: BtcNetwork = "mainnet";
  const TEST_NETWORKS: BtcNetwork[] = ["regtest", "signet", "testnet", "testnet4"];
  const PROFILES = Object.keys(TIMING_PROFILES) as TimingProfileName[];
  const OTHER_PROFILES = PROFILES.filter((profile) => profile !== "mainnet");

  it("starts on mainnet with the mainnet profile", () => {
    expect(loadHubConfig({ BTC_NETWORK: MAINNET, TIMING_PROFILE: "mainnet" }).timing.name).toBe("mainnet");
  });

  it.each(OTHER_PROFILES)("refuses mainnet with the %s profile, naming both settings", (profile) => {
    const load = () => loadHubConfig({ BTC_NETWORK: MAINNET, TIMING_PROFILE: profile });
    expect(load).toThrow(`Invalid hub configuration: BTC_NETWORK=mainnet needs TIMING_PROFILE=mainnet (it is ${profile})`);
  });

  it("refuses mainnet with the default profile (regtest) when TIMING_PROFILE is not set", () => {
    expect(() => loadHubConfig({ BTC_NETWORK: MAINNET })).toThrow(/BTC_NETWORK=mainnet needs TIMING_PROFILE=mainnet/);
  });

  const TEST_NETWORK_COMBINATIONS = TEST_NETWORKS.flatMap((network) => PROFILES.map((profile) => [network, profile] as const));

  it.each(TEST_NETWORK_COMBINATIONS)("lets the test network %s borrow the %s profile, as before", (network, profile) => {
    expect(loadHubConfig({ BTC_NETWORK: network, TIMING_PROFILE: profile }).timing.name).toBe(profile);
  });
});

describe("price agreement settings (security review H6)", () => {
  const DEFAULT_MIN_SOURCES = 2;
  const DEFAULT_MAX_SPREAD_BPS = 300;
  const DEFAULT_MAX_AGE_SECONDS = 120;

  it("defaults to PRICE_MIN_SOURCES=2, PRICE_MAX_SPREAD_BPS=300 and PRICE_MAX_AGE_SECONDS=120", () => {
    expect(loadHubConfig({}).pricing).toMatchObject({
      minSources: DEFAULT_MIN_SOURCES,
      maxSpreadBps: DEFAULT_MAX_SPREAD_BPS,
      maxPriceAgeMs: DEFAULT_MAX_AGE_SECONDS * MS_PER_SECOND,
    });
  });

  it.each([
    ["PRICE_MIN_SOURCES", DEFAULT_MIN_SOURCES],
    ["PRICE_MAX_SPREAD_BPS", DEFAULT_MAX_SPREAD_BPS],
    ["PRICE_MAX_AGE_SECONDS", DEFAULT_MAX_AGE_SECONDS],
  ])("documents %s in .env.example with the default the code uses (%d)", (name, value) => {
    expect(readEnvExample()[name]).toBe(String(value));
  });

  it("reads each from its env var", () => {
    const pricing = loadHubConfig({ PRICE_MIN_SOURCES: "3", PRICE_MAX_SPREAD_BPS: "150", PRICE_MAX_AGE_SECONDS: "45" }).pricing;
    expect(pricing).toMatchObject({ minSources: 3, maxSpreadBps: 150, maxPriceAgeMs: 45 * MS_PER_SECOND });
  });

  it.each([
    ["PRICE_MIN_SOURCES", "0"],
    ["PRICE_MIN_SOURCES", "-1"],
    ["PRICE_MIN_SOURCES", "1.5"],
    ["PRICE_MIN_SOURCES", "two"],
    ["PRICE_MAX_SPREAD_BPS", "0"],
    ["PRICE_MAX_SPREAD_BPS", "-300"],
    ["PRICE_MAX_SPREAD_BPS", "2.5"],
    ["PRICE_MAX_AGE_SECONDS", "0"],
  ])("refuses %s=%p, naming it", (name, value) => {
    expect(() => loadHubConfig({ [name]: value })).toThrow(new RegExp(`^Invalid hub configuration: ${name}`));
  });

  describe("PRICE_MIN_SOURCES cannot exceed the configured sources (assertEnoughPriceSources)", () => {
    it("refuses more than the sources configured, naming both counts", () => {
      const load = () => loadHubConfig({ PRICE_SOURCES: "coingecko,binance", PRICE_MIN_SOURCES: "3" });
      expect(load).toThrow(INVALID);
      expect(load).toThrow("PRICE_MIN_SOURCES (3) is more than the 2 PRICE_SOURCES configured");
    });

    it("refuses the default minimum (2) with a single source configured", () => {
      expect(() => loadHubConfig({ PRICE_SOURCES: "kucoin" })).toThrow("PRICE_MIN_SOURCES (2) is more than the 1 PRICE_SOURCES configured");
    });

    it("starts with exactly as many sources as the minimum", () => {
      expect(loadHubConfig({ PRICE_SOURCES: "coingecko,binance,kucoin", PRICE_MIN_SOURCES: "3" }).pricing.minSources).toBe(3);
    });

    it("starts with a single source when the minimum is 1", () => {
      expect(loadHubConfig({ PRICE_SOURCES: "kucoin", PRICE_MIN_SOURCES: "1" }).pricing.sources).toEqual(["kucoin"]);
    });

    it.each(["coingecko,coingecko", "coingecko, CoinGecko"])("refuses PRICE_SOURCES=%p with PRICE_MIN_SOURCES=2: it names one source", (sources) => {
      expect(() => loadHubConfig({ PRICE_SOURCES: sources, PRICE_MIN_SOURCES: "2" })).toThrow(INVALID);
    });

    it("counts distinct names in its message: three entries naming two sources are two", () => {
      expect(() => loadHubConfig({ PRICE_SOURCES: "kucoin,KuCoin,binance", PRICE_MIN_SOURCES: "3" })).toThrow(
        "PRICE_MIN_SOURCES (3) is more than the 2 PRICE_SOURCES configured",
      );
    });

    it("starts when the distinct names reach the minimum, duplicates and blanks aside", () => {
      expect(loadHubConfig({ PRICE_SOURCES: "kucoin, KuCoin,,binance", PRICE_MIN_SOURCES: "2" }).pricing.minSources).toBe(2);
    });
  });
});
