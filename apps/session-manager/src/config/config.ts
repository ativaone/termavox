import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parseTrustedProxies } from '../ws/client-ip.ts';

const LogLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

/** Environment of the data-plane pieces (plan §13.2). Boot wiring adds the rest in main.ts. */
const Env = z.object({
  TERMAVOX_PUBLIC_URL: z.url({ protocol: /^https?$/ }),
  TERMAVOX_WS_HOST: z.string().min(1).default('0.0.0.0'),
  TERMAVOX_WS_PORT: z.coerce.number().int().min(0).max(65_535).default(3001),
  TERMAVOX_WS_SECRET_FILE: z.string().min(1),
  TERMAVOX_LOG_LEVEL: LogLevel.default('info'),
  TERMAVOX_DATA_DIR: z.string().min(1).default('/data'),
  // Comma-separated IPs/CIDRs allowed to set X-Forwarded-For on WebSockets (plan §4.3).
  TERMAVOX_TRUSTED_PROXIES: z
    .string()
    .default('')
    .transform((value, ctx) => {
      try {
        return parseTrustedProxies(value);
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: (err as Error).message });
        return z.NEVER;
      }
    }),
});

export interface DataPlaneConfig {
  publicUrl: string;
  /** What browsers send as `Origin` (checked on every WebSocket upgrade). */
  publicOrigin: string;
  wsHost: string;
  wsPort: number;
  wsSecretFile: string;
  logLevel: z.infer<typeof LogLevel>;
  dataDir: string;
  /** Peers whose `X-Forwarded-For` names the client (Caddy's network); empty = none. */
  trustedProxies: string[];
}

/** Parses the environment; throws a readable error listing every invalid variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): DataPlaneConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid configuration: ${issues.join('; ')}`);
  }
  const e = parsed.data;
  return {
    publicUrl: e.TERMAVOX_PUBLIC_URL,
    publicOrigin: new URL(e.TERMAVOX_PUBLIC_URL).origin,
    wsHost: e.TERMAVOX_WS_HOST,
    wsPort: e.TERMAVOX_WS_PORT,
    wsSecretFile: e.TERMAVOX_WS_SECRET_FILE,
    logLevel: e.TERMAVOX_LOG_LEVEL,
    dataDir: e.TERMAVOX_DATA_DIR,
    trustedProxies: e.TERMAVOX_TRUSTED_PROXIES,
  };
}

/**
 * Reads a secret file (TERMAVOX_WS_SECRET_FILE, TERMAVOX_INTERNAL_TOKEN_FILE). The trimmed file
 * content, encoded as UTF-8 bytes, is the secret (no base64 decoding): the WS ticket HMAC-SHA256
 * key, or the internal API bearer token sent as `Authorization: Bearer <trimmed content>`. Web
 * must derive both the same way.
 */
export async function readSecretFile(path: string, minLength = 32): Promise<Uint8Array> {
  const value = (await readFile(path, 'utf8')).trim();
  if (value.length < minLength) {
    throw new Error(`secret file ${path} is shorter than ${minLength} characters`);
  }
  return new TextEncoder().encode(value);
}

const Flag = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

/** Audit and session-event retention (plan §10.2): 0 keeps rows forever. */
export const DEFAULT_EVENT_RETENTION_DAYS = 180;
export const MIN_EVENT_RETENTION_DAYS = 7;
export const MAX_EVENT_RETENTION_DAYS = 3650;

// Whole days: 0, or 7 to 3650. Unset or empty means the default (z.coerce would turn an empty
// value into 0 and silently turn purging off).
const RetentionDays = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    const value = raw?.trim() ?? '';
    if (value === '') return DEFAULT_EVENT_RETENTION_DAYS;
    const days = /^\d{1,9}$/.test(value) ? Number(value) : Number.NaN;
    if (days === 0 || (days >= MIN_EVENT_RETENTION_DAYS && days <= MAX_EVENT_RETENTION_DAYS)) {
      return days;
    }
    ctx.addIssue({
      code: 'custom',
      message: `use 0 (keep forever) or a whole number of days from ${MIN_EVENT_RETENTION_DAYS} to ${MAX_EVENT_RETENTION_DAYS}`,
    });
    return z.NEVER;
  });

const DaemonEnv = z.object({
  TERMAVOX_MASTER_KEY_FILE: z.string().min(1),
  TERMAVOX_INTERNAL_TOKEN_FILE: z.string().min(1),
  // 127.0.0.1 outside containers; compose sets 0.0.0.0 (reachable on the `internal` network only).
  TERMAVOX_INTERNAL_HOST: z.string().min(1).default('127.0.0.1'),
  TERMAVOX_INTERNAL_PORT: z.coerce.number().int().min(0).max(65_535).default(3002),
  TERMAVOX_ENABLE_LOCAL_SHELL: Flag,
  // SSH targets on loopback, link-local, unspecified, multicast or the daemon's own addresses
  // are refused unless this is set (plan §10.2).
  TERMAVOX_SSH_ALLOW_LOCAL_TARGETS: Flag,
  TERMAVOX_EVENT_RETENTION_DAYS: RetentionDays,
});

/** Everything the daemon process needs (plan §13.2): the data plane plus vault and internal API. */
export interface DaemonConfig extends DataPlaneConfig {
  /** Vault KEK file: 32 random bytes, base64 (`openssl rand -base64 32`). */
  masterKeyFile: string;
  /** Internal API bearer file; read like the WS secret (trimmed content, UTF-8 bytes). */
  internalTokenFile: string;
  internalHost: string;
  internalPort: number;
  enableLocalShell: boolean;
  /** TERMAVOX_SSH_ALLOW_LOCAL_TARGETS: sessions and host tests may reach local addresses. */
  sshAllowLocalTargets: boolean;
  /**
   * TERMAVOX_EVENT_RETENTION_DAYS: `audit_events` and `session_events` rows older than this are
   * purged (store/retention.ts); 0 keeps them forever.
   */
  eventRetentionDays: number;
  /** `<dataDir>/app.db`. */
  dbFile: string;
}

/** Parses the daemon environment; throws one readable error listing every invalid variable. */
export function loadDaemonConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const issues: string[] = [];
  let base: DataPlaneConfig | null = null;
  try {
    base = loadConfig(env);
  } catch (err) {
    issues.push((err as Error).message.replace(/^invalid configuration: /, ''));
  }
  const parsed = DaemonEnv.safeParse(env);
  if (!parsed.success) {
    issues.push(...parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  if (!base || !parsed.success) throw new Error(`invalid configuration: ${issues.join('; ')}`);
  const e = parsed.data;
  return {
    ...base,
    masterKeyFile: e.TERMAVOX_MASTER_KEY_FILE,
    internalTokenFile: e.TERMAVOX_INTERNAL_TOKEN_FILE,
    internalHost: e.TERMAVOX_INTERNAL_HOST,
    internalPort: e.TERMAVOX_INTERNAL_PORT,
    enableLocalShell: e.TERMAVOX_ENABLE_LOCAL_SHELL,
    sshAllowLocalTargets: e.TERMAVOX_SSH_ALLOW_LOCAL_TARGETS,
    eventRetentionDays: e.TERMAVOX_EVENT_RETENTION_DAYS,
    dbFile: join(base.dataDir, 'app.db'),
  };
}
