import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { XTERM_VERSION } from '@termavox/terminal-config';
import { describe, expect, it } from 'vitest';

interface Manifest {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const root = new URL('../../../../', import.meta.url);
const readManifest = (path: string): Manifest =>
  JSON.parse(readFileSync(new URL(path, root), 'utf8')) as Manifest;
const declared = (m: Manifest, name: string) => m.dependencies?.[name] ?? m.devDependencies?.[name];

// The server and the browser must parse identical bytes with the identical engine (plan T-02).
describe('xterm version pin', () => {
  it('the installed @xterm/headless is XTERM_VERSION', () => {
    const require = createRequire(import.meta.url);
    expect((require('@xterm/headless/package.json') as Manifest).version).toBe(XTERM_VERSION);
    expect(declared(readManifest('apps/session-manager/package.json'), '@xterm/headless')).toBe(
      XTERM_VERSION,
    );
  });

  it('apps/web declares the same @xterm/xterm and addon versions, if present', () => {
    if (!existsSync(new URL('apps/web/package.json', root))) return;
    const web = readManifest('apps/web/package.json');
    const server = readManifest('apps/session-manager/package.json');
    if (declared(web, '@xterm/xterm')) expect(declared(web, '@xterm/xterm')).toBe(XTERM_VERSION);
    for (const addon of ['@xterm/addon-unicode11', '@xterm/addon-serialize']) {
      if (declared(web, addon)) expect(declared(web, addon)).toBe(declared(server, addon));
    }
  });
});
