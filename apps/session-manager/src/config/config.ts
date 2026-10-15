import { readFile } from 'node:fs/promises';
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
 * Reads a secret file (e.g. TERMDOCK_WS_SECRET_FILE). The trimmed file content is the key, as
 * bytes; web must derive the ticket HMAC key the same way.
 */
export async function readSecretFile(path: string, minLength = 32): Promise<Uint8Array> {
  const value = (await readFile(path, 'utf8')).trim();
  if (value.length < minLength) {
    throw new Error(`secret file ${path} is shorter than ${minLength} characters`);
  }
  return new TextEncoder().encode(value);
}
