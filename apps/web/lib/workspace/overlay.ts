import type { AuthPromptRequest, HostKeyPrompt, SessionEntry } from '../terminal/index.ts';

/**
 * Which card a pane draws over its session (plan §5.6, §11.1; drawn by
 * `components/workspace/pane-overlays.tsx`): a decision while the session waits for the user, a
 * docked card while it is reconnecting, disconnected or ended, nothing while it runs.
 */
export type Overlay =
  | { kind: 'hostKey'; prompt: HostKeyPrompt }
  | { kind: 'mismatch'; prompt: HostKeyPrompt | null }
  | { kind: 'auth'; prompt: AuthPromptRequest }
  /** Action required with no prompt to answer (it expired or has not arrived yet): Retry. */
  | { kind: 'actionWait' }
  | { kind: 'reconnecting'; deadline: number | null }
  | { kind: 'disconnected'; detail: string | null }
  | { kind: 'ended'; reason: string | null }
  | { kind: 'gone' };

export function chooseOverlay(
  sessionId: string,
  entry: SessionEntry | undefined,
  gone: boolean,
  prompts: { hostKey?: HostKeyPrompt | undefined; auth?: AuthPromptRequest | undefined },
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
    case 'connecting':
    case 'restoring':
      // An attempt of a retry round keeps the round's card (plan D-31), with its Stop, rather
      // than trading it for the progress chip at every attempt.
      return entry.attempt !== null || entry.retryUntil !== null
        ? { kind: 'reconnecting', deadline: null }
        : null;
    case 'ended':
      return { kind: 'ended', reason: entry.endReason ?? entry.detail };
    default:
      return null;
  }
}
