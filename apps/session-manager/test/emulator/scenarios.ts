/**
 * Hand-crafted streams for state the real recordings do not leave behind at the end (non-default
 * scroll region, origin mode, ACS charset, odd resets, …). Each one ends in the state under test.
 */
import type { Scenario } from './harness.ts';

const ESC = '\x1b';
const CSI = '\x1b[';

const lines = (n: number, f: (i: number) => string): string =>
  Array.from({ length: n }, (_, i) => `${f(i)}\r\n`).join('');

const sgrPalette = lines(48, (i) => {
  const fg16 = `${CSI}${30 + (i % 8)}m`;
  const bright = `${CSI}${90 + (i % 8)};${40 + ((i + 3) % 8)}m`;
  const c256 = `${CSI}38;5;${(i * 37) % 256};48;5;${(i * 11) % 256}m`;
  const rgb = `${CSI}38;2;${(i * 53) % 256};${(i * 97) % 256};${(i * 29) % 256}m`;
  const bgRgb = `${CSI}48;2;${(i * 7) % 256};20;${255 - ((i * 13) % 256)}m`;
  return (
    `${fg16}16 ${bright}bright ${CSI}0m${c256}256c ${CSI}0m${rgb}truecolor ${bgRgb} bg ` +
    `${CSI}1mbold${CSI}22m ${CSI}3mitalic${CSI}23m ${CSI}4munder${CSI}24m ${CSI}7minv${CSI}27m ` +
    `${CSI}2mdim${CSI}22m ${CSI}9mstrike${CSI}29m ${CSI}5mblink${CSI}25m ${CSI}8mhid${CSI}28m ` +
    `${CSI}53mover${CSI}55m ${CSI}1;3;4;7mall${CSI}0m ${CSI}44m${CSI}K${CSI}0m`
  );
});

