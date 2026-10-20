// The repository version (release contract): the `version` field of every workspace package.json
// (the root one included) and the tags of the three published images in deploy/compose.yaml.
//
//   node scripts/set-version.ts <version>          writes it everywhere
//   node scripts/set-version.ts --check <version>  exits 1 and names every mismatch
//
// Valid versions: X.Y.Z or X.Y.Z-rc.N (numbers without leading zeros). The files are edited in
// place, only the version strings change: nothing is re-serialized or reformatted. The workspace
// packages are the ones pnpm-workspace.yaml lists (no YAML parser: its `packages:` entries are a
// flat list of paths and `dir/*` globs).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
export const COMPOSE_PATH = 'deploy/compose.yaml';
/** The published images, one per service: `ghcr.io/ativaone/termdock-<service>:<version>`. */
export const IMAGE_SERVICES = ['caddy', 'web', 'session-manager'] as const;
export const IMAGE_PREFIX = 'ghcr.io/ativaone/termdock-';

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.(0|[1-9]\d*))?$/;

/** `X.Y.Z` or `X.Y.Z-rc.N`, numbers without leading zeros. */
export function isValidVersion(version: string): boolean {
  return VERSION.test(version);
}

export function isReleaseCandidate(version: string): boolean {
  return isValidVersion(version) && version.includes('-rc.');
}

