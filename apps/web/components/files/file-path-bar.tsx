'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { breadcrumbs, parentPath, resolvePathInput } from '../../lib/files/paths.ts';
import { ArrowUpIcon, HomeIcon, PencilIcon } from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';

const SEGMENT =
  'shrink-0 rounded-xs px-1 text-ink-muted transition-colors duration-(--duration-step) ease-(--ease-out) ' +
  'hover:bg-surface-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-1';

/**
 * Where the panel is: Up, then the folder's segments as buttons (from the home folder when inside
 * it, from `/` otherwise) in a field-like well that scrolls to its end. The pencil turns the well
 * into a text field: Enter goes there (`~`, relative and absolute paths), Escape cancels.
 */
export function FilePathBar({
  path,
  home,
  phone,
  disabled,
  onNavigate,
}: {
  path: string | null;
  home: string | null;
  phone: boolean;
  disabled: boolean;
  /** Resolves true once the folder is listed (the field then closes). */
  onNavigate(path: string): Promise<boolean>;
}) {
  const t = useTranslations('files.path');
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trail = useRef<HTMLDivElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const crumbs = path ? breadcrumbs(path, home) : [];
  const isEditing = editing !== null;

  // The field replaces the pencil that opened it: it takes the keyboard, its text selected.
  useLayoutEffect(() => {
    if (!isEditing) return;
    field.current?.focus();
    field.current?.select();
  }, [isEditing]);

  // The deepest segment stays in view.
  useLayoutEffect(() => {
    const element = trail.current;
    if (element && path) element.scrollLeft = element.scrollWidth;
  }, [path]);

  const close = (refocus: boolean) => {
    setEditing(null);
    setError(null);
    if (refocus) requestAnimationFrame(() => editButton.current?.focus());
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (editing === null || !path || busy) return;
    const target = resolvePathInput(editing, { current: path, home });
    if (!target) {
      setError(t('invalid'));
      return;
    }
    setBusy(true);
    const ok = await onNavigate(target);
    setBusy(false);
    if (ok) close(true);
  };

  const height = phone ? 'h-11' : 'h-8';
  return (
    <div className={cx('flex shrink-0 flex-col gap-1', phone ? 'px-3 pt-2.5 pb-2' : 'px-2.5 pb-2')}>
      <div className="flex items-center gap-1.5">
        <Button
          variant="secondary"
          size={phone ? 'lg' : 'sm'}
          iconOnly
          disabled={disabled || !path || path === '/'}
          onClick={() => path && void onNavigate(parentPath(path))}
          aria-label={t('up')}
          title={t('up')}
          icon={<ArrowUpIcon size={phone ? 20 : 16} />}
        />
        {editing !== null ? (
          <form onSubmit={submit} className="flex min-w-0 flex-1" noValidate>
            <input
              ref={field}
              type="text"
              value={editing}
              onChange={(event) => {
                setEditing(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  close(true);
                }
              }}
              onBlur={() => {
                if (!busy) close(false);
              }}
              aria-label={t('field')}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className={cx(
                height,
                'min-w-0 flex-1 rounded-control border border-accent bg-field px-2.5 font-mono text-ink outline-none',
                phone ? 'text-md' : 'text-sm',
                error && 'border-danger',
              )}
            />
          </form>
        ) : (
          <div
            className={cx(
              height,
              'flex min-w-0 flex-1 items-center rounded-control border border-line bg-field ps-1.5 pe-0.5',
              phone ? 'text-base' : 'text-sm',
            )}
          >
            <nav aria-label={t('label')} className="flex min-w-0 flex-1">
              <div
                ref={trail}
                className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {crumbs.map((crumb, index) => {
                  const last = index === crumbs.length - 1;
                  const label =
                    crumb.kind === 'home'
                      ? t('home')
                      : crumb.kind === 'root'
                        ? t('root')
                        : undefined;
                  const content =
                    crumb.kind === 'home' ? <HomeIcon size={phone ? 17 : 15} /> : crumb.name;
                  return (
                    <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
                      {index > 0 && crumbs[index - 1]?.kind !== 'root' ? (
                        <span aria-hidden="true" className="px-0.5 text-ink-faint">
                          /
                        </span>
                      ) : null}
                      {last ? (
                        <span
                          aria-current="page"
                          className="flex items-center px-1 font-semibold text-ink"
                        >
                          {content}
                          {label ? <span className="sr-only">{label}</span> : null}
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => void onNavigate(crumb.path)}
                          aria-label={label}
                          title={label}
                          className={cx(SEGMENT, 'flex items-center')}
                        >
                          {content}
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
            </nav>
            <button
              ref={editButton}
              type="button"
              disabled={disabled || !path}
              onClick={() => {
                setEditing(path ?? '');
                setError(null);
              }}
              aria-label={t('edit')}
              title={t('edit')}
              className={cx(
                'ms-1 flex shrink-0 items-center justify-center rounded-sm text-ink-muted',
                phone ? 'size-10' : 'size-7',
                'transition-colors duration-(--duration-step) ease-(--ease-out) hover:bg-surface-raised hover:text-ink',
                'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2 disabled:text-ink-faint',
              )}
            >
              <PencilIcon size={phone ? 17 : 14} />
            </button>
          </div>
        )}
      </div>
      {error ? (
        <p id={errorId} className="text-danger text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
