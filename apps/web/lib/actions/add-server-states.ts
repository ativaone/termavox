import type { ServerKind } from '../repo/servers.ts';
import type { FormState } from './form-state.ts';

/**
 * How the Credential section of "Add server" signs in: a new credential of one kind, a saved
 * one, or none (the server asks for a password in the terminal).
 */
export type CredentialChoice = 'generate' | 'private_key' | 'password' | 'saved' | 'none';

/** The first session's grid from "Start a session" (the pane refits it as soon as it attaches). */
export const ADD_SERVER_VIEWPORT = { cols: 120, rows: 32 } as const;

/** What "Add server" created, shown in place (plan D-29). Secrets never appear here. */
export interface AddServerResult {
  serverId: string;
  serverName: string;
  kind: ServerKind;
  /** `user@host` (`:port` when not 22), or null for a local shell. */
  target: string | null;
  /** Null for a local shell, which signs in without a credential. */
  credential: {
    choice: CredentialChoice;
    /** The credential's name; null for `none`. */
    name: string | null;
    /** OpenSSH public key line, only for a key generated just now. */
    publicKey: string | null;
    /** The key's SHA256 fingerprint, for a generated or pasted key. */
    fingerprint: string | null;
  } | null;
}

/** Result of the "Add server" Server Action: field errors and echoed values, or what was created. */
export interface AddServerState extends FormState {
  created?: AddServerResult;
}

/** Result of "Start a session" on the success state (on success it redirects instead). */
export interface StartSessionState {
  message?: string;
}
