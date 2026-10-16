import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const LogLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

/** Environment of the data-plane pieces (plan §13.2). Boot wiring adds the rest in main.ts. */
const Env = z.object({
  TERMDOCK_PUBLIC_URL: z.url({ protocol: /^https?$/ }),
  TERMDOCK_WS_HOST: z.string().min(1).default('0.0.0.0'),
  TERMDOCK_WS_PORT: z.coerce.number().int().min(0).max(65_535).default(3001),
  TERMDOCK_WS_SECRET_FILE: z.string().min(1),
  TERMDOCK_LOG_LEVEL: LogLevel.default('info'),
  TERMDOCK_DATA_DIR: z.string().min(1).default('/data'),
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
    publicUrl: e.TERMDOCK_PUBLIC_URL,
    publicOrigin: new URL(e.TERMDOCK_PUBLIC_URL).origin,
    wsHost: e.TERMDOCK_WS_HOST,
    wsPort: e.TERMDOCK_WS_PORT,
    wsSecretFile: e.TERMDOCK_WS_SECRET_FILE,
    logLevel: e.TERMDOCK_LOG_LEVEL,
    dataDir: e.TERMDOCK_DATA_DIR,
  };
}

/**
 * Reads a secret file (TERMDOCK_WS_SECRET_FILE, TERMDOCK_INTERNAL_TOKEN_FILE). The trimmed file
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

const DaemonEnv = z.object({
  TERMDOCK_MASTER_KEY_FILE: z.string().min(1),
  TERMDOCK_INTERNAL_TOKEN_FILE: z.string().min(1),
  // 127.0.0.1 outside containers; compose sets 0.0.0.0 (reachable on the `internal` network only).
  TERMDOCK_INTERNAL_HOST: z.string().min(1).default('127.0.0.1'),
  TERMDOCK_INTERNAL_PORT: z.coerce.number().int().min(0).max(65_535).default(3002),
  TERMDOCK_ENABLE_LOCAL_SHELL: z
    .enum(['true', 'false', '1', '0', ''])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
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
    masterKeyFile: e.TERMDOCK_MASTER_KEY_FILE,
    internalTokenFile: e.TERMDOCK_INTERNAL_TOKEN_FILE,
    internalHost: e.TERMDOCK_INTERNAL_HOST,
    internalPort: e.TERMDOCK_INTERNAL_PORT,
    enableLocalShell: e.TERMDOCK_ENABLE_LOCAL_SHELL,
    dbFile: join(base.dataDir, 'app.db'),
  };
}
