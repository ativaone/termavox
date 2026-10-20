'use client';

import type { SessionStatus } from '@termavox/protocol/client';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { LearnMore } from '../help-links.tsx';
import { HomeIcon, RetryIcon } from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { CopyButton } from '../ui/copy-button.tsx';
import { Notice } from '../ui/notice.tsx';
import { Panel } from '../ui/panel.tsx';
import { StatusChip } from '../ui/status-chip.tsx';

/** The SSH server setting the panel needs, and the reload that applies it (plan §5.12). */
export const SFTP_LINE = 'Subsystem sftp internal-sftp';
export const SFTP_RELOAD = 'sudo systemctl reload ssh';

function Frame({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">{children}</div>;
}

/**
 * The session is not connected (or this tab is offline): its state lamp and word, and the promise
 * that files come back by themselves when it reconnects.
 */
export function OfflineCard({
  status,
  statusLabel,
  tabOffline,
}: {
  status: SessionStatus;
  statusLabel: string;
  tabOffline: boolean;
}) {
  const t = useTranslations('files.unavailable');
  return (
    <Frame>
      <Panel as="div" className="flex flex-col gap-2 px-4 py-3.5">
        {tabOffline ? null : <StatusChip status={status} label={statusLabel} />}
        <h3 className="font-semibold text-base text-ink">
          {tabOffline ? t('tabOfflineTitle') : t('offlineTitle')}
        </h3>
        <p className="text-ink-muted text-sm">
          {tabOffline ? t('tabOfflineBody') : t('offlineBody')}
        </p>
      </Panel>
    </Frame>
  );
}

function Command({ value }: { value: string }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <code className="min-w-0 break-all rounded-sm bg-field px-2 py-1 font-mono text-ink text-xs">
        {value}
      </code>
      <CopyButton value={value} size="sm" variant="quiet" />
    </span>
  );
}

/**
 * The server offers no SFTP: what to enable there (the `Subsystem` line, the reload), with copy
 * buttons, that Termavox installs nothing and the terminal keeps working, and Try again.
 */
export function SftpCard({ target, onRetry }: { target: string; onRetry(): void }) {
  const t = useTranslations('files.unavailable');
  return (
    <Frame>
      <Panel as="div" className="flex flex-col gap-3 px-4 py-3.5">
        <h3 className="font-semibold text-base text-ink">{t('sftpTitle')}</h3>
        <p className="text-pretty text-ink-muted text-sm">
          {t.rich('sftpBody', {
            target,
            data: (chunks) => <span className="font-mono text-ink text-xs">{chunks}</span>,
          })}{' '}
          <LearnMore section="files-sftp" />
        </p>
        <p className="font-semibold text-sm">{t('sftpSteps')}</p>
        <ol className="flex list-decimal flex-col gap-3 ps-5 text-sm marker:text-ink-muted">
          <li className="flex flex-col gap-1.5">
            <span>{t('sftpStep1')}</span>
            <Command value={SFTP_LINE} />
          </li>
          <li className="flex flex-col gap-1.5">
            <span>{t('sftpStep2')}</span>
            <Command value={SFTP_RELOAD} />
          </li>
        </ol>
        <div>
          <Button variant="secondary" size="sm" icon={<RetryIcon size={15} />} onClick={onRetry}>
            {t('tryAgain')}
          </Button>
        </div>
      </Panel>
    </Frame>
  );
}

/** An administrator turned file transfer off while this page was open. */
export function DisabledCard() {
  const t = useTranslations('files.unavailable');
  return (
    <Frame>
      <Notice tone="info" title={t('disabledTitle')}>
        {t('disabledBody')}
      </Notice>
    </Frame>
  );
}

/** The folder could not be listed: why, Try again, and the way home. */
export function ListError({
  message,
  onRetry,
  onHome,
}: {
  message: string;
  onRetry(): void;
  onHome: (() => void) | null;
}) {
  const t = useTranslations('files.list');
  return (
    <Frame>
      <div className="flex flex-col gap-3">
        <Notice tone="danger">{message}</Notice>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" icon={<RetryIcon size={15} />} onClick={onRetry}>
            {t('tryAgain')}
          </Button>
          {onHome ? (
            <Button variant="quiet" size="sm" icon={<HomeIcon size={15} />} onClick={onHome}>
              {t('goHome')}
            </Button>
          ) : null}
        </div>
      </div>
    </Frame>
  );
}
