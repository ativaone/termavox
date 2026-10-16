'use client';

import type { SessionStatus } from '@termdock/protocol/client';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react';
import type {
  AuthPromptRequest,
  ChannelState,
  HostKeyPrompt,
  ServerError,
  SessionEntry,
  TerminalLayout,
} from '../../lib/terminal/index.ts';
import { RetryIcon } from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { Notice } from '../ui/notice.tsx';
import { Panel } from '../ui/panel.tsx';
import { PasswordField } from '../ui/password-field.tsx';
import { Spinner } from '../ui/spinner.tsx';
import { STATE_FILL } from '../ui/state.ts';
import { StatusChip } from '../ui/status-chip.tsx';
import { TextField } from '../ui/text-field.tsx';
import { useNow } from './hooks.ts';
import { type SessionActionKind, useWorkspace } from './workspace-context.tsx';

/**
 * Everything a pane says about its session, drawn over the terminal's last screen and never in
 * place of it (plan §5.6, §11.1): a quiet chip while connecting or restoring, a docked slip when
 * the session is reconnecting, disconnected or ended, and a centred buff panel when the user has
 * to decide (host key, keyboard-interactive sign-in). No modals: each panel belongs to its pane.
 */

export interface LinkPrompt {
  uri: string;
  resolve(open: boolean): void;
}

type Overlay =
  | { kind: 'hostKey'; prompt: HostKeyPrompt }
  | { kind: 'mismatch'; prompt: HostKeyPrompt | null }
  | { kind: 'auth'; prompt: AuthPromptRequest }
  | { kind: 'actionWait' }
  | { kind: 'reconnecting'; deadline: number | null }
  | { kind: 'disconnected'; detail: string | null }
  | { kind: 'ended'; reason: string | null }
  | { kind: 'gone' };

/** Known failure details (`session.status` detail of `failed`), mapped to their message key. */
const FAILURE_KEYS = {
  AUTH_REJECTED: 'authRejected',
  CREDENTIAL_INVALID: 'credentialInvalid',
  HOST_KEY_REJECTED: 'hostKeyRejected',
  HOST_UNREACHABLE: 'hostUnreachable',
  NOT_FOUND: 'notFound',
  FORBIDDEN: 'forbidden',
  LOCAL_SHELL_DISABLED: 'localShellDisabled',
} as const;

const END_KEYS = {
  user_terminated: 'userTerminated',
  shell_exited: 'shellExited',
  connection_lost: 'connectionLost',
  service_restarted: 'serviceRestarted',
  error: 'error',
} as const;

function pick<T extends Record<string, string>>(table: T, key: string | null): T[keyof T] | null {
  return key !== null && Object.hasOwn(table, key) ? table[key as keyof T] : null;
}

function chooseOverlay(
  sessionId: string,
  entry: SessionEntry | undefined,
  gone: boolean,
  prompts: { hostKey?: HostKeyPrompt; auth?: AuthPromptRequest },
): Overlay | null {
  if (!entry) return gone ? { kind: 'gone' } : null;
  const { hostKey, auth } = prompts;
  switch (entry.status) {
    case 'action_required':
      if (hostKey && !hostKey.mismatch) return { kind: 'hostKey', prompt: hostKey };
      if (auth?.sessionId === sessionId) return { kind: 'auth', prompt: auth };
      return { kind: 'actionWait' };
    case 'disconnected':
      if (hostKey?.mismatch || entry.detail === 'HOST_KEY_MISMATCH') {
        return { kind: 'mismatch', prompt: hostKey ?? null };
      }
      return { kind: 'disconnected', detail: entry.detail };
    case 'reconnecting':
      return {
        kind: 'reconnecting',
        deadline:
          entry.retryInMs !== null && entry.statusAt !== null
            ? entry.statusAt + entry.retryInMs
            : null,
      };
    case 'ended':
      return { kind: 'ended', reason: entry.endReason ?? entry.detail };
    default:
      return null;
  }
}

/** Runs a session Server Action with its pending and error state. */
function useSessionAction(sessionId: string) {
  const { sessionAction } = useWorkspace();
  const [pending, setPending] = useState<SessionActionKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (kind: SessionActionKind): Promise<boolean> => {
    setPending(kind);
    setError(null);
    try {
      const result = await sessionAction(kind, sessionId);
      if (!result.ok) setError(result.message);
      return result.ok;
    } finally {
      setPending(null);
    }
  };
  return { run, pending, error };
}

