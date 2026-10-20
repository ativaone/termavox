import { FILES_LIMITS, type ServerMessage, TRANSFER_TOKEN_TTL_MS } from '@termdock/protocol';
import { ErrorCode, type TermdockError } from '@termdock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentDisposition } from '../../src/files/content-disposition.ts';
import { TOKEN_PATTERN, type TransferGrantInput } from '../../src/files/transfer-tokens.ts';
import {
  MAX_RUNNING_TRANSFERS,
  PROGRESS_INTERVAL_MS,
  Transfers,
} from '../../src/files/transfers.ts';

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

  it('allow 64 in the whole process at once (RATE_LIMITED beyond)', () => {
    // Regression: only the per-user cap existed.
    expect(MAX_RUNNING_TRANSFERS).toBe(64);
    const transfers = new Transfers();
    const begin = (userId: string) => transfers.begin(transfers.mint(grantInput({ userId })).grant);
    const running = Array.from({ length: 64 }, (_, i) =>
      begin(`user-${Math.floor(i / FILES_LIMITS.transfersPerUser)}`),
    );
    expect(() => begin('someone-else')).toThrow(
      expect.objectContaining({ code: ErrorCode.RateLimited }),
    );
    running[0]!.finish({ state: 'done' });
    expect(() => begin('someone-else')).not.toThrow();
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

  it('replaces non-ASCII and control characters in the fallback', () => {
    expect(header('relatório.pdf')).toBe(
      `attachment; filename="relat_rio.pdf"; filename*=UTF-8''relat%C3%B3rio.pdf`,
    );
    expect(header('報告.txt')).toBe(
      `attachment; filename="__.txt"; filename*=UTF-8''%E5%A0%B1%E5%91%8A.txt`,
    );
    expect(header('😀.png')).toBe(
      `attachment; filename="_.png"; filename*=UTF-8''%F0%9F%98%80.png`,
    );
    const control = header('a\tb\x7fc\r\n\x85.txt');
    // Controls are dropped from the exact name (regression: they were percent-encoded in it).
    expect(control).toBe(`attachment; filename="a_b_c___.txt"; filename*=UTF-8''abc.txt`);
    expect(control).not.toMatch(/[\r\n\t\x7f\x85]/);
  });

  it('drops invisible formatting from both forms: the name reads as what it is', () => {
    // Regression: `report<U+202E>fdp.exe` kept its override in filename* (shown as
    // "reportexe.pdf"), and zero-width characters made two names look alike.
    expect(header('report\u202efdp.exe')).toBe(
      `attachment; filename="reportfdp.exe"; filename*=UTF-8''reportfdp.exe`,
    );
    const invisible = [
      '\u200b', // zero-width space
      '\u200d', // zero-width joiner
      '\u200f', // right-to-left mark
      '\u2066', // left-to-right isolate
      '\u2060', // word joiner
      '\u00ad', // soft hyphen
      '\u061c', // Arabic letter mark
      '\u034f', // combining grapheme joiner
      '\u3164', // Hangul filler
      '\ufeff', // zero-width no-break space
      '\ufff9', // interlinear annotation anchor (a format character, not default-ignorable)
      '\ufffa', // interlinear annotation separator
      '\ufffb', // interlinear annotation terminator
    ];
    for (const ch of invisible) {
      expect(header(`con${ch}fig`)).toBe(`attachment; filename="config"; filename*=UTF-8''config`);
    }
    // The line and paragraph separators break a line like `\n` does: dropped from the exact name
    // as controls are (regression: kept in filename*), `_` in the fallback.
    expect(header('a\u2028b\u2029c.txt')).toBe(
      `attachment; filename="a_b_c.txt"; filename*=UTF-8''abc.txt`,
    );
    // Nothing visible left: a placeholder rather than an empty name.
    expect(header('\u202e\u200b\n')).toBe(`attachment; filename="_"; filename*=UTF-8''_`);
  });
});
