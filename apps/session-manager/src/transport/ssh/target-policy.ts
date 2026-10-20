import { promises as dns, type LookupAddress, type LookupOptions } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { networkInterfaces } from 'node:os';
import { ErrorCode, TermavoxError } from '@termavox/shared';

/**
 * SSH target policy (plan §10.2). Users choose the hosts the daemon connects to, so by default
 * it refuses addresses that reach the daemon's own machine or network segment: loopback,
 * link-local (cloud metadata services live there), unspecified, multicast, and the daemon's
 * own interface addresses. Private LAN ranges (10/8, 172.16/12, 192.168/16, fc00::/7), and so
 * the Docker host gateway behind `host.docker.internal`, stay allowed: self-hosters target
 * their LAN. `TERMAVOX_SSH_ALLOW_LOCAL_TARGETS=true` allows everything.
 */
export type TargetDenial = 'loopback' | 'link_local' | 'unspecified' | 'multicast' | 'own_address';

/** Every address of a host name (dns.lookup with `all: true`). */
export type ResolveAll = (hostname: string, options: LookupOptions) => Promise<LookupAddress[]>;

export interface TargetPolicyOptions {
  /** TERMAVOX_SSH_ALLOW_LOCAL_TARGETS. */
  allowLocalTargets: boolean;
  /** Default: `dns.lookup(hostname, { all: true })`. */
  resolve?: ResolveAll;
  /** The daemon's own addresses. Default: every address of `os.networkInterfaces()`. */
  localAddresses?: () => Iterable<string>;
}

const defaultResolve: ResolveAll = (hostname, options) =>
  dns.lookup(hostname, { ...options, all: true });

function interfaceAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.address));
}

/** 4 or 16 bytes, or null when `address` is not an IP address (a zone id is ignored). */
export function ipBytes(address: string): Uint8Array | null {
  const plain = address.replace(/%.*$/, '');
  const family = isIP(plain);
  if (family === 4) return Uint8Array.from(plain.split('.').map(Number));
  if (family !== 6) return null;
  let text = plain;
  // An embedded dotted IPv4 tail (`::ffff:127.0.0.1`) becomes two hex groups.
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const zeros = new Array<string>(8 - left.length - right.length).fill('0');
  const groups = rest === undefined ? left : [...left, ...zeros, ...right];
  const bytes = new Uint8Array(16);
  groups.forEach((group, i) => {
    const value = Number.parseInt(group, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  });
  return bytes;
}

/** The IPv4 address an IPv4-mapped (`::ffff:a.b.c.d`) or -compatible IPv6 address carries. */
function embeddedIPv4(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length !== 16 || bytes.subarray(0, 10).some((b) => b !== 0)) return null;
  const mapped = bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible = bytes[10] === 0 && bytes[11] === 0;
  return mapped || compatible ? bytes.subarray(12) : null;
}

function denialOf(bytes: Uint8Array): Exclude<TargetDenial, 'own_address'> | null {
  if (bytes.length === 4) {
    const [a = 0, b = 0] = bytes;
    if (a === 0) return 'unspecified'; // 0.0.0.0/8: Linux connects 0.0.0.0 to itself
    if (a === 127) return 'loopback';
    if (a === 169 && b === 254) return 'link_local';
    if (a >= 224 && a <= 239) return 'multicast';
    return null;
  }
  if (bytes.every((b) => b === 0)) return 'unspecified';
  if (bytes.subarray(0, 15).every((b) => b === 0) && bytes[15] === 1) return 'loopback';
  const v4 = embeddedIPv4(bytes);
  if (v4) return denialOf(v4);
  if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return 'link_local';
  if (bytes[0] === 0xff) return 'multicast';
  return null;
}

/** Comparison key of an address: IPv4-mapped and -compatible forms read as their IPv4. */
function addressKey(bytes: Uint8Array): string {
  return Buffer.from(embeddedIPv4(bytes) ?? bytes).toString('hex');
}

/**
 * Why `address` may not be an SSH target, or null when it may (also for anything that is not an
 * IP address: only resolved addresses are classified).
 */
export function classifyTarget(
  address: string,
  ownAddresses: Iterable<string> = [],
): TargetDenial | null {
  const bytes = ipBytes(address);
  if (!bytes) return null;
  const denial = denialOf(bytes);
  if (denial) return denial;
  const key = addressKey(bytes);
  for (const own of ownAddresses) {
    const ownBytes = ipBytes(own);
    if (ownBytes && addressKey(ownBytes) === key) return 'own_address';
  }
  return null;
}

/**
 * Applies the policy to SSH connections: `target()` checks an IP-literal host before connecting
 * (Node never calls the lookup for literals), and `lookup` is the socket's resolver for names.
 * It resolves once, keeps only allowed addresses and hands those to the socket, so the address
 * connected to is one that passed the check: DNS cannot change between check and connect.
 * Host-key verification stays bound to the host row, whatever the name resolves to.
 */
export class TargetPolicy {
  readonly allowLocalTargets: boolean;
  readonly #resolve: ResolveAll;
  readonly #localAddresses: () => Iterable<string>;

  constructor(options: TargetPolicyOptions) {
    this.allowLocalTargets = options.allowLocalTargets;
    this.#resolve = options.resolve ?? defaultResolve;
    this.#localAddresses = options.localAddresses ?? interfaceAddresses;
  }

  /** Why `address` is refused, or null. */
  denial(address: string): TargetDenial | null {
    if (this.allowLocalTargets) return null;
    return classifyTarget(address, this.#localAddresses());
  }

  /**
   * The host to connect to: an IP literal (brackets removed) once it passed the policy, or the
   * name unchanged (then checked by `lookup`). Throws TARGET_NOT_ALLOWED for a refused literal.
   */
  target(host: string): string {
    const literal = /^\[.*\]$/.test(host) ? host.slice(1, -1) : host;
    if (isIP(literal.replace(/%.*$/, '')) === 0) return host;
    const denial = this.denial(literal);
    if (denial) throw notAllowed(host, denial);
    return literal;
  }

  /** Every allowed address of `hostname`; TARGET_NOT_ALLOWED when there is none. */
  async resolveAllowed(hostname: string, options: LookupOptions = {}): Promise<LookupAddress[]> {
    const addresses = await this.#resolve(hostname, {
      ...(options.family !== undefined ? { family: options.family } : {}),
      ...(options.hints !== undefined ? { hints: options.hints } : {}),
    });
    if (addresses.length === 0) {
      throw Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' });
    }
    const allowed = addresses.filter((a) => this.denial(a.address) === null);
    if (allowed.length === 0) throw notAllowed(hostname, this.denial(addresses[0]!.address)!);
    return allowed;
  }

  /** `net.connect` resolver: only allowed addresses ever reach the socket. */
  readonly lookup: LookupFunction = (hostname, options, callback) => {
    this.resolveAllowed(hostname, options).then(
      (addresses) => {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, ''),
    );
  };
}

function notAllowed(host: string, denial: TargetDenial): TermavoxError {
  return new TermavoxError(
    ErrorCode.TargetNotAllowed,
    `SSH target ${host} is not allowed (${denial.replace('_', ' ')} address)`,
    { denial },
  );
}
