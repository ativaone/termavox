import type { HostKind } from '../repo/hosts.ts';
import type { FormState } from './form-state.ts';

/** How section 3 of "Add server" signs in: a new credential of one kind, or a saved one. */
export type CredentialChoice = 'generate' | 'private_key' | 'password' | 'saved';

/** The first session's grid from "Start a session" (the pane refits it as soon as it attaches). */
export const ADD_SERVER_VIEWPORT = { cols: 120, rows: 32 } as const;

/** What "Add server" created, shown in place (plan D-27). Secrets never appear here. */
export interface AddServerResult {
  hostId: string;
  hostName: string;
  /** False when the user picked a server they had already added. */
  hostCreated: boolean;
  kind: HostKind;
  /** `hostname:port`, or null for a local shell. */
  address: string | null;
  profileId: string;
  profileName: string;
  username: string;
  /** Null for a local shell, which signs in without a credential. */
  credential: {
    choice: CredentialChoice;
    name: string;
    /** OpenSSH public key line, only for a key generated just now. */
    publicKey: string | null;
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
