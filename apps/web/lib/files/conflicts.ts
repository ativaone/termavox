import { FILES_LIMITS } from '@termavox/protocol/client';

/**
 * Upload names that already exist in the target folder (plan §5.12): the panel asks once for the
 * whole batch whether to replace them, keep both (`name (1).ext`, the first free number) or skip
 * them. Framework-free.
 */

export type ConflictChoice = 'replace' | 'keepBoth' | 'skip';

/** Compound extensions kept whole, so `site.tar.gz` becomes `site (1).tar.gz`. */
const COMPOUND = /\.tar\.[A-Za-z0-9]+$/;

/**
 * A name's stem and extension. A leading dot does not start an extension (`.env` has none,
 * `.config.json` has `.json`), nor does a trailing one; `.tar.*` archives keep both parts.
 */
export function splitName(name: string): { stem: string; ext: string } {
  const compound = COMPOUND.exec(name);
  if (compound && compound.index > 0) {
    return { stem: name.slice(0, compound.index), ext: name.slice(compound.index) };
  }
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

const utf8 = new TextEncoder();
const fits = (name: string): boolean => utf8.encode(name).byteLength <= FILES_LIMITS.nameBytes;

/** `stem (n)ext`, the stem shortened (by whole characters) when the name would pass 255 bytes. */
export function numberedName(name: string, n: number): string {
  const { stem, ext } = splitName(name);
  const suffix = ` (${n})${ext}`;
  const chars = [...stem];
  while (chars.length > 1 && !fits(chars.join('') + suffix)) chars.pop();
  return chars.join('') + suffix;
}

/** The first `name (n).ext` (n = 1, 2, …) that `isTaken` does not claim. */
export function uniqueName(name: string, isTaken: (candidate: string) => boolean): string {
  for (let n = 1; ; n++) {
    const candidate = numberedName(name, n);
    if (!isTaken(candidate)) return candidate;
  }
}

/** Names of the batch that already exist in the folder, each once, in batch order. */
export function findConflicts(names: readonly string[], existing: ReadonlySet<string>): string[] {
  return [...new Set(names.filter((name) => existing.has(name)))];
}

export interface PlannedUpload<T> {
  source: T;
  /** The name it is stored under. */
  name: string;
  size: number;
  /** Replace an existing file (it keeps that file's permission bits, plan §5.12). */
  overwrite: boolean;
}

/**
 * Turns a batch into uploads. A name already in the folder follows `choice`; a name that repeats
 * inside the batch (two dropped files with one name) keeps both, so no dropped file silently
 * replaces another. Numbered names are checked against the folder and the batch together.
 */
export function planUploads<T>(
  files: ReadonlyArray<{ name: string; size: number; source: T }>,
  existing: ReadonlySet<string>,
  choice: ConflictChoice,
): PlannedUpload<T>[] {
  const used = new Set(existing);
  const batch = new Set<string>();
  const planned: PlannedUpload<T>[] = [];
  for (const file of files) {
    let name = file.name;
    let overwrite = false;
    if (batch.has(name)) {
      name = uniqueName(name, (candidate) => used.has(candidate));
    } else if (existing.has(name)) {
      if (choice === 'skip') continue;
      if (choice === 'replace') overwrite = true;
      else name = uniqueName(name, (candidate) => used.has(candidate));
    }
    used.add(name);
    batch.add(name);
    planned.push({ source: file.source, name, size: file.size, overwrite });
  }
  return planned;
}
