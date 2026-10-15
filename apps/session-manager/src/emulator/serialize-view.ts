import type { IBuffer, IBufferLine, Terminal } from '@xterm/headless';

/**
 * The terminal as SerializeAddon should see it: every line clipped to the terminal width.
 *
 * xterm does not reflow the alternate buffer, so after a shrink its lines keep their old,
 * longer length with stale cells hidden beyond the right edge. SerializeAddon 0.14 iterates
 * `line.length` cells: hidden content would be printed and wrap on the client, and even empty
 * hidden cells break its wrapped-line heuristic. Hidden cells cannot be restored anyway.
 */
export function clippedTerminalView(term: Terminal): Terminal {
  const clipLine = (line: IBufferLine | undefined): IBufferLine | undefined => {
    const cols = term.cols;
    if (!line || line.length <= cols) return line;
    return {
      length: cols,
      get isWrapped() {
        return line.isWrapped;
      },
      getCell: (x, cell) => (x < cols ? line.getCell(x, cell) : undefined),
      translateToString: (trimRight, start, end) =>
        line.translateToString(trimRight, start, Math.min(end ?? cols, cols)),
    };
  };
  const clip = (buffer: () => IBuffer): IBuffer => ({
    get type() {
      return buffer().type;
    },
    get cursorX() {
      return buffer().cursorX;
    },
    get cursorY() {
      return buffer().cursorY;
    },
    get viewportY() {
      return buffer().viewportY;
    },
    get baseY() {
      return buffer().baseY;
    },
    get length() {
      return buffer().length;
    },
    getLine: (y) => clipLine(buffer().getLine(y)),
    getNullCell: () => buffer().getNullCell(),
  });
  const buffer = {
    normal: clip(() => term.buffer.normal),
    alternate: clip(() => term.buffer.alternate),
    active: clip(() => term.buffer.active),
  };
  return {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    get modes() {
      return term.modes;
    },
    buffer,
    // SerializeAddon reads the current SGR from internals (`_core._inputHandler._curAttrData`).
    _core: (term as unknown as { _core: unknown })._core,
  } as unknown as Terminal;
}
