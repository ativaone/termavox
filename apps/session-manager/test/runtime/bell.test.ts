import type { ServerMessage } from '@termavox/protocol';
import { describe, expect, it } from 'vitest';
import { BELL_RELAY_INTERVAL_MS } from '../../src/core/session-runtime.ts';
import { encode, FakeAttachment, harness, until } from './fakes.ts';

/** `terminal.bell` messages an attachment received (control frames are JSON). */
function terminalBells(attachment: FakeAttachment): number {
  return attachment.frames.filter(
    (f) =>
      f[0] === 0x7b &&
      (JSON.parse(Buffer.from(f).toString()) as { type: string }).type === 'terminal.bell',
  ).length;
}

describe('the bell relayed to the owner (session.bell)', () => {
  it('goes to every connection of the owner, at most once a second', async () => {
    let now = 1_000_000;
    const h = harness();
    const rt = h.runtime({ now: () => now });
    await rt.start();
    const pty = h.factory.last.pty;
    const a = new FakeAttachment('a');
    rt.attach(a, { cols: 80, rows: 24 });
    const relayed = () =>
      h.notifier.messages.filter(
        (m): m is { userId: string; message: Extract<ServerMessage, { type: 'session.bell' }> } =>
          m.message.type === 'session.bell',
      );
    const ring = async (n: number) => {
      pty.stdout.push(encode(`ding\x07\r\n`));
      await until(() => terminalBells(a) === n);
    };

    // A title ended with BEL is no bell; the bell that follows carries that title.
    pty.stdout.push(encode('\x1b]0;\u2733 Claude Code\x07'));
    await ring(1);
    expect(relayed()).toEqual([
      {
        userId: 'user-1',
        message: { type: 'session.bell', sessionId: 'session-1', title: '\u2733 Claude Code' },
      },
    ]);
    // Within the second: the attachment still hears every bell, the owner's channel only one.
    await ring(2);
    now += BELL_RELAY_INTERVAL_MS - 1;
    await ring(3);
    expect(relayed()).toHaveLength(1);
    now += 1;
    await ring(4);
    expect(relayed()).toHaveLength(2);
    expect(relayed().every((m) => m.userId === 'user-1')).toBe(true);
    await rt.shutdown();
  });

  it('does not depend on the desktop notifications flag (the browser decides what to show)', async () => {
    let now = 1_000_000;
    const h = harness();
    const rt = h.runtime({ now: () => now });
    await rt.start();
    const pty = h.factory.last.pty;
    const a = new FakeAttachment('a');
    rt.attach(a, { cols: 80, rows: 24 });
    const relayed = () => h.notifier.messages.filter((m) => m.message.type === 'session.bell');
    let rung = 0;
    const ring = async () => {
      const n = ++rung;
      pty.stdout.push(encode('\x07'));
      await until(() => terminalBells(a) === n);
    };

    await ring();
    expect(relayed()).toHaveLength(1);
    rt.setDisplay({ notify: true });
    now += BELL_RELAY_INTERVAL_MS;
    await ring();
    expect(relayed()).toHaveLength(2);
    rt.setDisplay({ notify: false });
    now += BELL_RELAY_INTERVAL_MS;
    await ring();
    expect(relayed()).toHaveLength(3);
    await rt.shutdown();
  });
});

describe('the title for a late attachment', () => {
  it('a view attached after the title was set gets the latest one (a background tab coming back)', async () => {
    const h = harness();
    const rt = h.runtime();
    await rt.start();
    const pty = h.factory.last.pty;
    const first = new FakeAttachment('first');
    rt.attach(first, { cols: 80, rows: 24 });
    pty.stdout.push(encode('\x1b]0;working\x07\x1b]2;\u2733 done\x07'));
    await until(() => titles(first).at(-1) === '\u2733 done');
    rt.detach('first');
    const later = new FakeAttachment('later');
    rt.attach(later, { cols: 80, rows: 24 });
    expect(titles(later)).toEqual(['\u2733 done']);
    await rt.shutdown();
  });
});

/** The `terminal.title` messages an attachment received, in order. */
function titles(attachment: FakeAttachment): string[] {
  return attachment.frames
    .filter((f) => f[0] === 0x7b)
    .map((f) => JSON.parse(Buffer.from(f).toString()) as { type: string; title?: string })
    .filter((m) => m.type === 'terminal.title')
    .map((m) => m.title ?? '');
}
