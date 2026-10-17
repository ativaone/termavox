import { describe, expect, it } from 'vitest';
import { normalizeHostname } from './address.ts';

describe('normalizeHostname', () => {
  it('trims and lowercases names', () => {
    expect(normalizeHostname('  DB.Internal ')).toBe('db.internal');
    expect(normalizeHostname('api-prod')).toBe('api-prod');
  });

  it('keeps IPv4 as typed', () => {
    expect(normalizeHostname('10.0.0.12')).toBe('10.0.0.12');
  });

  it('stores IPv6 without brackets, lowercased', () => {
    expect(normalizeHostname('[::1]')).toBe('::1');
    expect(normalizeHostname('[FE80::1]')).toBe('fe80::1');
    expect(normalizeHostname('fe80::1')).toBe('fe80::1');
  });

  it('is idempotent', () => {
    for (const raw of ['DB.Internal', '[::1]', ' 10.0.0.12 ']) {
      const once = normalizeHostname(raw);
      expect(normalizeHostname(once)).toBe(once);
    }
  });
});
