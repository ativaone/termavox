import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateDb, openDb } from '@termdock/db';
import { type AuthRuntime, createAuthRuntime } from '../lib/auth/runtime.ts';
import type { WebLogger } from '../lib/logger.ts';

export const PUBLIC_URL = 'https://termdock.test';
export const PASSWORD = 'correct horse battery';
/** Cheap argon2id parameters for tests; production defaults are covered in password.test.ts. */
export const FAST_ARGON2 = { memoryKiB: 1024, passes: 1, parallelism: 1 };

export interface TestRuntime {
  rt: AuthRuntime;
  logs: string[];
  dir: string;
  dbFile: string;
  cleanup(): void;
}

/** A Better Auth runtime over a fresh temp SQLite database with every migration applied. */
export function makeRuntime(
  opts: { wsSecret?: Uint8Array; dir?: string; migrate?: boolean } = {},
): TestRuntime {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'termdock-web-'));
  const dbFile = join(dir, 'app.db');
  const db = openDb(dbFile);
  if (opts.migrate !== false) migrateDb(db);
  const logs: string[] = [];
  const logger: WebLogger = {
    info: (m) => logs.push(`info ${m}`),
    warn: (m) => logs.push(`warn ${m}`),
    error: (m) => logs.push(`error ${m}`),
  };
  const rt = createAuthRuntime({
    db,
    publicUrl: PUBLIC_URL,
    authSecret: randomBytes(32).toString('base64url'),
    wsSecret: opts.wsSecret ?? randomBytes(32),
    logger,
    argon2: FAST_ARGON2,
    // Isolates Termdock's own lockout from Better Auth's per-IP limiter (3 sign-ins / 10 s).
    rateLimit: false,
  });
  return {
    rt,
    logs,
    dir,
    dbFile,
    cleanup: () => {
      db.$client.close();
      if (!opts.dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Minimal cookie jar fed with Set-Cookie headers from Better Auth responses. */
export class Jar {
  readonly #cookies = new Map<string, string>();

  apply(res: Response): Response {
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(';', 1)[0]!;
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1);
      if (value === '' || /max-age=0(;|$)/i.test(line)) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
    return res;
  }

  has(name: string): boolean {
    return [...this.#cookies.keys()].some((k) => k.endsWith(name));
  }

  copy(only?: (name: string) => boolean): Jar {
    const jar = new Jar();
    for (const [k, v] of this.#cookies) if (!only || only(k)) jar.#cookies.set(k, v);
    return jar;
  }

  headers(extra: Record<string, string> = {}): Headers {
    const headers = new Headers(extra);
    if (this.#cookies.size > 0) {
      headers.set('cookie', [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    return headers;
  }
}

/** Calls a Better Auth endpoint through its HTTP handler, as the browser would via Caddy. */
export async function call(
  rt: AuthRuntime,
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: unknown; jar?: Jar; ip?: string } = {},
): Promise<Response> {
  const headers = (opts.jar ?? new Jar()).headers({
    origin: PUBLIC_URL,
    'x-forwarded-for': opts.ip ?? '203.0.113.10',
  });
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  const res = await rt.auth.handler(
    new Request(`${PUBLIC_URL}/api/auth${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
  );
  opts.jar?.apply(res);
  return res;
}

export async function createUser(
  rt: AuthRuntime,
  username: string,
  extra: { role?: 'admin' | 'user'; mustChangePassword?: boolean; totpRequired?: boolean } = {},
): Promise<{ id: string }> {
  const { user } = await rt.auth.api.createUser({
    body: {
      email: `${username}@example.test`,
      password: PASSWORD,
      name: username,
      role: extra.role ?? 'user',
      data: {
        username,
        mustChangePassword: extra.mustChangePassword ?? false,
        totpRequired: extra.totpRequired ?? false,
      },
    },
  });
  return user;
}

export async function signIn(
  rt: AuthRuntime,
  username: string,
  opts: { password?: string; ip?: string; jar?: Jar } = {},
): Promise<{ res: Response; jar: Jar }> {
  const jar = opts.jar ?? new Jar();
  const res = await call(rt, 'POST', '/sign-in/username', {
    body: { username, password: opts.password ?? PASSWORD },
    jar,
    ...(opts.ip ? { ip: opts.ip } : {}),
  });
  return { res, jar };
}

/** Enables TOTP for the signed-in user and confirms it with a valid code; returns the otpauth URI. */
export async function enrollTotp(rt: AuthRuntime, jar: Jar): Promise<string> {
  const enabled = await call(rt, 'POST', '/two-factor/enable', {
    body: { password: PASSWORD },
    jar,
  });
  if (enabled.status !== 200)
    throw new Error(`enable failed: ${enabled.status} ${await enabled.text()}`);
  const { totpURI } = (await enabled.json()) as { totpURI: string };
  const verified = await call(rt, 'POST', '/two-factor/verify-totp', {
    body: { code: totp(totpURI) },
    jar,
  });
  if (verified.status !== 200) throw new Error(`verify failed: ${verified.status}`);
  return totpURI;
}

/** RFC 6238 code (SHA-1, 6 digits, 30 s) for an otpauth URI, as an authenticator app computes it. */
export function totp(uri: string, now: number = Date.now()): string {
  const key = base32Decode(new URL(uri).searchParams.get('secret')!);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
