import { describe, expect, it } from 'vitest';
import { cleanTitle } from '../lib/workspace/title.ts';

describe('terminal titles in the workspace (L9)', () => {
  it('drops controls, bidi overrides, isolates, zero-width characters and the BOM', () => {
    expect(cleanTitle('vim \u202egnp.exe\u202c')).toBe('vim gnp.exe');
    expect(cleanTitle('\u2066a\u2069\u200bb\u200c\u200dc\u200e\u200fd\ufeff')).toBe('abcd');
    expect(cleanTitle('bell\x07 esc\x1b c1\u0085 del\x7f')).toBe('bell esc c1 del');
    expect(cleanTitle('  many   spaces  here ')).toBe('many spaces here');
    expect(cleanTitle('tab\there')).toBe('tabhere');
    expect(cleanTitle('\u200b\u202e')).toBeNull();
    expect(cleanTitle('\u00e9\u4e2d\ud83d\ude00')).toBe('\u00e9\u4e2d\ud83d\ude00');
    expect(cleanTitle('t'.repeat(200))).toHaveLength(120);
  });
});
