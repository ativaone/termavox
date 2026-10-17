import { describe, expect, it } from 'vitest';
import { resolveOpenParam } from '../../lib/workspace/open-param.ts';

describe('/workspace?open=<sessionId> (plan D-27)', () => {
  const mine = ['01a1-aaaa', '01a1-bbbb'];

  it('shows a session of the user and asks for the URL to be cleaned', () => {
    expect(resolveOpenParam('?open=01a1-bbbb', mine)).toEqual({
      sessionId: '01a1-bbbb',
      present: true,
    });
    expect(resolveOpenParam(new URLSearchParams('open=01a1-aaaa'), mine)).toEqual({
      sessionId: '01a1-aaaa',
      present: true,
    });
  });

  it('drops an unknown, foreign or empty id but still cleans the URL', () => {
    expect(resolveOpenParam('?open=01a1-zzzz', mine)).toEqual({ sessionId: null, present: true });
    expect(resolveOpenParam('?open=', mine)).toEqual({ sessionId: null, present: true });
    expect(resolveOpenParam('?open=%20', mine)).toEqual({ sessionId: null, present: true });
  });

  it('is inert without the parameter', () => {
    expect(resolveOpenParam('', mine)).toEqual({ sessionId: null, present: false });
    expect(resolveOpenParam('?s=01a1-aaaa', mine)).toEqual({ sessionId: null, present: false });
    expect(resolveOpenParam(null, [])).toEqual({ sessionId: null, present: false });
  });
});
