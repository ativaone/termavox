'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import {
  adoptRemoteSession,
  listRemoteSessions,
  terminateRemoteSession,
} from '../../lib/actions/remote-sessions.ts';
import { ROUTES } from '../../lib/routes.ts';
import type { RemoteScanResult } from '../../lib/sessions/action-result.ts';
import { SearchIcon } from '../icons/index.tsx';
import { Button, ButtonLink } from '../ui/button.tsx';
import { LocalTime } from '../ui/local-time.tsx';
import { DANGER_SLIP_CLASSES, Notice } from '../ui/notice.tsx';
import { Tag } from '../ui/tag.tsx';

type Scan = Extract<RemoteScanResult, { ok: true }>;
type RemoteSessionInfo = Scan['sessions'][number];
type Step = { socket: string; kind: 'end' | 'adopt' };

/** The confirmation of Adopt while someone is attached: a caution, not a destruction. */
const CAUTION_SLIP_CLASSES =
  'flex flex-col gap-3 rounded-control bg-warning-soft px-3.5 py-3 text-base text-ink';

function When({ at }: { at: number | null }) {
  const t = useTranslations('servers.remote');
  return at === null ? t('notReported') : <LocalTime at={at} />;
}

/**
 * "Sessions on this server" (plan D-30): Check now connects to the server as its user and lists
 * the Termdock tmux servers there that this installation does not run. Each shows where it comes
 * from, when it started and was last used, and who is attached, with Adopt (a new session of this
 * server attached to it, opened in the workspace; confirmed first while someone is attached) and
 * End (a danger slip: the programs in it stop). Nothing runs until the user presses Check now.
 */
