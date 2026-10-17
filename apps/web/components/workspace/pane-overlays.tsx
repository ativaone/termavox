'use client';

import type { SessionStatus } from '@termdock/protocol/client';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react';
import { formatTarget } from '../../lib/servers/target.ts';
import { END_KEYS, FAILURE_KEYS, pick } from '../../lib/sessions/reasons.ts';
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
import { StateLamp } from '../ui/status-chip.tsx';
import { TextField } from '../ui/text-field.tsx';
import { useNow } from './hooks.ts';
import { type SessionActionKind, useWorkspace } from './workspace-context.tsx';

/**
 * Everything a pane says about its session, drawn over the terminal's last screen and never in
 * place of it (plan §5.6, §11.1): a quiet chip while connecting or restoring, a docked card when
 * the session is reconnecting, disconnected or ended, and a centred card when the user has to
 * decide (host key, keyboard-interactive sign-in). No modals: each card belongs to its pane.
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
  /** The title already names the state, so the state word is not repeated after it. */
  inline?: boolean;
  children?: ReactNode;
}) {
  // The state lives on the title row: its swatch before the title and, when the title does not
  // name the state, the state word trailing on the same row (never a label stacked above).
  return (
    <div className="flex flex-col gap-1.5">
      {/* A long title wraps under itself; the state word stays on its first line (narrow panes). */}
      <div className="flex min-w-0 items-start justify-between gap-3">
        <h2 id={titleId} className="flex min-w-0 items-start gap-2 font-semibold text-ink text-md">
          <StateLamp status={status} className="mt-2" />
          <span className="min-w-0 break-words">{title}</span>
        </h2>
        {inline ? null : (
          <span
            className="shrink-0 font-medium text-ink-muted text-xs leading-6"
            data-status={status}
          >
            {statusLabel}
          </span>
        )}
      </div>
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
      <div className="absolute inset-0 z-20 flex items-center justify-center overflow-y-auto bg-pane/75 p-3">
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
    <Panel aria-labelledby={titleId} solid floating className="w-full max-w-[30rem]">
      <div className="flex flex-col gap-4 px-5 py-4">
        <Head
          status="action_required"
          statusLabel={t('status.action_required')}
          title={t('hostKey.title')}
          titleId={titleId}
        >
          {t('hostKey.body', { server: entry.serverName })}
        </Head>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-line border-y py-3 text-base">
          <dt className="font-semibold text-ink-muted text-sm">{t('hostKey.target')}</dt>
          <dd className="break-all text-ink">
            {formatTarget(entry.username, entry.hostname, entry.port)}
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
  const { serverHref } = useWorkspace();
  const titleId = useId();
  return (
    <Panel aria-labelledby={titleId} solid floating className="w-full max-w-[30rem]">
      <div className="flex flex-col gap-4 px-5 py-4">
        <Head
          status="disconnected"
          statusLabel={t('status.disconnected')}
          title={t('mismatch.title')}
          titleId={titleId}
        />
        <Notice tone="danger">
          {prompt?.revoked
            ? t('mismatch.revokedBody', { server: entry.serverName })
            : t('mismatch.body', { server: entry.serverName })}
        </Notice>
        {prompt ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-base">
            <dt className="font-semibold text-ink-muted text-sm">{t('hostKey.keyType')}</dt>
            <dd className="break-all font-mono text-ink text-xs leading-5">{prompt.keyType}</dd>
            <dt className="font-semibold text-ink-muted text-sm">{t('mismatch.presented')}</dt>
            <dd className="break-all font-mono text-ink text-xs leading-5">{prompt.fingerprint}</dd>
          </dl>
        ) : null}
        {entry.serverId ? (
          <div>
            <Link
              href={serverHref(entry.serverId)}
              className="font-medium text-accent text-base underline decoration-accent/50 underline-offset-4 hover:decoration-accent"
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
  const promptName = prompt.name.trim();
  const instructions = prompt.instructions.trim();
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
    <Panel aria-labelledby={titleId} solid floating className="w-full max-w-[28rem]">
      <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-4" autoComplete="off">
        {/* Termdock's own title and framing line, always: the host's name and instructions are
            quoted beneath as host content, never shown as the panel's own words (§5.10). */}
        <Head
          status="action_required"
          statusLabel={t('status.action_required')}
          title={t('auth.title')}
          titleId={titleId}
        >
          {t('auth.asks', { target: formatTarget(entry.username, entry.hostname, entry.port) })}
        </Head>
        {promptName || instructions ? (
          <div className="flex flex-col gap-1 rounded-control bg-field px-4 py-3 text-base text-ink">
            {promptName ? <p className="break-words font-semibold">{promptName}</p> : null}
            {instructions ? (
              <p className="whitespace-pre-line break-words">{instructions}</p>
            ) : null}
          </div>
        ) : null}
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
        <p className="text-ink-muted text-sm">{t('auth.note')}</p>
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
    <Panel aria-labelledby={titleId} solid floating className="w-full">
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
      body={t('overlay.reconnectingBody', { server: entry.serverName })}
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
  // Its server was deleted (plan D-29): it never connects again, so Terminate replaces Retry.
  const serverDeleted = entry.serverId === null;
  const key = serverDeleted ? 'serverDeleted' : pick(FAILURE_KEYS, detail);
  return (
    <ActionPanel
      status="disconnected"
      titleId={titleId}
      inline
      title={t('overlay.disconnectedTitle')}
      body={key ? t(`failure.${key}`) : t('failure.generic')}
      error={action.error}
      actions={
        serverDeleted ? (
          <Button
            size="sm"
            variant="secondary"
            loading={action.pending === 'terminate'}
            onClick={() => void action.run('terminate')}
          >
            {t('overlay.terminate')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            icon={<RetryIcon size={16} />}
            loading={action.pending === 'retry'}
            onClick={() => void action.run('retry')}
          >
            {t('overlay.retry')}
          </Button>
        )
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
      body={
        <>
          <span className="block">{key ? t(`endReason.${key}`) : t('endReason.unknown')}</span>
          {/* Plan D-30: its tmux is still running on the server until the next connection. */}
          {entry.remoteCleanup ? (
            <span className="mt-1 block">
              {t('overlay.remoteCleanup', { server: entry.serverName })}
            </span>
          ) : null}
        </>
      }
      error={action.error}
      actions={
        <>
          {onClose ? (
            <Button size="sm" variant="quiet" onClick={onClose}>
              {t('overlay.closePane')}
            </Button>
          ) : null}
          {/* A session whose server was deleted cannot be reopened (plan D-29). */}
          {entry.serverId !== null ? (
            <Button
              size="sm"
              variant="primary"
              loading={action.pending === 'reopen'}
              onClick={() => void action.run('reopen')}
            >
              {t('overlay.reopen')}
            </Button>
          ) : null}
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
    <Panel aria-labelledby={titleId} solid floating className="w-full max-w-[30rem]">
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
      className="inline-flex h-7 items-center gap-1.5 rounded-pill border border-line bg-surface-solid px-2.5 font-medium text-ink text-xs shadow-float"
    >
      {busy ? <Spinner size={13} className="text-accent" /> : null}
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
  onRetryAttach,
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
  /** Attaches this pane again (after the server refused the attach). */
  onRetryAttach: (() => void) | null;
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
  // The user has too many terminals attached across their windows: this pane was refused.
  const attachLimited =
    channelState?.phase === 'failed' && channelState.error?.code === 'RATE_LIMITED';

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
    !attachLimited &&
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
  if (attachLimited) {
    notices.push(
      <Notice key="attach-limit" tone="warning">
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span>{t('pane.tooManyTerminals')}</span>
          {onRetryAttach ? (
            <button
              type="button"
              className="font-semibold underline underline-offset-2"
              onClick={onRetryAttach}
            >
              {t('overlay.retry')}
            </button>
          ) : null}
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
          <div className="flex w-full max-w-[32rem] flex-col gap-2 [&>*]:border [&>*]:border-line [&>*]:bg-surface-solid [&>*]:shadow-float">
            {notices}
          </div>
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
