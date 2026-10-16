import { describe, expect, it } from 'vitest';
import { buildCsp, createNonce } from '../lib/csp.ts';

describe('content security policy (plan §10.2)', () => {
  it('locks scripts to the nonce and denies framing', () => {
    const csp = buildCsp('abc123');
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it("adds 'unsafe-eval' only in development", () => {
    expect(buildCsp('n', true)).toContain("'unsafe-eval'");
  });

  it('creates a fresh 128-bit nonce each time', () => {
    const a = createNonce();
    expect(Buffer.from(a, 'base64')).toHaveLength(16);
    expect(createNonce()).not.toBe(a);
  });
});
