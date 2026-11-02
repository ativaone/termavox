import { cx } from '../ui/cx.ts';

/**
 * How the pane's Terminal and note tabs look (plan D-58), shared by the tabs themselves and the
 * notes settings preview (D-59), so the preview can never drift from them.
 */

export const NOTE_TAB_FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2';
const UNDERLINE =
  'after:pointer-events-none after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-pill after:bg-accent';

/**
 * The Terminal tab lights like a workspace tab; a note's tab takes the note's own page colour with
 * a hairline, so the selected tab reads as the top of the page under it. The selected note tab
 * carries the note's paper scope (`data-note-paper`), so its page colour and ink are the note's.
 */
export function noteTabFrame(selected: boolean, phone: boolean, kind: 'terminal' | 'note'): string {
  return cx(
    'relative flex shrink-0 items-stretch rounded-sm',
    'transition-colors duration-(--duration-step) ease-(--ease-out)',
    phone ? 'h-11' : 'h-7',
    selected
      ? cx(
          'text-ink',
          kind === 'note'
            ? 'bg-note shadow-[inset_0_0_0_1px_var(--color-line-strong)]'
            : 'bg-surface-raised',
          UNDERLINE,
        )
      : 'text-ink-muted hover:bg-surface hover:text-ink',
  );
}

/** The glyph and name inside a tab. */
export function noteTabLabel(kind: 'terminal' | 'note'): string {
  return kind === 'terminal'
    ? 'flex items-center gap-1.5 rounded-sm px-2 font-semibold text-sm leading-4'
    : 'flex min-w-0 max-w-44 items-center gap-1.5 rounded-sm ps-2 font-semibold text-sm leading-4';
}

/** The rule between the terminal and the notes. */
export const NOTE_TAB_RULE = 'mx-1 h-4 w-px shrink-0 bg-line-strong';
