import type { TermdockDb } from '@termdock/db';
import {
  EndReason,
  Protection,
  ProtectionMode,
  SessionState,
  SessionStatus,
  type SessionSummary,
} from '@termdock/protocol';
import { ErrorCode, normalizeHostname, randomToken, TermdockError, uuidv7 } from '@termdock/shared';
import { z } from 'zod';
import type {
  Dimensions,
  SessionEventInput,
  SessionPolicies,
  SessionRecord,
  SessionRecordPatch,
  SessionStore,
  SessionTarget,
} from '../core/types.ts';
import { isAdmin, requireActingUser } from './access.ts';
import { insertAudit } from './audit.ts';
import type { BatchedWriter } from './batched-writer.ts';
import { maxRunningSessions } from './settings.ts';
import { allRows, execute, getRow, parseJson, type Sqlite } from './sqlite.ts';

/**
 * Policies used when the session's server was deleted (history survives with server_id NULL):
 * the schema defaults of `servers`.
 */
export const DEFAULT_POLICIES: SessionPolicies = {
  protectionMode: 'auto',
  startupCommand: null,
  env: {},
  keepaliveIntervalS: 15,
  autoReopen: true,
};

const StateColumn = SessionState.catch('failed');
const StatusColumn = SessionStatus.catch('disconnected');
const ProtectionColumn = Protection.nullable().catch(null);
const EndReasonColumn = EndReason.nullable().catch(null);
const ProtectionModeColumn = ProtectionMode.catch('auto');
const EnvJson = z.record(z.string(), z.string());
const RemoteIdentityJson = z.object({ sessionCreated: z.number(), panePid: z.number() });

/** A local session's snapshot (plan §9): nothing reads it, the columns are NOT NULL. */
const LOCAL_TARGET: SessionTarget = {
  kind: 'local',
  hostname: 'localhost',
  port: 0,
  username: '',
  credentialId: null,
};

interface RecordRow {
  id: string;
  user_id: string;
  server_id: string | null;
  target_kind: string;
  target_hostname: string;
  target_port: number;
  target_username: string;
  target_credential_id: string | null;
  term: string;
  scrollback_lines: number;
  label: string;
  desired_state: string;
  state: string;
  status: string;
  protection_effective: string | null;
  tmux_token: string;
  tmux_version: string | null;
  remote_identity_json: string | null;
  cols: number;
  rows: number;
  created_at: number;
  last_ready_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
  // live policies from the server (all NULL when it was deleted)
  sv_id: string | null;
  sv_protection_mode: string | null;
  sv_startup_command: string | null;
  sv_env_json: string | null;
  sv_keepalive_interval_s: number | null;
  sv_auto_reopen: number | null;
}

const SELECT_RECORD = `
  SELECT s.id, s.user_id, s.server_id, s.target_kind, s.target_hostname, s.target_port,
         s.target_username, s.target_credential_id, s.term, s.scrollback_lines, s.label,
         s.desired_state, s.state, s.status, s.protection_effective, s.tmux_token, s.tmux_version,
         s.remote_identity_json, s.cols, s.rows, s.created_at, s.last_ready_at, s.ended_at,
         s.end_reason,
         sv.id AS sv_id, sv.protection_mode AS sv_protection_mode,
         sv.startup_command AS sv_startup_command, sv.env_json AS sv_env_json,
         sv.keepalive_interval_s AS sv_keepalive_interval_s, sv.auto_reopen AS sv_auto_reopen
    FROM sessions s
    LEFT JOIN servers sv ON sv.id = s.server_id`;

/** SessionRecordPatch field → sessions column (+ encoder). */
const PATCH_COLUMNS: Record<string, [column: string, encode?: (value: unknown) => unknown]> = {
  desiredState: ['desired_state'],
  state: ['state'],
  status: ['status'],
  protection: ['protection_effective'],
  tmuxVersion: ['tmux_version'],
  remoteIdentity: ['remote_identity_json', (v) => (v === null ? null : JSON.stringify(v))],
  cols: ['cols'],
  rows: ['rows'],
  lastReadyAt: ['last_ready_at'],
  endedAt: ['ended_at'],
  endReason: ['end_reason'],
  probe: ['probe_json', (v) => (v === null ? null : JSON.stringify(v))],
};

