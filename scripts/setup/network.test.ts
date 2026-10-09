import { describe, expect, test } from "bun:test";
import { canonicalUrl, isPrivateIPv4, pickLanAddress } from "./network.ts";

describe("canonicalUrl", () => {
  test("local uses localhost", () => {
    expect(canonicalUrl("local", "127.0.0.1", 7340)).toBe("http://localhost:7340");
  });
  test("lan uses the LAN address", () => {
    expect(canonicalUrl("lan", "192.168.1.20", 7340)).toBe("http://192.168.1.20:7340");
  });
  test("remote uses the tunnel URL", () => {
    expect(canonicalUrl("remote", "127.0.0.1", 7340, "https://x")).toBe("https://x");
  });
  test("remote without a tunnel URL throws", () => {
    expect(() => canonicalUrl("remote", "127.0.0.1", 7340)).toThrow();
  });
});

const v4 = (address: string, internal = false) => ({ address, family: "IPv4", internal });

describe("pickLanAddress", () => {
  test("skips internal and IPv6, prefers private ranges", () => {
    expect(
      pickLanAddress({
        lo0: [v4("127.0.0.1", true)],
        utun3: [v4("100.101.102.103")],
        en0: [{ address: "fe80::1", family: "IPv6", internal: false }, v4("192.168.1.20")],
      }),
    ).toBe("192.168.1.20");
  });
  test("accepts 10/8 and 172.16/12 but not 172.32", () => {
    expect(pickLanAddress({ a: [v4("172.32.0.5")], b: [v4("10.0.0.7")] })).toBe("10.0.0.7");
    expect(pickLanAddress({ a: [v4("172.20.1.1")] })).toBe("172.20.1.1");
  });
  test("falls back to the first non-internal IPv4", () => {
    expect(pickLanAddress({ a: [v4("100.64.0.1")] })).toBe("100.64.0.1");
  });
  test("skips virtual interfaces listed before the real one", () => {
    expect(pickLanAddress({ docker0: [v4("172.17.0.1")], "br-1a2b": [v4("172.18.0.1")], veth9: [v4("10.1.0.1")], en0: [v4("192.168.1.20")] })).toBe("192.168.1.20");
  });
  test("skips VPN tunnels (utun 10.8.0.2)", () => {
    expect(pickLanAddress({ utun4: [v4("10.8.0.2")], tailscale0: [v4("10.9.0.1")], wg0: [v4("10.7.0.1")], en0: [v4("192.168.1.20")] })).toBe("192.168.1.20");
    expect(pickLanAddress({ utun4: [v4("10.8.0.2")] })).toBeNull();
  });
  test("a lone public address is returned but flagged non-private", () => {
    expect(pickLanAddress({ eth0: [v4("203.0.113.7")] })).toBe("203.0.113.7");
    expect(isPrivateIPv4("203.0.113.7")).toBe(false);
  });
  test("null when there is none", () => {
    expect(pickLanAddress({ lo0: [v4("127.0.0.1", true)] })).toBeNull();
  });
});

describe("isPrivateIPv4", () => {
  test("RFC 1918 ranges only", () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1"]) expect(isPrivateIPv4(ip)).toBe(true);
    for (const ip of ["172.15.0.1", "172.32.0.1", "192.169.0.1", "100.64.0.1", "8.8.8.8", "nonsense"]) expect(isPrivateIPv4(ip)).toBe(false);
  });
});
