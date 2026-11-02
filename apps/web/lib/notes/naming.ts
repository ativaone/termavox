/**
 * The title of a new note: the lowest "Note {n}" not in use, n from 1. `format` is the catalog's
 * wording, so a note named by hand in another language never blocks a number.
 */
export function lowestFreeNoteTitle(
  titles: readonly string[],
  format: (n: number) => string,
): string {
  const used = new Set(titles);
  let n = 1;
  while (used.has(format(n))) n += 1;
  return format(n);
}
