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

export const ProfileProtection = z.enum(['auto', 'off']);
export type ProfileProtection = z.infer<typeof ProfileProtection>;

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
