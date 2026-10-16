import { BlockList, isIP } from 'node:net';

/**
 * Trusted proxies (`TERMDOCK_TRUSTED_PROXIES`, plan §4.3): IPs and CIDRs whose connections may
 * name the client in `X-Forwarded-For`. Empty trusts nothing.
 */
export class TrustedProxies {
  readonly #list = new BlockList();
  readonly size: number;

  /** Throws on an entry that is neither an IP nor a CIDR. */
  constructor(entries: readonly string[]) {
    for (const entry of entries) {
      const [address = '', prefix, extra] = entry.split('/');
      const family = isIP(address);
      const bits = family === 4 ? 32 : 128;
      const type = family === 4 ? 'ipv4' : 'ipv6';
      if (family === 0 || extra !== undefined) throw new Error(`not an IP or CIDR: ${entry}`);
      if (prefix === undefined) {
        this.#list.addAddress(address, type);
        continue;
      }
      const length = /^\d{1,3}$/.test(prefix) ? Number(prefix) : Number.NaN;
      if (!(length >= 0 && length <= bits)) throw new Error(`not an IP or CIDR: ${entry}`);
      this.#list.addSubnet(address, length, type);
    }
    this.size = entries.length;
  }

  has(address: string | undefined): boolean {
    if (!address || this.size === 0) return false;
    const plain = unmapIPv4(address);
    const family = isIP(plain);
    return family !== 0 && this.#list.check(plain, family === 4 ? 'ipv4' : 'ipv6');
  }
}

/** Parses the comma-separated variable; blanks are ignored. Throws on an invalid entry. */
export function parseTrustedProxies(value: string): string[] {
  const entries = value
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  new TrustedProxies(entries); // validates
  return entries;
}

/**
 * The client address of a connection. Only when the socket peer is a trusted proxy is
 * `X-Forwarded-For` read, from the right (the end proxies append to): trusted proxies are
 * skipped, and the first other value is the client, as in Better Auth. Values to its left were
 * written by the client itself and are never believed. Without such a value (an empty header,
 * a non-IP value before the client is found, only trusted hops) it is the socket peer.
 */
export function clientAddress(
  peer: string | undefined,
  forwardedFor: string | string[] | undefined,
  trusted: TrustedProxies,
): string | undefined {
  const socket = peer === undefined ? undefined : unmapIPv4(peer);
  if (!trusted.has(socket)) return socket;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '');
  const hops = header
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = unmapIPv4(hops[i]!);
    if (isIP(hop) === 0) return socket;
    if (!trusted.has(hop)) return hop;
  }
  return socket;
}

/** `::ffff:192.0.2.1` → `192.0.2.1` (dual-stack sockets report IPv4 peers mapped). */
function unmapIPv4(address: string): string {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return match?.[1] ?? address;
}
