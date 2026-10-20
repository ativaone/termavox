import { uuidv7 } from '@termavox/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AddServerDeps,
  addServerCore,
  duplicatePrefill,
} from '../lib/actions/add-server-core.ts';
import {
  type CreateCredentialInput,
  type CreateCredentialResult,
  InternalApiError,
} from '../lib/internal-api.ts';
import { createServer, getServer, listServers, type ServerInput } from '../lib/repo/servers.ts';
import { optionsDifferFromDefaults } from '../lib/servers/options.ts';
import { createUser, makeRuntime, type TestRuntime } from './helpers.ts';

// The Server Action wrapper (lib/actions/add-server.ts) runs against these stand-ins for Next.
const next = vi.hoisted(() => {
  class Redirect extends Error {
    readonly url: string;

    constructor(url: string) {
      super(`redirect ${url}`);
      this.url = url;
    }
  }
  return {
    user: { id: '', role: 'user' as string | null },
    rt: null as unknown,
    revalidated: [] as string[],
    Redirect,
  };
});
vi.mock('../lib/auth/server.ts', () => ({
  requireSession: async () => ({ user: next.user, session: {} }),
  getAuthRuntime: () => next.rt,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => (key: string, values?: Record<string, unknown>) =>
    `${ns}.${key}${values ? JSON.stringify(values) : ''}`,
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'user-agent': 'vitest' }),
}));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => next.revalidated.push(path),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new next.Redirect(url);
  },
}));

let t: TestRuntime;
let alice: string;
let bob: string;
let admin: string;

beforeAll(async () => {
  t = makeRuntime();
  alice = (await createUser(t.rt, 'alice')).id;
  bob = (await createUser(t.rt, 'bob')).id;
  admin = (await createUser(t.rt, 'root', { role: 'admin' })).id;
  next.rt = t.rt;
});
afterAll(() => t.cleanup());

function insertCredential(userId: string, name = 'key'): string {
  const id = uuidv7();
  t.rt.db.$client
    .prepare(
      `INSERT INTO credentials (id, user_id, name, kind, ciphertext, nonce, key_version, created_at)
       VALUES (?, ?, ?, 'private_key', ?, ?, 1, ?)`,
    )
    .run(id, userId, name, Buffer.alloc(16), Buffer.alloc(12), Date.now());
  return id;
}

function credentialCount(userId: string): number {
  return (
    t.rt.db.$client
      .prepare('SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?')
      .get(userId) as { n: number }
  ).n;
}

const PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFake termavox';
const FINGERPRINT = `SHA256:${'B'.repeat(43)}`;

/**
 * The daemon's credential endpoints, faked. Like the daemon, a create writes the credentials row
 * (so the server's ownership check sees it) unless `orphan` says to answer without one.
 */
class FakeApi {
  created: CreateCredentialInput[] = [];
  deleted: string[] = [];
  serversAtCreate: number[] = [];
  fail: InternalApiError | null = null;
  failDelete = false;
  orphan = false;
  noPublicKey = false;

  async createCredential(input: CreateCredentialInput): Promise<CreateCredentialResult> {
    this.created.push(input);
    this.serversAtCreate.push(listServers(t.rt.db, input.actingUserId).length);
    if (this.fail) throw this.fail;
    const credentialId = this.orphan ? uuidv7() : insertCredential(input.actingUserId, input.name);
    const key = input.kind === 'generate' && !this.noPublicKey;
    return {
      credentialId,
      publicKey: key ? PUBLIC_KEY : null,
      fingerprint: input.kind === 'password' ? null : FINGERPRINT,
    };
  }

  async deleteCredential(credentialId: string, actingUserId: string): Promise<void> {
    this.deleted.push(credentialId);
    if (this.failDelete) throw new InternalApiError('unavailable', 0, 'UNAVAILABLE', 'down');
    t.rt.db.$client
      .prepare('DELETE FROM credentials WHERE id = ? AND user_id = ?')
      .run(credentialId, actingUserId);
  }
}

let api: FakeApi;
beforeEach(() => {
  api = new FakeApi();
});

