'use client';

import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { ConflictChoice } from '../../lib/files/conflicts.ts';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { choiceCardClasses, radioClasses } from '../ui/radio.ts';
import { FileName, withNames } from './file-name.tsx';

const SHOWN = 5;

/**
 * Names of an upload batch that already exist in the folder: asked once for all of them (plan
 * §5.12). Replace (it keeps the file's permissions), Keep both (numbered, the first free
 * number), Skip these; Cancel upload drops the whole batch. A native modal dialog in the rename
 * dialog's shape, choice cards for the answer.
 */
export function ConflictDialog({
  folder,
  names,
  example,
  onChoose,
  onCancel,
}: {
  /** The folder's name (its last segment). */
  folder: string;
  names: string[];
  /** What the first name becomes with Keep both. */
  example: string;
  onChoose(choice: ConflictChoice): void;
  onCancel(): void;
}) {
  const t = useTranslations('files.conflict');
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [choice, setChoice] = useState<ConflictChoice>('replace');

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => {
      if (element?.open) element.close();
    };
  }, []);

  const options: Array<{ value: ConflictChoice; label: string; help: ReactNode }> = [
    { value: 'replace', label: t('replace'), help: t('replaceHelp') },
    {
      value: 'keepBoth',
      label: t('keepBoth'),
      help: withNames([example], (name) => t('keepBothHelp', { name })),
    },
    { value: 'skip', label: t('skip'), help: null },
  ];

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      className="card-solid m-auto w-[min(28rem,calc(100vw-2rem))] p-0 text-ink shadow-float backdrop:bg-ground-deep/70"
    >
      <form
        method="dialog"
        className="flex flex-col gap-4 px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          onChoose(choice);
        }}
      >
        <h2 id={titleId} className="font-semibold text-ink text-md">
          {withNames([folder], (mark) => t('title', { count: names.length, folder: mark }))}
        </h2>
        <ul className="flex flex-col gap-1 rounded-control bg-field px-3 py-2.5 font-mono text-ink-muted text-sm">
          {names.slice(0, SHOWN).map((name) => (
            <li key={name} className="truncate">
              <FileName name={name} tooltip />
            </li>
          ))}
          {names.length > SHOWN ? (
            <li className="font-sans">{t('more', { count: names.length - SHOWN })}</li>
          ) : null}
        </ul>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-semibold text-sm">{t('question')}</legend>
          {options.map((option) => (
            <label
              key={option.value}
              className={cx(
                choiceCardClasses(choice === option.value),
                'items-start gap-3 px-3 py-2.5',
              )}
            >
              <input
                type="radio"
                name="conflict"
                value={option.value}
                checked={choice === option.value}
                onChange={() => setChoice(option.value)}
                className={radioClasses('sm', 'mt-0.5')}
              />
              <span className="flex min-w-0 flex-col gap-0.5 text-sm">
                <span className="font-semibold">{option.label}</span>
                {option.help ? (
                  <span className="break-words text-ink-muted">{option.help}</span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary">
            {t('continue')}
          </Button>
          <Button variant="quiet" onClick={onCancel}>
            {t('cancel')}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
