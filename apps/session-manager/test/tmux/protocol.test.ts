import { describe, expect, it } from 'vitest';
import {
  BLOCK_LINE_OVERHEAD,
  CommandCorrelator,
  type ControlEvent,
  ControlParser,
  DEFAULT_MAX_BLOCK_BYTES,
  DEFAULT_MAX_UNSOLICITED_BLOCK_BYTES,
  encodeInput,
  LineSplitter,
  singlePaneLayout,
  TmuxDesyncError,
  unescapeOutput,
} from '../../src/drivers/tmux-control/index.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

function parseAll(text: string | Uint8Array): ControlEvent[] {
  const parser = new ControlParser();
  const splitter = new LineSplitter();
  const events: ControlEvent[] = [];
  for (const line of splitter.push(typeof text === 'string' ? enc(text) : text)) {
    const event = parser.push(line);
    if (event) events.push(event);
  }
  return events;
}

describe('LineSplitter', () => {
  it('splits at the byte level across arbitrary chunk boundaries', () => {
    // é = c3 a9, split between its two bytes and across the newline.
    const input = enc('%output %0 café\n%exit\n');
    for (let size = 1; size <= input.byteLength; size++) {
      const splitter = new LineSplitter();
      const lines: string[] = [];
      for (let i = 0; i < input.byteLength; i += size) {
        for (const line of splitter.push(input.slice(i, i + size))) lines.push(dec(line));
      }
      expect(lines).toEqual(['%output %0 café', '%exit']);
      expect(splitter.end()).toBeNull();
    }
  });

  it('keeps CR and empty lines and reports a truncated last line', () => {
    const splitter = new LineSplitter();
    expect(splitter.push(enc('a\r\n\nb')).map(dec)).toEqual(['a\r', '']);
    expect(dec(splitter.end()!)).toBe('b');
  });

  it('rejects absurdly long lines', () => {
    const splitter = new LineSplitter(8);
    expect(() => splitter.push(enc('0123456789'))).toThrow(RangeError);
  });
});

describe('unescapeOutput', () => {
  it('decodes exactly-3-digit octal escapes and keeps other bytes raw', () => {
    expect(unescapeOutput(enc('a\\033[1mb\\015\\012\\134x'))).toEqual(
      bytes(0x61, 0x1b, 0x5b, 0x31, 0x6d, 0x62, 0x0d, 0x0a, 0x5c, 0x78),
    );
    // Raw UTF-8 and DEL pass through untouched.
    expect(unescapeOutput(bytes(0xe4, 0xb8, 0xad, 0x7f))).toEqual(bytes(0xe4, 0xb8, 0xad, 0x7f));
  });

  it('keeps a backslash that is not followed by three octal digits', () => {
    expect(dec(unescapeOutput(enc('\\08 \\12 x\\')))).toBe('\\08 \\12 x\\');
    expect(unescapeOutput(enc('\\1234'))).toEqual(bytes(0x53, 0x34));
  });
});

