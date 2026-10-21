import { sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { user } from './auth.ts';

/**
 * Application tables (plan §9). Write ownership: session-manager writes sessions, session_events,
 * credentials, known_host_keys, its instance_settings keys and the audit events of those; web
 * writes the rest.
 */
const createdAt = () => integer('created_at', { mode: 'timestamp_ms' }).notNull();
const updatedAt = () => integer('updated_at', { mode: 'timestamp_ms' }).notNull();
const ownerId = () =>
  text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' });

export const credentials = sqliteTable(
  'credentials',
  {
    id: text('id').primaryKey(),
    userId: ownerId(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['password', 'private_key'] }).notNull(),
    publicKey: text('public_key'),
    fingerprintSha256: text('fingerprint_sha256'),
    ciphertext: blob('ciphertext', { mode: 'buffer' }).notNull(),
    nonce: blob('nonce', { mode: 'buffer' }).notNull(),
    keyVersion: integer('key_version').notNull(),
    createdAt: createdAt(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('credentials_user_idx').on(t.userId)],
);

/**
 * A server (plan D-29): everything one terminal needs, in one row, like an `ssh user@host`
 * command line or an `~/.ssh/config` entry. Duplicates are allowed (the same machine as another
 * user is another server). `kind: local` (direct mode) has no address, user name or credential.
 * `hostname` is stored normalized (`normalizeHostname` in @termavox/shared).
 */
export const servers = sqliteTable(
  'servers',
  {
    id: text('id').primaryKey(),
    userId: ownerId(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['ssh', 'local'] }).notNull(),
    hostname: text('hostname'),
    port: integer('port'),
    username: text('username'),
    // Null: no stored secret, the server prompts in the terminal (password / keyboard-interactive).
    credentialId: text('credential_id').references(() => credentials.id, {
      onDelete: 'set null',
    }),
    protectionMode: text('protection_mode', { enum: ['auto', 'off'] })
      .notNull()
      .default('auto'),
    startupCommand: text('startup_command'),
    term: text('term').notNull().default('xterm-256color'),
    envJson: text('env_json').notNull().default('{}'),
    keepaliveIntervalS: integer('keepalive_interval_s').notNull().default(15),
    autoReopen: integer('auto_reopen', { mode: 'boolean' }).notNull().default(true),
    scrollbackLines: integer('scrollback_lines').notNull().default(5_000),
    // The terminal type inside protected sessions (plan D-49); `term` is the unprotected one.
    tmuxTerm: text('tmux_term', { enum: ['auto', 'xterm-256color'] })
      .notNull()
      .default('auto'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('servers_user_idx').on(t.userId),
    check(
      'servers_ssh_target_ck',
      sql`${t.kind} = 'local' OR (${t.hostname} IS NOT NULL AND ${t.port} IS NOT NULL AND ${t.username} IS NOT NULL)`,
    ),
  ],
);

/**
 * Host keys a user decided on, per address (plan §5.9, D-29): the normalized hostname as typed
 * (a DNS name or an IP) and the port, like OpenSSH's `known_hosts`. A decision applies to every
 * server of that user with that address, and outlives the servers (no foreign key): deleting and
 * re-adding a server never lets a revoked key back in. Never shared between users.
 */
export const knownHostKeys = sqliteTable(
  'known_host_keys',
  {
    id: text('id').primaryKey(),
    userId: ownerId(),
    hostname: text('hostname').notNull(),
    port: integer('port').notNull(),
    keyType: text('key_type').notNull(),
    publicKeyB64: text('public_key_b64'),
    fingerprintSha256: text('fingerprint_sha256').notNull(),
    // pending = seen on an aborted connect, awaiting the owner's decision (expires after 24 h)
    status: text('status', { enum: ['trusted', 'pending', 'revoked'] }).notNull(),
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),
    decidedBy: text('decided_by').references(() => user.id, { onDelete: 'set null' }),
    decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('known_host_keys_address_idx').on(t.userId, t.hostname, t.port),
    uniqueIndex('known_host_keys_trusted_uq')
      .on(t.userId, t.hostname, t.port, t.keyType)
      .where(sql`status = 'trusted'`),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: ownerId(),
    // Nullable so history survives server deletion; deleting a server with non-ended sessions
    // is rejected by the application (409).
    serverId: text('server_id').references(() => servers.id, { onDelete: 'set null' }),
    // Target snapshotted at creation: later server edits only affect new sessions. A local
    // session snapshots hostname 'localhost', port 0 and an empty user name (nothing reads them).
    targetKind: text('target_kind', { enum: ['ssh', 'local'] }).notNull(),
    targetHostname: text('target_hostname').notNull(),
    targetPort: integer('target_port').notNull(),
    targetUsername: text('target_username').notNull(),
    targetCredentialId: text('target_credential_id').references(() => credentials.id, {
      onDelete: 'set null',
    }),
    term: text('term').notNull(),
    scrollbackLines: integer('scrollback_lines').notNull(),
    tmuxTerm: text('tmux_term', { enum: ['auto', 'xterm-256color'] })
      .notNull()
      .default('auto'),
    label: text('label').notNull(),
    desiredState: text('desired_state', { enum: ['running', 'terminated'] }).notNull(),
    state: text('state').notNull(),
    status: text('status').notNull(),
    protectionEffective: text('protection_effective', {
      enum: ['tmux-control', 'tmux-normal', 'none'],
    }),
    tmuxToken: text('tmux_token').notNull(),
    // Full tmux socket name of an adopted session (plan D-30); null = `tv-<prefix>-<tmux_token>`.
    tmuxSocket: text('tmux_socket'),
    tmuxVersion: text('tmux_version'),
    remoteIdentityJson: text('remote_identity_json'),
    probeJson: text('probe_json'),
    cols: integer('cols').notNull(),
    rows: integer('rows').notNull(),
    createdAt: createdAt(),
    lastReadyAt: integer('last_ready_at', { mode: 'timestamp_ms' }),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
    endReason: text('end_reason'),
  },
  (t) => [
    index('sessions_user_idx').on(t.userId),
    index('sessions_server_idx').on(t.serverId),
    index('sessions_desired_idx').on(t.desiredState),
  ],
);

export const sessionEvents = sqliteTable(
  'session_events',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    detailJson: text('detail_json'),
    actorUserId: text('actor_user_id'),
    attachmentId: text('attachment_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [
    index('session_events_session_idx').on(t.sessionId, t.createdAt),
    // The retention purge deletes by age across every session (plan §10.2).
    index('session_events_created_idx').on(t.createdAt),
  ],
);

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    actorUserId: text('actor_user_id'),
    type: text('type').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    detailJson: text('detail_json'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_events_created_idx').on(t.createdAt),
    index('audit_events_actor_idx').on(t.actorUserId),
  ],
);

export const workspaceLayouts = sqliteTable('workspace_layouts', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  layoutJson: text('layout_json').notNull(),
  updatedAt: updatedAt(),
});

export const userPreferences = sqliteTable('user_preferences', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  theme: text('theme').notNull().default('system'),
  terminalJson: text('terminal_json').notNull().default('{}'),
  updatedAt: updatedAt(),
});

export const instanceSettings = sqliteTable('instance_settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: updatedAt(),
});
