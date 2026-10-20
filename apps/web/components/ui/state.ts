import type { SessionStatus } from '@termavox/protocol/client';

/** State colour per user-facing status: the only place state colours are assigned. */
export const STATE_FILL: Record<SessionStatus, string> = {
  connected: 'bg-state-connected',
  connecting: 'bg-state-progress',
  restoring: 'bg-state-progress',
  reconnecting: 'bg-state-reconnecting',
  action_required: 'bg-state-action',
  disconnected: 'bg-state-disconnected',
  ended: 'bg-state-ended',
};
