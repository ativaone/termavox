'use client';

import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { withReturnPath } from '../../lib/manage/return-to.ts';
import { ROUTES } from '../../lib/routes.ts';
import { ServerIcon } from '../icons/index.tsx';
import { ButtonLink } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { EmptyState } from '../ui/empty-state.tsx';
import { Panel } from '../ui/panel.tsx';
import { NewSessionButton } from './new-session-button.tsx';

/**
 * First run: no server yet. Teaches the three steps (where the server is and the user name, a
 * key or a password, then a session; plan D-29) and offers "Add your first server", whose Back
 * and Cancel return to the workspace.
 */
export function FirstRunPanel({ className }: { className?: string }) {
  const t = useTranslations('workspace.pane');
  const titleId = useId();
  const steps = [t('firstRunStep1'), t('firstRunStep2'), t('firstRunStep3')];
  return (
    <Panel aria-labelledby={titleId} className={cx('w-full max-w-[30rem] p-6 sm:p-7', className)}>
      <EmptyState
        titleId={titleId}
        icon={<ServerIcon size={22} />}
        title={t('firstRunTitle')}
        body={t('firstRunBody')}
        action={
          <ButtonLink
            href={withReturnPath(ROUTES.addServer, ROUTES.workspace)}
            variant="primary"
            size="lg"
          >
            {t('firstRunCta')}
          </ButtonLink>
        }
      >
        <ol className="flex w-full flex-col border-line border-y">
          {steps.map((step, index) => (
            <li
              key={step}
              className="grid grid-cols-[1.5rem_1fr] items-center gap-3 border-line border-t py-2.5 text-base text-ink first:border-t-0"
            >
              <span className="inline-flex size-6 items-center justify-center rounded-pill bg-surface-raised font-semibold text-ink-muted text-xs tabular-nums">
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </EmptyState>
    </Panel>
  );
}

/**
 * Servers exist but nothing is open in this pane: says what the pane is for. With no session at
 * all it also offers the one action that starts one (the sidebar's button keeps the shortcut).
 */
export function PickSessionPanel({ hasSessions }: { hasSessions: boolean }) {
  const t = useTranslations('workspace.pane');
  const titleId = useId();
  return (
    <Panel aria-labelledby={titleId} className="w-full max-w-[26rem] p-6 sm:p-7">
      <EmptyState
        titleId={titleId}
        title={hasSessions ? t('emptyTitle') : t('noSessionsTitle')}
        body={hasSessions ? t('emptyBody') : t('noSessionsBody')}
        action={hasSessions ? undefined : <NewSessionButton shortcut={false} block={false} />}
      />
    </Panel>
  );
}
