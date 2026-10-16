import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NonceCache, TICKET_TTL_MS, verifyTicket } from '@termdock/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSecretFileSync, secretBytes } from '../lib/config.ts';
import { issueWsTicket } from '../lib/ws-ticket.ts';
import {
  createUser,
  type Jar,
  makeRuntime,
  PUBLIC_URL,
  signIn,
  type TestRuntime,
} from './helpers.ts';

let t: TestRuntime;
let daemonKey: Uint8Array;
let secretDir: string;

beforeAll(async () => {
  secretDir = mkdtempSync(join(tmpdir(), 'termdock-secret-'));
  const secretFile = join(secretDir, 'ws_secret');
  writeFileSync(secretFile, `  ${randomBytes(32).toString('base64url')}\n`);
  t = makeRuntime({ wsSecret: secretBytes(readSecretFileSync(secretFile)) });
  // session-manager's derivation: the trimmed file content as UTF-8 bytes (no base64 decoding).
  daemonKey = new TextEncoder().encode(readFileSync(secretFile, 'utf8').trim());
  await createUser(t.rt, 'root', { role: 'admin' });
});
afterAll(() => {
  t.cleanup();
  rmSync(secretDir, { recursive: true, force: true });
});

function post(jar?: Jar, origin: string | null = PUBLIC_URL, now?: number) {
  const headers = jar?.headers() ?? new Headers();
  if (origin) headers.set('origin', origin);
  const request = new Request(`${PUBLIC_URL}/api/ws/ticket`, { method: 'POST', headers });
  return issueWsTicket(t.rt, request, now);
}

describe('POST /api/ws/ticket', () => {
  it('refuses without a session (401) and with a foreign or missing Origin (403)', async () => {
    const anonymous = await post();
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('cache-control')).toBe('no-store');

    await createUser(t.rt, 'ivy');
    const { jar } = await signIn(t.rt, 'ivy');
    const foreign = await post(jar, 'https://evil.example');
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('cache-control')).toBe('no-store');
    expect((await post(jar, null)).status).toBe(403);
  });

  it('refuses while a TOTP enrollment is pending (403)', async () => {
    await createUser(t.rt, 'jack', { totpRequired: true });
    const { jar } = await signIn(t.rt, 'jack');
    expect((await post(jar)).status).toBe(403);
  });

  it('issues a single-use ticket that the daemon key verifies', async () => {
    const kate = await createUser(t.rt, 'kate');
    const { jar } = await signIn(t.rt, 'kate');
    const now = Date.now();
    const res = await post(jar, PUBLIC_URL, now);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { ticket, expiresAt } = (await res.json()) as { ticket: string; expiresAt: number };
    expect(expiresAt).toBe(now + TICKET_TTL_MS);

    const nonces = new NonceCache();
    const verified = verifyTicket(daemonKey, ticket, nonces);
    expect(verified.ok).toBe(true);
    const sessionRow = t.rt.db.$client
      .prepare('SELECT id FROM auth_session WHERE user_id = ?')
      .get(kate.id) as { id: string };
    expect(verified.ok && verified.payload).toMatchObject({ uid: kate.id, asid: sessionRow.id });
    expect(verifyTicket(daemonKey, ticket, nonces)).toEqual({ ok: false, error: 'replayed' });

    // Disabled account: the session no longer authenticates.
    t.rt.db.$client.prepare('UPDATE user SET banned = 1 WHERE id = ?').run(kate.id);
    expect((await post(jar)).status).toBe(401);
  });
});
