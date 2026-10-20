# ADR-0001 — Emulator fidelity, snapshot barrier and query silencer (spike S1)

- **Status:** accepted. Decision: **GO** for `@xterm/headless` 6.0.0 + SerializeAddon 0.14.0 as the authoritative server emulator, **with the conditions listed under Decision** (snapshot = serialize + mode epilogue + parser tail; UTF-8-aligned writes on both sides; cached snapshots).
- **Date:** 2026-10-15
- **Scope:** plan §5.3 (emulator and query authority), §5.4 (output pipeline and snapshot barrier), §15 (T0/T1 tests), §17 (snapshot cost and memory risks).
- **Code:** `apps/session-manager/src/emulator/` (`HeadlessEmulator`, `clippedTerminalView`), `packages/terminal-config/src/` (`ModeTracker`, `Utf8Aligner`, `installQuerySilencer`).
- **Evidence:** real recordings in `apps/session-manager/test/fixtures/terminal/*.json` (re-recordable with `python3 -I apps/session-manager/test/fixtures/terminal/record/record.py`). The T0 tests are in `apps/session-manager/test/emulator/` (golden, barrier, version pin) and `packages/terminal-config/test/` (silencer). The T1 measurements are in `apps/session-manager/test/emulator/emulator.measure.int.test.ts`.

## Context

The server keeps one `@xterm/headless` terminal per session. A browser restores from a snapshot and then applies the same raw output bytes (§5.4). The core promise is "the terminal is exactly as I left it", so S1 had to answer four questions:

1. Does `SerializeAddon` output, written into a fresh browser terminal, reproduce the server state? If not, what is missing?
2. Is a snapshot taken at a write barrier consistent with the sequence number recorded for it?
3. Does `installQuerySilencer` cover every query form that xterm 6 answers?
4. What do a snapshot and an emulator cost at the default scrollback of 10,000 lines?

## Method

- **Environment:** Linux 6.8 (AWS, 2 vCPU, 3.8 GiB), Node 24.16.0, `@xterm/headless` 6.0.0, `@xterm/addon-serialize` 0.14.0, `@xterm/addon-unicode11` 0.9.0. The machine was shared with another agent's test runs (load average 0.7–2.5), so timings are reported as medians, with CPU time next to wall time.
- **Source reading:** `SerializeAddon.ts` (shipped in the package), and the xterm 6.0.0 sources extracted from `xterm-headless.mjs.map` (`InputHandler`, `Buffer`, `BufferSet`, `CoreService`, `CoreMouseService`, `CharsetService`, `EscapeSequenceParser`, `WriteBuffer`, `TextDecoder`).
- **Real recordings:** `bash` (colored prompt, 256-color and truecolor SGR, 60 lines of scrollback with wrapped lines, `tabs 4,12,30`, OSC 2 title, CJK and emoji, a command line typed past the right edge), `vim` 8.2 (alternate screen, scroll regions, `ttymouse=sgr`, `set title`, truecolor, a resize from 100×30 to 90×26, insert mode left active with `CSI 6 SP q`), `htop` 3.0.5 (SGR mouse `?1006;1000h`, hidden cursor, keypad mode) and `less` 590 (alternate screen, search highlight). Each runs in a fresh PTY (TERM=xterm-256color, 100×30, C.UTF-8) under an empty environment, and nobody answers the program's queries. The total is about 29 KB of output and no personal data (checked for paths, user and host names).
- **Synthetic streams** (`test/emulator/scenarios.ts`) for end states the recordings do not leave behind: SGR attributes and colors, wide characters (CJK, emoji, ZWJ, VS16, combining marks, a wide char at the wrap edge), an alternate screen with a scroll region and the cursor mid-screen, origin mode, SGR mouse with a bar cursor, custom tab stops, titles, resizes mid-stream with custom tabs and margins, normal-buffer state under the alternate screen, leaving the alternate screen, the DEC graphics charset left active, DECSTR/RIS and odd DECSCUSR values, DECSET 12, LNM and 2026, hidden stale cells after an alternate-screen shrink, and the pending-wrap cursor.
- **Golden test:** emulator A gets each scenario in random chunks (seeded; 70 % of chunks are 1–6 bytes, so UTF-8 and escape sequences get cut: more than 20 of each per run, asserted). A fresh emulator B (created at 80×24, resized to A's size, like the browser's `reset → resize → write`) gets `A.snapshot()`. The probe then compares, per cell, the chars, width, fg/bg color and color mode, and nine attribute flags, plus `isWrapped`, buffer length, `baseY` and viewport for **both** buffers. It also compares the cursor, the active buffer, `term.modes`, xterm internals (mouse protocol and encoding, all DEC private modes, ANSI modes, cursor hidden, the `cursorBlink`/`convertEol` options, title, G0–G3/GL charsets, the current SGR, and the tab stops and margins of both buffers) and the two trackers' `state()`. A is also compared, with no normalization at all, with a reference that got the same bytes in one write.
- **Barrier tests:** writes submitted in the same tick right after `snapshot()`, random barriers in every recording, and ten targeted barriers inside sequences. In each case the client applies the snapshot and then every op after the barrier, and must end identical to the live emulator.
- **Silencer test:** every query form, with and without the silencer. A spy handler registered before the silencer proves that the silencer itself consumed the query.