describe('ControlParser', () => {
  it('parses output and extended output (payload after the first " : " following age)', () => {
    const [output, extended, future] = parseAll(
      '%output %12 hi \\033 : x\n%extended-output %3 250 : a : b\n%extended-output %3 7 new-field : z\n',
    );
    expect(output).toEqual({ type: 'output', paneId: 12, data: enc('hi \x1b : x') });
    expect(extended).toEqual({ type: 'extendedOutput', paneId: 3, ageMs: 250, data: enc('a : b') });
    expect(future).toEqual({ type: 'extendedOutput', paneId: 3, ageMs: 7, data: enc('z') });
  });

  it('treats every line inside a block as data until the guard with the same triple', () => {
    const events = parseAll(
      [
        '%begin 1700000000 42 1',
        '%end 1700000000 41 1',
        '%output %0 fake',
        '%begin 1700000000 43 1',
        '%error 1700000000 42 0',
        '',
        '%end 1700000000 42 1',
        '%exit',
        '',
      ].join('\n'),
    );
    expect(events.map((e) => e.type)).toEqual(['blockBegin', 'blockEnd', 'exit']);
    const end = events[1] as Extract<ControlEvent, { type: 'blockEnd' }>;
    expect(end.guard).toEqual({ time: 1700000000, num: 42, flags: 1, raw: '1700000000 42 1' });
    expect(end.lines.map(dec)).toEqual([
      '%end 1700000000 41 1',
      '%output %0 fake',
      '%begin 1700000000 43 1',
      '%error 1700000000 42 0',
      '',
    ]);
  });

  it('reports %error blocks', () => {
    const events = parseAll("%begin 1 2 1\ncan't find pane: %99\n%error 1 2 1\n");
    expect(events[1]).toMatchObject({ type: 'blockError', guard: { raw: '1 2 1' } });
  });

  it('parses the notifications the driver handles', () => {
    const events = parseAll(
      [
        '%exit',
        '%exit too far behind',
        '%pause %4',
        '%continue %4',
        '%layout-change @1 b25f,80x24,0,0,2 b25f,80x24,0,0,2 *',
        '%layout-change @1 b25f,80x24,0,0,2',
        '%session-changed $0 main session',
        '%window-add @2',
        '%window-close @2',
        '%window-renamed @0 vim é',
        '%window-pane-changed @0 %5',
        '%pane-mode-changed %5',
        '%client-detached client-107',
        '%config-error /dev/null:1: bad',
        '%message hello world',
        '%sessions-changed',
        'stray text',
        '',
      ].join('\n'),
    );
    expect(events).toEqual([
      { type: 'exit' },
      { type: 'exit', reason: 'too far behind' },
      { type: 'pause', paneId: 4 },
      { type: 'continue', paneId: 4 },
      {
        type: 'layoutChange',
        windowId: 1,
        layout: 'b25f,80x24,0,0,2',
        visibleLayout: 'b25f,80x24,0,0,2',
        windowFlags: '*',
      },
      { type: 'layoutChange', windowId: 1, layout: 'b25f,80x24,0,0,2' },
      { type: 'sessionChanged', sessionId: 0, name: 'main session' },
      { type: 'windowAdd', windowId: 2 },
      { type: 'windowClose', windowId: 2 },
      { type: 'windowRenamed', windowId: 0, name: 'vim é' },
      { type: 'windowPaneChanged', windowId: 0, paneId: 5 },
      { type: 'paneModeChanged', paneId: 5 },
      { type: 'clientDetached', client: 'client-107' },
      { type: 'configError', message: '/dev/null:1: bad' },
      { type: 'message', message: 'hello world' },
      { type: 'unknown', name: 'sessions-changed', text: '' },
      { type: 'unknown', name: '', text: 'stray text' },
    ]);
  });

  it('drops a reply block that grows past its cap: RangeError, none of its lines kept', () => {
    const parser = new ControlParser({ maxBlockBytes: 4096 });
    const line = new Uint8Array(100).fill(0x61);
    expect(parser.push(enc('%begin 1 2 1'))).toMatchObject({ type: 'blockBegin' });
    const fits = Math.floor(4096 / (100 + BLOCK_LINE_OVERHEAD));
    for (let i = 0; i < fits; i++) expect(parser.push(line)).toBeNull();
    expect(() => parser.push(line)).toThrow(RangeError);
    expect(parser.inBlock).toBe(false);
    // The dropped block's guard is now a stray line; a new block holds only its own lines.
    expect(parser.push(enc('%end 1 2 1'))).toMatchObject({ type: 'unknown', malformed: true });
    expect(parser.push(enc('%exit'))).toEqual({ type: 'exit' });
    parser.push(enc('%begin 1 3 1'));
    parser.push(line);
    expect(parser.push(enc('%end 1 3 1'))).toMatchObject({ type: 'blockEnd', lines: [line] });
  });

  it('counts every line, so a flood of empty lines is bounded too', () => {
    const parser = new ControlParser({ maxBlockBytes: 64 * 1024 });
    parser.push(enc('%begin 1 2 1'));
    let kept = 0;
    expect(() => {
      for (;;) {
        parser.push(new Uint8Array(0));
        kept++;
      }
    }).toThrow(RangeError);
    expect(kept).toBe((64 * 1024) / BLOCK_LINE_OVERHEAD);
  });

  it('caps unsolicited blocks (flags 0) much lower than replies to our commands', () => {
    const big = new Uint8Array(DEFAULT_MAX_UNSOLICITED_BLOCK_BYTES);
    const unsolicited = new ControlParser();
    unsolicited.push(enc('%begin 1 2 0'));
    expect(() => unsolicited.push(big)).toThrow(RangeError);
    const solicited = new ControlParser();
    solicited.push(enc('%begin 1 2 1'));
    expect(solicited.push(big)).toBeNull();
    const end = solicited.push(enc('%end 1 2 1')) as Extract<ControlEvent, { type: 'blockEnd' }>;
    expect(end.type).toBe('blockEnd');
    expect(end.lines).toHaveLength(1);
    expect(end.lines[0]).toBe(big);
  });

  it('still parses large replies under the default cap', () => {
    const parser = new ControlParser();
    // A 10,000-line history of 400-byte lines, then 60 MiB in 2 MiB lines (one shared buffer).
    const historyLine = new Uint8Array(400).fill(0x62);
    parser.push(enc('%begin 1 2 1'));
    for (let i = 0; i < 10_000; i++) parser.push(historyLine);
    const history = parser.push(enc('%end 1 2 1'));
    expect(history).toMatchObject({ type: 'blockEnd' });
    expect((history as Extract<ControlEvent, { type: 'blockEnd' }>).lines).toHaveLength(10_000);
    const chunk = new Uint8Array(2 * 1024 * 1024);
    const count = Math.floor((DEFAULT_MAX_BLOCK_BYTES - 4 * 1024 * 1024) / chunk.byteLength);
    parser.push(enc('%begin 1 3 1'));
    for (let i = 0; i < count; i++) expect(parser.push(chunk)).toBeNull();
    const big = parser.push(enc('%end 1 3 1'));
    expect((big as Extract<ControlEvent, { type: 'blockEnd' }>).lines).toHaveLength(count);
  });

  it('flags malformed known notifications', () => {
    for (const line of ['%output 0 x', '%output', '%pause 4', '%end 1 2 1', '%begin x 2 1']) {
      expect(parseAll(`${line}\n`)[0]).toMatchObject({ type: 'unknown', malformed: true });
    }
  });

  it('extracts the pane size of a single-pane layout only', () => {
    expect(singlePaneLayout('a87d,100x30,0,0,0')).toEqual({ width: 100, height: 30, paneId: 0 });
    expect(singlePaneLayout('bb62,159x48,0,0{79x48,0,0,1,79x48,80,0,2}')).toBeNull();
  });
});

