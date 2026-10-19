// T1: the file panel (plan §5.12) through the real daemon (SQLite stores, vault, internal API, WS)
// against an unprotected server (no-tmux) and a tmux-protected one (tmux-3.4): the SFTP channel on
// the session's own connection, the requests over the WebSocket, the audit rows in SQLite.
// Precondition: docker compose -f test/sshd/compose.yaml up -d --build
import {
  type FileEntry,
  type FileRequest,
  parseServerMessage,
  type ServerMessage,
} from '@termdock/protocol';
import { ErrorCode, randomToken } from '@termdock/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FILE_SETTINGS_CACHE_MS } from '../../src/files/settings.ts';
import type { Daemon } from '../../src/main.ts';
import {
  SETTING_FILE_AUDIT_ENABLED,
  SETTING_FILE_TRANSFER_ENABLED,
} from '../../src/store/settings.ts';
import type { SshTransport } from '../../src/transport/ssh/index.ts';
import { DaemonFixture, shows } from '../daemon/harness.ts';
import { until } from '../runtime/fakes.ts';
import {
  HOST_KEY,
  requireSshd,
  runExec,
  SSHD_PORTS,
  type SshdImage,
  sshdTransport,
  TEST_USER,
  USER_KEY,
} from '../ssh/sshd.ts';
import { insertAuthSession, insertServer, insertUser } from '../store/fixture.ts';
import type { TestClient } from '../ws/client.ts';

const IMAGES: SshdImage[] = ['no-tmux', 'tmux-3.4'];
const PROMPT = /\$ ?$/m;
type FilesResult = Extract<ServerMessage, { type: 'files.result' }>;

