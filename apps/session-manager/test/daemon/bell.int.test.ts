// T1: a session's bell relayed to its owner (`session.bell`) through the real daemon, for an
// unprotected session (no-tmux image) and a tmux-protected one (the core tmux images; the bell
// then crosses tmux control mode as `%output`). Connections that are not attached to the session
// get it too: browsers mount only the panes of their active tab.
// Precondition: docker compose -f test/sshd/compose.yaml up -d --build
import type { ServerMessage } from '@termavox/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Daemon } from '../../src/main.ts';
import { until } from '../runtime/fakes.ts';
import {
  HOST_KEY,
  requireSshd,
  SSHD_PORTS,
  type SshdImage,
  TEST_USER,
  USER_KEY,
} from '../ssh/sshd.ts';
import { insertAuthSession, insertServer, insertUser } from '../store/fixture.ts';
import { selectedImages } from '../tmux/driver-harness.ts';
import type { TestClient } from '../ws/client.ts';
import { DaemonFixture, shows, VIEWPORT } from './harness.ts';

const PROMPT = /\$ ?$/m;
const CASES: Array<{ image: SshdImage; protection: 'none' | 'tmux-control' }> = [
  { image: 'no-tmux', protection: 'none' },
  ...selectedImages(['tmux-3.2a', 'tmux-edge']).map((image) => ({
    image,
    protection: 'tmux-control' as const,
  })),
];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const isBell =
  (sessionId: string) =>
  (m: ServerMessage): boolean =>
    m.type === 'session.bell' && m.sessionId === sessionId;

describe.each(CASES)(
  'the bell relayed to the owner ($image, $protection)',
  ({ image, protection }) => {
    let fixture: DaemonFixture;
    let daemon: Daemon;
    let userId: string;
    let sessionId: string;
    /** Attached on channel 1: types the commands and sees `terminal.bell`. */
    let attached: TestClient;
    /** Another connection of the owner, attached to nothing (a session in a background tab). */
    let watcher: TestClient;
    /** A connection of another user. */
    let stranger: TestClient;

    /** Prints BEL once; resolves when the attachment heard it (the daemon's emulator rang). */
    const ring = async (word: string): Promise<void> => {
      const mark = attached.messages.length;
      attached.input(1, `printf 'ding-%s\\a\\n' ${word}\r`);
      await shows(attached, new RegExp(`^ding-${word}$`, 'm'));
      await attached.next(
        (m) => m.type === 'terminal.bell' && attached.messages.indexOf(m) >= mark,
        10_000,
      );
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
        fingerprint: HOST_KEY.fingerprint.slice('SHA256:'.length),
      });
      expect(trusted.status).toBe(204);
      const asid = insertAuthSession(db, userId, Date.now() + 3_600_000);
      const created = await fixture.api(daemon, 'POST', '/sessions', {
        actingUserId: userId,
        serverId,
        viewport: VIEWPORT,
      });
      expect(created.status).toBe(201);
      sessionId = created.json?.sessionId as string;
      await until(() => daemon.plane.registry.host(sessionId)?.state === 'ready', 20_000);
      expect(daemon.plane.registry.host(sessionId)?.protection).toBe(protection);

      attached = await fixture.attach(daemon, userId, asid, sessionId);
      await shows(attached, PROMPT);
      watcher = await fixture.connect(daemon, userId, asid);
      const other = insertUser(db);
      stranger = await fixture.connect(
        daemon,
        other,
        insertAuthSession(db, other, Date.now() + 3_600_000),
      );
    });

    afterAll(async () => {
      // A protected session's tmux outlives the daemon: end it on the server.
      if (daemon && sessionId) {
        await fixture
          .api(daemon, 'POST', `/sessions/${sessionId}/terminate`, { actingUserId: userId })
          .catch(() => {});
      }
      await fixture?.cleanup();
    });

    it('every connection of the owner gets session.bell, attached or not, notifications off', async () => {
      expect(daemon.plane.registry.host(sessionId)?.notify).toBe(false);
      await ring('relay');
      // The title is whatever the server's shell set (none under tmux, `user@host: dir` from
      // Ubuntu's .bashrc without it).
      const bell = (await watcher.next(isBell(sessionId), 10_000)) as { title?: unknown };
      expect(bell).toMatchObject({ type: 'session.bell', sessionId });
      expect(bell.title === null || typeof bell.title === 'string').toBe(true);
      await attached.next(isBell(sessionId), 10_000);
      await sleep(300);
      expect(stranger.messages.some(isBell(sessionId))).toBe(false);
      expect(watcher.messages.filter(isBell(sessionId))).toHaveLength(1);
    });
  },
);
