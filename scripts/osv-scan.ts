// OSV vulnerability scan of pnpm-lock.yaml (pre-release routine, plan §15.4).
//
//   node scripts/osv-scan.ts [--lockfile <path>] [--allowlist <path>]
//
// Reads every `name@version` key of the lockfile's `packages:` section (no YAML dependency),
// asks https://api.osv.dev/v1/querybatch which of them have known advisories, and fails on any
// advisory that scripts/osv-allowlist.json does not accept for exactly that package and version.
// Exit status: 0 clean (or only allowlisted findings), 1 unlisted findings, 2 the scan could not
// run (network, lockfile or allowlist problem). Only Node built-ins: fetch and node:fs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OSV_API = 'https://api.osv.dev/v1';
const BATCH_SIZE = 1000; // the querybatch limit
const TIMEOUT_MS = 30_000;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface LockedPackage {
  name: string;
  version: string;
}

export interface AllowlistEntry {
  /** OSV id or one of its aliases (GHSA-…, CVE-…). */
  id: string;
  /** `name@version`, exactly as locked: another version re-surfaces the advisory. */
  package: string;
  reason: string;
  /** Last review, YYYY-MM-DD. */
  reviewed: string;
}

export interface Finding {
  id: string;
  pkg: LockedPackage;
  summary: string;
  severity: string;
  aliases: string[];
  allowed: AllowlistEntry | null;
}

export class ScanError extends Error {}

function unquote(key: string): string {
  if (key.length >= 2 && key.startsWith("'") && key.endsWith("'")) {
    return key.slice(1, -1).replaceAll("''", "'");
  }
  if (key.length >= 2 && key.startsWith('"') && key.endsWith('"')) {
    return JSON.parse(key) as string;
  }
  return key;
}

/**
 * The `name@version` keys of a pnpm v9 lockfile's `packages:` section: the lines indented by
 * exactly two spaces between `packages:` and the next top-level key. Keys whose version is not
 * a plain semver (tarball or file specs) are returned in `skipped`.
 */
export function parseLockfilePackages(text: string): {
  lockfileVersion: string | null;
  packages: LockedPackage[];
  skipped: string[];
} {
  const lines = text.split(/\r?\n/);
  const versionLine = lines.find((line) => line.startsWith('lockfileVersion:'));
  const lockfileVersion = versionLine
    ? unquote(versionLine.slice('lockfileVersion:'.length).trim())
    : null;
  const start = lines.indexOf('packages:');
  if (start < 0) throw new ScanError('the lockfile has no top-level `packages:` section');
  const packages: LockedPackage[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level key (`snapshots:`)
    const match = /^ {2}(\S.*):\s*$/.exec(line);
    if (!match?.[1]) continue;
    const key = unquote(match[1]);
    const at = key.lastIndexOf('@');
    const name = at > 0 ? key.slice(0, at) : '';
    const version = at > 0 ? key.slice(at + 1) : '';
    if (!name || !SEMVER.test(version)) {
      skipped.push(key);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    packages.push({ name, version });
  }
  if (packages.length === 0) throw new ScanError('no packages found in the lockfile');
  return { lockfileVersion, packages, skipped };
}

export function loadAllowlist(path: string): AllowlistEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ScanError(`cannot read the allowlist ${path}: ${(err as Error).message}`);
  }
  const entries = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) throw new ScanError(`${path}: expected { "entries": [...] }`);
  return entries.map((entry, index) => {
    const e = entry as Partial<Record<keyof AllowlistEntry, unknown>>;
    for (const field of ['id', 'package', 'reason', 'reviewed'] as const) {
      if (typeof e[field] !== 'string' || !(e[field] as string).trim()) {
        throw new ScanError(`${path}: entry ${index} has no "${field}"`);
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.reviewed as string)) {
      throw new ScanError(`${path}: entry ${index}: "reviewed" must be YYYY-MM-DD`);
    }
    return e as AllowlistEntry;
  });
}

async function post(path: string, body: unknown): Promise<unknown> {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const url = `${OSV_API}${path}`;
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message ?? (err as Error).message;
    throw new ScanError(`cannot reach ${url} (${detail}); the OSV step needs network access`);
  }
  if (!response.ok) {
    throw new ScanError(`${url} answered HTTP ${response.status} ${response.statusText}`);
  }
  try {
    return await response.json();
  } catch {
    throw new ScanError(`${url} returned a body that is not JSON`);
  }
}

interface BatchResult {
  vulns?: Array<{ id: string }>;
  next_page_token?: string;
}

