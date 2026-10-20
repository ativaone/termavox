import { describe, expect, it } from 'vitest';
import { ErrorCode, isTermavoxError, TermavoxError } from './errors.ts';

describe('isTermavoxError', () => {
  it('matches an instance of this module', () => {
    const err = new TermavoxError(ErrorCode.Forbidden, 'invalid setup token');
    expect(isTermavoxError(err)).toBe(true);
  });

  it('matches an instance of another copy of the class, as a second bundle layer creates', () => {
    class OtherCopy extends Error {
      readonly code = ErrorCode.Forbidden;
      constructor() {
        super('invalid setup token');
        this.name = 'TermavoxError';
      }
    }
    const err: unknown = new OtherCopy();
    expect(err instanceof TermavoxError).toBe(false);
    expect(isTermavoxError(err)).toBe(true);
  });

  it('rejects other errors and look-alike plain objects', () => {
    expect(isTermavoxError(new Error('boom'))).toBe(false);
    expect(isTermavoxError(Object.assign(new Error('x'), { name: 'TermavoxError' }))).toBe(false);
    expect(isTermavoxError({ name: 'TermavoxError', code: 'FORBIDDEN', message: 'x' })).toBe(false);
    expect(isTermavoxError(null)).toBe(false);
  });
});