function Head({
  status,
  statusLabel,
  title,
  titleId,
  inline = false,
  children,
}: {
  status: SessionStatus;
  statusLabel: string;
  title: string;
  titleId: string;
  /** The title already names the state: the swatch sits beside it, without a separate chip. */
  inline?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {inline ? null : <StatusChip status={status} label={statusLabel} />}
      <h2 id={titleId} className="flex items-center gap-2 font-semibold text-ink text-md">
        {inline ? (
          <span
            aria-hidden="true"
            className={cx('size-2 shrink-0 rounded-[1px]', STATE_FILL[status])}
          />
        ) : null}
        {title}
      </h2>
      {children ? <div className="text-ink-muted text-base">{children}</div> : null}
    </div>
  );
}

function Docked({
  placement,
  children,
}: {
  placement: 'center' | 'bottom' | 'top';
  children: ReactNode;
}) {
  if (placement === 'center') {
    return (
      <div className="absolute inset-0 z-20 flex items-center justify-center overflow-y-auto bg-pane/70 p-3">
        {children}
      </div>
    );
  }
  return (
    <div
      className={cx(
        'pointer-events-none absolute inset-x-0 z-20 flex justify-center p-2.5',
        placement === 'bottom' ? 'bottom-0' : 'top-0',
      )}
    >
      <div className="pointer-events-auto w-full max-w-[32rem]">{children}</div>
    </div>
  );
}