export const sessionWriteKey = (sessionId: string): string => `session:${sessionId}`;

export interface CreateSessionInput {
  actingUserId: string;
  serverId: string;
  /** Absent: the server's name. */
  label?: string | undefined;
  viewport: Dimensions;
  /** `TERMDOCK_ENABLE_LOCAL_SHELL` (direct mode itself arrives in Phase 6). */
  enableLocalShell: boolean;
}

/**
 * The per-user running-session cap (`max_running_sessions_per_user`), shared by create and reopen
 * so both refuse with the same code and message. `exceptSessionId` is left out of the count.
 */
function assertRunningCapacity(
  sqlite: Sqlite,
  userId: string,
  exceptSessionId: string | null,
): void {
  const cap = maxRunningSessions(sqlite);
  const running =
    getRow<{ n: number }>(
      sqlite,
      `SELECT COUNT(*) AS n FROM sessions
        WHERE user_id = ? AND desired_state = 'running' AND (? IS NULL OR id != ?)`,
      userId,
      exceptSessionId,
      exceptSessionId,
    )?.n ?? 0;
  if (running >= cap) {
    throw new TermdockError(ErrorCode.RateLimited, `running session limit reached (${cap})`);
  }
}

/**
 * `SessionStore` over SQLite. Reads go straight to the DB (WAL readers never wait); every write
 * goes through the batched writer.
 *
 * Restore rule: `state = 'failed'` is only ever persisted for non-retryable causes (the runtime
 * parks on AUTH_REJECTED, CREDENTIAL_INVALID, HOST_KEY_MISMATCH/REJECTED, LOCAL_SHELL_DISABLED,
 * TARGET_NOT_ALLOWED, BAD_LAUNCH_PARAMS, NOT_FOUND, FORBIDDEN and non-retryable transport errors;
 * retryable problems persist as `reconnecting`). The specific code is in `session_events`
 * (`state_changed`, `detail`). So `listRestorable()` = `desired_state = 'running' AND state <>
 * 'failed'`; those sessions wait for the user's Retry (plan §5.8).
 */
export class SqliteSessionStore implements SessionStore {
  readonly #sqlite: Sqlite;
  readonly #writer: BatchedWriter;
  readonly #now: () => number;

  constructor(db: TermdockDb, writer: BatchedWriter, now: () => number = Date.now) {
    this.#sqlite = db.$client;
    this.#writer = writer;
    this.#now = now;
  }