function deps(userId: string, extra: Partial<AddServerDeps> = {}): AddServerDeps {
  return {
    db: t.rt.db,
    user: { id: userId, role: userId === admin ? 'admin' : 'user' },
    api: () => api,
    localShellVisible: false,
    ...extra,
  };
}

/** A filled-in "Add server" form: an SSH server, user deploy, a generated key. */
function form(overrides: Record<string, string | string[] | null> = {}): FormData {
  const fields: Record<string, string | string[] | null> = {
    'server.name': 'api-prod',
    'server.hostname': '10.0.0.5',
    'server.port': '2222',
    'server.username': 'deploy',
    'server.protectionMode': 'auto',
    'server.startupCommand': '',
    'server.keepaliveIntervalS': '15',
    'server.scrollbackLines': '5000',
    'server.autoReopen': 'on',
    'credential.mode': 'generate',
    'credential.name': '',
    ...overrides,
  };
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) continue;
    for (const one of Array.isArray(value) ? value : [value]) data.append(key, one);
  }
  return data;
}

function serverRows(): number {
  return (t.rt.db.$client.prepare('SELECT COUNT(*) AS n FROM servers').get() as { n: number }).n;
}

function auditTypes(targetId: string): string[] {
  return (
    t.rt.db.$client
      .prepare('SELECT type FROM audit_events WHERE target_id = ? ORDER BY created_at')
      .all(targetId) as Array<{ type: string }>
  ).map((r) => r.type);
}

const SERVER: ServerInput = {
  name: 'edge',
  kind: 'ssh',
  hostname: 'edge.internal',
  port: 22,
  username: 'ops',
  credentialId: null,
  protectionMode: 'off',
  startupCommand: 'cd /srv/app',
  env: { APP_ENV: 'prod', TZ: 'UTC' },
  keepaliveIntervalS: 30,
  autoReopen: false,
  scrollbackLines: 8000,
};

