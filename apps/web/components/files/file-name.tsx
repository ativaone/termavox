import type { ReactNode } from 'react';
import { displayName, splitNames } from '../../lib/files/display-name.ts';

/**
 * A remote name or path drawn as text (`displayName`): inside `<bdi dir="ltr">`, so it never
 * reorders what is around it and is laid out left to right whatever its first letter (a bare
 * `<bdi>` is `dir=auto`: `\u05DFphoto.jpg\u05DF.exe` would end in "photo.jpg\u05DF" on screen),
 * while a right-to-left run in it still reads right to left. Hidden characters show as U+FFFD
 * and then the escaped name is the tooltip. `tooltip` makes the name the tooltip anyway, where
 * it may be cut.
 */
export function FileName({ name, tooltip = false }: { name: string; tooltip?: boolean }) {
  const shown = displayName(name);
  return (
    <bdi dir="ltr" title={shown.title ?? (tooltip ? shown.text : undefined)}>
      {shown.text}
    </bdi>
  );
}

/**
 * A catalog sentence with remote names in it (`splitNames`), each drawn as `<FileName>`, so that
 * two names in one sentence never trade places.
 */
export function withNames<const Names extends readonly string[]>(
  names: Names,
  format: (...marks: { [K in keyof Names]: string }) => string,
): ReactNode {
  const parts: ReactNode[] = [];
  for (const part of splitNames(names, format)) {
    parts.push(typeof part === 'string' ? part : <FileName key={parts.length} name={part.name} />);
  }
  return parts;
}
