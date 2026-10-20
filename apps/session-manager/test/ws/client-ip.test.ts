import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.ts';
import { clientAddress, TrustedProxies } from '../../src/ws/client-ip.ts';

describe('client address behind a trusted proxy (plan §4.3)', () => {
  const caddy = new TrustedProxies(['172.30.10.0/24', '2001:db8::1']);

  it('believes X-Forwarded-For only from a trusted peer', () => {
    expect(clientAddress('172.30.10.5', '203.0.113.7', caddy)).toBe('203.0.113.7');
    expect(clientAddress('2001:db8::1', ['2001:db8::99'], caddy)).toBe('2001:db8::99');
    // Untrusted peer (outside the subnet), or nothing trusted at all: the socket address.
    expect(clientAddress('172.30.11.5', '203.0.113.7', caddy)).toBe('172.30.11.5');
    expect(clientAddress('172.30.10.5', '203.0.113.7', new TrustedProxies([]))).toBe('172.30.10.5');
    // Trusted peer without a usable header.
    expect(clientAddress('172.30.10.5', undefined, caddy)).toBe('172.30.10.5');
    expect(clientAddress('172.30.10.5', '', caddy)).toBe('172.30.10.5');
    expect(clientAddress('172.30.10.5', ' , ', caddy)).toBe('172.30.10.5');
  });

  it('takes the rightmost value that is not a trusted proxy, like Better Auth (L7)', () => {
    // A proxy that appends: the client's own (spoofable) values sit to the left.
    expect(clientAddress('172.30.10.5', '198.51.100.66, 203.0.113.7', caddy)).toBe('203.0.113.7');
    expect(clientAddress('::ffff:172.30.10.5', '203.0.113.7, 10.0.0.1', caddy)).toBe('10.0.0.1');
    expect(clientAddress('172.30.10.5', 'evil, 203.0.113.7', caddy)).toBe('203.0.113.7');
    // Trusted hops on the right are skipped (IPv4-mapped forms too).
    expect(
      clientAddress('172.30.10.5', '1.2.3.4, 203.0.113.7, 172.30.10.9, ::ffff:172.30.10.8', caddy),
    ).toBe('203.0.113.7');
    expect(clientAddress('2001:db8::1', '2001:db8::99, 2001:db8::1', caddy)).toBe('2001:db8::99');
    // Several header lines read as one list, in order.
    expect(clientAddress('172.30.10.5', ['198.51.100.66', '203.0.113.7'], caddy)).toBe(
      '203.0.113.7',
    );
    // A non-IP value before the client is found, or only trusted hops: the socket address.
    expect(clientAddress('172.30.10.5', '203.0.113.7, evil', caddy)).toBe('172.30.10.5');
    expect(clientAddress('172.30.10.5', '172.30.10.9, 172.30.10.8', caddy)).toBe('172.30.10.5');
  });

  it('TERMAVOX_TRUSTED_PROXIES defaults to none and rejects anything but IPs and CIDRs', () => {
    const env = {
      TERMAVOX_PUBLIC_URL: 'https://termavox.test',
      TERMAVOX_WS_SECRET_FILE: '/run/secrets/ws_secret',
    };
    expect(loadConfig(env).trustedProxies).toEqual([]);
    expect(
      loadConfig({ ...env, TERMAVOX_TRUSTED_PROXIES: ' 172.30.10.0/24, ::1 ,' }).trustedProxies,
    ).toEqual(['172.30.10.0/24', '::1']);
    for (const bad of ['caddy', '172.30.10.0/33', '10.0.0.1/8/1', '::1/129']) {
      expect(() => loadConfig({ ...env, TERMAVOX_TRUSTED_PROXIES: bad })).toThrow(
        /TERMAVOX_TRUSTED_PROXIES/,
      );
    }
  });
});
