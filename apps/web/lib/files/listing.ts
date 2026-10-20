import type { FileEntry } from '@termavox/protocol/client';

/**
 * A listed folder as the panel shows it (plan §5.12): folders (and links to folders) first, then
 * files, in natural order by name; dot-files hidden unless asked; a selection of entry names.
 * Framework-free.
 */

/** Opens like a folder: a folder, or a link whose target is one. */
export function isFolderLike(entry: FileEntry): boolean {
  return entry.type === 'dir' || (entry.type === 'link' && entry.target === 'dir');
}

/** A link whose target is missing or unreadable. */
export function isDangling(entry: FileEntry): boolean {
  return entry.type === 'link' && (entry.target ?? null) === null;
}

/** Downloads as a file: a regular file, or a link to one (the daemon follows it). */
export function isDownloadable(entry: FileEntry): boolean {
  return entry.type === 'file' || (entry.type === 'link' && entry.target === 'file');
}

/** A dot-file (hidden unless the hidden-files toggle is on). */
export function isHidden(name: string): boolean {
  return name.startsWith('.');
}

/** Natural order ("file2" before "file10"), case-insensitive, in the UI's locale. */
export function nameCollator(locale?: string): Intl.Collator {
  return new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
}

/** Folders first, then by name in natural order; a code-point tie-break keeps the order total. */
export function sortEntries(
  entries: readonly FileEntry[],
  collator: Intl.Collator = nameCollator(),
): FileEntry[] {
  return [...entries].sort((a, b) => {
    const folders = Number(isFolderLike(b)) - Number(isFolderLike(a));
    if (folders !== 0) return folders;
    const byName = collator.compare(a.name, b.name);
    if (byName !== 0) return byName;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/** The entries on screen: dot-files only while the toggle is on. */
export function visibleEntries(entries: readonly FileEntry[], showHidden: boolean): FileEntry[] {
  return showHidden ? [...entries] : entries.filter((entry) => !isHidden(entry.name));
}

export function hiddenCount(entries: readonly FileEntry[]): number {
  return entries.reduce((count, entry) => count + (isHidden(entry.name) ? 1 : 0), 0);
}

// ── selection ─────────────────────────────────────────────────────────────────

/** Selected entry names (immutable: every change returns a new set). */
export type Selection = ReadonlySet<string>;

export const EMPTY_SELECTION: Selection = new Set();

export function toggleSelection(selection: Selection, name: string): Selection {
  const next = new Set(selection);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}

/** Selects every name in `names` (on) or clears them (off), keeping the rest. */
export function setSelected(
  selection: Selection,
  names: readonly string[],
  on: boolean,
): Selection {
  const next = new Set(selection);
  for (const name of names) {
    if (on) next.add(name);
    else next.delete(name);
  }
  return next;
}

/** Drops names no longer in `names` (after a refresh, or when hidden files hide); same set if none. */
export function pruneSelection(selection: Selection, names: readonly string[]): Selection {
  if (selection.size === 0) return selection;
  const present = new Set(names);
  for (const name of selection) {
    if (!present.has(name)) return new Set([...selection].filter((n) => present.has(n)));
  }
  return selection;
}

/** How much of `names` is selected: drives the select-all checkbox (checked / mixed). */
export function selectionState(
  selection: Selection,
  names: readonly string[],
): 'none' | 'some' | 'all' {
  let selected = 0;
  for (const name of names) if (selection.has(name)) selected++;
  if (selected === 0) return 'none';
  return selected === names.length ? 'all' : 'some';
}

/** The selected entries, in the listing's order. */
export function selectedEntries(entries: readonly FileEntry[], selection: Selection): FileEntry[] {
  return entries.filter((entry) => selection.has(entry.name));
}

/** What a delete would remove, by kind: a link counts as a link, whatever it points to. */
export function countKinds(entries: readonly FileEntry[]): {
  folders: number;
  files: number;
  links: number;
} {
  const counts = { folders: 0, files: 0, links: 0 };
  for (const entry of entries) {
    if (entry.type === 'dir') counts.folders++;
    else if (entry.type === 'link') counts.links++;
    else counts.files++;
  }
  return counts;
}

/**
 * Splits a selection for download: files and links to files download (one browser download
 * each); folders, links to folders and anything else are skipped (folder download is out of
 * scope, plan D-39).
 */
export function planDownloads(entries: readonly FileEntry[]): {
  files: FileEntry[];
  skipped: number;
} {
  const files = entries.filter(isDownloadable);
  return { files, skipped: entries.length - files.length };
}