  /** The record with its server's live policies, plus any queued (uncommitted) updates. */
  async get(sessionId: string): Promise<SessionRecord | null> {
    const row = getRow<RecordRow>(this.#sqlite, `${SELECT_RECORD} WHERE s.id = ?`, sessionId);
    return row ? this.#withPending(toRecord(row)) : null;
  }

  async listRestorable(): Promise<SessionRecord[]> {
    const rows = allRows<RecordRow>(
      this.#sqlite,
      `${SELECT_RECORD} WHERE s.desired_state = 'running' AND s.state <> 'failed' ORDER BY s.created_at, s.rowid`,
    );
    return rows
      .map((row) => this.#withPending(toRecord(row)))
      .filter((r) => r.desiredState === 'running' && r.state !== 'failed');
  }

  /**
   * Every session of the user (history included), newest first, with the server's current name
   * joined (the snapshotted hostname once the server is gone). `statusDetail` is only known from
   * history for `failed` sessions (their code, see the class comment); the registry overlays the
   * live value of runtimes that changed state since boot.
   */
  async listForUser(userId: string): Promise<SessionSummary[]> {
    const rows = allRows<{
      id: string;
      label: string;
      server_id: string | null;
      server_name: string;
      target_kind: string;
      target_hostname: string;
      target_port: number;
      target_username: string;
      state: string;
      status: string;
      protection_effective: string | null;
      created_at: number;
      last_ready_at: number | null;
      ended_at: number | null;
      end_reason: string | null;
      status_detail: unknown;
    }>(
      this.#sqlite,
      `SELECT s.id, s.label, s.server_id, COALESCE(sv.name, s.target_hostname) AS server_name,
              s.target_kind, s.target_hostname, s.target_port, s.target_username, s.state, s.status,
              s.protection_effective, s.created_at, s.last_ready_at, s.ended_at, s.end_reason,
              CASE WHEN s.state = 'failed' THEN (
                SELECT json_extract(e.detail_json, '$.detail') FROM session_events e
                 WHERE e.session_id = s.id AND e.type = 'state_changed'
                   AND json_extract(e.detail_json, '$.to') = 'failed'
                 ORDER BY e.created_at DESC, e.id DESC LIMIT 1
              ) END AS status_detail
         FROM sessions s LEFT JOIN servers sv ON sv.id = s.server_id
        WHERE s.user_id = ?
        ORDER BY s.created_at DESC, s.rowid DESC`,
      userId,
    );
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      serverId: r.server_id,
      serverName: r.server_name,
      kind: r.target_kind === 'local' ? 'local' : 'ssh',
      hostname: r.target_hostname,
      port: r.target_port,
      username: r.target_username,
      state: StateColumn.parse(r.state),
      status: StatusColumn.parse(r.status),
      protection: ProtectionColumn.parse(r.protection_effective),
      createdAt: r.created_at,
      lastReadyAt: r.last_ready_at,
      endedAt: r.ended_at,
      endReason: r.end_reason,
      statusDetail: typeof r.status_detail === 'string' ? r.status_detail : null,
    }));
  }

  update(sessionId: string, patch: SessionRecordPatch): void {
    this.#writer.enqueueUpdate(sessionWriteKey(sessionId), patch, (sqlite, merged) => {
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [field, value] of Object.entries(merged)) {
        const mapping = PATCH_COLUMNS[field];
        if (!mapping || value === undefined) continue;
        const [column, encode] = mapping;
        sets.push(`${column} = ?`);
        params.push(encode ? encode(value) : value);
      }
      if (sets.length === 0) return;
      execute(sqlite, `UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, ...params, sessionId);
    });
  }

  /**
   * Reopen (plan §5.7) honours the same per-user running-session cap as create, not counting the
   * session being reopened (an unprotected running one already counts). Queued behind every
   * earlier write, so a terminate just requested is already reflected.
   */
  assertRunningCapacity(userId: string, sessionId: string): Promise<void> {
    return this.#writer.run('session.capacity', (sqlite) =>
      assertRunningCapacity(sqlite, userId, sessionId),
    );
  }

  appendEvent(sessionId: string, event: SessionEventInput): void {
    const at = this.#now();
    const id = uuidv7(at);
    this.#writer.enqueue(`session_event:${event.type}`, (sqlite) => {
      insertSessionEvent(sqlite, id, sessionId, event, at);
    });
  }

  /**
   * Internal API `POST sessions` (plan §8.3, §9, D-29): validates the acting user, the server
   * (owned by the acting user, else NOT_FOUND), for `kind: ssh` its credential (owned too), for
   * `kind: local` direct mode and the admin role, and the per-user running-session cap; then
   * inserts the row with the target snapshotted from the server (a local session: 'localhost',
   * port 0, no user name). Committed before it resolves, so the registry can load the session
   * right away.
   */
  createFromServer(input: CreateSessionInput): Promise<SessionRecord> {
    return this.#writer.run('session.create', (sqlite) => {
      const now = this.#now();
      const user = requireActingUser(sqlite, input.actingUserId, now);
      const server = getRow<{
        id: string;
        name: string;
        kind: string;
        hostname: string | null;
        port: number | null;
        username: string | null;
        credential_id: string | null;
        protection_mode: string;
        startup_command: string | null;
        term: string;
        env_json: string;
        keepalive_interval_s: number;
        auto_reopen: number;
        scrollback_lines: number;
      }>(
        sqlite,
        `SELECT id, name, kind, hostname, port, username, credential_id, protection_mode,
                startup_command, term, env_json, keepalive_interval_s, auto_reopen, scrollback_lines
           FROM servers WHERE id = ? AND user_id = ?`,
        input.serverId,
        user.id,
      );
      if (!server) throw new TermdockError(ErrorCode.NotFound, 'server not found');
      let target: SessionTarget;
      if (server.kind === 'local') {
        if (!input.enableLocalShell) {
          throw new TermdockError(ErrorCode.LocalShellDisabled, 'local shells are disabled');
        }
        if (!isAdmin(user)) {
          throw new TermdockError(ErrorCode.Forbidden, 'local sessions are admin-only');
        }
        target = { ...LOCAL_TARGET };
      } else {
        // The CHECK constraint `servers_ssh_target_ck` guarantees all three for ssh rows.
        if (server.hostname === null || server.port === null || server.username === null) {
          throw new TermdockError(ErrorCode.Internal, 'ssh server without an address');
        }
        if (server.credential_id) {
          const credential = getRow(
            sqlite,
            'SELECT id FROM credentials WHERE id = ? AND user_id = ?',
            server.credential_id,
            user.id,
          );
          if (!credential) throw new TermdockError(ErrorCode.NotFound, 'credential not found');
        }
        target = {
          kind: 'ssh',
          hostname: normalizeHostname(server.hostname),
          port: server.port,
          username: server.username,
          credentialId: server.credential_id,
        };
      }
      assertRunningCapacity(sqlite, user.id, null);

      const record: SessionRecord = {
        id: uuidv7(now),
        userId: user.id,
        serverId: server.id,
        label: input.label ?? server.name,
        target,
        term: server.term,
        scrollbackLines: server.scrollback_lines,
        policies: policiesOf({
          sv_id: server.id,
          sv_protection_mode: server.protection_mode,
          sv_startup_command: server.startup_command,
          sv_env_json: server.env_json,
          sv_keepalive_interval_s: server.keepalive_interval_s,
          sv_auto_reopen: server.auto_reopen,
        }),
        desiredState: 'running',
        state: 'new',
        status: 'connecting',
        protection: null,
        tmuxToken: randomToken(12),
        tmuxVersion: null,
        remoteIdentity: null,
        cols: input.viewport.cols,
        rows: input.viewport.rows,
        createdAt: now,
        lastReadyAt: null,
        endedAt: null,
        endReason: null,
      };
      execute(
        sqlite,
        `INSERT INTO sessions (id, user_id, server_id, target_kind, target_hostname, target_port,
           target_username, target_credential_id, term, scrollback_lines, label, desired_state,
           state, status, protection_effective, tmux_token, cols, rows, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        record.id,
        record.userId,
        record.serverId,
        record.target.kind,
        record.target.hostname,
        record.target.port,
        record.target.username,
        record.target.credentialId,
        record.term,
        record.scrollbackLines,
        record.label,
        record.desiredState,
        record.state,
        record.status,
        record.tmuxToken,
        record.cols,
        record.rows,
        record.createdAt,
      );
      insertSessionEvent(
        sqlite,
        uuidv7(now),
        record.id,
        { type: 'created', detail: { serverId: server.id }, actorUserId: user.id },
        now,
      );
      return record;
    });
  }

  /**
   * Internal API `PATCH sessions/:id` (D-28): renames a session of the acting user in any state
   * (ended included: it is only a name), with a `session.rename` audit row in the same
   * transaction. A missing or foreign session is NOT_FOUND. Renaming to the current label writes
   * nothing. `label` is already cleaned and checked (internal-api `sessionLabel`). Resolves with
   * the label it replaced once committed.
   */
  rename(actingUserId: string, sessionId: string, label: string): Promise<{ previous: string }> {
    return this.#writer.run('session.rename', (sqlite) => {
      const now = this.#now();
      requireActingUser(sqlite, actingUserId, now);
      const row = getRow<{ label: string }>(
        sqlite,
        'SELECT label FROM sessions WHERE id = ? AND user_id = ?',
        sessionId,
        actingUserId,
      );
      if (!row) throw new TermdockError(ErrorCode.NotFound, 'session not found');
      if (row.label !== label) {
        execute(sqlite, 'UPDATE sessions SET label = ? WHERE id = ?', label, sessionId);
        insertAudit(sqlite, {
          type: 'session.rename',
          actorUserId: actingUserId,
          targetType: 'session',
          targetId: sessionId,
          detail: { previousLabel: row.label, label },
          at: now,
        });
      }
      return { previous: row.label };
    });
  }

  #withPending(record: SessionRecord): SessionRecord {
    const pending = this.#writer.pending(sessionWriteKey(record.id));
    if (!pending) return record;
    const { probe: _probe, ...fields } = pending as SessionRecordPatch;
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) (record as unknown as Record<string, unknown>)[key] = value;
    }
    return record;
  }
}

