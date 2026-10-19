'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, useSyncExternalStore } from 'react';
import { formatSize, formatSpeed, percentOf } from '../../lib/files/format.ts';
import { isFinished, type TransferJob } from '../../lib/files/transfer-queue.ts';
import { ChevronDownIcon, CloseIcon, DownloadIcon, UploadIcon } from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { useWorkspace } from '../workspace/workspace-context.tsx';
import { useFileErrorText } from './use-file-text.ts';

const BAR: Record<TransferJob['state'], string> = {
  queued: 'bg-transparent',
  running: 'bg-accent',
  done: 'bg-line-strong',
  failed: 'bg-danger',
  cancelled: 'bg-line-strong',
};

function Bar({ value, tone, label }: { value: number; tone: string; label: string }) {
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className="block h-1 overflow-hidden rounded-pill bg-surface-raised"
    >
      <span
        className={cx(
          'block h-full rounded-pill transition-[width] duration-(--duration-move) ease-(--ease-out)',
          tone,
        )}
        style={{ width: `${value}%` }}
      />
    </span>
  );
}

function JobRow({ job }: { job: TransferJob }) {
  const t = useTranslations('files.transfers');
  const locale = useLocale();
  const errorText = useFileErrorText();
  const { transfers } = useWorkspace();
  const percent = job.state === 'done' ? 100 : percentOf(job.bytes, job.size);

  let meta: string;
  if (job.state === 'queued') meta = t('queued');
  else if (job.state === 'running') {
    meta =
      job.bytes === 0 && job.speed === null
        ? t('starting')
        : [
            t('progress', {
              done: formatSize(job.bytes, locale),
              total: formatSize(job.size, locale),
            }),
            job.speed !== null ? formatSpeed(job.speed, locale) : null,
            `${percent}%`,
          ]
            .filter(Boolean)
            .join(' · ');
  } else if (job.state === 'done') meta = job.untracked ? t('handedOff') : t('done');
  else if (job.state === 'failed') meta = errorText(job.error?.code ?? '', job.error?.message);
  else meta = t('cancelled');

  const Icon = job.direction === 'upload' ? UploadIcon : DownloadIcon;
  return (
    <li className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 rounded-sm bg-surface py-1.5 ps-2 pe-1">
      <span className="flex text-ink-muted">
        <Icon size={16} />
        <span className="sr-only">{t(job.direction)}</span>
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate font-semibold text-sm" title={job.name}>
            {job.name}
          </span>
          <span
            className={cx(
              'ms-auto min-w-0 shrink truncate text-xs tabular-nums',
              job.state === 'failed' ? 'text-danger' : 'text-ink-muted',
            )}
            title={meta}
          >
            {meta}
          </span>
        </span>
        <Bar value={percent} tone={BAR[job.state]} label={t('progressLabel', { name: job.name })} />
      </span>
      {job.state === 'queued' || job.state === 'running' ? (
        <Button
          variant="quiet"
          size="sm"
          iconOnly
          onClick={() => transfers.cancel(job.id)}
          aria-label={t('cancel', { name: job.name })}
          title={t('cancel', { name: job.name })}
          icon={<CloseIcon size={14} />}
          className="size-7"
        />
      ) : job.state === 'failed' || job.state === 'cancelled' ? (
        <Button
          variant="quiet"
          size="sm"
          onClick={() => transfers.retry(job.id)}
          aria-label={t('retryLabel', { name: job.name })}
          className="h-7 px-2"
        >
          {t('retry')}
        </Button>
      ) : (
        <span className="size-7" />
      )}
    </li>
  );
}

/**
 * The session's uploads and downloads, from the tab-wide queue (they keep running when the panel
 * closes): name, direction, bar, "x of y · speed · %", Cancel or Retry, and Clear finished. On a
 * phone it folds into one summary line with the overall bar and Show.
 */
export function TransferTray({ sessionId, phone }: { sessionId: string; phone: boolean }) {
  const t = useTranslations('files.transfers');
  const { transfers } = useWorkspace();
  const all = useSyncExternalStore(
    transfers.subscribe,
    transfers.getSnapshot,
    transfers.getSnapshot,
  );
  const [open, setOpen] = useState(false);
  const jobs = all.filter((job) => job.sessionId === sessionId);
  if (jobs.length === 0) return null;
  const active = jobs.filter((job) => !isFinished(job));
  const finished = jobs.length - active.length;
  const total = active.reduce((sum, job) => sum + job.size, 0);
  const done = active.reduce((sum, job) => sum + job.bytes, 0);
  const overall = active.length > 0 ? percentOf(done, total) : 100;
  const expanded = !phone || open;

  return (
    <section
      aria-label={t('label')}
      className={cx(
        'shrink-0',
        phone
          ? 'mx-3 mt-2 rounded-row bg-surface-solid p-2.5 shadow-float'
          : 'border-line border-t bg-ground',
      )}
    >
      <div className={cx('flex items-center gap-2', phone ? 'min-h-8' : 'h-9 ps-3.5 pe-2')}>
        <h3 className="font-semibold text-sm">
          {phone ? t('summary', { count: jobs.length }) : t('label')}
        </h3>
        {active.length > 0 ? (
          <span className="text-ink-muted text-xs tabular-nums">
            {phone ? `${overall}%` : t('running', { count: active.length })}
          </span>
        ) : null}
        <span className="flex-1" />
        {finished > 0 && expanded ? (
          <Button
            variant="quiet"
            size="sm"
            onClick={() => transfers.clearFinished(sessionId)}
            className="h-7 px-2.5 text-xs"
          >
            {t('clear')}
          </Button>
        ) : null}
        {phone ? (
          <Button
            variant="quiet"
            size="sm"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            icon={
              <ChevronDownIcon
                size={14}
                className={cx(
                  'transition-transform duration-(--duration-step) ease-(--ease-out)',
                  open && 'rotate-180',
                )}
              />
            }
            className="h-8 px-2.5"
          >
            {open ? t('hide') : t('show')}
          </Button>
        ) : null}
      </div>
      {phone && !open && active.length > 0 ? (
        <div className="pt-1.5">
          <Bar value={overall} tone="bg-accent" label={t('summary', { count: active.length })} />
        </div>
      ) : null}
      {expanded ? (
        <ul
          className={cx(
            'flex flex-col gap-0.5 overflow-y-auto overscroll-contain',
            phone ? 'max-h-[40dvh] pt-1.5' : 'max-h-48 px-2 pb-2',
          )}
        >
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
