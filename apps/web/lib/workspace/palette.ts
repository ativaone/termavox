/**
 * Command palette search (plan §11.1): every whitespace-separated word of the query must occur in
 * the item (case- and accent-insensitive); matches are ranked by where the words land (start of
 * the first field, start of a word, anywhere), keeping the input order between equals.
 */

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const WORD_START = /[\s@._:/-]/;

/** Score of one word in one field: 3 at the field start, 2 at a word start, 1 inside, 0 absent. */
function wordScore(field: string, word: string): number {
  let best = 0;
  let from = 0;
  for (;;) {
    const at = field.indexOf(word, from);
    if (at < 0) return best;
    const score = at === 0 ? 3 : WORD_START.test(field[at - 1]!) ? 2 : 1;
    if (score > best) best = score;
    if (best === 3) return best;
    from = at + 1;
  }
}

/**
 * Relevance of an item for a query, or null when some word is missing. Earlier fields weigh
 * more (the label before `user@host`).
 */
export function matchScore(query: string, fields: readonly string[]): number | null {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const folded = fields.map(fold);
  let total = 0;
  for (const word of words) {
    let best = 0;
    folded.forEach((field, i) => {
      const score = wordScore(field, word);
      if (score > 0) best = Math.max(best, score * 10 - i);
    });
    if (best === 0) return null;
    total += best;
  }
  return total;
}

/** The items matching `query`, best first (stable); all items unchanged for an empty query. */
export function filterPalette<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => readonly string[],
): T[] {
  if (query.trim() === '') return [...items];
  return items
    .map((item, index) => ({ item, index, score: matchScore(query, fields(item)) }))
    .filter((entry): entry is { item: T; index: number; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