describe('add server: a new credential', () => {
  it('generates the key first, then creates the server that uses it', async () => {
    const before = listServers(t.rt.db, alice).length;
    const outcome = await addServerCore(
      deps(alice),
      form({ 'server.envKey': ['APP_ENV'], 'server.envValue': ['prod'] }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { created } = outcome;
    expect(api.created).toHaveLength(1);
    expect(api.created[0]).toMatchObject({
      actingUserId: alice,
      kind: 'generate',
      algorithm: 'ed25519',
      name: 'deploy@api-prod',
    });
    expect(api.serversAtCreate).toEqual([before]); // the credential exists before the server row
    expect(created).toMatchObject({
      serverName: 'api-prod',
      kind: 'ssh',
      target: 'deploy@10.0.0.5:2222',
      credential: {
        choice: 'generate',
        name: 'deploy@api-prod',
        publicKey: PUBLIC_KEY,
        fingerprint: FINGERPRINT,
      },
    });
    expect(getServer(t.rt.db, alice, created.serverId)).toMatchObject({
      name: 'api-prod',
      hostname: '10.0.0.5',
      port: 2222,
      username: 'deploy',
      credentialName: 'deploy@api-prod',
      protectionMode: 'auto',
      env: { APP_ENV: 'prod' },
      keepaliveIntervalS: 15,
      autoReopen: true,
      scrollbackLines: 5000,
    });
    expect(auditTypes(created.serverId)).toEqual(['server.create']);
    expect(api.deleted).toEqual([]);
  });

  it('keeps a typed credential name and stores a password credential', async () => {
    const outcome = await addServerCore(
      deps(alice),
      form({
        'server.name': 'db-1',
        'credential.mode': 'password',
        'credential.name': 'db password',
        'credential.password': 'hunter2-long',
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(api.created[0]).toMatchObject({ kind: 'password', name: 'db password' });
    expect(outcome.created.credential).toMatchObject({
      choice: 'password',
      name: 'db password',
      publicKey: null,
      fingerprint: null,
    });
  });

  it('shows the fingerprint of a pasted key, and stores the address normalized', async () => {
    const outcome = await addServerCore(
      deps(alice),
      form({
        'server.hostname': 'DB.Internal',
        'server.port': '22',
        'credential.mode': 'private_key',
        'credential.privateKey': '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END-----',
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.created.credential).toMatchObject({
      choice: 'private_key',
      publicKey: null,
      fingerprint: FINGERPRINT,
    });
    expect(outcome.created.target).toBe('deploy@DB.Internal');
    expect(getServer(t.rt.db, alice, outcome.created.serverId)?.hostname).toBe('db.internal');
  });
});

describe('add server: no new credential', () => {
  it('uses a saved credential with no daemon call', async () => {
    const credentialId = insertCredential(alice, 'team key');
    const credentials = credentialCount(alice);
    const outcome = await addServerCore(
      deps(alice),
      form({
        'credential.mode': 'saved',
        'credential.id': credentialId,
        // Fields of choices that were not picked are ignored, secrets included.
        'credential.password': 'ignored-secret',
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(api.created).toEqual([]);
    expect(credentialCount(alice)).toBe(credentials);
    expect(outcome.created.credential).toMatchObject({
      choice: 'saved',
      name: 'team key',
      publicKey: null,
    });
    expect(getServer(t.rt.db, alice, outcome.created.serverId)?.credentialId).toBe(credentialId);
  });

  it('"None": stores no credential, so the server asks in the terminal', async () => {
    const credentials = credentialCount(alice);
    const outcome = await addServerCore(
      deps(alice),
      form({
        'server.name': 'prompted',
        'credential.mode': 'none',
        'credential.name': 'ignored',
        'credential.password': 'ignored-secret',
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(api.created).toEqual([]);
    expect(credentialCount(alice)).toBe(credentials);
    expect(outcome.created.credential).toEqual({
      choice: 'none',
      name: null,
      publicKey: null,
      fingerprint: null,
    });
    expect(getServer(t.rt.db, alice, outcome.created.serverId)).toMatchObject({
      name: 'prompted',
      credentialId: null,
      credentialName: null,
    });
  });
});

describe('add server: validation', () => {
  it('returns every field error at once, writes nothing and never echoes a secret', async () => {
    const servers = serverRows();
    const outcome = await addServerCore(
      deps(alice),
      form({
        'server.name': '',
        'server.hostname': 'not a host',
        'server.port': '70000',
        'server.username': '',
        'server.keepaliveIntervalS': '1',
        'credential.mode': 'private_key',
        'credential.privateKey': '',
        'credential.passphrase': 'pass-secret',
        'credential.password': 'password-secret',
        'credential.name': 'x'.repeat(121),
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.fields).toEqual({
      'server.name': { scope: 'server', key: 'nameRequired' },
      'server.hostname': { scope: 'server', key: 'hostname' },
      'server.port': { scope: 'server', key: 'port' },
      'server.username': { scope: 'server', key: 'usernameRequired' },
      'server.keepaliveIntervalS': { scope: 'server', key: 'keepalive' },
      'credential.privateKey': { scope: 'credential', key: 'privateKeyRequired' },
      'credential.name': { scope: 'credential', key: 'nameLong' },
    });
    expect(api.created).toEqual([]);
    expect(serverRows()).toBe(servers);
    expect(outcome.values).toMatchObject({
      'server.hostname': 'not a host',
      'server.port': '70000',
      'credential.mode': 'private_key',
    });
    for (const key of ['credential.password', 'credential.privateKey', 'credential.passphrase']) {
      expect(outcome.values).not.toHaveProperty(key);
    }
    expect(JSON.stringify(outcome.values)).not.toContain('secret');
  });

  it('does not echo a pasted key when the server section fails', async () => {
    const pasted =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAsecretkeymaterial\n-----END OPENSSH PRIVATE KEY-----';
    const outcome = await addServerCore(
      deps(alice),
      form({
        'server.port': 'abc',
        'credential.mode': 'private_key',
        'credential.privateKey': pasted,
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(Object.keys(outcome.fields ?? {})).toEqual(['server.port']);
    expect(JSON.stringify(outcome)).not.toContain('secretkeymaterial');
    expect(api.created).toEqual([]);
  });

  it('asks for a saved credential when none is picked, and refuses duplicate variables', async () => {
    const outcome = await addServerCore(
      deps(alice),
      form({
        'credential.mode': 'saved',
        'server.envKey': ['A', 'A'],
        'server.envValue': ['1', '2'],
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.fields).toEqual({
      'server.env': { scope: 'server', key: 'envDuplicate' },
      'credential.id': { scope: 'addServer', key: 'credentialRequired' },
    });
  });
});

describe('add server: failures', () => {
  it('writes nothing when the daemon cannot read the pasted key', async () => {
    api.fail = new InternalApiError('bad_request', 400, 'CREDENTIAL_INVALID', 'bad key');
    const servers = serverRows();
    const outcome = await addServerCore(
      deps(alice),
      form({ 'credential.mode': 'private_key', 'credential.privateKey': 'garbage' }),
    );
    expect(outcome).toMatchObject({
      ok: false,
      fields: { 'credential.privateKey': { scope: 'credential', key: 'privateKeyInvalid' } },
    });
    expect(api.created[0]).toMatchObject({ kind: 'private_key', privateKey: 'garbage\n' });
    expect(serverRows()).toBe(servers);
    expect(api.deleted).toEqual([]);
  });

  it('writes nothing when the session service is down', async () => {
    api.fail = new InternalApiError('unavailable', 0, 'UNAVAILABLE', 'connection refused');
    const servers = serverRows();
    const outcome = await addServerCore(deps(alice), form());
    expect(outcome).toMatchObject({ ok: false, message: { key: 'unavailable' } });
    expect(serverRows()).toBe(servers);
  });

  it('deletes the new credential when the server cannot be written', async () => {
    // The daemon answers with an id but no row: the server's ownership check refuses it.
    api.orphan = true;
    const servers = serverRows();
    const outcome = await addServerCore(deps(alice), form({ 'server.name': 'rollback' }));
    expect(outcome).toMatchObject({ ok: false, message: { key: 'saveFailed' } });
    expect(api.created).toHaveLength(1);
    expect(api.deleted).toHaveLength(1);
    expect(serverRows()).toBe(servers);
    expect(listServers(t.rt.db, alice).some((s) => s.name === 'rollback')).toBe(false);
  });

  it('says so when the credential cannot be deleted again', async () => {
    api.orphan = true;
    api.failDelete = true;
    const outcome = await addServerCore(
      deps(alice),
      form({ 'server.name': 'leftover', 'credential.name': 'lost key' }),
    );
    expect(outcome).toMatchObject({ ok: false, message: { key: 'leftover', name: 'lost key' } });
    expect(api.deleted).toHaveLength(1);
  });

  it('deletes a generated credential that came back without a public key', async () => {
    api.noPublicKey = true;
    const servers = serverRows();
    const credentials = credentialCount(alice);
    const outcome = await addServerCore(deps(alice), form());
    expect(outcome).toMatchObject({ ok: false, message: { key: 'generic' } });
    expect(api.deleted).toHaveLength(1);
    expect(credentialCount(alice)).toBe(credentials);
    expect(serverRows()).toBe(servers);
  });
});

describe('add server: isolation', () => {
  it("rejects another user's credential id, writing nothing", async () => {
    const servers = serverRows();
    const outcome = await addServerCore(
      deps(alice),
      form({ 'credential.mode': 'saved', 'credential.id': insertCredential(bob, 'bob key') }),
    );
    expect(outcome).toMatchObject({
      ok: false,
      fields: { 'credential.id': { scope: 'addServer', key: 'credentialMissing' } },
    });
    expect(api.created).toEqual([]);
    expect(serverRows()).toBe(servers);
  });
});

describe('add server: local shell', () => {
  it('stores no target or credential and ignores the credential section', async () => {
    const outcome = await addServerCore(
      deps(admin, { localShellVisible: true }),
      form({
        'server.kind': 'local',
        'server.name': 'this box',
        'server.hostname': '',
        'server.username': '',
        'credential.mode': 'password',
        'credential.password': 'ignored',
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(api.created).toEqual([]);
    expect(outcome.created).toMatchObject({ kind: 'local', target: null, credential: null });
    expect(getServer(t.rt.db, admin, outcome.created.serverId)).toMatchObject({
      kind: 'local',
      hostname: null,
      port: null,
      username: null,
      credentialId: null,
    });
  });

  it('is refused unless an admin turned it on and the user is an admin', async () => {
    for (const [userId, visible] of [
      [alice, true],
      [admin, false],
    ] as const) {
      const outcome = await addServerCore(
        deps(userId, { localShellVisible: visible }),
        form({ 'server.kind': 'local', 'server.name': 'nope' }),
      );
      expect(outcome).toMatchObject({
        ok: false,
        fields: { 'server.kind': { scope: 'server', key: 'kindLocal' } },
      });
    }
  });
});

describe('duplicate (plan D-29)', () => {
  const copyName = (name: string) => `${name} (copy)`;

  it('prefills every field of the source, with the copy suffix and the same credential', () => {
    const credentialId = insertCredential(alice, 'ops key');
    const created = createServer(t.rt.db, alice, { ...SERVER, credentialId });
    if (created.outcome !== 'ok') throw new Error('setup failed');
    const servers = serverRows();
    expect(duplicatePrefill(t.rt.db, alice, created.id, copyName)).toEqual({
      'server.name': 'edge (copy)',
      'server.kind': 'ssh',
      'server.hostname': 'edge.internal',
      'server.port': '22',
      'server.username': 'ops',
      'server.protectionMode': 'off',
      'server.startupCommand': 'cd /srv/app',
      'server.keepaliveIntervalS': '30',
      'server.autoReopen': '',
      'server.scrollbackLines': '8000',
      'server.env': JSON.stringify([
        { key: 'APP_ENV', value: 'prod' },
        { key: 'TZ', value: 'UTC' },
      ]),
      'credential.mode': 'saved',
      'credential.id': credentialId,
    });
    // Reading the source writes nothing.
    expect(serverRows()).toBe(servers);
  });

  it('opens Advanced when the copied options differ from the defaults, not otherwise', () => {
    const custom = createServer(t.rt.db, alice, { ...SERVER, name: 'custom options' });
    const plain = createServer(t.rt.db, alice, {
      ...SERVER,
      name: 'default options',
      protectionMode: 'auto',
      startupCommand: null,
      env: {},
      keepaliveIntervalS: 15,
      autoReopen: true,
      scrollbackLines: 5000,
    });
    if (custom.outcome !== 'ok' || plain.outcome !== 'ok') throw new Error('setup failed');
    const opens = (id: string) =>
      optionsDifferFromDefaults(duplicatePrefill(t.rt.db, alice, id, copyName) ?? {}, 'server.');
    expect(opens(custom.id)).toBe(true);
    expect(opens(plain.id)).toBe(false);
    // One option is enough, the environment included.
    expect(
      optionsDifferFromDefaults({ 'server.env': '[{"key":"A","value":"1"}]' }, 'server.'),
    ).toBe(true);
    expect(optionsDifferFromDefaults({}, 'server.')).toBe(false);
  });

  it('preselects "None" for a source without a credential and keeps the name in its limit', () => {
    const created = createServer(t.rt.db, alice, { ...SERVER, name: 'n'.repeat(80) });
    if (created.outcome !== 'ok') throw new Error('setup failed');
    const values = duplicatePrefill(t.rt.db, alice, created.id, copyName);
    expect(values).toMatchObject({ 'credential.mode': 'none', 'credential.id': '' });
    expect(values?.['server.name']).toHaveLength(80);
    expect(values?.['server.name']?.endsWith('… (copy)')).toBe(true);
  });

  it("gives nothing for another user's server or a missing id (an empty form)", () => {
    const created = createServer(t.rt.db, bob, { ...SERVER, name: 'bob-secret-box' });
    if (created.outcome !== 'ok') throw new Error('setup failed');
    expect(duplicatePrefill(t.rt.db, alice, created.id, copyName)).toBeNull();
    expect(duplicatePrefill(t.rt.db, alice, 'no-such-server', copyName)).toBeNull();
  });

  it('saving the prefilled form adds a second server, and the source stays as it was', async () => {
    const credentialId = insertCredential(alice, 'shared key');
    const created = createServer(t.rt.db, alice, { ...SERVER, name: 'twin', credentialId });
    if (created.outcome !== 'ok') throw new Error('setup failed');
    const values = duplicatePrefill(t.rt.db, alice, created.id, copyName) ?? {};
    const data = new FormData();
    for (const [key, value] of Object.entries(values)) {
      if (key === 'server.env') continue;
      if (key === 'server.autoReopen' && !value) continue;
      data.set(key, value);
    }
    for (const [key, value] of Object.entries(SERVER.env)) {
      data.append('server.envKey', key);
      data.append('server.envValue', value);
    }
    const outcome = await addServerCore(deps(alice), data);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(api.created).toEqual([]);
    const copy = getServer(t.rt.db, alice, outcome.created.serverId);
    const source = getServer(t.rt.db, alice, created.id);
    expect(copy).toMatchObject({
      name: 'twin (copy)',
      hostname: source?.hostname,
      port: source?.port,
      username: source?.username,
      credentialId,
      protectionMode: 'off',
      startupCommand: 'cd /srv/app',
      env: SERVER.env,
      keepaliveIntervalS: 30,
      autoReopen: false,
      scrollbackLines: 8000,
    });
    expect(source?.name).toBe('twin');
  });
});

describe('add server: the Server Actions', () => {
  const sessions: Array<Record<string, unknown>> = [];
  beforeEach(() => {
    sessions.length = 0;
    next.user = { id: alice, role: 'user' };
    next.revalidated = [];
    const fake = Object.assign(api, {
      createSession: async (input: Record<string, unknown>) => {
        sessions.push(input);
        return { sessionId: 'sess-1' };
      },
    });
    (globalThis as { __termavoxInternalApi?: unknown }).__termavoxInternalApi = fake;
  });
  afterAll(() => {
    delete (globalThis as { __termavoxInternalApi?: unknown }).__termavoxInternalApi;
  });

  it('localizes field errors in the catalog of the section that owns the rule', async () => {
    const { addServer } = await import('../lib/actions/add-server.ts');
    const state = await addServer(
      {},
      form({ 'server.port': '0', 'server.username': 'two words', 'credential.mode': 'saved' }),
    );
    expect(state.fields).toEqual({
      'server.port': 'servers.error.port',
      'server.username': 'servers.error.username',
      'credential.id': 'servers.addServer.error.credentialRequired',
    });
    expect(state.created).toBeUndefined();
  });

  it('returns what it created, audits it with the request, and refreshes the lists', async () => {
    const { addServer } = await import('../lib/actions/add-server.ts');
    const state = await addServer({}, form({ 'server.name': 'via-action' }));
    expect(state.created?.serverName).toBe('via-action');
    expect(next.revalidated).toEqual(['/servers', '/credentials', '/workspace']);
    expect(listServers(t.rt.db, alice).some((s) => s.name === 'via-action')).toBe(true);
    const audit = t.rt.db.$client
      .prepare(
        'SELECT type, target_type, actor_user_id, user_agent, detail_json FROM audit_events WHERE target_id = ?',
      )
      .get(state.created?.serverId) as Record<string, string>;
    expect(audit).toMatchObject({
      type: 'server.create',
      target_type: 'server',
      actor_user_id: alice,
      user_agent: 'vitest',
    });
    expect(JSON.parse(audit.detail_json ?? '{}')).toEqual({
      name: 'via-action',
      kind: 'ssh',
      hostname: '10.0.0.5',
      port: 2222,
      username: 'deploy',
    });
  });

  it('starts a 120×32 session from the new server and opens it in the workspace', async () => {
    const { startAddedServerSession } = await import('../lib/actions/add-server.ts');
    const data = new FormData();
    data.set('serverId', 'server-1');
    await expect(startAddedServerSession({}, data)).rejects.toMatchObject({
      url: '/workspace?open=sess-1',
    });
    expect(sessions).toEqual([
      { actingUserId: alice, serverId: 'server-1', viewport: { cols: 120, rows: 32 } },
    ]);
  });
});