describe.each(IMAGES)('file panel through the daemon (%s)', (image) => {
  let fixture: DaemonFixture;
  let daemon: Daemon;
  let userId: string;
  let sessionId: string;
  let client: TestClient;
  /** A connection of the test's own, to prepare and check the files on the server. */
  let shell: SshTransport;
  const dir = `/tmp/td-files-${randomToken(8)}`;
  let requests = 0;

  const setSetting = (key: string, value: boolean): void => {
    daemon.db.$client
      .prepare(
        `INSERT INTO instance_settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(key, JSON.stringify(value), Date.now());
  };

  /** One request, answered by exactly one `files.result` that the protocol schema accepts. */
  const send = async (request: FileRequest): Promise<FilesResult> => {
    const requestId = `req-${++requests}`;
    client.send({ type: 'files.request', requestId, sessionId, request });
    const answer = await client.next(
      (m): m is FilesResult => m.type === 'files.result' && m.requestId === requestId,
      30_000,
    );
    expect(parseServerMessage(JSON.stringify(answer))).toEqual(answer);
    expect((answer.result === undefined) !== (answer.error === undefined)).toBe(true);
    return answer;
  };
  const ok = async <Op extends FileRequest['op']>(request: FileRequest & { op: Op }) => {
    const answer = await send(request);
    expect(answer.error).toBeUndefined();
    return answer.result as Extract<NonNullable<FilesResult['result']>, { op: Op }>;
  };
  const errorCode = async (request: FileRequest): Promise<string | undefined> =>
    (await send(request)).error?.code;
  const remote = async (command: string): Promise<string> => {
    const result = await runExec(shell, command);
    return result.stdout.trim();
  };

  beforeAll(async () => {
    await requireSshd([image]);
    fixture = new DaemonFixture();
    daemon = await fixture.boot();
    const { db } = daemon;
    userId = insertUser(db);
    const { credentialId } = await daemon.credentials.create({
      actingUserId: userId,
      kind: 'private_key',
      name: 'test key',
      privateKey: USER_KEY,
    });
    const serverId = insertServer(db, userId, {
      name: image,
      port: SSHD_PORTS[image],
      username: TEST_USER,
      credentialId,
    });
    const trusted = await fixture.api(daemon, 'POST', `/servers/${serverId}/trust-key`, {
      actingUserId: userId,
      keyType: HOST_KEY.type,
      fingerprint: HOST_KEY.fingerprint,
    });
    expect(trusted.status).toBe(204);
    setSetting(SETTING_FILE_AUDIT_ENABLED, true);
    const asid = insertAuthSession(db, userId, Date.now() + 3_600_000);
    const created = await fixture.api(daemon, 'POST', '/sessions', {
      actingUserId: userId,
      serverId,
      viewport: { cols: 100, rows: 30 },
    });
    expect(created.status).toBe(201);
    sessionId = created.json?.sessionId as string;
    await until(() => daemon.plane.registry.host(sessionId)?.state === 'ready', 30_000);
    client = await fixture.attach(daemon, userId, asid, sessionId);

    shell = sshdTransport(image);
    await shell.connect(AbortSignal.timeout(15_000));
    await remote(
      [
        `mkdir -p ${dir}/tree/sub ${dir}/outside/deep`,
        `printf keep > ${dir}/outside/keep.txt`,
        `printf deep > ${dir}/outside/deep/keep2.txt`,
        `printf ab > ${dir}/tree/a.txt`,
        `printf h > ${dir}/tree/.hidden`,
        `ln -s a.txt ${dir}/tree/link-to-a`,
        `ln -s /nowhere ${dir}/tree/dangling`,
        `ln -s ${dir}/outside ${dir}/tree/sub/escape`,
      ].join(' && '),
    );
  });

  afterAll(async () => {
    // A protected session's tmux outlives the daemon: end it even when a test failed early.
    if (daemon && sessionId && daemon.plane.registry.host(sessionId)?.state !== 'ended') {
      await fixture.api(daemon, 'POST', `/sessions/${sessionId}/terminate`, {
        actingUserId: userId,
      });
    }
    if (shell) {
      await remote(`rm -rf ${dir}`).catch(() => {});
      await shell.close();
    }
    await fixture?.cleanup();
  });

  it("opens at the user's home, and at the terminal's folder when tmux protects the session", async () => {
    const opened = await ok({ op: 'open' });
    expect(opened.home).toBe(`/home/${TEST_USER}`);
    const protection = daemon.plane.registry.host(sessionId)?.protection;
    if (image === 'no-tmux') {
      expect(protection).toBe('none');
      expect(opened.cwd).toBeNull();
      return;
    }
    expect(protection).toBe('tmux-control');
    expect(opened.cwd).toBe(`/home/${TEST_USER}`);
    await shows(client, PROMPT);
    client.input(1, 'cd /tmp\r');
    let cwd: string | null = null;
    const deadline = Date.now() + 15_000;
    while (cwd !== '/tmp' && Date.now() < deadline) {
      cwd = (await ok({ op: 'open' })).cwd;
      if (cwd !== '/tmp') await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(cwd).toBe('/tmp');
  });

  it('lists the lstat view with links resolved, hidden files included', async () => {
    const listing = await ok({ op: 'list', path: `${dir}/tree/` });
    expect(listing.path).toBe(`${dir}/tree`);
    expect(listing.truncated).toBe(false);
    const byName = new Map<string, FileEntry>(listing.entries.map((e) => [e.name, e]));
    expect([...byName.keys()].sort()).toEqual(['.hidden', 'a.txt', 'dangling', 'link-to-a', 'sub']);
    expect(byName.get('a.txt')).toMatchObject({ type: 'file', size: 2 });
    expect(byName.get('.hidden')).toMatchObject({ type: 'file', size: 1 });
    expect(byName.get('sub')).toMatchObject({ type: 'dir' });
    expect(byName.get('link-to-a')).toMatchObject({
      type: 'link',
      target: 'file',
      linkTo: 'a.txt',
      size: 2,
    });
    expect(byName.get('dangling')).toMatchObject({
      type: 'link',
      target: null,
      linkTo: '/nowhere',
    });
    const mtime = byName.get('a.txt')!.mtime;
    expect(Math.abs(mtime - Date.now())).toBeLessThan(10 * 60_000);
    expect(byName.get('a.txt')!.mode & 0o600).toBe(0o600);

    // Through a link to a folder: the canonical path of its target.
    const through = await ok({ op: 'list', path: `${dir}/tree/sub/escape` });
    expect(through.path).toBe(`${dir}/outside`);
    expect(through.entries.map((e) => e.name).sort()).toEqual(['deep', 'keep.txt']);
    expect(await errorCode({ op: 'list', path: `${dir}/missing` })).toBe(ErrorCode.NotFound);
  });

  it('creates folders and renames, never over an existing name', async () => {
    expect(await ok({ op: 'mkdir', path: `${dir}/tree/new` })).toMatchObject({
      entry: { name: 'new', type: 'dir' },
    });
    expect(await errorCode({ op: 'mkdir', path: `${dir}/tree/new` })).toBe(ErrorCode.Conflict);
    expect(await errorCode({ op: 'mkdir', path: `${dir}/tree/..` })).toBe(ErrorCode.NameInvalid);
    expect(
      await ok({ op: 'rename', from: `${dir}/tree/a.txt`, to: `${dir}/tree/new/b.txt` }),
    ).toMatchObject({ entry: { name: 'b.txt', type: 'file', size: 2 } });
    expect(
      await errorCode({ op: 'rename', from: `${dir}/tree/.hidden`, to: `${dir}/tree/new/b.txt` }),
    ).toBe(ErrorCode.Conflict);
    expect(await remote(`cat ${dir}/tree/new/b.txt; cat ${dir}/tree/.hidden`)).toBe('abh');
  });

  it('removes a folder tree without following its link to a folder outside it', async () => {
    const removed = await ok({ op: 'remove', paths: [`${dir}/tree`] });
    // .hidden, link-to-a, dangling, sub/escape, sub, new/b.txt, new, tree
    expect(removed.removed).toBe(8);
    expect(await remote(`test -e ${dir}/tree && echo present || echo gone`)).toBe('gone');
    expect(await remote(`cat ${dir}/outside/keep.txt ${dir}/outside/deep/keep2.txt`)).toBe(
      'keepdeep',
    );
  });

  it('wrote the audit rows with the client address', async () => {
    await daemon.writer.flush();
    const rows = daemon.db.$client
      .prepare(
        `SELECT type, actor_user_id, target_type, target_id, detail_json, ip
         FROM audit_events WHERE type LIKE 'file.%' ORDER BY rowid`,
      )
      .all() as Array<Record<string, unknown>>;
    const serverId = rows[0]?.detail_json
      ? JSON.parse(rows[0].detail_json as string).serverId
      : null;
    expect(typeof serverId).toBe('string');
    const base = {
      actor_user_id: userId,
      target_type: 'session',
      target_id: sessionId,
      ip: '127.0.0.1',
    };
    expect(rows).toEqual([
      {
        ...base,
        type: 'file.mkdir',
        detail_json: JSON.stringify({ serverId, path: `${dir}/tree/new` }),
      },
      {
        ...base,
        type: 'file.rename',
        detail_json: JSON.stringify({
          serverId,
          from: `${dir}/tree/a.txt`,
          to: `${dir}/tree/new/b.txt`,
        }),
      },
      {
        ...base,
        type: 'file.remove',
        detail_json: JSON.stringify({ serverId, paths: [`${dir}/tree`], removed: 8 }),
      },
    ]);
  });

  it('answers FILES_DISABLED once transfer is turned off, and SESSION_NOT_CONNECTED once ended', async () => {
    setSetting(SETTING_FILE_TRANSFER_ENABLED, false);
    await new Promise((resolve) => setTimeout(resolve, FILE_SETTINGS_CACHE_MS + 100));
    expect(await errorCode({ op: 'open' })).toBe(ErrorCode.FilesDisabled);
    setSetting(SETTING_FILE_TRANSFER_ENABLED, true);
    await new Promise((resolve) => setTimeout(resolve, FILE_SETTINGS_CACHE_MS + 100));
    const terminated = await fixture.api(daemon, 'POST', `/sessions/${sessionId}/terminate`, {
      actingUserId: userId,
    });
    expect(terminated.status).toBe(204);
    await until(() => daemon.plane.registry.host(sessionId)?.state === 'ended', 15_000);
    expect(await errorCode({ op: 'open' })).toBe(ErrorCode.SessionNotConnected);
  });
});
