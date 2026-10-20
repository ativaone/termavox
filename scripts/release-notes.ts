// The release notes of a version (release contract), printed as Markdown on stdout:
//
//   node scripts/release-notes.ts <version>
//
// The body of the `## [<version>]` section of CHANGELOG.md. A release candidate (X.Y.Z-rc.N) without
// a section of its own gets the `## [Unreleased]` section instead; a final release must have its
// section. Exits non-zero, with the reason on stderr, when there is no such section or it is
// empty. The heading itself and the link references at the end of the file are left out.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isReleaseCandidate, isValidVersion } from './set-version.ts';

const ROOT = join(import.meta.dirname, '..');
export const UNRELEASED = 'Unreleased';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LINK_REFERENCE = /^\[[^\]]+\]:\s*\S/;

/**
 * The body of the `## [<name>]` section (trimmed; the heading excluded), or null when there is no
 * such heading. The section ends at the next `## ` heading or at the link references that close
 * the file.
 */
export function changelogSection(changelog: string, name: string): string | null {
  const lines = changelog.split(/\r?\n/);
  const heading = new RegExp(`^## \\[${escapeRegExp(name)}\\](?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return null;
  // The trailing block of link reference definitions (blank lines between them allowed).
  let tail = lines.length;
  for (let i = lines.length - 1; i > start; i--) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (!LINK_REFERENCE.test(line)) break;
    tail = i;
  }
  let end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  if (end < 0 || end > tail) end = tail;
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
}

export type ReleaseNotes =
  | { ok: true; section: string; body: string }
  | { ok: false; error: string };

/** The notes for `version`: its own section, or Unreleased for a release candidate. */
export function releaseNotes(changelog: string, version: string): ReleaseNotes {
  if (!isValidVersion(version)) {
    return { ok: false, error: `"${version}" is not a valid version: X.Y.Z or X.Y.Z-rc.N` };
  }
  const candidates = isReleaseCandidate(version) ? [version, UNRELEASED] : [version];
  for (const section of candidates) {
    const body = changelogSection(changelog, section);
    if (body === null) continue;
    if (body === '') return { ok: false, error: `the ## [${section}] section is empty` };
    return { ok: true, section, body };
  }
  return {
    ok: false,
    error: isReleaseCandidate(version)
      ? `CHANGELOG.md has neither a ## [${version}] nor a ## [${UNRELEASED}] section`
      : `CHANGELOG.md has no ## [${version}] section (only release candidates fall back to ## [${UNRELEASED}])`,
  };
}

function main(args: string[]): number {
  const [version] = args;
  if (version === undefined || args.length !== 1) {
    console.error('usage: node scripts/release-notes.ts <version>');
    return 2;
  }
  const notes = releaseNotes(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
  if (!notes.ok) {
    console.error(`release-notes: ${notes.error}`);
    return 1;
  }
  if (notes.section !== version) {
    console.error(`release-notes: ${version}: no section of its own, using ## [${notes.section}]`);
  }
  process.stdout.write(`${notes.body}\n`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