## Results

### Fidelity

**SerializeAddon alone is not enough.** It restores the buffers, the cursor, the current SGR and the modes listed below, but nothing else:

| Restored by SerializeAddon 0.14.0 | Not restored (now handled, see below) |
|---|---|
| Normal buffer with scrollback; alternate buffer (as `CSI ? 1049 h` + contents) | Mouse encoding (DECSET 1006 SGR, 1016 SGR-pixels) |
| Cursor position (relative moves) and current SGR (read from internals) | Cursor style and blink (DECSCUSR) |
| DECCKM ?1, keypad ?66 / `ESC =`, bracketed paste ?2004, IRM 4, DECOM ?6, reverse wrap ?45, focus ?1004, DECAWM ?7 | Cursor visibility (DECTCEM ?25) |
| Mouse protocol (?9 / ?1000 / ?1002 / ?1003) | Tab stops (per buffer), scroll region (per buffer) |
| | Window title (OSC 0 / 2) |
| | DECSET 12 and LNM (xterm stores them as the `cursorBlink` / `convertEol` options) |
| | DECSET 2026 (skipped as "temporary", wrong for a snapshot taken mid-frame) |
| | G0–G3 charset designations (e.g. DEC graphics left active mid-drawing) |
| | Parser state: half-received escape sequence or UTF-8 character |
| | Grapheme join state (a ZWJ / combining mark arriving right after the barrier) |

DECSET 1005 and 1015 are accepted but ignored by xterm 6 (`#2507`), so there is nothing to restore.

**Defects found in SerializeAddon 0.14.0** (each one was reproduced by a golden scenario, then fixed in Termavox code):

1. **Alternate-buffer attributes:** the normal-buffer part ends by applying the current SGR, but the alternate part is serialized as if it started from default attributes. Live vim (status line drawn last, left in bold + inverse) restored with its whole first row bold + inverse. *Fix:* `SGR 0` before the serialized `CSI ? 1049 h`.
2. **Overlong alternate-buffer lines:** xterm does not reflow the alternate buffer, so after a shrink its lines keep their old length, with stale cells beyond the right edge. SerializeAddon iterates `line.length`: hidden content would be printed and wrap on the client, and even empty hidden cells break its wrapped-line heuristic (vim after 100→90). *Fix:* SerializeAddon is activated on `clippedTerminalView`, a view whose lines are clipped to `cols`.
3. **Off-by-one cursor:** when the last content row ends in the last column, SerializeAddon assumes the cursor sits at `x == cols`, but xterm clamps before `CUB`. *Fix:* the epilogue always ends with an absolute CUP.
4. **Cursor lost with DECOM:** the trailing `CSI ? 6 h` homes the cursor. *Fix:* the CUP is relative to the top margin when origin mode is set.
5. **256-color indexes 0–15** (`38;5;n`) come back as 16-color SGR (`3n`/`9n`): same palette entry, different color mode. *Not fixed* (cell-level, inside the addon). The restored-vs-live probe treats the two encodings as equal (the chunked-vs-one-write probe does not). Both render from the same palette entry; the only possible difference is xterm's "bold as bright" rule, if the browser renderer applies it to 16-color mode only. That is unverified until `@xterm/xterm` is installed (follow-up).

**Mode tracker and epilogue** (`ModeTracker` in `packages/terminal-config/src/mode-tracker.ts`). The tracker uses parser hooks that always return `false`, plus `onResize`, `onBufferChange` and `onTitleChange`. It mirrors xterm 6 exactly, quirks included: DECSTR resets the cursor style and the active buffer's margins but not the mouse encoding or tab stops. RIS does **not** show a hidden cursor again. Resizes reset both margins and extend tab stops from the last stop below the new width. Leaving the alternate screen clears its tabs and margins. A non-standard DECSCUSR changes only the blink. `epilogue()` emits nothing for state at its default. The exceptions are visibility, DECSET 12, LNM and title: `Terminal.reset()` on the client does not clear them, so the tracker emits them explicitly once the stream has touched them. When the alternate screen is active, `normalBufferEpilogue()` restores the normal buffer's tab stops, margins and cursor **before** the serialized `CSI ? 1049 h`.

