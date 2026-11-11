import { expect, test } from "@playwright/test";
import { clientAddressKey, IPV6_CLIENT_PREFIX_BITS } from "../../lib/client-address";

/*
 * The key rate limits and the hub's daily caps count a client under (lib/client-address.ts): an IPv4 address as it is,
 * an IPv6 address by its /64, since one subscriber can use a new IPv6 address for every request.
 */

test.describe("client address keys", () => {
  test("IPv4: the full address, so neighbours on one network are counted apart", () => {
    expect(clientAddressKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientAddressKey("203.0.113.8")).toBe("203.0.113.8");
    expect(clientAddressKey(" 198.51.100.1 ")).toBe("198.51.100.1");
    expect(clientAddressKey("0.0.0.0")).toBe("0.0.0.0");
    expect(clientAddressKey("255.255.255.255")).toBe("255.255.255.255");
    // Leading zeros and a port do not make a second key for the same client.
    expect(clientAddressKey("203.000.113.007")).toBe("203.0.113.7");
    expect(clientAddressKey("203.0.113.7:51234")).toBe("203.0.113.7");
  });

  test("IPv6: every address of one /64 shares a key; the next /64 has its own", () => {
    expect(IPV6_CLIENT_PREFIX_BITS).toBe(64);
    const key = "2001:db8:1:2::/64";
    for (const address of [
      "2001:0db8:0001:0002:0000:0000:0000:0001",
      "2001:db8:1:2::1",
      "2001:db8:1:2:ffff:ffff:ffff:ffff",
      "2001:DB8:1:2:A:B:C:D",
      "2001:db8:1:2:aaaa::",
      "[2001:db8:1:2::99]",
      "[2001:db8:1:2::99]:443",
      "2001:db8:1:2::1%eth0",
    ]) {
      expect(clientAddressKey(address), address).toBe(key);
    }
    expect(clientAddressKey("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(clientAddressKey("2001:db8:1:2::1")).not.toBe(clientAddressKey("2001:db8:1:3::1"));
  });

  test("IPv6 keys are written in RFC 5952 form: lower case, no leading zeros, the longest zero run as ::", () => {
    expect(clientAddressKey("2001:db8::1")).toBe("2001:db8::/64");
    expect(clientAddressKey("2001:0:0:1::5")).toBe("2001:0:0:1::/64");
    expect(clientAddressKey("2001:db8:0:0:1:2:3:4")).toBe("2001:db8::/64");
    expect(clientAddressKey("::1")).toBe("::/64");
    expect(clientAddressKey("::")).toBe("::/64");
    expect(clientAddressKey("1::")).toBe("1::/64");
    expect(clientAddressKey("abcd:ef01:2345:6789:abcd:ef01:2345:6789")).toBe("abcd:ef01:2345:6789::/64");
    // An IPv4 tail on a plain IPv6 address is part of its host bits.
    expect(clientAddressKey("2001:db8:1:2::192.0.2.1")).toBe("2001:db8:1:2::/64");
    // Short enough for the hub's X-CKBolt-Client (1 to 128 printable characters).
    expect(clientAddressKey("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")!.length).toBeLessThanOrEqual(128);
  });

  test("IPv4-mapped IPv6 is the IPv4 client, in either notation", () => {
    expect(clientAddressKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientAddressKey("::FFFF:203.0.113.7")).toBe("203.0.113.7");
    expect(clientAddressKey("0:0:0:0:0:ffff:cb00:7107")).toBe("203.0.113.7");
    expect(clientAddressKey("[::ffff:203.0.113.7]:80")).toBe("203.0.113.7");
    // Only ::ffff:0:0/96 is mapped; other prefixes with an IPv4 tail stay IPv6.
    expect(clientAddressKey("64:ff9b::203.0.113.7")).toBe("64:ff9b::/64");
  });

  test("anything that is not an IP address has no key", () => {
    for (const garbage of [
      "",
      "   ",
      "unknown",
      "localhost",
      "example.com",
      "203.0.113",
      "203.0.113.256",
      "203.0.113.7.1",
      "-1.0.0.0",
      "1.2.3.4/24",
      "2001:db8::1::2",
      "2001:db8:1:2:3:4:5:6:7",
      "2001:db8:1:2:3:4:5",
      ":::",
      ":1::",
      "2001:db8::g",
      "12345::",
      "::ffff:203.0.113.256",
      "[2001:db8::1",
      "[]",
      "2001:db8::1/64",
      "<script>",
    ]) {
      expect(clientAddressKey(garbage), JSON.stringify(garbage)).toBeNull();
    }
  });
});
