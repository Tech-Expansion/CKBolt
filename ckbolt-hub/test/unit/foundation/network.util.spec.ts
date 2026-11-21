import { UNKNOWN_CLIENT_KEY } from "../../../src/common/constants/http.constants";
import { clientNetworkKey, isLoopbackHost } from "../../../src/common/utils/network.util";

/**
 * network.util helpers the security review added: isLoopbackHost (H2: which HUB_HOST needs HUB_PROXY_SECRET) and
 * clientNetworkKey (H3: the key the rate limits count a client address by; IPv6 per /64).
 */

describe("isLoopbackHost (security review H2)", () => {
  it.each(["127.0.0.1", "127.1.2.3", "127.255.255.255", "::1", "0:0:0:0:0:0:0:1", "localhost", "LOCALHOST", "::ffff:127.0.0.1"])(
    "says %s only the machine itself can reach",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each([
    ["every IPv4 interface", "0.0.0.0"],
    ["every IPv6 interface", "::"],
    ["a LAN address", "192.168.1.10"],
    ["a private network address", "10.0.0.1"],
    ["a unique-local IPv6 address", "fd00::5"],
    ["a public address", "203.0.113.5"],
    ["the first address past 127.0.0.0/8", "128.0.0.1"],
    ["a host name", "hub.example.com"],
    ["a name that only starts like localhost", "localhost.example.com"],
    ["an empty name", ""],
  ])("says %s (%s) is reachable from other machines", (_label, host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("clientNetworkKey (security review H3)", () => {
  it.each(["203.0.113.5", "8.8.8.8", "10.0.0.1"])("keeps the IPv4 address %s as it is", (address) => {
    expect(clientNetworkKey(address)).toBe(address);
  });

  it.each([
    ["::ffff:8.8.8.8", "8.8.8.8"],
    ["::FFFF:203.0.113.5", "203.0.113.5"],
    ["::ffff:127.0.0.1", "127.0.0.1"],
  ])("keys the IPv4-mapped address %s as its IPv4 address %s", (address, key) => {
    expect(clientNetworkKey(address)).toBe(key);
  });

  it.each([
    ["a full address", "2001:0db8:0001:0002:0003:0004:0005:0006", "2001:db8:1:2::/64"],
    ["a compressed address", "2001:db8:1:2::7", "2001:db8:1:2::/64"],
    ["a compressed run inside the /64", "2001:db8::1", "2001:db8:0:0::/64"],
    ["upper-case hex", "2001:DB8:A:B::1", "2001:db8:a:b::/64"],
    ["the network address itself", "2001:db8:1:2::", "2001:db8:1:2::/64"],
    ["a dotted IPv4 tail", "2001:db8:1:2:3:4:1.2.3.4", "2001:db8:1:2::/64"],
    ["a zone index", "fe80::1%eth0", "fe80:0:0:0::/64"],
    ["the loopback", "::1", "0:0:0:0::/64"],
  ])("keys %s (%s) as its first 4 groups plus ::/64", (_label, address, key) => {
    expect(clientNetworkKey(address)).toBe(key);
  });

  it("gives two addresses in the same /64 the same key", () => {
    expect(clientNetworkKey("2001:db8:1:2::1")).toBe(clientNetworkKey("2001:db8:1:2:ffff:ffff:ffff:ffff"));
    expect(clientNetworkKey("2001:db8:1:2:abcd::")).toBe(clientNetworkKey("2001:0db8:0001:0002:0000:0000:0000:0001"));
  });

  it("gives addresses in different /64s different keys", () => {
    expect(clientNetworkKey("2001:db8:1:2::1")).not.toBe(clientNetworkKey("2001:db8:1:3::1"));
    expect(clientNetworkKey("2001:db8:1:2::1")).not.toBe(clientNetworkKey("2001:db9:1:2::1"));
  });

  it.each([UNKNOWN_CLIENT_KEY, "hub.example.com", "not an address"])("leaves %p, which is no IP address, unchanged", (value) => {
    expect(clientNetworkKey(value)).toBe(value);
  });

  it.each([
    ["::ffff:808:808", "8.8.8.8"],
    ["0:0:0:0:0:ffff:8.8.8.8", "8.8.8.8"],
  ])("keys the IPv4-mapped address %s, written another way, as its IPv4 address %s", (address, key) => {
    expect(clientNetworkKey(address)).toBe(key);
  });
});