**Golden result:** all 19 scenarios (4 recordings + 15 synthetic) restore with **zero differences**, with random chunking and after the snapshot round trip. With the epilogue disabled, 13 of them fail, among them `synthetic:mouse-cursor` (`mouseEncoding "SGR" != "DEFAULT"`, `cursorStyle "bar" != undefined`) and the real vim, htop and bash recordings. A permanent T0 assertion also shows that plain `serialize()` loses mouse encoding and cursor style.

### xterm 6.0.0 UTF-8 decoder defect

`Utf8ToUtf32.decode` rebuilds a buffered partial character with `while ((tmp = interim[++pos] & 0x3F) && pos < 4)`. The loop stops at a continuation byte equal to `0x80`, so a character split right after such a byte is **silently dropped**. Measured: `—` `…` `“` `•` and U+200D ZWJ (`E2 80 xx`) are dropped when split after the second byte, and U+1F004 when split after the third byte. Other split points, CJK and 2-byte characters are fine. The golden test caught it as a lost ZWJ in `👨‍👩‍👧` under random chunking. The server and the browser chunk the same stream differently, so this is a fidelity bug as well as a display bug. *Fix:* `Utf8Aligner` (terminal-config) carries an incomplete trailing UTF-8 sequence over to the next write, so xterm only ever gets complete characters. `HeadlessEmulator.write` uses it, and **the browser must too** (see Decision).

### Snapshot barrier