/** Advisory ids per package, following `next_page_token` for packages with many advisories. */
async function queryIds(packages: LockedPackage[]): Promise<Map<LockedPackage, string[]>> {
  const found = new Map<LockedPackage, string[]>();
  let pending = packages.map((pkg) => ({ pkg, pageToken: undefined as string | undefined }));
  while (pending.length > 0) {
    const next: typeof pending = [];
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const chunk = pending.slice(i, i + BATCH_SIZE);
      const body = {
        queries: chunk.map(({ pkg, pageToken }) => ({
          package: { name: pkg.name, ecosystem: 'npm' },
          version: pkg.version,
          ...(pageToken ? { page_token: pageToken } : {}),
        })),
      };
      const results = (await post('/querybatch', body)) as { results?: BatchResult[] };
      if (!Array.isArray(results.results) || results.results.length !== chunk.length) {
        throw new ScanError('querybatch returned an unexpected number of results');
      }
      results.results.forEach((result, j) => {
        const item = chunk[j];
        if (!item) return;
        const ids = (result.vulns ?? []).map((v) => v.id);
        if (ids.length > 0) found.set(item.pkg, [...(found.get(item.pkg) ?? []), ...ids]);
        if (result.next_page_token) next.push({ pkg: item.pkg, pageToken: result.next_page_token });
      });
    }
    pending = next;
  }
  return found;
}

interface Vuln {
  id: string;
  summary?: string;
  aliases?: string[];
  database_specific?: { severity?: string };
  severity?: Array<{ type: string; score: string }>;
}

function severityOf(vuln: Vuln): string {
  const label = vuln.database_specific?.severity;
  if (label) return label.toLowerCase();
  const cvss = vuln.severity?.find((s) => s.type.startsWith('CVSS'));
  return cvss ? cvss.score : 'unknown';
}

export async function scan(options: { lockfile: string; allowlist: string }): Promise<{
  packages: number;
  skipped: string[];
  lockfileVersion: string | null;
  findings: Finding[];
  staleEntries: AllowlistEntry[];
}> {
  let text: string;
  try {
    text = readFileSync(options.lockfile, 'utf8');
  } catch (err) {
    throw new ScanError(`cannot read ${options.lockfile}: ${(err as Error).message}`);
  }
  const allowlist = loadAllowlist(options.allowlist);
  const { lockfileVersion, packages, skipped } = parseLockfilePackages(text);
  const ids = await queryIds(packages);
  const findings: Finding[] = [];
  const used = new Set<AllowlistEntry>();
  for (const [pkg, vulnIds] of ids) {
    for (const id of new Set(vulnIds)) {
      const vuln = (await request(`/vulns/${encodeURIComponent(id)}`)) as Vuln;
      const aliases = vuln.aliases ?? [];
      const allowed =
        allowlist.find(
          (entry) =>
            entry.package === `${pkg.name}@${pkg.version}` &&
            (entry.id === id || aliases.includes(entry.id)),
        ) ?? null;
      if (allowed) used.add(allowed);
      findings.push({
        id,
        pkg,
        summary: vuln.summary ?? '(no summary)',
        severity: severityOf(vuln),
        aliases,
        allowed,
      });
    }
  }
  return {
    packages: packages.length,
    skipped,
    lockfileVersion,
    findings,
    staleEntries: allowlist.filter((entry) => !used.has(entry)),
  };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const lockfile = option(args, '--lockfile') ?? join(ROOT, 'pnpm-lock.yaml');
  const allowlist = option(args, '--allowlist') ?? join(ROOT, 'scripts', 'osv-allowlist.json');
  console.log(`osv: scanning ${lockfile} against ${OSV_API}/querybatch`);
  let result: Awaited<ReturnType<typeof scan>>;
  try {
    result = await scan({ lockfile, allowlist });
  } catch (err) {
    if (!(err instanceof ScanError)) throw err;
    console.error(`osv: FAIL: the scan could not run: ${err.message}`);
    return 2;
  }
  const { findings, skipped, staleEntries } = result;
  console.log(
    `osv: ${result.packages} packages (lockfile v${result.lockfileVersion ?? '?'}), ` +
      `${findings.length} advisory match(es)`,
  );
  for (const key of skipped)
    console.log(`osv: warning: not scanned (not a registry version): ${key}`);
  for (const f of findings) {
    const pkg = `${f.pkg.name}@${f.pkg.version}`;
    const aliases = f.aliases.length > 0 ? ` (${f.aliases.join(', ')})` : '';
    if (f.allowed) {
      console.log(`osv: allowed  ${f.id}${aliases} ${pkg} [${f.severity}] ${f.summary}`);
      console.log(`osv:          reason: ${f.allowed.reason} (reviewed ${f.allowed.reviewed})`);
    } else {
      console.log(`osv: FINDING  ${f.id}${aliases} ${pkg} [${f.severity}] ${f.summary}`);
    }
  }
  for (const entry of staleEntries) {
    console.log(
      `osv: note: allowlist entry ${entry.id} for ${entry.package} matches nothing; remove it`,
    );
  }
  const unlisted = findings.filter((f) => !f.allowed);
  if (unlisted.length > 0) {
    console.error(
      `osv: FAIL: ${unlisted.length} advisory match(es) not in scripts/osv-allowlist.json. ` +
        'Upgrade the package, or add an entry (id, package, reason, reviewed) after review.',
    );
    return 1;
  }
  console.log(
    `osv: PASS: no unlisted advisories (${findings.length} allowlisted, ${result.packages} packages)`,
  );
  return 0;
}

if (import.meta.main) process.exitCode = await main();
