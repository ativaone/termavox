import type { ServerMessage } from '@termavox/protocol';
import { describe, expect, it } from 'vitest';
import type { DriverContext } from '../../src/core/types.ts';
import { FakeAttachment, fakeTmuxDrivers, harness, TMUX_PROBE, until } from './fakes.ts';

const VIEW = { cols: 80, rows: 24 };

function hints(attachment: FakeAttachment): Array<string | null> {
  return attachment.client.messages
    .filter(
      (m): m is Extract<ServerMessage, { type: 'terminal.hint' }> => m.type === 'terminal.hint',
    )
    .map((m) => m.hint);
}

/** Everything sent so far applied (the first snapshot is gzipped asynchronously). */
async function settled(attachment: FakeAttachment): Promise<void> {
  await until(() => attachment.client.snapshots.length > 0);
  await attachment.client.settle();
}

describe('the nested tmux tip (plan D-33)', () => {
  it('follows the foreground command, reaches late attachments and clears when the shell is lost', async () => {
    const contexts: DriverContext[] = [];
    const h = harness({
      behavior: () => ({ probe: TMUX_PROBE }),
      drivers: fakeTmuxDrivers(async (ctx) => {
        contexts.push(ctx);
      }),
    });
    const rt = h.runtime();
    await rt.start();
    expect(rt.state).toBe('ready');
    const ctx = contexts[0]!;
    const first = new FakeAttachment('a1');
    rt.attach(first, VIEW);

    ctx.foreground?.('bash'); // nothing to clear
    ctx.foreground?.('tmux');
    ctx.foreground?.('tmux'); // unchanged: no second message
    await settled(first);
    expect(hints(first)).toEqual(['nested_tmux']);

    // A pane that attaches later gets the tip with its attach.
    const late = new FakeAttachment('a2');
    rt.attach(late, VIEW);
    await settled(late);
    expect(hints(late)).toEqual(['nested_tmux']);

    ctx.foreground?.('bash');
    await settled(first);
    expect(hints(first)).toEqual(['nested_tmux', null]);

    // Leaving `ready` clears it; the lost attempt's context no longer counts.
    ctx.foreground?.('tmux');
    h.factory.last.lose();
    await until(() => rt.state !== 'ready');
    await settled(first);
    expect(hints(first)).toEqual(['nested_tmux', null, 'nested_tmux', null]);
    await until(() => rt.state === 'ready');
    ctx.foreground?.('tmux');
    await settled(first);
    expect(hints(first).at(-1)).toBeNull();
    contexts.at(-1)?.foreground?.('tmux');
    await settled(first);
    expect(hints(first).at(-1)).toBe('nested_tmux');
    await rt.shutdown();
  });
});
