import { FILES_LIMITS, type ServerMessage, TRANSFER_TOKEN_TTL_MS } from '@termdock/protocol';
import { ErrorCode, type TermdockError } from '@termdock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentDisposition } from '../../src/files/content-disposition.ts';
import { TOKEN_PATTERN, type TransferGrantInput } from '../../src/files/transfer-tokens.ts';
import { PROGRESS_INTERVAL_MS, Transfers } from '../../src/files/transfers.ts';

type Progress = Extract<ServerMessage, { type: 'transfer.progress' }>;

function grantInput(
  overrides: Partial<{
    userId: string;
    authSessionId: string;
    notify: (m: ServerMessage) => void;
  }> = {},
  direction: 'upload' | 'download' = 'download',
): TransferGrantInput {
  const base = {
    userId: 'user-1',
    authSessionId: 'asid-1',
    sessionId: 'session-1',
    size: 100,
    notify: () => {},
    client: { ip: '203.0.113.7' },
    ...overrides,
  };
  return direction === 'download'
    ? { ...base, direction, path: '/data/a.txt' }
    : { ...base, direction, dir: '/data', name: 'a.txt', path: '/data/a.txt', overwrite: false };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('transfer URLs', () => {
  it('are 32 random bytes, single use and bound to their direction', () => {
    const transfers = new Transfers();
    const { token, grant } = transfers.mint(grantInput());
    expect(token).toMatch(TOKEN_PATTERN);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(transfers.mint(grantInput()).token).not.toBe(token);
    expect(transfers.consume(token, 'download')).toBe(grant);
    expect(transfers.consume(token, 'download')).toBeNull(); // spent

    // Used for the other direction: refused, and spent all the same.
    const upload = transfers.mint(grantInput({}, 'upload'));
    expect(transfers.consume(upload.token, 'download')).toBeNull();
    expect(transfers.consume(upload.token, 'upload')).toBeNull();
    expect(transfers.consume('x'.repeat(43), 'download')).toBeNull();
  });

  it('expire after their lifetime and tell the minting connection (TRANSFER_EXPIRED)', () => {
    vi.useFakeTimers();
    const told: ServerMessage[] = [];
    const transfers = new Transfers();
    const late = transfers.mint(grantInput({ notify: (m) => told.push(m) }));
    vi.advanceTimersByTime(TRANSFER_TOKEN_TTL_MS - 1);
    expect(told).toEqual([]);
    const fresh = transfers.mint(grantInput());
    expect(transfers.consume(fresh.token, 'download')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(told).toEqual([
      {
        type: 'transfer.progress',
        transferId: late.grant.transferId,
        bytes: 0,
        size: 100,
        state: 'failed',
        code: ErrorCode.TransferExpired,
      },
    ]);
    expect(transfers.tokens.size).toBe(0);
    expect(transfers.consume(late.token, 'download')).toBeNull();
    // A used, voided or revoked URL never reports an expiry.
    const used = transfers.mint(grantInput({ notify: (m) => told.push(m) }));
    transfers.consume(used.token, 'download');
    const voided = transfers.mint(grantInput({ notify: (m) => told.push(m) }));
    transfers.cancel('user-1', voided.grant.transferId);
    transfers.mint(grantInput({ notify: (m) => told.push(m) }));
    transfers.revoke({ userId: 'user-1' });
    vi.advanceTimersByTime(TRANSFER_TOKEN_TTL_MS * 2);
    expect(told).toHaveLength(1);
  });

  it('refuse a URL used just after its lifetime, telling its connection once', () => {
    let now = 1_000;
    const told: ServerMessage[] = [];
    const transfers = new Transfers({ now: () => now });
    const { token } = transfers.mint(grantInput({ notify: (m) => told.push(m) }));
    now += TRANSFER_TOKEN_TTL_MS;
    expect(transfers.consume(token, 'download')).toBeNull();
    expect(told.map((m) => (m as Progress).code)).toEqual([ErrorCode.TransferExpired]);
    expect(transfers.consume(token, 'download')).toBeNull();
    expect(told).toHaveLength(1);
  });

  it('are revoked by user or by auth session, and voided by their own user only', () => {
    const transfers = new Transfers();
    const a = transfers.mint(grantInput());
    const b = transfers.mint(grantInput({ authSessionId: 'asid-2' }));
    const c = transfers.mint(grantInput({ userId: 'user-2', authSessionId: 'asid-3' }));
    transfers.revoke({ authSessionId: 'asid-2' });
    expect(transfers.consume(b.token, 'download')).toBeNull();
    expect(transfers.cancel('user-1', c.grant.transferId)).toBe(false);
    transfers.revoke({ userId: 'user-1' });
    expect(transfers.consume(a.token, 'download')).toBeNull();
    expect(transfers.consume(c.token, 'download')).not.toBeNull();
  });

  it('are capped per user while unused (RATE_LIMITED)', () => {
    const transfers = new Transfers();
    for (let i = 0; i < 64; i++) transfers.mint(grantInput());
    const err = (() => {
      try {
        transfers.mint(grantInput());
      } catch (e) {
        return e as TermdockError;
      }
    })();
    expect(err?.code).toBe(ErrorCode.RateLimited);
    expect(() => transfers.mint(grantInput({ userId: 'user-2' }))).not.toThrow();
  });
});

describe('running transfers', () => {
  it(`allow ${FILES_LIMITS.transfersPerUser} per user at once (RATE_LIMITED beyond)`, () => {
    const transfers = new Transfers();
    const running = Array.from({ length: FILES_LIMITS.transfersPerUser }, () =>
      transfers.begin(transfers.mint(grantInput()).grant),
    );
    expect(() => transfers.begin(transfers.mint(grantInput()).grant)).toThrow(
      expect.objectContaining({ code: ErrorCode.RateLimited }),
    );
    expect(() => transfers.begin(transfers.mint(grantInput({ userId: 'u2' })).grant)).not.toThrow();
    running[0]!.finish({ state: 'done' });
    expect(() => transfers.begin(transfers.mint(grantInput()).grant)).not.toThrow();
  });

  it('send progress at the start, at most four times a second, and once at the end', () => {
    let now = 0;
    const told: Progress[] = [];
    const transfers = new Transfers({ now: () => now });
    const transfer = transfers.begin(
      transfers.mint(grantInput({ notify: (m) => told.push(m as Progress) })).grant,
    );
    transfer.start(5_000);
    for (let bytes = 1; bytes <= 5_000; bytes++) {
      now += 1; // 5 s of progress, one call per ms
      transfer.progress(bytes);
    }
    transfer.finish({ state: 'done' });
    transfer.progress(9); // after the end: nothing
    expect(told[0]).toMatchObject({ bytes: 0, size: 5_000, state: 'running' });
    expect(told.at(-1)).toMatchObject({ bytes: 5_000, size: 5_000, state: 'done' });
    const running = told.filter((m) => m.state === 'running');
    expect(running.length).toBeLessThanOrEqual(1 + 5_000 / PROGRESS_INTERVAL_MS);
    expect(running.length).toBeGreaterThanOrEqual(5_000 / PROGRESS_INTERVAL_MS);
    expect(told.filter((m) => m.state !== 'running')).toHaveLength(1);
  });

  it('stop by their user (cancelled), by a revoke or at shutdown (failed with a code)', () => {
    const transfers = new Transfers();
    const begin = (overrides = {}) => transfers.begin(transfers.mint(grantInput(overrides)).grant);
    const mine = begin();
    const other = begin({ userId: 'user-2', authSessionId: 'asid-9' });
    expect(transfers.cancel('user-2', mine.transferId)).toBe(false);
    expect(transfers.cancel('user-1', mine.transferId)).toBe(true);
    expect(mine.signal.reason).toMatchObject({ end: { state: 'cancelled' } });
    const revoked = begin({ authSessionId: 'asid-5' });
    transfers.revoke({ authSessionId: 'asid-5' });
    expect(revoked.signal.reason).toMatchObject({
      end: { state: 'failed', code: ErrorCode.Unauthenticated },
    });
    expect(other.signal.aborted).toBe(false);
    transfers.close();
    expect(other.signal.reason).toMatchObject({
      end: { state: 'failed', code: ErrorCode.Cancelled },
    });
    expect(() => transfers.mint(grantInput())).toThrow();
  });
});

describe('Content-Disposition of a download', () => {
  const header = (name: string) => contentDisposition(name);

  it('keeps an ASCII name as it is, in both forms', () => {
    expect(header('report-2026.pdf')).toBe(
      `attachment; filename="report-2026.pdf"; filename*=UTF-8''report-2026.pdf`,
    );
  });

  it('escapes quotes and backslashes in the fallback, percent-encodes the exact name', () => {
    expect(header('say "hi" \\ bye.txt')).toBe(
      `attachment; filename="say \\"hi\\" \\\\ bye.txt"; filename*=UTF-8''say%20%22hi%22%20%5C%20bye.txt`,
    );
    // RFC 5987 attr-char excludes what encodeURIComponent keeps: ' ( ) * !
    expect(header("it's (1)*!.txt")).toContain(`filename*=UTF-8''it%27s%20%281%29%2A%21.txt`);
  });

  it('replaces non-ASCII and control characters in the fallback only', () => {
    expect(header('relatório.pdf')).toBe(
      `attachment; filename="relat_rio.pdf"; filename*=UTF-8''relat%C3%B3rio.pdf`,
    );
    expect(header('報告.txt')).toBe(
      `attachment; filename="__.txt"; filename*=UTF-8''%E5%A0%B1%E5%91%8A.txt`,
    );
    expect(header('😀.png')).toBe(
      `attachment; filename="_.png"; filename*=UTF-8''%F0%9F%98%80.png`,
    );
    const control = header('a\tb\x7fc\r\n.txt');
    expect(control).toBe(
      `attachment; filename="a_b_c__.txt"; filename*=UTF-8''a%09b%7Fc%0D%0A.txt`,
    );
    expect(control).not.toMatch(/[\r\n\t\x7f]/);
  });
});