export function RemoteSessions({
  serverId,
  username,
}: {
  serverId: string;
  /** The server's user name: the user whose tmux servers are listed. */
  username: string;
}) {
  const t = useTranslations('servers.remote');
  const tn = useTranslations('workspace.notice');
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [scan, setScan] = useState<Scan | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Step | null>(null);
  const [pending, setPending] = useState<Step | null>(null);
  const [itemError, setItemError] = useState<{ socket: string; message: string } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // A confirmation slip takes the focus on its Cancel control, like the session menu's.
  useEffect(() => {
    if (confirm) listRef.current?.querySelector<HTMLElement>('[data-cancel]')?.focus();
  }, [confirm]);

  const check = async () => {
    setChecking(true);
    setFailure(null);
    setDone(null);
    setConfirm(null);
    setItemError(null);
    try {
      const result = await listRemoteSessions(serverId);
      if (result.ok) setScan(result);
      else {
        setScan(null);
        setFailure(result.message);
      }
    } catch {
      setFailure(tn('actionFailed'));
    } finally {
      setChecking(false);
    }
  };

  const end = async (socket: string) => {
    setPending({ socket, kind: 'end' });
    setItemError(null);
    try {
      const result = await terminateRemoteSession(serverId, socket);
      if (!result.ok) {
        setItemError({ socket, message: result.message });
        return;
      }
      setConfirm(null);
      setDone(result.terminated ? t('endedNotice') : t('goneNotice'));
      setScan((s) => (s ? { ...s, sessions: s.sessions.filter((x) => x.socket !== socket) } : s));
    } catch {
      setItemError({ socket, message: tn('actionFailed') });
    } finally {
      setPending(null);
    }
  };

  const adopt = async (session: RemoteSessionInfo) => {
    const { socket } = session;
    setPending({ socket, kind: 'adopt' });
    setItemError(null);
    try {
      // An ended session's leftover keeps the name it had.
      const result = await adoptRemoteSession(serverId, socket, session.label ?? undefined);
      if (result.ok) {
        router.push(`${ROUTES.workspace}?open=${encodeURIComponent(result.sessionId)}`);
        return; // the spinner stays until the workspace takes over
      }
      setItemError({ socket, message: result.message });
    } catch {
      setItemError({ socket, message: tn('actionFailed') });
    }
    setPending(null);
  };

  const busy = pending !== null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div>
          <Button
            variant="secondary"
            loading={checking}
            disabled={busy}
            icon={<SearchIcon size={16} />}
            onClick={() => void check()}
          >
            {t('check')}
          </Button>
        </div>
        <p className="max-w-[65ch] text-pretty text-ink-muted text-sm">
          {t('help', { user: username })}
        </p>
      </div>

      <div aria-live="polite" className="flex flex-col gap-3 empty:hidden">
        {failure ? (
          <Notice tone="danger" title={t('checkFailed')}>
            {failure}
          </Notice>
        ) : null}
        {done ? <Notice tone="success">{done}</Notice> : null}
        {scan && scan.cleaned > 0 ? (
          <Notice tone="success">{t('cleaned', { count: scan.cleaned })}</Notice>
        ) : null}
        {scan?.truncated ? <Notice tone="warning">{t('truncated')}</Notice> : null}
        {scan ? (
          <p className="text-ink-muted text-sm">
            {t('checkedAt')} <LocalTime at={scan.at} withSeconds />
          </p>
        ) : null}
        {scan && scan.sessions.length === 0 ? (
          <p className="text-pretty text-base text-ink-muted">{t('empty', { user: username })}</p>
        ) : null}
      </div>

      {scan && scan.sessions.length > 0 ? (
        <>
          <ul
            ref={listRef}
            aria-label={t('listLabel')}
            className="flex flex-col border-line border-y"
          >
            {scan.sessions.map((session) => {
              const { socket } = session;
              const step = confirm?.socket === socket ? confirm.kind : null;
              const working = pending?.socket === socket ? pending.kind : null;
              const error = itemError?.socket === socket ? itemError.message : null;
              const inUse = session.attachedClients > 0;
              return (
                <li
                  key={socket}
                  className="flex flex-col gap-3 border-line border-t py-4 first:border-t-0"
                >
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Tag>{t(`origin.${session.origin}`)}</Tag>
                      {session.origin === 'ended' && session.label ? (
                        <span className="min-w-0 break-words font-semibold text-ink text-sm">
                          {session.label}
                        </span>
                      ) : null}
                    </div>
                    <code className="break-all font-mono text-ink-muted text-xs leading-5">
                      {socket}
                    </code>
                  </div>
                  <dl className="grid gap-x-6 gap-y-2 text-base sm:grid-cols-3">
                    <div className="flex flex-col gap-0.5">
                      <dt className="text-ink-muted text-sm">{t('created')}</dt>
                      <dd className="text-ink">
                        <When at={session.createdAt} />
                      </dd>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <dt className="text-ink-muted text-sm">{t('lastActivity')}</dt>
                      <dd className="text-ink">
                        <When at={session.lastActivityAt} />
                      </dd>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <dt className="text-ink-muted text-sm">{t('clients')}</dt>
                      <dd className="text-ink tabular-nums">
                        {t('clientsCount', { count: session.attachedClients })}
                      </dd>
                    </div>
                  </dl>
                  {inUse ? (
                    <Notice tone="warning">{t('inUse', { count: session.attachedClients })}</Notice>
                  ) : null}
                  {step === 'end' ? (
                    <div className={DANGER_SLIP_CLASSES}>
                      <p className="text-pretty">{t('endQuestion')}</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="destructive"
                          size="sm"
                          isolated={false}
                          loading={working === 'end'}
                          onClick={() => void end(socket)}
                        >
                          {t('endConfirm')}
                        </Button>
                        <Button
                          data-cancel=""
                          variant="quiet"
                          size="sm"
                          disabled={busy}
                          onClick={() => setConfirm(null)}
                        >
                          {t('cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : step === 'adopt' ? (
                    <div className={CAUTION_SLIP_CLASSES}>
                      <p className="text-pretty">{t('adoptQuestion')}</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={working === 'adopt'}
                          onClick={() => void adopt(session)}
                        >
                          {t('adoptConfirm')}
                        </Button>
                        <Button
                          data-cancel=""
                          variant="quiet"
                          size="sm"
                          disabled={busy}
                          onClick={() => setConfirm(null)}
                        >
                          {t('cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      {session.origin === 'ended' && session.sessionId ? (
                        // The user's own ended session: Reopen there reattaches this tmux server
                        // (same token), so it is not adopted as a second session (409).
                        <ButtonLink
                          href={`${ROUTES.workspace}?open=${encodeURIComponent(session.sessionId)}`}
                          variant="secondary"
                          size="sm"
                        >
                          {t('openEnded')}
                        </ButtonLink>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={working === 'adopt'}
                          disabled={busy || checking}
                          onClick={() =>
                            inUse ? setConfirm({ socket, kind: 'adopt' }) : void adopt(session)
                          }
                        >
                          {t('adopt')}
                        </Button>
                      )}
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={busy || checking}
                        onClick={() => setConfirm({ socket, kind: 'end' })}
                      >
                        {t('end')}
                      </Button>
                    </div>
                  )}
                  {error ? <Notice tone="danger">{error}</Notice> : null}
                </li>
              );
            })}
          </ul>
          <p className="max-w-[65ch] text-pretty text-ink-muted text-sm">{t('actionsHelp')}</p>
        </>
      ) : null}
    </div>
  );
}
