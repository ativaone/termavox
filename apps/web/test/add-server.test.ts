import { uuidv7 } from '@termdock/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AddServerDeps, addServerCore } from '../lib/actions/add-server-core.ts';
import {
  type CreateCredentialInput,
  type CreateCredentialResult,
  InternalApiError,
} from '../lib/internal-api.ts';
import { createHost, listHosts } from '../lib/repo/hosts.ts';
import { listProfiles, listProfilesForUser } from '../lib/repo/profiles.ts';
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
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFake termdock';
const FINGERPRINT = `SHA256:${'B'.repeat(43)}`;

/**
 * The daemon's credential endpoints, faked. Like the daemon, a create writes the credentials row
 * (so the profile's ownership check sees it) unless `orphan` says to answer without one.
 */
class FakeApi {
  created: CreateCredentialInput[] = [];
  deleted: string[] = [];
  hostsAtCreate: number[] = [];
  fail: InternalApiError | null = null;
  failDelete = false;
  orphan = false;
  noPublicKey = false;

  async createCredential(input: CreateCredentialInput): Promise<CreateCredentialResult> {
    this.created.push(input);
    this.hostsAtCreate.push(listHosts(t.rt.db, input.actingUserId).length);
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

/** A filled-in "Add server" form: a new SSH server, user deploy, a generated key. */
function form(overrides: Record<string, string | string[] | null> = {}): FormData {
  const fields: Record<string, string | string[] | null> = {
    'host.mode': 'new',
    'host.name': 'api-prod',
    'host.hostname': '10.0.0.5',
    'host.port': '2222',
    'profile.name': '',
    'profile.username': 'deploy',
    'profile.protectionMode': 'auto',
    'profile.startupCommand': '',
    'profile.keepaliveIntervalS': '15',
    'profile.scrollbackLines': '5000',
    'profile.autoReopen': 'on',
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

function hostRows(): number {
  return (t.rt.db.$client.prepare('SELECT COUNT(*) AS n FROM hosts').get() as { n: number }).n;
}
function profileRows(): number {
  return (
    t.rt.db.$client.prepare('SELECT COUNT(*) AS n FROM connection_profiles').get() as { n: number }
  ).n;
}

describe('add server: everything new', () => {
  it('generates the key first, then creates the host and a profile that uses it', async () => {
    const before = listHosts(t.rt.db, alice).length;
    const outcome = await addServerCore(
      deps(alice),
      form({ 'profile.envKey': ['APP_ENV'], 'profile.envValue': ['prod'] }),
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
    expect(api.hostsAtCreate).toEqual([before]); // the credential exists before any host row
    expect(created).toMatchObject({
      hostName: 'api-prod',
      hostCreated: true,
      kind: 'ssh',
      address: '10.0.0.5:2222',
      profileName: 'deploy',
      username: 'deploy',
      credential: {
        choice: 'generate',
        name: 'deploy@api-prod',
        publicKey: PUBLIC_KEY,
        fingerprint: FINGERPRINT,
      },
    });
    const [profile] = listProfiles(t.rt.db, alice, created.hostId);
    expect(profile).toMatchObject({
      id: created.profileId,
      name: 'deploy',
      username: 'deploy',
      credentialName: 'deploy@api-prod',
      protectionMode: 'auto',
      env: { APP_ENV: 'prod' },
      keepaliveIntervalS: 15,
      autoReopen: true,
      scrollbackLines: 5000,
    });
    expect(api.deleted).toEqual([]);
  });

  it('keeps a typed profile and credential name, and stores a password credential', async () => {
    const outcome = await addServerCore(
      deps(alice),
      form({
        'host.name': 'db-1',
        'profile.name': 'ops',
        'credential.mode': 'password',
        'credential.name': 'db password',
        'credential.password': 'hunter2-long',
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(api.created[0]).toMatchObject({ kind: 'password', name: 'db password' });
    expect(outcome.created.profileName).toBe('ops');
    expect(outcome.created.credential).toMatchObject({
      choice: 'password',
      name: 'db password',
      publicKey: null,
    });
  });
});

describe('add server: existing host and saved credential', () => {
  it('only adds a profile, with no daemon credential call', async () => {
    const hostId = createHost(t.rt.db, alice, {
      name: 'edge',
      kind: 'ssh',
      hostname: 'edge.internal',
      port: 22,
    });
    const credentialId = insertCredential(alice, 'team key');
    const hosts = hostRows();
    const credentials = credentialCount(alice);
    const outcome = await addServerCore(
      deps(alice),
      form({
        'host.mode': 'existing',
        'host.id': hostId,
        'host.name': '',
        'host.hostname': '',
        'credential.mode': 'saved',
        'credential.id': credentialId,
        // Fields of choices that were not picked are ignored, secrets included.
        'credential.password': 'ignored-secret',
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(api.created).toEqual([]);
    expect(hostRows()).toBe(hosts);
    expect(credentialCount(alice)).toBe(credentials);
    expect(outcome.created).toMatchObject({
      hostId,
      hostName: 'edge',
      hostCreated: false,
      address: 'edge.internal:22',
      credential: { choice: 'saved', name: 'team key', publicKey: null },
    });
    const profile = listProfiles(t.rt.db, alice, hostId).find(
      (p) => p.id === outcome.created.profileId,
    );
    expect(profile?.credentialId).toBe(credentialId);
  });
});

describe('add server: validation', () => {
  it('returns every field error at once, writes nothing and never echoes a secret', async () => {
    const hosts = hostRows();
    const profiles = profileRows();
    const outcome = await addServerCore(
      deps(alice),
      form({
        'host.name': '',
        'host.hostname': 'not a host',
        'host.port': '70000',
        'profile.username': '',
        'profile.keepaliveIntervalS': '1',
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
      'host.name': { scope: 'host', key: 'nameRequired' },
      'host.hostname': { scope: 'host', key: 'hostname' },
      'host.port': { scope: 'host', key: 'port' },
      'profile.username': { scope: 'profile', key: 'usernameRequired' },
      'profile.keepaliveIntervalS': { scope: 'profile', key: 'keepalive' },
      'credential.privateKey': { scope: 'credential', key: 'privateKeyRequired' },
      'credential.name': { scope: 'credential', key: 'nameLong' },
    });
    expect(api.created).toEqual([]);
    expect(hostRows()).toBe(hosts);
    expect(profileRows()).toBe(profiles);
    expect(outcome.values).toMatchObject({
      'host.mode': 'new',
      'host.hostname': 'not a host',
      'host.port': '70000',
      'credential.mode': 'private_key',
    });
    const echoed = JSON.stringify(outcome.values);
    for (const key of ['credential.password', 'credential.privateKey', 'credential.passphrase']) {
      expect(outcome.values).not.toHaveProperty(key);
    }
    expect(echoed).not.toContain('secret');
  });

  it('does not echo a pasted key when another section fails', async () => {
    const pasted =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAsecretkeymaterial\n-----END OPENSSH PRIVATE KEY-----';
    const outcome = await addServerCore(
      deps(alice),
      form({
        'host.port': 'abc',
        'credential.mode': 'private_key',
        'credential.privateKey': pasted,
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(Object.keys(outcome.fields ?? {})).toEqual(['host.port']);
    expect(JSON.stringify(outcome)).not.toContain('secretkeymaterial');
    expect(api.created).toEqual([]);
  });

  it('asks for a server and a saved credential when none is picked', async () => {
    const outcome = await addServerCore(
      deps(alice),
      form({ 'host.mode': 'existing', 'host.id': '', 'credential.mode': 'saved' }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.fields).toEqual({
      'host.id': { scope: 'addServer', key: 'hostRequired' },
      'credential.id': { scope: 'addServer', key: 'credentialRequired' },
    });
  });
});

describe('add server: failures', () => {
  it('writes nothing when the daemon cannot read the pasted key', async () => {
    api.fail = new InternalApiError('bad_request', 400, 'CREDENTIAL_INVALID', 'bad key');
    const hosts = hostRows();
    const profiles = profileRows();
    const outcome = await addServerCore(
      deps(alice),
      form({ 'credential.mode': 'private_key', 'credential.privateKey': 'garbage' }),
    );
    expect(outcome).toMatchObject({
      ok: false,
      fields: { 'credential.privateKey': { scope: 'credential', key: 'privateKeyInvalid' } },
    });
    expect(api.created[0]).toMatchObject({ kind: 'private_key', privateKey: 'garbage\n' });
    expect(hostRows()).toBe(hosts);
    expect(profileRows()).toBe(profiles);
    expect(api.deleted).toEqual([]);
  });

  it('writes nothing when the session service is down', async () => {
    api.fail = new InternalApiError('unavailable', 0, 'UNAVAILABLE', 'connection refused');
    const hosts = hostRows();
    const outcome = await addServerCore(deps(alice), form());
    expect(outcome).toMatchObject({ ok: false, message: { key: 'unavailable' } });
    expect(hostRows()).toBe(hosts);
  });

  it('deletes the new credential when the host and profile cannot be written', async () => {
    // The daemon answers with an id but no row: the profile's ownership check refuses it.
    api.orphan = true;
    const hosts = hostRows();
    const profiles = profileRows();
    const outcome = await addServerCore(deps(alice), form({ 'host.name': 'rollback' }));
    expect(outcome).toMatchObject({ ok: false, message: { key: 'saveFailed' } });
    expect(api.created).toHaveLength(1);
    expect(api.deleted).toHaveLength(1);
    expect(hostRows()).toBe(hosts); // the host insert was rolled back with the profile
    expect(profileRows()).toBe(profiles);
    expect(listHosts(t.rt.db, alice).some((h) => h.name === 'rollback')).toBe(false);
  });

  it('says so when the credential cannot be deleted again', async () => {
    api.orphan = true;
    api.failDelete = true;
    const outcome = await addServerCore(
      deps(alice),
      form({ 'host.name': 'leftover', 'credential.name': 'lost key' }),
    );
    expect(outcome).toMatchObject({ ok: false, message: { key: 'leftover', name: 'lost key' } });
    expect(api.deleted).toHaveLength(1);
  });

  it('deletes a generated credential that came back without a public key', async () => {
    api.noPublicKey = true;
    const hosts = hostRows();
    const credentials = credentialCount(alice);
    const outcome = await addServerCore(deps(alice), form());
    expect(outcome).toMatchObject({ ok: false, message: { key: 'generic' } });
    expect(api.deleted).toHaveLength(1);
    expect(credentialCount(alice)).toBe(credentials);
    expect(hostRows()).toBe(hosts);
  });
});

describe('add server: isolation', () => {
  it("rejects another user's host and credential ids, writing nothing", async () => {
    const bobHost = createHost(t.rt.db, bob, {
      name: 'bob-box',
      kind: 'ssh',
      hostname: '10.9.9.9',
      port: 22,
    });
    const bobCredential = insertCredential(bob, 'bob key');
    const profiles = profileRows();
    const outcome = await addServerCore(
      deps(alice),
      form({
        'host.mode': 'existing',
        'host.id': bobHost,
        'credential.mode': 'saved',
        'credential.id': bobCredential,
      }),
    );
    expect(outcome).toMatchObject({
      ok: false,
      fields: {
        'host.id': { scope: 'addServer', key: 'hostMissing' },
        'credential.id': { scope: 'addServer', key: 'credentialMissing' },
      },
    });
    expect(api.created).toEqual([]);
    expect(profileRows()).toBe(profiles);
    expect(listProfiles(t.rt.db, bob, bobHost)).toEqual([]);
  });

  it("rejects another user's credential with a new server too", async () => {
    const hosts = hostRows();
    const outcome = await addServerCore(
      deps(alice),
      form({ 'credential.mode': 'saved', 'credential.id': insertCredential(bob) }),
    );
    expect(outcome).toMatchObject({
      ok: false,
      fields: { 'credential.id': { scope: 'addServer', key: 'credentialMissing' } },
    });
    expect(hostRows()).toBe(hosts);
  });
});

describe('add server: local shell', () => {
  it('signs in without a credential and ignores the credential section', async () => {
    const outcome = await addServerCore(
      deps(admin, { localShellVisible: true }),
      form({
        'host.kind': 'local',
        'host.name': 'this box',
        'host.hostname': '',
        'credential.mode': 'password',
        'credential.password': 'ignored',
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(api.created).toEqual([]);
    expect(outcome.created).toMatchObject({ kind: 'local', address: null, credential: null });
    expect(listProfiles(t.rt.db, admin, outcome.created.hostId)[0]?.credentialId).toBeNull();
  });

  it('is refused unless an admin turned it on and the user is an admin', async () => {
    for (const [userId, visible] of [
      [alice, true],
      [admin, false],
    ] as const) {
      const outcome = await addServerCore(
        deps(userId, { localShellVisible: visible }),
        form({ 'host.kind': 'local', 'host.name': 'nope' }),
      );
      expect(outcome).toMatchObject({
        ok: false,
        fields: { 'host.kind': { scope: 'host', key: 'kindLocal' } },
      });
    }
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
    (globalThis as { __termdockInternalApi?: unknown }).__termdockInternalApi = fake;
  });
  afterAll(() => {
    delete (globalThis as { __termdockInternalApi?: unknown }).__termdockInternalApi;
  });

  it('localizes field errors in the catalog of the section that owns the rule', async () => {
    const { addServer } = await import('../lib/actions/add-server.ts');
    const state = await addServer(
      {},
      form({ 'host.port': '0', 'profile.username': 'two words', 'credential.mode': 'saved' }),
    );
    expect(state.fields).toEqual({
      'host.port': 'hosts.error.port',
      'profile.username': 'hosts.profile.error.username',
      'credential.id': 'hosts.addServer.error.credentialRequired',
    });
    expect(state.created).toBeUndefined();
  });

  it('returns what it created and refreshes the pages that list it', async () => {
    const { addServer } = await import('../lib/actions/add-server.ts');
    const state = await addServer({}, form({ 'host.name': 'via-action' }));
    expect(state.created?.hostName).toBe('via-action');
    expect(next.revalidated).toEqual(['/hosts', '/credentials', '/workspace']);
    expect(listProfilesForUser(t.rt.db, alice).some((p) => p.hostName === 'via-action')).toBe(true);
  });

  it('starts a 120×32 session from the new profile and opens it in the workspace', async () => {
    const { startAddedServerSession } = await import('../lib/actions/add-server.ts');
    const data = new FormData();
    data.set('profileId', 'profile-1');
    await expect(startAddedServerSession({}, data)).rejects.toMatchObject({
      url: '/workspace?open=sess-1',
    });
    expect(sessions).toEqual([
      { actingUserId: alice, profileId: 'profile-1', viewport: { cols: 120, rows: 32 } },
    ]);
  });
});
