import { z } from 'zod';
import { Protection, SessionState, SessionStatus } from './session-state.ts';

/** Internal API (session-manager :3002) request/response schemas. Plan §8.3. */
export const INTERNAL_API_PREFIX = '/internal/v1';

const id = z.string().min(1).max(64);
const actingUserId = id;
export const Viewport = z.object({
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
});

/** Longest session label, counted after the daemon cleaned it (see `SessionLabelInput`). */
export const SESSION_LABEL_MAX = 120;

/**
 * A session label as the user typed it. The daemon drops control characters and invisible
 * formatting (bidi controls, zero-width characters) with the stripper it uses for terminal titles
 * and keyboard-interactive prompts, trims the rest, and then requires 1–`SESSION_LABEL_MAX`
 * characters, else `400 LABEL_INVALID`. The cap here only bounds the raw text.
 */
export const SessionLabelInput = z.string().max(1024);

export const CreateSessionRequest = z.object({
  actingUserId,
  serverId: id,
  /** Absent: the server's name. */
  label: SessionLabelInput.optional(),
  viewport: Viewport,
});
export const CreateSessionResponse = z.object({ sessionId: id });

/** Renames a session of the acting user, in any state (ended included): it is only a name. */
export const RenameSessionRequest = z.object({ actingUserId, label: SessionLabelInput });
/** The label as stored (cleaned and trimmed). */
export const RenameSessionResponse = z.object({ sessionId: id, label: z.string() });

/** Body of terminate / retry / reopen, and of credential deletion. */
export const ActingUserRequest = z.object({ actingUserId });
export const ListSessionsQuery = z.object({ actingUserId });

export const LiveSessionStatus = z.object({
  sessionId: id,
  state: SessionState,
  status: SessionStatus,
  protection: Protection.nullable(),
  attachments: z.number().int(),
});
export const ListSessionsResponse = z.object({ sessions: z.array(LiveSessionStatus) });

export const CreateCredentialRequest = z.discriminatedUnion('kind', [
  z.object({
    actingUserId,
    kind: z.literal('password'),
    name: z.string().trim().min(1).max(120),
    password: z.string().min(1).max(4096),
  }),
  z.object({
    actingUserId,
    kind: z.literal('private_key'),
    name: z.string().trim().min(1).max(120),
    privateKey: z.string().min(1).max(32_768),
    passphrase: z.string().max(4096).optional(),
  }),
  z.object({
    actingUserId,
    kind: z.literal('generate'),
    name: z.string().trim().min(1).max(120),
    algorithm: z.literal('ed25519'),
  }),
]);
export const RenameCredentialRequest = z.object({
  actingUserId,
  name: z.string().trim().min(1).max(120),
});

export const CreateCredentialResponse = z.object({
  credentialId: id,
  publicKey: z.string().nullable(),
  fingerprint: z.string().nullable(),
});

/**
 * `POST /servers/:id/test`: connects to the server's address, records an unknown host key as
 * pending for that address, and probes the remote with the server's own user name and credential.
 */
export const ServerTestRequest = z.object({ actingUserId });
export const ServerTestResponse = z.object({
  reachable: z.boolean(),
  error: z.string().nullable(),
  hostKey: z.object({ type: z.string(), fingerprint: z.string(), trusted: z.boolean() }).nullable(),
  probe: z.record(z.string(), z.string()).nullable(),
  /**
   * The presented key is one the owner revoked for this address (`error` stays
   * HOST_KEY_MISMATCH). Absent otherwise.
   */
  revoked: z.literal(true).optional(),
});

/** OpenSSH-style fingerprint: `SHA256:` + 43 chars of unpadded base64. */
export const Fingerprint = z
  .string()
  .trim()
  .transform((v) => (v.startsWith('SHA256:') ? v : `SHA256:${v}`).replace(/=+$/, ''))
  .pipe(z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/));

/**
 * Host-key decisions, `POST /servers/:id/{trust,replace,revoke}-key`. The server id only names
 * the address (and proves ownership): every decision is stored for the server's normalized
 * hostname and port, so it applies to all of the user's servers with that address (plan §5.9).
 */
/** Trusts the pending key with this fingerprint (or pre-trusts a pasted fingerprint). */
export const TrustHostKeyRequest = z.object({
  actingUserId,
  keyType: z.string().min(1).max(64),
  fingerprint: Fingerprint,
});
/**
 * Replaces the trusted key of this type after a mismatch (explicit owner action). The owner
 * types the address (the server's stored hostname) to confirm, since the change applies to every
 * server with that address.
 */
