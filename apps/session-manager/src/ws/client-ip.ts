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
 * The client address of a connection: the first `X-Forwarded-For` value when the socket peer is
 * a trusted proxy and that value is an IP, otherwise the socket peer itself.
 */
export function clientAddress(
  peer: string | undefined,
  forwardedFor: string | string[] | undefined,
  trusted: TrustedProxies,
): string | undefined {
  const socket = peer === undefined ? undefined : unmapIPv4(peer);
  if (!trusted.has(socket)) return socket;
  const header = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const first = header?.split(',')[0]?.trim();
  return first && isIP(unmapIPv4(first)) !== 0 ? unmapIPv4(first) : socket;
}

/** `::ffff:192.0.2.1` → `192.0.2.1` (dual-stack sockets report IPv4 peers mapped). */
function unmapIPv4(address: string): string {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return match?.[1] ?? address;
}