- **Write callbacks run synchronously between chunks** (WriteBuffer `_innerWrite` calls each chunk's callback right after parsing it). Verified by a T0 test.
- **`await flush()` followed by a synchronous serialize is NOT consistent.** The promise continuation runs as a microtask after the whole batch of queued chunks has been parsed. Measured: `write('A'); write('', cb → resolve); write('B')`. The callback sees `A`, but the `.then` sees `AB`. The same happens when `B` is written from a later `setImmediate` before the batch runs. The `Emulator` contract `flush(): Promise` + `snapshot(): string` could therefore not express a consistent barrier. **`snapshot()` now takes its own barrier and serializes inside the write callback** (interface change below).
- **A serialized screen cannot express parser state.** If the last chunk before the barrier ends inside an escape sequence (e.g. `ESC [ 3`), the client's parser starts the next chunk in ground state and prints `1m` as text. If it ends inside a UTF-8 character, the client drops the continuation bytes. During TUI redraws a large share of the bytes are escape sequences, so this would hit a real share of attaches. *Fix:* the emulator keeps the bytes of the unfinished sequence. After each chunk it checks the parser state (internal `currentState`) and takes the bytes from the last sequence introducer: ESC, or a UTF-8-encoded C1 CSI/OSC/DCS/SOS/PM/APC, which xterm 6 also accepts. The snapshot ends with those bytes plus the aligner's partial character, so the client's parser resumes in the same state.
- **Grapheme join state.** xterm joins a combining mark, ZWJ or VS16 to the previously printed cell even across chunks, but any escape sequence (including the epilogue's CUP) resets that join state. *Fix:* when the last parser action was a print (internal `precedingJoinState != 0`), the snapshot ends by printing that cell again in place, with the same content and attributes. This also restores the pending-wrap position, which no cursor sequence can express.
- **Resize through the write queue** lands exactly between the bytes written before and after it. The test compares this with write → flush → resize → write, plus a control showing that the order is observable. `cols`/`rows` read when `snapshot()` is called give the snapshot's size.

Result: at random barriers in the four recordings and at ten targeted barriers (inside CSI parameters, right after ESC, inside an OSC title, inside a DCS request, between ESC and the ST backslash, inside `—`, inside a ZWJ emoji, inside `CSI ? 1006 h`, inside a CSI opened by C1 U+009B, inside an OSC opened by U+009D after an earlier ESC), the snapshot equals an independent emulator fed exactly the bytes before the barrier. A client that applies the snapshot and then the remaining ops ends identical to the live emulator.

### Query silencer (xterm 6.0.0)

With the silencer, every form below produces **no reply**, and the spy proves that the silencer consumed it. Without the silencer, xterm answers exactly once where shown:

| Form | xterm 6 reply without the silencer |
|---|---|
| DA1 `CSI c`, `CSI 0 c` | `CSI ? 1 ; 2 c` |
| DA2 `CSI > c` | `CSI > 0 ; 276 ; 0 c` |
| DSR `CSI 5 n` / CPR `CSI 6 n` | `CSI 0 n` / `CSI r ; c R` |
| DEC CPR `CSI ? 6 n` | `CSI ? r ; c R` |
| DECRQM `CSI Ps $ p` / `CSI ? Ps $ p` | `CSI Ps ; v $ y` / `CSI ? Ps ; v $ y` |
| Window report `CSI 18 t` (only if `windowOptions.getWinSizeChars`) | `CSI 8 ; rows ; cols t` |
| DECRQSS `DCS $ q … ST` (SGR, DECSTBM, DECSCUSR, …) | `DCS 1 $ r … ST` |
| **No reply from xterm 6 (headless) even without the silencer:** DA3 `CSI = c`; DEC DSR other than `?6n` (e.g. `?996n`); XTVERSION `CSI > q`; kitty `CSI ? u`; window reports 11/13/15/19/20/21; 14 and 16 (raised as events that only the browser answers); XTGETTCAP `DCS + q`; OSC 4/10/11/12 `?` (headless has no theme service; the browser answers them); OSC 52 `?` (only `@xterm/addon-clipboard` answers it) | — |

Window ops are gated by `windowOptions`, all disabled by default: xterm wraps every custom `CSI t` handler and swallows disabled ops before any handler runs. With the silencer installed, the non-query sequences that share these finals still work: `CSI 8 ; r ; c t` and `CSI 22/23 ; 0 t` (title push/pop still works) pass through, and so do OSC 4/10/11 color sets and OSC 52 set.

**Changes to `installQuerySilencer`:** xterm-6 coverage was already complete. I added OSC 52 `?` (clipboard read), in case the browser ever loads the clipboard addon. I also documented two caveats: install the silencer **after** every addon (xterm calls the last registered handler first), and an OSC 4/10/11/12 that mixes sets with `?` is swallowed whole.

### Measurements

At 10,000 scrollback lines × 120 columns (+40 rows), median of 9 runs:

| | Mixed SGR (new SGR every 8 columns, worst case) | Typical log output (4 SGR runs per line) |
|---|---|---|
| `snapshot()` wall | **443 ms** (411–590) | **288 ms** (250–424) |
| `snapshot()` process CPU (includes GC threads) | 594 ms | 401 ms |
| Plain `serialize()` CPU by scrollback: 0 / 1k / 5k / 10k lines | 3.8 / 22 / 85 / 552 ms | 2.3 / 12 / 92 / 221 ms |
| Snapshot size → gzip -6 | 2.61 MiB → 0.62 MiB (**4.2:1**, 94 ms) | 1.09 MiB → 0.11 MiB (**9.7:1**, 12 ms) |
| Restore into a fresh headless terminal | 130 ms | 55 ms |
| Ingest | 24.5 MiB/s | 26.8 MiB/s |

**Retained memory per emulator at a full scrollback** (4 emulators, after GC): **4.0 MiB** JS heap + **14.1 MiB** ArrayBuffers (xterm's cell arrays: 13.8 MiB = 10,040 lines × 120 cells × 12 bytes), about 18 MiB in total (+21–23 MiB RSS). This matches the §17 estimate of about 14 MiB of cells.

**Typical snapshots** (the recordings, gzip -6): bash 7,651 → 831 B (9.2:1), vim 2,422 → 561 B (4.3:1), less 2,427 → 194 B (12.5:1), htop 910 → 488 B (1.9:1).

Serialization is not linear in the number of lines (5k → 10k costs 2.5–6×), probably because of GC and string building. It is synchronous and blocks the event loop for every session in the process.

## State not restored even with the epilogue

- **Saved cursor (DECSC / `CSI s` / DECRC):** position, attributes and charset, per buffer. One partial exception: while the alternate screen is active, the normal buffer's slot is set again by the serialized `?1049h` at the right position, but with default attributes instead of the attributes in effect when the application entered the alternate screen.
- **GL/GR shift state** (SO/SI, LS2/LS3, and a charset restored by DECRC). SO/SI are C0 executes, which public parser hooks cannot observe. Only the G0–G3 designations are restored.
- **Dynamic colors:** OSC 4 palette entries, OSC 10/11/12 foreground/background/cursor colors and their resets (OSC 104/110–112). This is browser-side theme state; headless keeps none.
- **Cell extras that SerializeAddon does not write:** hyperlinks (OSC 8), extended underline styles and underline color (SGR 4:x, 58), the protected attribute (DECSCA), and the 16- vs 256-color mode of palette indexes 0–15.
- **Icon name (OSC 1) and the title stack** (`CSI 22/23 t`, disabled by default).
- **Stale cells beyond the right edge** of alternate-buffer lines after a shrink, and **tab stops beyond the current width**. xterm keeps both and shows them again after a later grow; the client starts without them.
- **The pending-wrap position** when the last parser action was not a print and the epilogue had to move the cursor (custom tab stops, a non-default scroll region or DECOM).
- **Grapheme join** across a barrier when a queued resize moved the cursor between the print and the barrier. The reprint is skipped unless the cell left of the cursor could be the one just printed.
- **An unfinished OSC/DCS string longer than 64 KiB** at the barrier (replayed truncated).
- **Not applicable in xterm 6:** mouse encodings 1005/1015 and the kitty keyboard protocol (not implemented), and reverse video DECSCNM (not implemented).
- Viewport scroll position and selection: UI state, not terminal state.

## Decision

**GO**, under these conditions:

1. **Snapshot = SerializeAddon output + mode epilogue + parser tail**, as implemented by `HeadlessEmulator.snapshot()`. The payload is **bytes** (it can end with a partial UTF-8 character), which fits the binary SNAPSHOT frame.
2. **Both sides write UTF-8-aligned chunks.** The server does this inside `HeadlessEmulator.write`. **The browser must pass the SNAPSHOT payload and every OUTPUT frame through one `Utf8Aligner` per terminal.** The runtime may also align chunks at ingest, before assigning sequence numbers.
3. **Client apply sequence:** `term.reset()` → `term.resize(cols, rows)` → `term.write(aligner.push(snapshot))`. Use the same `@xterm/xterm` version (pinned by `XTERM_VERSION` and a T0 test), the same `sharedTerminalOptions` and Unicode 11, and call `installQuerySilencer` **after** loading every addon.
4. **Snapshot cost:** serialize at most once per (session, seq) and share the result between attachments (§17). Never serialize per attachment in a loop. The ~0.3–0.45 s event-loop block at 10k lines needs a Phase-1 decision: a smaller default scrollback (5k lines ≈ 85–90 ms), a viewport-first snapshot with scrollback sent later, or emulators in worker threads (§18.1).
5. **Internals are pinned:** the emulator reads xterm 6.0.0 internals (`_core._inputHandler._parser.currentState/initialState/precedingJoinState`, `_curAttrData`, `buffers.active.scrollTop`), and SerializeAddon itself reads `_curAttrData`. The version-pin, golden and barrier tests must pass before any xterm upgrade.

### Interface change (`apps/session-manager/src/core/types.ts`)

`Emulator.snapshot(): string` (synchronous, "call after `flush()`") became **`snapshot(): Promise<Uint8Array>`**, which enqueues its own barrier and serializes inside the write callback. There are two reasons: (a) after `await flush()`, more chunks may already have been parsed, so a synchronous snapshot would not match the recorded `snapshotSeq`; (b) the payload must carry an unfinished escape sequence and a partial UTF-8 character, which a string cannot hold. `flush()` is unchanged. The runtime records `snapshotSeq`, `cols` and `rows` synchronously when it calls `snapshot()`.

## Follow-ups

- **Color queries in raw / tmux-normal modes:** headless never answers OSC 4/10/11/12 `?` (it has no theme service), and the browser is silenced. Programs that ask for the background color (vim `t_RB`, neovim, bat/delta, fish) therefore get no answer from anyone. Proposal: when `answerQueries` is set, `HeadlessEmulator` answers them from the configured theme.
- `scripts/test-area.ts` maps the `terminal` area to `apps/session-manager/src/emulator` and `packages/terminal-config`, but the S1 tests live in `apps/session-manager/test/emulator/` (coordination rule). Add that path to the area so `pnpm test:area terminal` runs the T1 measurements.
- If the web app loads `@xterm/addon-image` or `@xterm/addon-clipboard`, add their query forms (XTSMGRAPHICS `CSI ? Pi ; Pa ; Pv S`; OSC 52 is already covered) to the silencer, and their state to the server, or do not load them.
- Track OSC 4/10/11/12 color changes in the mode tracker if themes set by applications (base16 scripts, pywal) should survive a reattach.
- Once `@xterm/xterm` is installed, check that its renderer draws 16-color and 256-color indexes 0–7 the same way under "bold as bright" (SerializeAddon defect 5).
