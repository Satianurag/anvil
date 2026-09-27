import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { config } from "../config.ts";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(net, prefix, "ipv6");

export class UnsafeTargetError extends Error {}

/** Throws unless the URL is http(s) and every resolved address is public. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new UnsafeTargetError(`protocol ${url.protocol} not allowed`);
  if (config.ALLOW_PRIVATE_TARGETS) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  for (const { address, family } of addrs) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    if (mapped ? blocked.check(mapped, "ipv4") : blocked.check(address, family === 6 ? "ipv6" : "ipv4"))
      throw new UnsafeTargetError(`${host} resolves to non-public address`);
  }
  return url;
}