describe('CommandCorrelator', () => {
  function harness(nonce = 'tv-n1') {
    const written: string[] = [];
    const correlator = new CommandCorrelator((line) => written.push(line), { nonce: () => nonce });
    const parser = new ControlParser();
    const feed = (text: string): void => {
      for (const line of new LineSplitter().push(enc(text))) {
        const event = parser.push(line);
        if (event) correlator.handle(event);
      }
    };
    return { written, correlator, feed };
  }
  const block = (num: number, flags: number, body: string[], kind = 'end'): string =>
    [`%begin 9 ${num} ${flags}`, ...body, `%${kind} 9 ${num} ${flags}`, ''].join('\n');

  it('matches pipelined replies FIFO and ignores unsolicited flags=0 blocks', async () => {
    const { written, correlator, feed } = harness();
    const a = correlator.send('display-message -p a');
    const b = correlator.send('select-pane -t %99');
    expect(written).toEqual(['display-message -p a', 'select-pane -t %99']);
    feed(block(1, 0, ['launch output']) + block(2, 1, ['a']) + block(3, 1, ['nope'], 'error'));
    expect(await a).toEqual({ ok: true, lines: [enc('a')] });
    expect(await b).toEqual({ ok: false, lines: [enc('nope')] });
    expect(correlator.pending).toBe(0);
  });

  it('sends a batch on one line with the sentinel and returns one block per command', async () => {
    const { written, correlator, feed } = harness();
    const result = correlator.sendBatch(['capture-pane -p', 'display-message -p x']);
    expect(written).toEqual([
      "capture-pane -p ; display-message -p x ; display-message -p 'tv-n1'",
    ]);
    feed(block(1, 1, ['l1', '%end 9 1 0']) + block(2, 1, ['x']) + block(3, 1, ['tv-n1']));
    expect(await result).toEqual({
      ok: true,
      blocks: [
        { ok: true, lines: [enc('l1'), enc('%end 9 1 0')] },
        { ok: true, lines: [enc('x')] },
      ],
    });
  });

  it('stops a batch at the first %error (tmux skips the rest of the line)', async () => {
    const { correlator, feed } = harness();
    const failing = correlator.sendBatch(['a', 'b', 'c']);
    const next = correlator.send('d');
    feed(block(1, 1, ['ok']) + block(2, 1, ['bad'], 'error') + block(3, 1, ['d']));
    expect(await failing).toEqual({
      ok: false,
      blocks: [
        { ok: true, lines: [enc('ok')] },
        { ok: false, lines: [enc('bad')] },
      ],
    });
    expect(await next).toEqual({ ok: true, lines: [enc('d')] });
  });

  it('treats a parse error as one %error block for the whole line', async () => {
    const { correlator, feed } = harness();
    const failing = correlator.sendBatch(['no-such-command', 'b']);
    feed(block(1, 1, ['parse error: unknown command: no-such-command'], 'error'));
    expect((await failing).ok).toBe(false);
    expect(correlator.pending).toBe(0);
  });

  it('rejects with a desync error when the sentinel does not match', async () => {
    const { correlator, feed } = harness();
    const result = correlator.sendBatch(['a']);
    const later = correlator.send('b');
    expect(() => feed(block(1, 1, ['x']) + block(2, 1, ['tv-other']))).toThrow(TmuxDesyncError);
    await expect(result).rejects.toBeInstanceOf(TmuxDesyncError);
    await expect(later).rejects.toBeInstanceOf(TmuxDesyncError);
    await expect(correlator.send('c')).rejects.toBeInstanceOf(TmuxDesyncError);
  });

  it('flags a solicited reply with nothing pending as desync', () => {
    const { feed } = harness();
    expect(() => feed(block(1, 1, []))).toThrow(TmuxDesyncError);
  });

  it('fails pending commands on failAll and rejects multi-line commands', async () => {
    const { correlator } = harness();
    const pending = correlator.send('a');
    correlator.failAll(new Error('closed'));
    await expect(pending).rejects.toThrow('closed');
    await expect(harness().correlator.send('a\nb')).rejects.toBeInstanceOf(RangeError);
  });
});

describe('encodeInput', () => {
  it('encodes every byte as a hex argument', () => {
    expect(encodeInput(3, bytes(0x1b, 0x5b, 0x41, 0x00, 0x7f, 0xe4, 0xb8, 0xad))).toEqual([
      'send-keys -H -t %3 1b 5b 41 00 7f e4 b8 ad',
    ]);
    expect(encodeInput(0, new Uint8Array())).toEqual([]);
  });

  it('chunks at 1 KiB of input per command', () => {
    const data = new Uint8Array(2500).fill(0x61);
    const commands = encodeInput(7, data);
    expect(commands.map((c) => c.split(' ').length - 4)).toEqual([1024, 1024, 452]);
    expect(commands[0]!.startsWith('send-keys -H -t %7 61 61')).toBe(true);
  });
});
