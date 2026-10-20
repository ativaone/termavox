import { describe, expect, it } from 'vitest';
import { changelogSection, releaseNotes } from '../release-notes.ts';

const CHANGELOG = `# Changelog

Intro text.

## [Unreleased]

The next release.

### Added

- Something new.

## [0.1.0] - 2026-10-20

### Security

- Caddy runs as a non-root user.

## [0.0.9]

- Older.

[Unreleased]: https://github.com/ativaone/termavox/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ativaone/termavox/releases/tag/v0.1.0
`;

describe('CHANGELOG section extraction', () => {
  it('returns a section body up to the next heading, without its heading', () => {
    expect(changelogSection(CHANGELOG, 'Unreleased')).toBe(
      'The next release.\n\n### Added\n\n- Something new.',
    );
    expect(changelogSection(CHANGELOG, '0.1.0')).toBe(
      '### Security\n\n- Caddy runs as a non-root user.',
    );
  });
  it('leaves out the link references that close the file', () => {
    expect(changelogSection(CHANGELOG, '0.0.9')).toBe('- Older.');
  });
  it('matches the version exactly', () => {
    expect(changelogSection(CHANGELOG, '0.1')).toBeNull();
    expect(changelogSection(CHANGELOG, '0.1.0-rc.1')).toBeNull();
    expect(changelogSection(CHANGELOG, '0.0.8')).toBeNull();
  });
});

describe('release notes', () => {
  it('uses the version’s own section', () => {
    expect(releaseNotes(CHANGELOG, '0.1.0')).toEqual({
      ok: true,
      section: '0.1.0',
      body: '### Security\n\n- Caddy runs as a non-root user.',
    });
  });
  it('falls back to Unreleased for a release candidate only', () => {
    expect(releaseNotes(CHANGELOG, '0.2.0-rc.1')).toMatchObject({
      ok: true,
      section: 'Unreleased',
    });
    expect(releaseNotes(CHANGELOG, '0.2.0')).toEqual({
      ok: false,
      error:
        'CHANGELOG.md has no ## [0.2.0] section (only release candidates fall back to ## [Unreleased])',
    });
  });
  it('fails without a usable section', () => {
    const noUnreleased = CHANGELOG.replace(/## \[Unreleased\][\s\S]*?(?=## \[0\.1\.0\])/, '');
    expect(releaseNotes(noUnreleased, '0.2.0-rc.1')).toMatchObject({ ok: false });
    expect(releaseNotes('## [Unreleased]\n\n## [0.1.0]\n- x\n', '0.2.0-rc.1')).toEqual({
      ok: false,
      error: 'the ## [Unreleased] section is empty',
    });
    expect(releaseNotes(CHANGELOG, 'v0.1.0')).toMatchObject({ ok: false });
  });
});