function HostKeyPanel({
  entry,
  prompt,
  autoFocus,
}: {
  entry: SessionEntry;
  prompt: HostKeyPrompt;
  autoFocus: boolean;
}) {
  const t = useTranslations('workspace');
  const { connection } = useWorkspace();
  const titleId = useId();
  const [offline, setOffline] = useState(false);
  const decide = (accept: boolean) => {
    setOffline(!connection.hostKeyDecision(entry.id, prompt.fingerprint, accept));
  };
  return (
    <Panel aria-labelledby={titleId} className="w-full max-w-[30rem]">
      <div className="flex flex-col gap-4 px-5 py-4">
        <Head
          status="action_required"
          statusLabel={t('status.action_required')}
          title={t('hostKey.title')}
          titleId={titleId}
        >
          {t('hostKey.body', { host: entry.hostName })}
        </Head>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-rule border-y py-3 text-base">
          <dt className="font-semibold text-ink-muted text-sm">{t('hostKey.target')}</dt>
          <dd className="break-all text-ink">
            {entry.username}@{entry.hostname}
          </dd>
          <dt className="font-semibold text-ink-muted text-sm">{t('hostKey.keyType')}</dt>
          <dd className="break-all font-mono text-ink text-xs leading-5">{prompt.keyType}</dd>
          <dt className="font-semibold text-ink-muted text-sm">{t('hostKey.fingerprint')}</dt>
          <dd className="break-all font-mono text-ink text-xs leading-5">{prompt.fingerprint}</dd>
        </dl>
        <p className="text-ink-muted text-sm">{t('hostKey.compare')}</p>
        {offline ? <Notice tone="warning">{t('overlay.offline')}</Notice> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" autoFocus={autoFocus} onClick={() => decide(true)}>
            {t('hostKey.accept')}
          </Button>
          <Button variant="secondary" onClick={() => decide(false)}>
            {t('hostKey.reject')}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function MismatchPanel({ entry, prompt }: { entry: SessionEntry; prompt: HostKeyPrompt | null }) {
  const t = useTranslations('workspace');
  const { hostHref } = useWorkspace();
  const titleId = useId();
  return (
    <Panel aria-labelledby={titleId} className="w-full max-w-[30rem]">
      <div className="flex flex-col gap-4 px-5 py-4">
        <Head
          status="disconnected"
          statusLabel={t('status.disconnected')}
          title={t('mismatch.title')}
          titleId={titleId}
        />
        <Notice tone="danger">{t('mismatch.body', { host: entry.hostName })}</Notice>
        {prompt ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-base">
            <dt className="font-semibold text-ink-muted text-sm">{t('hostKey.keyType')}</dt>
            <dd className="break-all font-mono text-ink text-xs leading-5">{prompt.keyType}</dd>
            <dt className="font-semibold text-ink-muted text-sm">{t('mismatch.presented')}</dt>
            <dd className="break-all font-mono text-ink text-xs leading-5">{prompt.fingerprint}</dd>
          </dl>
        ) : null}
        {entry.hostId ? (
          <div>
            <Link
              href={hostHref(entry.hostId)}
              className="font-medium text-focus-stock text-base underline"
            >
              {t('mismatch.review')}
            </Link>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function AuthPanel({
  entry,
  prompt,
  autoFocus,
}: {
  entry: SessionEntry;
  prompt: AuthPromptRequest;
  autoFocus: boolean;
}) {
  const t = useTranslations('workspace');
  const tc = useTranslations('common.field');
  const { connection } = useWorkspace();
  const titleId = useId();
  const [offline, setOffline] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const answers = prompt.prompts.map((_, i) => String(data.get(`answer-${i}`) ?? ''));
    const sent = connection.authResponse(entry.id, prompt.promptId, answers);
    setOffline(!sent);
    // Answers never stay in the page once sent.
    if (sent) form.reset();
  };
  return (
    <Panel aria-labelledby={titleId} className="w-full max-w-[28rem]">
      <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-4" autoComplete="off">
        <Head
          status="action_required"
          statusLabel={t('status.action_required')}
          title={prompt.name.trim() || t('auth.title')}
          titleId={titleId}
        >
          {prompt.instructions.trim() ? (
            <p className="whitespace-pre-line">{prompt.instructions.trim()}</p>
          ) : (
            t('auth.body', { target: `${entry.username}@${entry.hostname}` })
          )}
        </Head>
        {prompt.prompts.map((field, i) => {
          const label = field.text.trim() || t('auth.answer', { n: i + 1 });
          const common = {
            name: `answer-${i}`,
            label,
            autoFocus: autoFocus && i === 0,
            errorPrefix: tc('errorPrefix'),
          };
          // Prompts are positional (answers go back in the same order) and never reorder.
          return field.echo ? (
            <TextField
              // biome-ignore lint/suspicious/noArrayIndexKey: positional prompts of one promptId
              key={`${prompt.promptId}-${i}`}
              {...common}
              autoComplete="off"
              spellCheck={false}
            />
          ) : (
            <PasswordField
              // biome-ignore lint/suspicious/noArrayIndexKey: positional prompts of one promptId
              key={`${prompt.promptId}-${i}`}
              {...common}
              autoComplete="one-time-code"
            />
          );
        })}
        {offline ? <Notice tone="warning">{t('overlay.offline')}</Notice> : null}
        <div>
          <Button type="submit" variant="primary">
            {t('auth.submit')}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function ActionPanel({
  status,
  title,
  body,
  titleId,
  actions,
  error,
  inline = false,
}: {
  status: SessionStatus;
  title: string;
  body: ReactNode;
  titleId: string;
  actions: ReactNode;
  error?: string | null;
  inline?: boolean;
}) {
  const t = useTranslations('workspace');
  return (
    <Panel aria-labelledby={titleId} className="w-full">
      <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-end sm:justify-between">
        <Head
          status={status}
          statusLabel={t(`status.${status}`)}
          title={title}
          titleId={titleId}
          inline={inline}
        >
          {body}
        </Head>
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      </div>
      {error ? (
        <div className="px-4 pb-3.5">
          <Notice tone="danger">{error}</Notice>
        </div>
      ) : null}
    </Panel>
  );
}

function ReconnectingSlip({ entry, deadline }: { entry: SessionEntry; deadline: number | null }) {
  const t = useTranslations('workspace');
  const titleId = useId();
  const now = useNow(1_000, deadline !== null);
  const action = useSessionAction(entry.id);
  const seconds = deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1_000));
  return (
    <ActionPanel
      status="reconnecting"
      titleId={titleId}
      inline
      title={
        seconds === null || seconds === 0
          ? t('overlay.reconnectingNow')
          : t('overlay.reconnectingIn', { seconds })
      }
      body={t('overlay.reconnectingBody', { host: entry.hostName })}
      error={action.error}
      actions={
        <Button
          size="sm"
          variant="primary"
          icon={<RetryIcon size={16} />}
          loading={action.pending === 'retry'}
          onClick={() => void action.run('retry')}
        >
          {t('overlay.retryNow')}
        </Button>
      }
    />
  );
}

function DisconnectedSlip({ entry, detail }: { entry: SessionEntry; detail: string | null }) {
  const t = useTranslations('workspace');
  const titleId = useId();
  const action = useSessionAction(entry.id);
  const key = pick(FAILURE_KEYS, detail);
  return (
    <ActionPanel
      status="disconnected"
      titleId={titleId}
      inline
      title={t('overlay.disconnectedTitle')}
      body={key ? t(`failure.${key}`) : t('failure.generic')}
      error={action.error}
      actions={
        <Button
          size="sm"
          variant="primary"
          icon={<RetryIcon size={16} />}
          loading={action.pending === 'retry'}
          onClick={() => void action.run('retry')}
        >
          {t('overlay.retry')}
        </Button>
      }
    />
  );
}

function EndedSlip({
  entry,
  reason,
  onClose,
}: {
  entry: SessionEntry;
  reason: string | null;
  onClose: (() => void) | null;
}) {
  const t = useTranslations('workspace');
  const titleId = useId();
  const action = useSessionAction(entry.id);
  const key = pick(END_KEYS, reason);
  return (
    <ActionPanel
      status="ended"
      titleId={titleId}
      inline
      title={t('overlay.endedTitle')}
      body={key ? t(`endReason.${key}`) : t('endReason.unknown')}
      error={action.error}
      actions={
        <>
          {onClose ? (
            <Button size="sm" variant="quiet" onClick={onClose}>
              {t('overlay.closePane')}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            loading={action.pending === 'reopen'}
            onClick={() => void action.run('reopen')}
          >
            {t('overlay.reopen')}
          </Button>
        </>
      }
    />
  );
}

function GoneSlip({ onClose }: { onClose: (() => void) | null }) {
  const t = useTranslations('workspace');
  const titleId = useId();
  return (
    <ActionPanel
      status="ended"
      titleId={titleId}
      inline
      title={t('overlay.endedTitle')}
      body={t('overlay.goneBody')}
      actions={
        onClose ? (
          <Button size="sm" variant="primary" onClick={onClose}>
            {t('overlay.closePane')}
          </Button>
        ) : null
      }
    />
  );
}

function ActionWaitPanel({ entry }: { entry: SessionEntry }) {
  const t = useTranslations('workspace');
  const titleId = useId();
  const action = useSessionAction(entry.id);
  return (
    <div className="w-full max-w-[30rem]">
      <ActionPanel
        status="action_required"
        titleId={titleId}
        title={t('overlay.waitTitle')}
        body={t('overlay.waitBody')}
        error={action.error}
        actions={
          <Button
            size="sm"
            variant="primary"
            icon={<RetryIcon size={16} />}
            loading={action.pending === 'retry'}
            onClick={() => void action.run('retry')}
          >
            {t('overlay.retry')}
          </Button>
        }
      />
    </div>
  );
}

function LinkPanel({ prompt }: { prompt: LinkPrompt }) {
  const t = useTranslations('workspace.link');
  const titleId = useId();
  const cancelOnEscape = (event: { key: string }) => {
    if (event.key === 'Escape') prompt.resolve(false);
  };
  return (
    <Panel aria-labelledby={titleId} className="w-full max-w-[30rem]">
      <div className="flex flex-col gap-3 px-5 py-4">
        <h2 id={titleId} className="font-semibold text-ink text-md">
          {t('title')}
        </h2>
        <p className="max-h-32 overflow-y-auto break-all rounded-control bg-field px-3 py-2 text-base text-ink">
          {prompt.uri}
        </p>
        <p className="text-ink-muted text-sm">{t('body')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            autoFocus
            onClick={() => prompt.resolve(true)}
            onKeyDown={cancelOnEscape}
          >
            {t('open')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => prompt.resolve(false)}
            onKeyDown={cancelOnEscape}
          >
            {t('cancel')}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/** A quiet chip in the pane's corner: progress (with spinner) or a passive-size hint. */
function Chip({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return (
    <span
      role="status"
      className="surface-board inline-flex h-7 items-center gap-1.5 rounded-control bg-board-1/90 px-2.5 font-medium text-board-ink text-xs shadow-strip"
    >
      {busy ? <Spinner size={13} className="text-board-ink-muted" /> : null}
      {children}
    </span>
  );
}

const ERROR_KEYS = { CONFLICT: 'conflict', FORBIDDEN: 'forbidden' } as const;

export function PaneOverlays({
  sessionId,
  channelState,
  layout,
  active,
  linkPrompt,
  notice,
  onDismissNotice,
  onClose,
}: {
  sessionId: string;
  channelState: ChannelState | null;
  layout: TerminalLayout | null;
  /** The pane holds the focus in its tab (panels may take the keyboard). */
  active: boolean;
  linkPrompt: LinkPrompt | null;
  /** A pane-local message (clipboard refused…). */
  notice: string | null;
  onDismissNotice(): void;
  onClose: (() => void) | null;
}) {
  const t = useTranslations('workspace');
  const { sessions, connectionState, connection } = useWorkspace();
  const entry = sessions.get(sessionId);
  const hostKey = connectionState.hostKeyPrompts[sessionId];
  const auth = connectionState.authPrompts[sessionId];
  const gone =
    connectionState.sessionsLoaded &&
    !entry &&
    channelState?.phase === 'failed' &&
    channelState.error?.code === 'NOT_FOUND';
  const overlay = chooseOverlay(sessionId, entry, gone, { hostKey, auth });

  // A refused decision (e.g. an expired host-key prompt) arrives as a connection-level error.
  const lastError: ServerError | null =
    connectionState.lastError?.sessionId === sessionId ? connectionState.lastError : null;
  const dismissed = useRef<ServerError | null>(null);
  const [, rerender] = useState(0);
  const showError = lastError !== null && dismissed.current !== lastError;

  const status = entry?.status ?? 'connecting';
  const linkOpen = linkPrompt !== null;
  const channelLive = channelState?.phase === 'live';
  const progress =
    !overlay &&
    !gone &&
    (status === 'connecting' ||
      status === 'restoring' ||
      (status === 'connected' && !channelLive) ||
      connectionState.status !== 'open');
  const passive =
    !overlay &&
    channelLive &&
    status === 'connected' &&
    channelState?.active === false &&
    layout !== null &&
    layout.mode !== 'fit';

  let docked: ReactNode = null;
  if (entry && overlay) {
    switch (overlay.kind) {
      case 'hostKey':
        docked = (
          <Docked placement="center">
            <HostKeyPanel entry={entry} prompt={overlay.prompt} autoFocus={active} />
          </Docked>
        );
        break;
      case 'mismatch':
        docked = (
          <Docked placement="center">
            <MismatchPanel entry={entry} prompt={overlay.prompt} />
          </Docked>
        );
        break;
      case 'auth':
        docked = (
          <Docked placement="center">
            <AuthPanel entry={entry} prompt={overlay.prompt} autoFocus={active} />
          </Docked>
        );
        break;
      case 'actionWait':
        docked = (
          <Docked placement="center">
            <ActionWaitPanel entry={entry} />
          </Docked>
        );
        break;
      case 'reconnecting':
        docked = (
          <Docked placement="top">
            <ReconnectingSlip entry={entry} deadline={overlay.deadline} />
          </Docked>
        );
        break;
      case 'disconnected':
        docked = (
          <Docked placement="bottom">
            <DisconnectedSlip entry={entry} detail={overlay.detail} />
          </Docked>
        );
        break;
      case 'ended':
        docked = (
          <Docked placement="bottom">
            <EndedSlip entry={entry} reason={overlay.reason} onClose={onClose} />
          </Docked>
        );
        break;
      case 'gone':
        break;
    }
  } else if (gone) {
    docked = (
      <Docked placement="bottom">
        <GoneSlip onClose={onClose} />
      </Docked>
    );
  }

  const notices: ReactNode[] = [];
  if (entry?.remoteRebooted) {
    notices.push(
      <Notice key="reboot" tone="warning" title={t('overlay.rebootTitle')}>
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span>{t('overlay.rebootBody')}</span>
          <button
            type="button"
            className="font-semibold underline underline-offset-2"
            onClick={() => connection.acknowledgeRemoteReboot(sessionId)}
          >
            {t('overlay.acknowledge')}
          </button>
        </span>
      </Notice>,
    );
  }
  if (showError && lastError) {
    const key = pick(ERROR_KEYS, lastError.code);
    notices.push(
      <Notice key="error" tone="danger">
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span>{key ? t(`serverError.${key}`) : t('serverError.generic')}</span>
          <button
            type="button"
            className="font-semibold underline underline-offset-2"
            onClick={() => {
              dismissed.current = lastError;
              rerender((n) => n + 1);
            }}
          >
            {t('overlay.dismiss')}
          </button>
        </span>
      </Notice>,
    );
  }
  if (notice) {
    notices.push(
      <Notice key="notice" tone="warning">
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span>{notice}</span>
          <button
            type="button"
            className="font-semibold underline underline-offset-2"
            onClick={onDismissNotice}
          >
            {t('overlay.dismiss')}
          </button>
        </span>
      </Notice>,
    );
  }

  return (
    <>
      {docked}
      {linkOpen ? (
        <Docked placement="center">
          <LinkPanel prompt={linkPrompt} />
        </Docked>
      ) : null}
      {notices.length > 0 ? (
        <div className="absolute inset-x-0 top-0 z-30 flex justify-center p-2.5">
          <div className="flex w-full max-w-[32rem] flex-col gap-2 shadow-panel">{notices}</div>
        </div>
      ) : null}
      {progress ? (
        <div className="pointer-events-none absolute end-2.5 top-2.5 z-10">
          <Chip busy>
            {status === 'connecting' ? t('status.connecting') : t('status.restoring')}
          </Chip>
        </div>
      ) : null}
      {passive ? (
        <div className="pointer-events-none absolute end-2.5 bottom-2.5 z-10">
          <Chip>{t('overlay.passive')}</Chip>
        </div>
      ) : null}
    </>
  );
}