export const ReplaceHostKeyRequest = TrustHostKeyRequest.extend({
  confirmHostname: z.string().min(1),
});
export const RevokeHostKeyRequest = z.object({ actingUserId, keyType: z.string().min(1).max(64) });

/**
 * Remote tmux leftovers (plan D-30). Every Termdock tmux server on a remote host is named
 * `td-<installation prefix>-<tmux token>` (§6.3): the prefix is 1–8 characters of [a-z0-9], the
 * token 12 of [a-z2-7]. Names read from a host are untrusted: anything else is ignored.
 */
export const REMOTE_SOCKET_PATTERN = /^td-[a-z0-9]{1,8}-[a-z2-7]{12}$/;
export const RemoteSocketName = z.string().regex(REMOTE_SOCKET_PATTERN);

/**
 * Where a listed remote session comes from:
 * - `ended`: this installation, a session of the acting user that was ended in Termdock but whose
 *   tmux could not be ended (a scan ends these by itself first; listed only when that failed);
 * - `unknown`: this installation's prefix, but no session record has its token;
 * - `other`: another prefix: another Termdock installation, or this one before its database was
 *   reset (the installation id lives in the database).
 * Sessions that run in Termdock, and ended sessions of other users, are never listed.
 */
export const RemoteSessionOrigin = z.enum(['ended', 'unknown', 'other']);
export const RemoteSession = z.object({
  socket: RemoteSocketName,
  origin: RemoteSessionOrigin,
  /** `ended` only: the acting user's own session (id and label); null otherwise. */
  sessionId: id.nullable(),
  label: z.string().nullable(),
  /** Epoch ms from tmux (`session_created`, `session_activity`); null when not reported. */
  createdAt: z.number().int().nullable(),
  lastActivityAt: z.number().int().nullable(),
  /** Clients attached right now (another Termdock, or someone's terminal). */
  attachedClients: z.number().int().min(0),
});

/**
 * `POST /servers/:id/remote-sessions`: connects as the server's user (its credential, its
 * address's trusted host key; never prompting) and lists the Termdock tmux servers there. Ends the
 * leftovers of sessions the acting user already ended before listing (`cleaned` counts them).
 */
export const ListRemoteSessionsRequest = z.object({ actingUserId });
export const ListRemoteSessionsResponse = z.object({
  /** Null when the scan ran; otherwise why it could not (the server test's error codes). */
  error: z.string().nullable(),
  sessions: z.array(RemoteSession),
  cleaned: z.number().int().min(0),
  /** The host listed more Termdock tmux servers than the daemon reads (the rest is ignored). */
  truncated: z.boolean(),
});

/**
 * `POST /servers/:id/remote-sessions/terminate`: ends one listed remote session. Refused (409)
 * when the socket belongs to a session that runs in Termdock.
 */
export const TerminateRemoteSessionRequest = z.object({ actingUserId, socket: RemoteSocketName });
/** `terminated: false` when it was already gone. */
export const TerminateRemoteSessionResponse = z.object({ terminated: z.boolean() });

/**
 * `POST /servers/:id/remote-sessions/adopt`: a new session of this server attached to that tmux
 * server (answers with `CreateSessionResponse`). Refused (409) when the socket belongs to a session
 * that runs in Termdock; the running-session cap applies as for create.
 */
export const AdoptRemoteSessionRequest = z.object({
  actingUserId,
  socket: RemoteSocketName,
  /** Absent: the server's name. */
  label: SessionLabelInput.optional(),
});

/**
 * `POST /sessions/terminate-all`: terminates every non-ended session of the acting user ("End all
 * sessions"). Answers once each one is ending; the ends themselves arrive as `session.status`.
 */
export const TerminateAllSessionsRequest = z.object({ actingUserId });
export const TerminateAllSessionsResponse = z.object({ terminated: z.number().int().min(0) });

export const RevokeAuthSessionsRequest = z
  .object({ authSessionId: id.optional(), userId: id.optional() })
  .refine((v) => v.authSessionId !== undefined || v.userId !== undefined, {
    message: 'authSessionId or userId is required',
  });

/**
 * Admin action: terminates every non-ended session of the user in the path. The acting user must
 * be an admin (not banned); anyone else gets 403.
 */
export const TerminateUserSessionsRequest = z.object({ actingUserId });
export const TerminateUserSessionsResponse = z.object({ terminated: z.number().int().min(0) });

export const HealthResponse = z.object({
  ok: z.boolean(),
  sessions: z.number().int(),
  uptimeMs: z.number(),
  version: z.string(),
});
