import { describe, expect, it } from 'vitest';
import { ErrorCode, isTermdockError, TermdockError } from './errors.ts';

describe('isTermdockError', () => {
  it('matches an instance of this module', () => {
    const err = new TermdockError(ErrorCode.Forbidden, 'invalid setup token');
    expect(isTermdockError(err)).toBe(true);
  });

  it('matches an instance of another copy of the class, as a second bundle layer creates', () => {
    class OtherCopy extends Error {
      readonly code = ErrorCode.Forbidden;
      constructor() {
        super('invalid setup token');
        this.name = 'TermdockError';
      }
    }
    const err: unknown = new OtherCopy();
    expect(err instanceof TermdockError).toBe(false);
    expect(isTermdockError(err)).toBe(true);
  });

  it('rejects other errors and look-alike plain objects', () => {
    expect(isTermdockError(new Error('boom'))).toBe(false);
    expect(isTermdockError(Object.assign(new Error('x'), { name: 'TermdockError' }))).toBe(false);
    expect(isTermdockError({ name: 'TermdockError', code: 'FORBIDDEN', message: 'x' })).toBe(false);
    expect(isTermdockError(null)).toBe(false);
  });
});
