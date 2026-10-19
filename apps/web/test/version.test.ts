import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VERSION } from '../lib/version.ts';

// instrumentation.ts boots the auth runtime after logging; here it is never ready.
vi.mock('../lib/auth/server.ts', () => ({
  getAuthRuntime: () => {
    throw new Error('not ready');
  },
}));

function manifestVersion(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')).version;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('running version', () => {
  it('is the web package version, the same as the daemon one', () => {
    expect(VERSION).toBe(manifestVersion('../package.json'));
    expect(VERSION).toBe(manifestVersion('../../session-manager/package.json'));
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-rc\.\d+)?$/);
  });

  it('is logged once when the web server starts', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const { register } = await import('../instrumentation.ts');
    await register();
    expect(info.mock.calls).toEqual([[`[termdock] web starting {"version":"${VERSION}"}`]]);
  });
});
