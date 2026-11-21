import { loadHubConfig } from "../../../src/config/hub.config";
import type { BtcNetwork } from "../../../src/domain/types";
import { readEnvExample } from "../../support/env-example";

/**
 * Security review H7: an inbound Lightning channel's push is the hub's own bitcoin, given to whoever asks for a channel,
 * and the per-client caps can be worked around with new keys. So LN_INBOUND_PUSH_SATS defaults to 0 on
 * BTC_NETWORK=mainnet (20,000 elsewhere, as before), and a non-zero value on mainnet is refused at start-up: no opt-in.
 */

/** What a mainnet hub needs besides BTC_NETWORK to pass the other start-up checks. */
const MAINNET = { BTC_NETWORK: "mainnet", TIMING_PROFILE: "mainnet" } as const;
/** Inbound Lightning channels on, with the channel-only macaroon they need. */
const LN_INBOUND_ON = { LN_INBOUND_ENABLED: "true", LND_CHANNELS_MACAROON_PATH: "/secrets/lnd-hub/channels.macaroon" } as const;
const TEST_NETWORK_PUSH_SATS = 20_000n;
const MAINNET_REFUSAL = /LN_INBOUND_PUSH_SATS \(\d+\) must be 0 or unset on BTC_NETWORK=mainnet/;

const pushSats = (env: Record<string, string>): bigint => loadHubConfig(env).lightningPeers.inboundChannels.pushSats;

describe("HubConfig: LN_INBOUND_PUSH_SATS by Bitcoin network (security review H7)", () => {
  describe("its default", () => {
    it("is 0 on mainnet", () => {
      expect(pushSats(MAINNET)).toBe(0n);
      expect(pushSats({ ...MAINNET, ...LN_INBOUND_ON })).toBe(0n);
      // So a channel of LND's smallest size, which the 20,000 default would fill, is fine there.
      expect(pushSats({ ...MAINNET, LN_INBOUND_CAPACITY_SATS: "20000" })).toBe(0n);
    });

    it.each(["signet", "testnet", "testnet4", "regtest"] satisfies BtcNetwork[])("is 20000 on %s, unchanged", (network) => {
      expect(pushSats({ BTC_NETWORK: network })).toBe(TEST_NETWORK_PUSH_SATS);
      expect(pushSats({ BTC_NETWORK: network, ...LN_INBOUND_ON })).toBe(TEST_NETWORK_PUSH_SATS);
    });

    it("is 20000 with no BTC_NETWORK (regtest by default), and on the kit's Mutinynet profile", () => {
      expect(pushSats({})).toBe(TEST_NETWORK_PUSH_SATS);
      expect(pushSats({ BTC_NETWORK: "signet", TIMING_PROFILE: "mutinynet" })).toBe(TEST_NETWORK_PUSH_SATS);
    });

    it("is what .env.example documents for test networks, where the line is commented out (unset)", () => {
      expect(readEnvExample().LN_INBOUND_PUSH_SATS).toBe(String(TEST_NETWORK_PUSH_SATS));
    });
  });

  describe("a value set on a test network", () => {
    it.each(["signet", "testnet", "regtest"] satisfies BtcNetwork[])("is taken as it is on %s, 0 included", (network) => {
      expect(pushSats({ BTC_NETWORK: network, LN_INBOUND_PUSH_SATS: "5000" })).toBe(5_000n);
      expect(pushSats({ BTC_NETWORK: network, LN_INBOUND_PUSH_SATS: "0" })).toBe(0n);
    });

    it("still has to stay below the capacity and within the caps, with the default as with a set value", () => {
      expect(() => loadHubConfig({ LN_INBOUND_PUSH_SATS: "30000" })).toThrow(/must be below LN_INBOUND_CAPACITY_SATS/);
      // The 20,000 default is checked too: a smaller channel refuses it.
      expect(() => loadHubConfig({ LN_INBOUND_CAPACITY_SATS: "20000" })).toThrow(/LN_INBOUND_PUSH_SATS \(20000\) must be below LN_INBOUND_CAPACITY_SATS \(20000\)/);
      expect(() => loadHubConfig({ ...LN_INBOUND_ON, SWAP_MAX_SATS: "10000" })).toThrow(/LN_INBOUND_PUSH_SATS \(20000\) must be at most SWAP_MAX_SATS/);
      expect(() => loadHubConfig({ LN_INBOUND_PUSH_SATS: "-1" })).toThrow("LN_INBOUND_PUSH_SATS");
    });
  });

  describe("on mainnet", () => {
    it("accepts 0 set explicitly", () => {
      expect(pushSats({ ...MAINNET, LN_INBOUND_PUSH_SATS: "0" })).toBe(0n);
      expect(pushSats({ ...MAINNET, ...LN_INBOUND_ON, LN_INBOUND_PUSH_SATS: "0" })).toBe(0n);
    });

    it.each(["1", "20000", "29999"])("refuses %s at start-up, naming the variable, the value and the network", (value) => {
      expect(() => loadHubConfig({ ...MAINNET, LN_INBOUND_PUSH_SATS: value })).toThrow(MAINNET_REFUSAL);
      expect(() => loadHubConfig({ ...MAINNET, LN_INBOUND_PUSH_SATS: value })).toThrow(`LN_INBOUND_PUSH_SATS (${value})`);
    });

    it("refuses a push whether inbound Lightning channels are on or off: there is no opt-in", () => {
      expect(() => loadHubConfig({ ...MAINNET, LN_INBOUND_ENABLED: "false", LN_INBOUND_PUSH_SATS: "1000" })).toThrow(MAINNET_REFUSAL);
      expect(() => loadHubConfig({ ...MAINNET, ...LN_INBOUND_ON, LN_INBOUND_PUSH_SATS: "1000" })).toThrow(MAINNET_REFUSAL);
    });

    it("refuses it before the capacity check (the mainnet sentence, not the capacity one)", () => {
      expect(() => loadHubConfig({ ...MAINNET, LN_INBOUND_PUSH_SATS: "50000" })).toThrow(MAINNET_REFUSAL);
    });

    it("says why: the hub gives no bitcoin away there", () => {
      expect(() => loadHubConfig({ ...MAINNET, LN_INBOUND_PUSH_SATS: "1" })).toThrow(/gives no bitcoin away/);
    });
  });
});
