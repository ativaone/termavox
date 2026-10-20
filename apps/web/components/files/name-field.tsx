'use client';

import { fileNameProblem } from '@termavox/protocol/client';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { cx } from '../ui/cx.ts';
import { useNameProblemText } from './use-file-text.ts';

/**
 * An inline name field (rename in a row, the new-folder row): Enter saves, Escape cancels, leaving
 * the field saves a changed name and cancels an unchanged one. The name is checked with
 * `fileNameProblem` before anything is sent; a refusal from the server shows under the field,
 * which stays open.
 */
export function NameField({
  initial,
  label,
  placeholder,
  taken,
  phone,
  onSubmit,
  onCancel,
}: {
  initial: string;
  label: string;
  placeholder?: string;
  /** Names already in the folder (other than `initial`). */
  taken: (name: string) => boolean;
  phone: boolean;
  /** Resolves to an error message, or null once saved. */
  onSubmit(name: string): Promise<string | null>;
  onCancel(): void;
}) {
  const problemText = useNameProblemText();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const errorId = useId();

  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.focus();
    // Select the stem, as file managers do: the extension stays.
    const dot = initial.lastIndexOf('.');
    element.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  const save = async () => {
    if (busy || done.current) return;
    const name = value;
    if (name === initial && initial !== '') {
      done.current = true;
      onCancel();
      return;
    }
    const problem = fileNameProblem(name);
    if (problem) {
      setError(problemText(problem));
      return;
    }
    if (taken(name)) {
      setError(problemText('taken'));
      return;
    }
    setBusy(true);
    const refused = await onSubmit(name);
    setBusy(false);
    if (refused) setError(refused);
    else done.current = true;
  };

  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1 py-1">
      <input
        ref={input}
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        aria-busy={busy || undefined}
        maxLength={1024}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          event.stopPropagation(); // the list's keys (Space, Delete, arrows) stay out
          if (event.key === 'Enter') {
            event.preventDefault();
            void save();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            done.current = true;
            onCancel();
          }
        }}
        onBlur={() => {
          if (done.current || busy) return;
          if (value === initial || value === '') {
            done.current = true;
            onCancel();
          } else {
            void save();
          }
        }}
        onClick={(event) => event.stopPropagation()}
        className={cx(
          'w-full min-w-0 rounded-sm border bg-field px-1.5 text-ink outline-none',
          phone ? 'h-9 text-md' : 'h-7 text-sm',
          error ? 'border-danger' : 'border-accent',
        )}
      />
      {error ? (
        <span id={errorId} role="alert" className="text-danger text-xs">
          {error}
        </span>
      ) : null}
    </span>
  );
}
