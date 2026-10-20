import { ErrorCode, TermavoxError } from '@termavox/shared';
import { describe, expect, it } from 'vitest';
import { SftpError, SftpStatus, TransportError } from '../../src/core/types.ts';
import { fileError, SERVER_MESSAGE_MAX } from '../../src/files/errors.ts';
import { isRemotePath, namedPath, normalizePath } from '../../src/files/paths.ts';

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as TermavoxError).code;
  }
};

describe('remote paths', () => {
  it('normalizes lexically, keeping the root', () => {
    expect(normalizePath('/a/./b//c/')).toBe('/a/b/c');
    expect(normalizePath('/a/b/../c')).toBe('/a/c');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('/..')).toBe('/');
  });

  it('splits a path that names an entry into its folder and name', () => {
    expect(namedPath('/home/tv/new folder')).toEqual({
      path: '/home/tv/new folder',
      parent: '/home/tv',
      name: 'new folder',
    });
    expect(namedPath('/x')).toEqual({ path: '/x', parent: '/', name: 'x' });
    expect(namedPath('/a/./b//c')).toEqual({ path: '/a/b/c', parent: '/a/b', name: 'c' });
  });

  it('refuses a last segment that cannot name an entry (NAME_INVALID)', () => {
    for (const raw of ['/', '/a/', '/a/.', '/a/..', '/a/b\0c', `/a/${'é'.repeat(128)}`]) {
      expect(
        codeOf(() => namedPath(raw)),
        raw,
      ).toBe(ErrorCode.NameInvalid);
    }
    // 255 UTF-8 bytes is the limit, not 255 characters.
    expect(namedPath(`/a/${'x'.repeat(255)}`).name).toHaveLength(255);
    expect(codeOf(() => namedPath(`/a/${'x'.repeat(256)}`))).toBe(ErrorCode.NameInvalid);
  });

  it('accepts only absolute, bounded, NUL-free paths from the server', () => {
    expect(isRemotePath('/home/tv')).toBe(true);
    expect(isRemotePath('home/tv')).toBe(false);
    expect(isRemotePath('/a\0b')).toBe(false);
    expect(isRemotePath(`/${'a'.repeat(4096)}`)).toBe(false);
    expect(isRemotePath(42)).toBe(false);
  });
});

describe('file errors', () => {
  const mapped = (err: unknown) => {
    const out = fileError(err);
    return { code: out.code, message: out.message };
  };

  it('maps SFTP statuses to the panel codes', () => {
    expect(mapped(new SftpError(SftpStatus.NoSuchFile, 'No such file')).code).toBe(
      ErrorCode.NotFound,
    );
    expect(mapped(new SftpError(SftpStatus.PermissionDenied, 'nope')).code).toBe(
      ErrorCode.PermissionDenied,
    );
    for (const status of [SftpStatus.NoConnection, SftpStatus.ConnectionLost]) {
      expect(mapped(new SftpError(status, 'gone')).code).toBe(ErrorCode.SessionNotConnected);
    }
    for (const status of [SftpStatus.Failure, SftpStatus.OpUnsupported, SftpStatus.BadMessage]) {
      expect(mapped(new SftpError(status, 'Operation failed'))).toEqual({
        code: ErrorCode.FileOpFailed,
        message: 'Operation failed',
      });
    }
  });

  it("cleans and caps the server's message, and never sends an unknown error's text", () => {
    const hostile = `bad\x1b[31m‮${'x'.repeat(500)}`;
    const { message } = mapped(new SftpError(SftpStatus.Failure, hostile));
    expect(message).toMatch(/^bad\[31mx+$/);
    expect(message.length).toBeLessThanOrEqual(SERVER_MESSAGE_MAX);
    expect(mapped(new SftpError(SftpStatus.Failure, '\x07')).message).toBe(
      'the server could not do it',
    );
    expect(mapped(new Error('secret internals at /srv/x'))).toEqual({
      code: ErrorCode.Internal,
      message: 'internal error',
    });
  });

  it('passes TermavoxErrors through and treats transport errors as not connected', () => {
    const conflict = new TermavoxError(ErrorCode.Conflict, 'exists');
    expect(fileError(conflict)).toBe(conflict);
    expect(mapped(new TransportError(ErrorCode.HostUnreachable, 'down', true)).code).toBe(
      ErrorCode.SessionNotConnected,
    );
  });
});
