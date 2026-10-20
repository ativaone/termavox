import { describe, expect, it } from 'vitest';
import {
  applyVersion,
  composeImages,
  isReleaseCandidate,
  isValidVersion,
  mismatches,
  setPackageVersion,
  type VersionFiles,
  workspaceEntries,
} from '../set-version.ts';

const manifest = (version: string | null) =>
  `{\n  "name": "@termavox/x",\n${version === null ? '' : `  "version": "${version}",\n`}  "private": true,\n  "dependencies": {\n    "y": "1.2.3"\n  },\n  "nested": {\n    "version": "9.9.9"\n  }\n}\n`;

const compose = (tags: Record<string, string>) =>
  [
    'services:',
    '  caddy:',
    `    image: ghcr.io/ativaone/termavox-caddy:${tags.caddy}`,
    '    build:',
    '      context: ..',
    '  web:',
    `    image: ghcr.io/ativaone/termavox-web:${tags.web}`,
    '  session-manager:',
    `    image: ghcr.io/ativaone/termavox-session-manager:${tags['session-manager']}`,
    '  smoke:',
    '    image: termavox-test-sshd:tmux-3.4',
    '',
  ].join('\n');

const files = (
  versions: Record<string, string | null>,
  tags: Record<string, string>,
): VersionFiles => ({
  manifests: new Map(Object.entries(versions).map(([path, v]) => [path, manifest(v)])),
  compose: compose(tags),
});

const ALL = { caddy: '0.0.0', web: '0.0.0', 'session-manager': '0.0.0' };

describe('version validation', () => {
  it.each(['0.0.0', '0.1.0', '1.2.3', '10.20.30', '0.1.0-rc.1', '1.0.0-rc.12'])('accepts %s', (v) =>
    expect(isValidVersion(v)).toBe(true),
  );
  it.each([
    '1.2',
    'v1.2.3',
    '1.2.3-beta',
    '1.2.3-rc',
    '1.2.3-rc.',
    '1.2.3-rc.01',
    '01.2.3',
    '1.2.3.4',
    '1.2.3-RC.1',
    ' 1.2.3',
    '',
  ])('refuses %j', (v) => expect(isValidVersion(v)).toBe(false));
  it('tells release candidates apart', () => {
    expect(isReleaseCandidate('0.1.0-rc.1')).toBe(true);
    expect(isReleaseCandidate('0.1.0')).toBe(false);
  });
});

describe('mismatch report', () => {
  it('is empty when every file agrees', () => {
    expect(
      mismatches(files({ 'package.json': '0.0.0', 'a/package.json': '0.0.0' }, ALL), '0.0.0'),
    ).toEqual([]);
  });
  it('names every disagreeing file and image', () => {
    const problems = mismatches(
      files(
        { 'package.json': null, 'apps/web/package.json': '0.0.0', 'site/package.json': '0.1.0' },
        { caddy: '0.1.0', web: '0.0.9', 'session-manager': '0.1.0' },
      ),
      '0.1.0',
    );
    expect(problems).toEqual([
      'package.json: no "version" field, expected "0.1.0"',
      'apps/web/package.json: version "0.0.0", expected "0.1.0"',
      'deploy/compose.yaml: image ghcr.io/ativaone/termavox-web:0.0.9, expected tag 0.1.0',
    ]);
  });
  it('reports a missing or duplicated image', () => {
    const text = compose(ALL)
      .replace('termavox-caddy:0.0.0', 'termavox-web:0.0.0')
      .replace('termavox-session-manager', 'termavox-other');
    expect(mismatches({ manifests: new Map(), compose: text }, '0.0.0')).toEqual([
      'deploy/compose.yaml: no image ghcr.io/ativaone/termavox-caddy:<version>',
      'deploy/compose.yaml: image ghcr.io/ativaone/termavox-web appears 2 times',
      'deploy/compose.yaml: no image ghcr.io/ativaone/termavox-session-manager:<version>',
      'deploy/compose.yaml: unexpected image ghcr.io/ativaone/termavox-other',
    ]);
  });
});

describe('writing a version', () => {
  it('changes only the top-level version and the three image tags', () => {
    const before = files({ 'package.json': '0.0.0' }, ALL);
    const after = applyVersion(before, '0.1.0-rc.1');
    const text = after.manifests.get('package.json') ?? '';
    expect(text).toBe(manifest('0.1.0-rc.1'));
    expect(text).toContain('"version": "9.9.9"');
    expect(composeImages(after.compose).map((i) => `${i.service}:${i.tag}`)).toEqual([
      'caddy:0.1.0-rc.1',
      'web:0.1.0-rc.1',
      'session-manager:0.1.0-rc.1',
    ]);
    expect(after.compose).toContain('image: termavox-test-sshd:tmux-3.4');
    expect(mismatches(after, '0.1.0-rc.1')).toEqual([]);
    expect(applyVersion(after, '0.0.0')).toEqual(before);
  });
  it('refuses a manifest without a version field, before writing anything', () => {
    expect(() => setPackageVersion(manifest(null), '1.0.0')).toThrow('no top-level "version"');
    expect(() => applyVersion(files({ 'x/package.json': null }, ALL), '1.0.0')).toThrow(
      'x/package.json',
    );
  });
});

describe('workspace entries', () => {
  it('reads the flat packages list of pnpm-workspace.yaml', () => {
    const yaml =
      "packages:\n  - apps/*\n  - 'packages/*'\n  - site # the project site\n\n# note\nallowBuilds:\n  esbuild: false\n";
    expect(workspaceEntries(yaml)).toEqual(['apps/*', 'packages/*', 'site']);
  });
});
