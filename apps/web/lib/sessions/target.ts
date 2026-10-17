import { formatTarget } from '../servers/target.ts';

/** What a session row shows under its label (plan D-29). Browser-safe. */
export interface SessionTargetFields {
  kind: 'ssh' | 'local';
  username: string;
  hostname: string;
  port: number;
}

/** `user@host`, `user@host:port` off port 22, or the (localized) local wording for direct mode. */
export function sessionTarget(session: SessionTargetFields, localLabel: string): string {
  return session.kind === 'local'
    ? localLabel
    : formatTarget(session.username, session.hostname, session.port);
}
