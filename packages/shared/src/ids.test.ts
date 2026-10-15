import { describe, expect, it } from 'vitest';
import { randomToken, uuidv7 } from './ids.ts';

describe('uuidv7', () => {
  it('encodes version, variant and a sortable timestamp', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    expect(Number.parseInt(a.replace(/-/g, '').slice(0, 12), 16)).toBe(1_700_000_000_000);
  });
});

describe('randomToken', () => {
  it('only uses tmux-safe characters', () => {
    expect(randomToken(64)).toMatch(/^[a-z2-7]{64}$/);
  });
});