function insertSessionEvent(
  sqlite: Sqlite,
  id: string,
  sessionId: string,
  event: SessionEventInput,
  at: number,
): void {
  execute(
    sqlite,
    `INSERT INTO session_events (id, session_id, type, detail_json, actor_user_id, attachment_id,
       ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    sessionId,
    event.type,
    event.detail ? JSON.stringify(event.detail) : null,
    event.actorUserId ?? null,
    event.attachmentId ?? null,
    event.ip ?? null,
    event.userAgent ?? null,
    at,
  );
}

function policiesOf(
  row: Pick<
    RecordRow,
    | 'sv_id'
    | 'sv_protection_mode'
    | 'sv_startup_command'
    | 'sv_env_json'
    | 'sv_keepalive_interval_s'
    | 'sv_auto_reopen'
  >,
): SessionPolicies {
  if (row.sv_id === null) return { ...DEFAULT_POLICIES, env: {} };
  const env = EnvJson.safeParse(parseJson(row.sv_env_json));
  return {
    protectionMode: ProtectionModeColumn.parse(row.sv_protection_mode),
    startupCommand: row.sv_startup_command,
    env: env.success ? env.data : {},
    keepaliveIntervalS: row.sv_keepalive_interval_s ?? DEFAULT_POLICIES.keepaliveIntervalS,
    autoReopen:
      row.sv_auto_reopen === null ? DEFAULT_POLICIES.autoReopen : row.sv_auto_reopen !== 0,
  };
}

function toRecord(row: RecordRow): SessionRecord {
  const identity = RemoteIdentityJson.safeParse(parseJson(row.remote_identity_json));
  return {
    id: row.id,
    userId: row.user_id,
    serverId: row.server_id,
    label: row.label,
    target: {
      kind: row.target_kind === 'local' ? 'local' : 'ssh',
      hostname: row.target_hostname,
      port: row.target_port,
      username: row.target_username,
      credentialId: row.target_credential_id,
    },
    term: row.term,
    scrollbackLines: row.scrollback_lines,
    policies: policiesOf(row),
    desiredState: row.desired_state === 'running' ? 'running' : 'terminated',
    state: StateColumn.parse(row.state),
    status: StatusColumn.parse(row.status),
    protection: ProtectionColumn.parse(row.protection_effective),
    tmuxToken: row.tmux_token,
    tmuxVersion: row.tmux_version,
    remoteIdentity: identity.success ? identity.data : null,
    cols: row.cols,
    rows: row.rows,
    createdAt: row.created_at,
    lastReadyAt: row.last_ready_at,
    endedAt: row.ended_at,
    endReason: EndReasonColumn.parse(row.end_reason),
  };
}