export const syntheticScenarios: Scenario[] = [
  {
    // Colors and attributes, erase-with-background, wrapped lines and scrollback; the current
    // SGR is left non-default.
    name: 'synthetic:sgr-attributes',
    cols: 100,
    rows: 30,
    events: [
      sgrPalette,
      `${CSI}45m${'w'.repeat(250)}${CSI}0m\r\n`,
      `${'x'.repeat(100)}${'y'.repeat(100)}\r\n`,
      `${CSI}1;38;5;196;48;2;1;2;3mstill bold red on rgb`,
    ],
  },
  {
    // CJK, emoji, combining marks, ZWJ and VS16 sequences, wide chars at the wrap boundary.
    name: 'synthetic:wide-chars',
    cols: 100,
    rows: 30,
    events: [
      '漢字かなカナ한국어 mixed ascii\r\n',
      'emoji 🙂🚀👍🏽 zwj 👨‍👩‍👧 vs16 ❤️ ✈️ flags 🇧🇷\r\n',
      'combining: é ä ñ ź̧\r\n',
      `${'a'.repeat(99)}漢字 wide char does not fit in the last column\r\n`,
      `${'漢'.repeat(60)}\r\n`,
      `${'🙂'.repeat(55)}\r\n`,
      `${CSI}31m${'字'.repeat(49)}x字${CSI}0m`,
    ],
  },
  {
    // Alternate screen app with a scroll region left set and the cursor mid-screen.
    name: 'synthetic:alt-screen-region',
    cols: 100,
    rows: 30,
    events: [
      lines(40, (i) => `shell line ${i}`),
      `${CSI}?1049h${CSI}H${CSI}2J`,
      `${CSI}1;1H${CSI}7m title bar ${CSI}K${CSI}0m`,
      `${CSI}30;1H${CSI}7m status ${CSI}K${CSI}0m`,
      `${CSI}3;28r${CSI}28;1H`,
      lines(40, (i) => `${CSI}3${i % 8}mregion line ${i}${CSI}0m`),
      `${CSI}2S${ESC}M${CSI}3;1H${ESC}M`,
      `${CSI}12;40Hcursor here`,
    ],
  },
  {
    // DECOM with a scroll region: SerializeAddon's trailing DECSET 6 homes the cursor.
    name: 'synthetic:origin-mode',
    cols: 100,
    rows: 30,
    events: [
      `${CSI}?1049h`,
      `${CSI}5;20r${CSI}?6h`,
      lines(30, (i) => `origin ${i}`),
      `${CSI}3;10Hinside`,
    ],
  },
  {
    // The scenario of criterion D: SGR mouse encoding and a bar cursor left active.
    name: 'synthetic:mouse-cursor',
    cols: 100,
    rows: 30,
    events: ['$ app\r\n', `${CSI}?1000h${CSI}?1006h${CSI}6 q`, 'mouse app running'],
  },
  {
    // Custom tab stops set with HTS, partially cleared with TBC 0, used with HT/CHT/CBT.
    name: 'synthetic:tab-stops',
    cols: 100,
    rows: 30,
    events: [
      `${CSI}3g\r${CSI}4G${ESC}H${CSI}12G${ESC}H${CSI}31G${ESC}H${CSI}50G${ESC}H${CSI}77G${ESC}H`,
      `${CSI}50G${CSI}g\r`,
      'a\tb\tc\td\te\r\n',
      `\t${CSI}2Ix${CSI}Zy\r\n`,
    ],
  },
  {
    // Titles: OSC 2, OSC 0, OSC 1 (icon only) and an ST-terminated OSC 2.
    name: 'synthetic:title',
    cols: 100,
    rows: 30,
    events: [
      `${ESC}]2;first\x07`,
      `${ESC}]0;second; with semicolon\x07`,
      `${ESC}]1;icon only\x07`,
      `${ESC}]2;final title ✓${ESC}\\`,
      'titled',
    ],
  },
  {
    // Resizes through the write queue, with custom tabs and a region set before each one.
    name: 'synthetic:resize-mid-stream',
    cols: 100,
    rows: 30,
    events: [
      lines(45, (i) => `before ${i} ${'r'.repeat((i * 9) % 150)}`),
      `${CSI}3g\r${CSI}5G${ESC}H${CSI}61G${ESC}H${CSI}97G${ESC}H${CSI}4;20r`,
      { resize: [72, 20] },
      lines(10, (i) => `narrow ${i}\tt`),
      { resize: [120, 35] },
      `${CSI}2;30r`,
      lines(5, (i) => `wide ${i}\ta\tb\tc\td\te\tf`),
      'end',
    ],
  },
  {
    // Normal-buffer tab stops and margins must survive while the alternate screen is active.
    name: 'synthetic:normal-state-under-alt',
    cols: 100,
    rows: 30,
    events: [
      lines(10, (i) => `normal ${i}`),
      `${CSI}3g\r${CSI}7G${ESC}H${CSI}23G${ESC}H${CSI}2;25r${CSI}10;5H`,
      `${CSI}?1049h${CSI}H`,
      `${CSI}40G${ESC}H${CSI}10;20r${CSI}15;3Halt app`,
    ],
  },
  {
    // Leaving the alternate screen clears its tab stops and margins; ?1049l restores the cursor.
    name: 'synthetic:alt-exit',
    cols: 100,
    rows: 30,
    events: [
      lines(5, (i) => `before app ${i}`),
      `${CSI}?1049h${CSI}3g${CSI}9G${ESC}H${CSI}4;12r${CSI}6;6Hin app`,
      `${CSI}?1049l`,
      `back in shell\r\n${CSI}?47h${CSI}2;3rold-style alt${CSI}?47l`,
      'after\tTab',
    ],
  },
  {
    // DEC special graphics left designated mid-drawing (G0) plus a G1 designation.
    name: 'synthetic:charset-acs',
    cols: 100,
    rows: 30,
    events: [`${ESC})0box: ${ESC}(0lqqqqk\r\nx    x\r\nmqq`],
  },
  {
    // DECSTR, RIS and non-standard DECSCUSR values; the cursor stays hidden across RIS (xterm 6).
    name: 'synthetic:resets',
    cols: 100,
    rows: 30,
    events: [
      `${CSI}?1006h${CSI}4 q${CSI}?25l${CSI}5;10r${CSI}3g${ESC}(0`,
      `${CSI}!p`,
      `${CSI}7 q${CSI}?1016h`,
      `${ESC}c`,
      `${CSI}0 q${CSI}8 q${CSI}?1006h${CSI}?1006l${ESC}%G`,
      'after resets',
    ],
  },
  {
    // Modes not covered by SerializeAddon: DECSET 12 (cursorBlink option), LNM, DECSET 2026,
    // plus serialized ones for good measure.
    name: 'synthetic:misc-modes',
    cols: 100,
    rows: 30,
    events: [
      `${CSI}?12h${CSI}20h`,
      'line feed is new line\nsecond\n',
      `${CSI}?1h${ESC}=${CSI}?2004h${CSI}4h${CSI}?45h${CSI}?1004h${CSI}?1003h${CSI}?1016h`,
      `${CSI}?2026h`,
      'mid-frame',
    ],
  },
  {
    // The alternate buffer is not reflowed: after a shrink, stale cells stay hidden beyond the
    // right edge of each line (only partially erased here), and some lines are wrapped.
    name: 'synthetic:alt-shrink-hidden-cells',
    cols: 100,
    rows: 30,
    events: [
      `${CSI}?1049h${CSI}H`,
      lines(28, (i) => `${CSI}3${i % 8}m${String(i).padStart(2, '0')}${'#'.repeat(98)}${CSI}0m`),
      { resize: [80, 30] },
      `${CSI}H${CSI}K top${CSI}5;1H${'w'.repeat(170)}${CSI}20;70Hend`,
    ],
  },
  {
    // Cursor in the pending-wrap position (x == cols) after filling the last column.
    name: 'synthetic:pending-wrap',
    cols: 100,
    rows: 30,
    events: [lines(3, (i) => `row ${i}`), 'z'.repeat(100)],
  },
];
