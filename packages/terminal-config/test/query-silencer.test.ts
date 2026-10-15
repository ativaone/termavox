import headless, { type ITerminalOptions, type Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { installQuerySilencer, sharedTerminalOptions } from '../src/index.ts';

const ESC = '\x1b';
const ST = `${ESC}\\`;

/** Report-type window ops are disabled by default in xterm; enable them so the silencer is hit. */
const windowOptions: ITerminalOptions['windowOptions'] = {
  getWinState: true,
  getWinPosition: true,
  getWinSizePixels: true,
  getScreenSizePixels: true,
  getCellSizePixels: true,
  getWinSizeChars: true,
  getScreenSizeChars: true,
  getIconTitle: true,
  getWinTitle: true,
  pushTitle: true,
  popTitle: true,
  setWinSizeChars: true,
};

type Kind =
  | { csi: { prefix?: string; intermediates?: string; final: string } }
  | { dcs: { intermediates?: string; final: string } }
  | { osc: number };

function terminal(silenced: boolean, spyOn: Kind) {
  const term: Terminal = new headless.Terminal({
    ...sharedTerminalOptions,
    cols: 20,
    rows: 5,
    windowOptions,
  });
  const replies: string[] = [];
  term.onData((d) => replies.push(d));
  term.onBinary((d) => replies.push(d));
  // Registered before the silencer, so it only runs if the silencer let the sequence through.
  let reachedDefault = false;
  const spy = () => {
    reachedDefault = true;
    return false;
  };
  if ('csi' in spyOn) term.parser.registerCsiHandler(spyOn.csi, spy);
  else if ('dcs' in spyOn) term.parser.registerDcsHandler(spyOn.dcs, spy);
  else term.parser.registerOscHandler(spyOn.osc, spy);
  if (silenced) installQuerySilencer(term);
  const titles: string[] = [];
  term.onTitleChange((t) => titles.push(t));
  const write = (s: string) => new Promise<void>((r) => term.write(s, r));
  return { write, replies, titles, passedThrough: () => reachedDefault };
}

/** [name, sequence, handler identity, exact xterm 6 reply without the silencer (null = none)]. */
const QUERIES: [string, string, Kind, string | null][] = [
  ['DA1', `${ESC}[c`, { csi: { final: 'c' } }, `${ESC}[?1;2c`],
  ['DA1 (Ps=0)', `${ESC}[0c`, { csi: { final: 'c' } }, `${ESC}[?1;2c`],
  ['DA2', `${ESC}[>c`, { csi: { prefix: '>', final: 'c' } }, `${ESC}[>0;276;0c`],
  ['DA3', `${ESC}[=c`, { csi: { prefix: '=', final: 'c' } }, null],
  ['DSR status', `${ESC}[5n`, { csi: { final: 'n' } }, `${ESC}[0n`],
  ['DSR CPR', `${ESC}[6n`, { csi: { final: 'n' } }, `${ESC}[1;1R`],
  ['DEC DSR CPR', `${ESC}[?6n`, { csi: { prefix: '?', final: 'n' } }, `${ESC}[?1;1R`],
  ['DEC DSR color scheme', `${ESC}[?996n`, { csi: { prefix: '?', final: 'n' } }, null],
  ['DECRQM ANSI', `${ESC}[4$p`, { csi: { intermediates: '$', final: 'p' } }, `${ESC}[4;2$y`],
  [
    'DECRQM DEC',
    `${ESC}[?25$p`,
    { csi: { prefix: '?', intermediates: '$', final: 'p' } },
    `${ESC}[?25;1$y`,
  ],
  ['XTVERSION', `${ESC}[>0q`, { csi: { prefix: '>', final: 'q' } }, null],
  ['kitty keyboard query', `${ESC}[?u`, { csi: { prefix: '?', final: 'u' } }, null],
  ['window: state', `${ESC}[11t`, { csi: { final: 't' } }, null],
  ['window: position', `${ESC}[13t`, { csi: { final: 't' } }, null],
  ['window: size px', `${ESC}[14t`, { csi: { final: 't' } }, null],
  ['window: screen px', `${ESC}[15t`, { csi: { final: 't' } }, null],
  ['window: cell px', `${ESC}[16t`, { csi: { final: 't' } }, null],
  ['window: size chars', `${ESC}[18t`, { csi: { final: 't' } }, `${ESC}[8;5;20t`],
  ['window: screen chars', `${ESC}[19t`, { csi: { final: 't' } }, null],
  ['window: icon label', `${ESC}[20t`, { csi: { final: 't' } }, null],
  ['window: title', `${ESC}[21t`, { csi: { final: 't' } }, null],
  [
    'DECRQSS SGR',
    `${ESC}P$qm${ST}`,
    { dcs: { intermediates: '$', final: 'q' } },
    `${ESC}P1$r0m${ST}`,
  ],
  [
    'DECRQSS DECSTBM',
    `${ESC}P$qr${ST}`,
    { dcs: { intermediates: '$', final: 'q' } },
    `${ESC}P1$r1;5r${ST}`,
  ],
  [
    'DECRQSS DECSCUSR',
    `${ESC}P$q q${ST}`,
    { dcs: { intermediates: '$', final: 'q' } },
    `${ESC}P1$r2 q${ST}`,
  ],
  ['XTGETTCAP', `${ESC}P+q544e${ST}`, { dcs: { intermediates: '+', final: 'q' } }, null],
  ['OSC 4 color query', `${ESC}]4;1;?\x07`, { osc: 4 }, null],
  ['OSC 10 foreground query', `${ESC}]10;?\x07`, { osc: 10 }, null],
  ['OSC 11 background query', `${ESC}]11;?${ST}`, { osc: 11 }, null],
  ['OSC 12 cursor color query', `${ESC}]12;?\x07`, { osc: 12 }, null],
  ['OSC 52 clipboard query', `${ESC}]52;c;?\x07`, { osc: 52 }, null],
];

describe('installQuerySilencer coverage (xterm 6, ADR-0001)', () => {
  it.each(QUERIES)(
    '%s: one reply without the silencer, none with it',
    async (_n, seq, kind, reply) => {
      const plain = terminal(false, kind);
      await plain.write(seq);
      expect(plain.replies).toEqual(reply === null ? [] : [reply]);

      const silenced = terminal(true, kind);
      await silenced.write(seq);
      expect(silenced.replies).toEqual([]);
      expect(silenced.passedThrough(), 'consumed by the silencer').toBe(false);
    },
  );

  it.each([
    ['window resize request (CSI 8;r;c t)', `${ESC}[8;10;40t`, { csi: { final: 't' } }],
    ['window op without report (CSI 22;0 t)', `${ESC}[22;0t`, { csi: { final: 't' } }],
    ['OSC 4 color set', `${ESC}]4;1;rgb:10/20/30\x07`, { osc: 4 }],
    ['OSC 10 foreground set', `${ESC}]10;rgb:10/20/30\x07`, { osc: 10 }],
    ['OSC 11 background set', `${ESC}]11;#102030${ST}`, { osc: 11 }],
    ['OSC 52 clipboard set', `${ESC}]52;c;aGVsbG8=\x07`, { osc: 52 }],
  ] as [string, string, Kind][])('%s is not swallowed', async (_n, seq, kind) => {
    const silenced = terminal(true, kind);
    await silenced.write(seq);
    expect(silenced.passedThrough()).toBe(true);
    expect(silenced.replies).toEqual([]);
  });

  it('keeps title push/pop working', async () => {
    const silenced = terminal(true, { csi: { final: 't' } });
    await silenced.write(`${ESC}]2;one\x07${ESC}[22;0t${ESC}]2;two\x07${ESC}[23;0t`);
    expect(silenced.titles).toEqual(['one', 'two', 'one']);
  });

  it('swallows an OSC that mixes a color set with a query (known limitation)', async () => {
    const silenced = terminal(true, { osc: 4 });
    await silenced.write(`${ESC}]4;1;rgb:10/20/30;2;?\x07`);
    expect(silenced.passedThrough()).toBe(false);
  });
});