/** The `packages:` entries of pnpm-workspace.yaml, in order. */
export function workspaceEntries(yaml: string): string[] {
  const entries: string[] = [];
  let inPackages = false;
  for (const line of yaml.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(['"]?)([^'"#\s]+)\1\s*(?:#.*)?$/.exec(line);
    if (!item) break; // the next top-level key
    entries.push(item[2] ?? '');
  }
  return entries;
}

/** The package.json paths (relative to the root) of the root and every workspace package. */
function workspaceManifests(): string[] {
  const manifests = ['package.json'];
  for (const entry of workspaceEntries(readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8'))) {
    if (entry.endsWith('/*') && !entry.slice(0, -2).includes('*')) {
      const dir = entry.slice(0, -2);
      for (const name of readdirSync(join(ROOT, dir), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()) {
        const manifest = `${dir}/${name}/package.json`;
        if (existsSync(join(ROOT, manifest))) manifests.push(manifest);
      }
    } else if (!entry.includes('*')) {
      manifests.push(`${entry}/package.json`);
    } else {
      throw new Error(`pnpm-workspace.yaml: unsupported pattern "${entry}" (only paths and dir/*)`);
    }
  }
  return manifests;
}

/** The top-level `version` of a package.json, or null when it has none. */
export function packageVersion(text: string): string | null {
  const { version } = JSON.parse(text) as { version?: unknown };
  return typeof version === 'string' ? version : null;
}

// Top-level keys sit at two spaces in every manifest (biome's JSON format); nested ones deeper.
const PACKAGE_VERSION_LINE = /^( {2}"version":\s*")[^"]*(")/m;

/** The package.json text with its top-level `version` replaced; throws when it has none. */
export function setPackageVersion(text: string, version: string): string {
  if (!PACKAGE_VERSION_LINE.test(text)) throw new Error('no top-level "version" field');
  const next = text.replace(PACKAGE_VERSION_LINE, `$1${version}$2`);
  if (packageVersion(next) !== version) throw new Error('the "version" field was not replaced');
  return next;
}

export interface ComposeImage {
  service: string;
  tag: string;
}

const COMPOSE_IMAGE_LINE = /^(\s*image:\s*)ghcr\.io\/ativaone\/termdock-([a-z0-9-]+):([^\s#]+)/gm;

/** The published-image references of deploy/compose.yaml, in file order. */
export function composeImages(text: string): ComposeImage[] {
  return [...text.matchAll(COMPOSE_IMAGE_LINE)].map((m) => ({
    service: m[2] ?? '',
    tag: m[3] ?? '',
  }));
}

/** deploy/compose.yaml with the three image tags replaced; throws unless each appears once. */
export function setComposeVersion(text: string, version: string): string {
  const problems = composeProblems(text, null);
  if (problems.length > 0) throw new Error(problems.join('; '));
  return text.replace(COMPOSE_IMAGE_LINE, (_line, lead: string, service: string) => {
    return `${lead}${IMAGE_PREFIX}${service}:${version}`;
  });
}

/** What is wrong with the compose image references (tags too, unless `version` is null). */
function composeProblems(text: string, version: string | null): string[] {
  const images = composeImages(text);
  const problems: string[] = [];
  for (const service of IMAGE_SERVICES) {
    const found = images.filter((image) => image.service === service);
    const name = `${IMAGE_PREFIX}${service}`;
    if (found.length === 0) problems.push(`${COMPOSE_PATH}: no image ${name}:<version>`);
    if (found.length > 1)
      problems.push(`${COMPOSE_PATH}: image ${name} appears ${found.length} times`);
    for (const image of found) {
      if (version !== null && image.tag !== version) {
        problems.push(`${COMPOSE_PATH}: image ${name}:${image.tag}, expected tag ${version}`);
      }
    }
  }
  for (const image of images) {
    if (!(IMAGE_SERVICES as readonly string[]).includes(image.service)) {
      problems.push(`${COMPOSE_PATH}: unexpected image ${IMAGE_PREFIX}${image.service}`);
    }
  }
  return problems;
}

export interface VersionFiles {
  /** package.json path → its text. */
  manifests: Map<string, string>;
  compose: string;
}

/** Every place where the files disagree with `version`, one line each (empty: all agree). */
export function mismatches(files: VersionFiles, version: string): string[] {
  const problems: string[] = [];
  for (const [path, text] of files.manifests) {
    let actual: string | null;
    try {
      actual = packageVersion(text);
    } catch (err) {
      problems.push(`${path}: not valid JSON (${(err as Error).message})`);
      continue;
    }
    if (actual === null) problems.push(`${path}: no "version" field, expected "${version}"`);
    else if (actual !== version)
      problems.push(`${path}: version "${actual}", expected "${version}"`);
  }
  problems.push(...composeProblems(files.compose, version));
  return problems;
}

/** The version files with every version set to `version` (throws before anything is written). */
export function applyVersion(files: VersionFiles, version: string): VersionFiles {
  const manifests = new Map<string, string>();
  for (const [path, text] of files.manifests) {
    try {
      manifests.set(path, setPackageVersion(text, version));
    } catch (err) {
      throw new Error(`${path}: ${(err as Error).message}`);
    }
  }
  return { manifests, compose: setComposeVersion(files.compose, version) };
}

function readFiles(): VersionFiles {
  const manifests = new Map<string, string>();
  for (const path of workspaceManifests()) {
    manifests.set(path, readFileSync(join(ROOT, path), 'utf8'));
  }
  return { manifests, compose: readFileSync(join(ROOT, COMPOSE_PATH), 'utf8') };
}

function main(args: string[]): number {
  const check = args[0] === '--check';
  const version = check ? args[1] : args[0];
  if (version === undefined || args.length !== (check ? 2 : 1) || version.startsWith('-')) {
    console.error('usage: node scripts/set-version.ts [--check] <version>');
    return 2;
  }
  if (!isValidVersion(version)) {
    console.error(`set-version: "${version}" is not a valid version: X.Y.Z or X.Y.Z-rc.N`);
    return 2;
  }
  const files = readFiles();
  const count = files.manifests.size + 1;
  if (!check) {
    let next: VersionFiles;
    try {
      next = applyVersion(files, version);
    } catch (err) {
      console.error(`set-version: nothing written: ${(err as Error).message}`);
      return 1;
    }
    for (const [path, text] of next.manifests) {
      if (text !== files.manifests.get(path)) writeFileSync(join(ROOT, path), text);
    }
    if (next.compose !== files.compose) writeFileSync(join(ROOT, COMPOSE_PATH), next.compose);
  }
  const problems = mismatches(check ? files : readFiles(), version);
  if (problems.length > 0) {
    console.error(`set-version: ${problems.length} mismatch(es) with ${version}:`);
    for (const problem of problems) console.error(`  ${problem}`);
    return 1;
  }
  console.log(
    `set-version: ${version} ${check ? 'everywhere' : 'written'}: ${count} files ` +
      `(${[...files.manifests.keys()].join(', ')}, ${COMPOSE_PATH})`,
  );
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
