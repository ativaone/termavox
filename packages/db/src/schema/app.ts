import { sql } from 'drizzle-orm';
import { blob, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
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

export const hosts = sqliteTable(
  'hosts',
  {
    id: text('id').primaryKey(),
    userId: ownerId(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['ssh', 'local'] }).notNull(),
    hostname: text('hostname').notNull(),
    port: integer('port').notNull().default(22),
    tagsJson: text('tags_json').notNull().default('[]'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('hosts_user_idx').on(t.userId)],
);

export const knownHostKeys = sqliteTable(
  'known_host_keys',
  {
    id: text('id').primaryKey(),
    hostId: text('host_id')
      .notNull()
      .references(() => hosts.id, { onDelete: 'cascade' }),
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
    uniqueIndex('known_host_keys_trusted_uq')
      .on(t.hostId, t.keyType)
      .where(sql`status = 'trusted'`),
  ],
);

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

export const connectionProfiles = sqliteTable(
  'connection_profiles',
  {
    id: text('id').primaryKey(),
    userId: ownerId(),
    hostId: text('host_id')
      .notNull()
      .references(() => hosts.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id').references(() => credentials.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    username: text('username').notNull(),
    protectionMode: text('protection_mode', { enum: ['auto', 'off'] })
      .notNull()
      .default('auto'),
    startupCommand: text('startup_command'),
    term: text('term').notNull().default('xterm-256color'),
    envJson: text('env_json').notNull().default('{}'),
    keepaliveIntervalS: integer('keepalive_interval_s').notNull().default(15),
    autoReopen: integer('auto_reopen', { mode: 'boolean' }).notNull().default(true),
    scrollbackLines: integer('scrollback_lines').notNull().default(5_000),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('connection_profiles_user_idx').on(t.userId),
    index('connection_profiles_host_idx').on(t.hostId),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: ownerId(),
    // Nullable so history survives profile deletion; deleting a profile with non-ended
    // sessions is rejected by the application (409).
    profileId: text('profile_id').references(() => connectionProfiles.id, { onDelete: 'set null' }),
    // Target snapshotted at creation: later profile/host edits only affect new sessions.
    targetKind: text('target_kind', { enum: ['ssh', 'local'] }).notNull(),
    targetHostId: text('target_host_id').references(() => hosts.id, { onDelete: 'set null' }),
    targetHostname: text('target_hostname').notNull(),
    targetPort: integer('target_port').notNull(),
    targetUsername: text('target_username').notNull(),
    targetCredentialId: text('target_credential_id').references(() => credentials.id, {
      onDelete: 'set null',
    }),
    term: text('term').notNull(),
    scrollbackLines: integer('scrollback_lines').notNull(),
    label: text('label').notNull(),
    desiredState: text('desired_state', { enum: ['running', 'terminated'] }).notNull(),
    state: text('state').notNull(),
    status: text('status').notNull(),
    protectionEffective: text('protection_effective', {
      enum: ['tmux-control', 'tmux-normal', 'none'],
    }),
    tmuxToken: text('tmux_token').notNull(),
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
  (t) => [index('session_events_session_idx').on(t.sessionId, t.createdAt)],
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
