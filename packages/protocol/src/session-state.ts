import { z } from 'zod';

/** Internal session states (persisted as sessions.state). See implementation plan §5.6. */
export const SessionState = z.enum([
  'new',
  'connecting',
  'verifying_host',
  'awaiting_host_key',
  'authenticating',
  'awaiting_user_input',
  'probing',
  'starting',
  'syncing',
  'ready',
  'reconnecting',
  'terminating',
  'ended',
  'failed',
]);
export type SessionState = z.infer<typeof SessionState>;

/** User-facing status. The UI only ever shows these. */
export const SessionStatus = z.enum([
  'connecting',
  'restoring',
  'connected',
  'action_required',
  'reconnecting',
  'disconnected',
  'ended',
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const Protection = z.enum(['tmux-control', 'tmux-normal', 'none']);
export type Protection = z.infer<typeof Protection>;

/**
 * Why the daemon left a session unprotected: `noticeCode` in the details of the
 * `protection_selected` / `protection_degraded` session events (next to the English `notice`).
 */
export const ProtectionNotice = z.enum([
  'tmux_missing',
  'tmux_too_old',
  'no_utf8',
  'control_unavailable',
]);
export type ProtectionNotice = z.infer<typeof ProtectionNotice>;

/** A server's `protection_mode` setting (plan §5.7). */
export const ProtectionMode = z.enum(['auto', 'off']);
export type ProtectionMode = z.infer<typeof ProtectionMode>;

/**
 * A server's `tmux_term` setting (plan D-49): the terminal type inside its protected sessions.
 * `auto`: tmux's own type (`tmux-256color`, else `screen-256color`); `xterm-256color` on request.
 */
export const TmuxTerm = z.enum(['auto', 'xterm-256color']);
export type TmuxTerm = z.infer<typeof TmuxTerm>;

export const EndReason = z.enum([
  'user_terminated',
  'shell_exited',
  'connection_lost',
  'service_restarted',
  'error',
]);
export type EndReason = z.infer<typeof EndReason>;

/**
 * Maps an internal state to the user-facing status.
 * `wasReady` = the session reached `ready` at least once in this runtime or before a restart,
 * which turns (re)starting/syncing into "Restoring…" instead of "Connecting…".
 */
export function toSessionStatus(state: SessionState, wasReady: boolean): SessionStatus {
  switch (state) {
    case 'ready':
      return 'connected';
    case 'awaiting_host_key':
    case 'awaiting_user_input':
      return 'action_required';
    case 'reconnecting':
      return 'reconnecting';
    case 'failed':
      return 'disconnected';
    case 'terminating':
    case 'ended':
      return 'ended';
    case 'starting':
    case 'syncing':
      return wasReady ? 'restoring' : 'connecting';
    case 'new':
    case 'connecting':
    case 'verifying_host':
    case 'authenticating':
    case 'probing':
      return wasReady ? 'restoring' : 'connecting';
  }
}
