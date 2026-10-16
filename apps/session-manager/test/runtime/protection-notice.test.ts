import { ProtectionNotice } from '@termdock/protocol';
import { describe, expect, it } from 'vitest';
import { createDriverFactory } from '../../src/core/driver-factory.ts';
import { fakeTmuxDrivers, harness, TMUX_PROBE } from './fakes.ts';

const SID = 'session-1';
const noopTmux = () => fakeTmuxDrivers(async () => {});

async function protectionEvent(options: Parameters<typeof harness>[0]) {
  const h = harness(options);
  const rt = h.runtime();
  await rt.start();
  await rt.shutdown();
  const events = h.store.events.filter(
    (e) =>
      e.sessionId === SID && (e.type === 'protection_selected' || e.type === 'protection_degraded'),
  );
  expect(events).toHaveLength(1);
  return events[0]!;
}

describe('protection notices carry a stable noticeCode next to the English notice', () => {
  it('tmux missing on the host (protection_selected)', async () => {
    const event = await protectionEvent({ drivers: noopTmux() });
    expect(event).toMatchObject({
      type: 'protection_selected',
      detail: {
        protection: 'none',
        notice: 'tmux not found on the host: session not protected',
        noticeCode: 'tmux_missing',
      },
    });
    expect(ProtectionNotice.safeParse(event.detail?.noticeCode).success).toBe(true);
  });

  it('tmux older than 3.2, and no UTF-8 locale', async () => {
    const old = await protectionEvent({
      behavior: () => ({ probe: TMUX_PROBE.replace('tmux 3.4', 'tmux 3.0a') }),
      drivers: noopTmux(),
    });
    expect(old.detail).toMatchObject({ protection: 'none', noticeCode: 'tmux_too_old' });
    expect(old.detail?.notice).toMatch(/^tmux too old \(tmux 3\.0a\)/);

    const noLocale = await protectionEvent({
      behavior: () => ({ probe: TMUX_PROBE.replace('utf8_locale=C.UTF-8\n', '') }),
      drivers: noopTmux(),
    });
    expect(noLocale.detail).toMatchObject({
      protection: 'none',
      notice: 'no UTF-8 locale on the host: session not protected',
      noticeCode: 'no_utf8',
    });
  });

  it('tmux-control driver not wired', async () => {
    const event = await protectionEvent({
      behavior: () => ({ probe: TMUX_PROBE }),
      drivers: createDriverFactory(),
    });
    expect(event.detail).toMatchObject({
      protection: 'none',
      notice: 'tmux control mode is not available: session not protected',
      noticeCode: 'control_unavailable',
    });
  });

  it('a protected session whose host lost tmux (protection_degraded)', async () => {
    const event = await protectionEvent({
      record: { protection: 'tmux-control', lastReadyAt: 1 },
      drivers: noopTmux(),
    });
    expect(event).toMatchObject({
      type: 'protection_degraded',
      detail: { from: 'tmux-control', noticeCode: 'tmux_missing' },
    });
  });

  it('a protected choice and protection off carry no notice at all', async () => {
    const chosen = await protectionEvent({
      behavior: () => ({ probe: TMUX_PROBE }),
      drivers: noopTmux(),
    });
    expect(chosen.detail).toEqual({ protection: 'tmux-control' });

    const off = await protectionEvent({
      record: {
        policies: {
          protectionMode: 'off',
          startupCommand: null,
          env: {},
          keepaliveIntervalS: 15,
          autoReopen: true,
        },
      },
      behavior: () => ({ probe: TMUX_PROBE }),
      drivers: noopTmux(),
    });
    expect(off.detail).toEqual({ protection: 'none' });
  });
});
