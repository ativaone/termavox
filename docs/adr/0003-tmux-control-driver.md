# ADR-0003 — TmuxControlDriver: snapshot boundary, flow control and lifecycle (spikes S3, S4, S5)

- **Status:** accepted. Decision: **GO** for the tmux-control protection design (rebuild from `capture-pane` at attach and after `%pause`, with the boundary rule of plan §6.8), with the unrecoverable state listed below.
- **Date:** 2026-10-15
- **Scope:** plan §6.3–§6.10, §5.5 (tmux-control ingest), §5.7 (protected restore), §5.11 (logind rules); corrections to §6.8.
- **Code:** `apps/session-manager/src/drivers/tmux-control/`: `driver.ts` (TmuxControlDriver), `rebuild.ts` (state format, snapshot batch, capture parsing, rebuild bytes), `boundary.ts` (OutputGate). Additive changes in `commands.ts` (launch marker, `scroll-on-clear`, builders), `correlator.ts` (synchronous batch hooks) and `parser.ts` (`paneSizeFromLayout`).
- **Evidence:**
  - T0 `apps/session-manager/test/tmux/rebuild.test.ts`: rebuild from recorded captures of the three versions (`test/fixtures/tmux/<image>/rebuild.{bin.gz,json}`, re-recordable with `node apps/session-manager/test/tmux/record-rebuild-fixtures.ts`), plus the boundary gate on a recorded mid-flood interleaving.
  - T1 `driver-boundary.int.test.ts` (S3), `driver-flow.int.test.ts` (S4), `driver-lifecycle.int.test.ts` (S5), with `driver-harness.ts` (stub runtime, pipe-pane reference, TCP proxy) and `compare.ts` (cell-by-cell comparison).

## Context

ADR-0002 confirmed the control-mode protocol. S3–S5 had to prove what plan §6.8 only derived from the tmux source:

- **S3:** output received before a capture is contained in it, output after it is not, so an emulator rebuilt from a capture taken mid-flood plus the later output equals an emulator fed the whole stream.
- **S4:** `pause-after`, `%pause`, continue + rebuild under real backpressure, and the daemon's memory bound.
- **S5:** daemon death, remote reboot, stale clients, shell exit, terminate, nested tmux.

## Versions tested

The same images as ADR-0002: `tmux-3.2a` (ubuntu:22.04), `tmux-3.4` (ubuntu:24.04) and `tmux-edge` (alpine:edge, tmux 3.8). T1 runs on 3.2a and 3.8 (core images); the T1 suites also ran once against 3.4 (`TD_TMUX_IMAGES=tmux-3.4`). The T0 fixtures cover all three. Machine: 2 vCPU, Node 24.16.0, `@xterm/headless` 6.0.0.

## How the driver works

**Start** (`start(ctx, dims)`), in order:

1. `ctx.transport.exec(launchCommand(...))`. `systemd-run --user --scope --quiet` prefix only when `KillUserProcesses=yes`, linger is on and `systemd-run` exists (`logindPolicy`). `default-terminal` comes from `tiTmux256` and `LC_CTYPE` from `utf8Locale`.
2. Consume the 9 flags-0 launch blocks. The last one (`new-session -A -P -F td-created`) contains `td-created` **only when it created the session**: `-A` returns before printing when it attaches. Verified on 3.2a, 3.4 and 3.8.
3. Detach other control clients (`list-clients`; `detach-client -t` every `client_control_mode=1` client except ours).
4. Read the identity: `display-message -p '#{session_created} #{pane_pid} #{pane_id} #{window_id}'` (no `%`). Call `onIdentity(identity, rebooted)`. `rebooted` means a previous identity existed and differs. Per the integration contract, the runtime writes the "remote host restarted" banner itself, so the driver never calls `ctx.banner`.
5. csh/tcsh with a startup command: the pane runs the plain login shell, and the driver types the command (`send-keys -H` + Enter) only when step 2 reported a **new** session.
6. `refresh-client -f pause-after=N` (default 5), then `refresh-client -C <cols>x<rows>`.
7. Snapshot batch, rebuild through `ctx.replaceState`, then live `%output` / `%extended-output` of the active pane through `ctx.output` (one call per stdout chunk).

**Snapshot batch** (one line, plus the nonce sentinel from `sendBatch`):

```text
capture-pane -p -e -J -N -t %P -S - -E -1      history (ignored when history_size = 0)
capture-pane -p -e -J -N -t %P                  screen (joined)
capture-pane -p -e -N -t %P                     screen rows (unjoined: pending wrap)
capture-pane -p -e -J -N -a -q -t %P            saved main screen (alternate screen active)
capture-pane -p -J -t %P -S -1 -E 0             wrap probe: 1 line back = last history line soft-wraps
display-message -p -t %P '<STATE_FORMAT>'       state, #{q:pane_title} last
capture-pane -p -P -C -t %P                     escape sequence pending in tmux's parser
```

The state format is the plan's, with three corrections:

- `mouse_all_flag` replaces `mouse_any_flag`. `mouse_any_flag` means "any mouse mode"; `?1003` is `mouse_all_flag`.
- `pane_key_mode` is dropped (xterm.js has no extended-key state to restore).
- `host` and `host_short` are added (see the title rule below).

**Boundary** (`OutputGate`). Pane output between the batch being written and its first `%begin` is dropped. Output inside the reply (between the first `%begin` and the last `%end`) is counted as a violation and the batch is retaken. Output and `%layout-change` after the last `%end` are held during the rebuild and replayed in order. A long rebuild stops reading the channel once 8 MiB is held. The correlator calls `onBegin` / `onEnd` **synchronously** from `handle()`, because a promise continuation would run only after the rest of the stdout chunk had been processed.

**Rebuild** (`rebuildBytes`, pure). Steps, in order:

1. Designate G1 as DEC Special Graphics. tmux reports line-drawing cells with SO/SI, and the tmux-256color `enacs` designates G1 the same way.
2. Write the content:
   - history lines, then screen lines, joined by CRLF, with the SGR pen tracked per line (`\e[0m\r\n<pen>`);
   - the last history line stays joined when the probe says it soft-wraps;
   - with the alternate screen active: history + saved main screen, CUP to `alternate_saved_x/y`, `?1049h`, alternate rows.
3. Write the modes: DECCKM, keypad, mouse 1000/1002/1003, encodings 1005/1006, `?1004` (3.8), bracketed paste, `?25l`, IRM, `?7l`, DECSCUSR (3.6+).
4. Write the scroll region before CUP, then origin mode, then the title.
5. Position the cursor: CUP relative to the region when origin mode is on. With a **pending wrap** (`cursor_x == pane_width`, which is how tmux represents it), print the cursor row again from column 1 instead, so the next character wraps.
6. Finish with the `-P` bytes, or else the `carry`: an incomplete UTF-8 character at the end of the dropped output, which tmux holds outside both the grid and `-P`.

**Other behaviour:**

- **Input:** coalesced for 3 ms, then pipelined `send-keys -H` (at most 1 KiB per command). `send-keys -X cancel` goes first when `pane_in_mode` is set (from the state, or re-read on `%pane-mode-changed`).
- **Resize:** `refresh-client -C`. `%layout-change` for our window goes to `ctx.resized`, using the pane's own cell, which also works in split layouts.
- **Pane changes:** the driver follows window and pane changes (`%window-pane-changed`, `%session-window-changed`, window close) and resyncs.
- **`%exit`:** confirmed with `has-session` in a fresh exec. Non-zero → `onShellExit({code: null})`; zero → `onDesync`. A channel EOF without `%exit` does nothing.
- **`detach()`:** sends an empty line and waits up to 3 s for `%exit`. **`terminate()`:** `kill-server` on the control client, or in a fresh exec when no client is left.
- **Desync:** any protocol inconsistency ends our control client only (never `kill-server`) and calls `onDesync` (after `start()`; during `start()`, `start()` rejects instead).

## S3 — snapshot boundary

**Verdict: the plan's assumption holds on 3.2a, 3.4 and 3.8.**

- No `%output` ever arrived between a batch's first `%begin` and its last `%end`: 0 violations in every run.
- Every golden comparison matched cell by cell.
- No fallback (pausing the pane around the capture) is needed. The driver keeps the retake-on-violation guard as a defence.

**T0, recorded captures.** One transcript per version with six scenarios:

1. colors (16/256/truecolor, bold/dim/italic/underline styles/inverse/strike/overline), 30-line history and wrapped lines;
2. alternate-screen application with a scroll region, the cursor mid-screen, DECCKM, keypad, SGR mouse, hidden cursor and a title;
3. origin mode with a scroll region, custom tab stops, IRM, a bar cursor and focus reporting;
4. wide characters at the right edge, emoji and combining marks;
5. a pending wrap;
6. a flood captured mid-output.

For every batch, three comparisons:

- the rebuilt emulator against one fed the raw stream up to the batch (static scenarios);
- after replaying the transcript through the gate exactly like the driver: rebuilt + held output against live, just before the next scenario;
- the same at the end of the transcript.

Result: **0 cell, cursor and mode differences** for every batch on all three versions. The flood batches dropped 20, 422 and 2,000 bytes and held about 24 KB. Mutation checks confirm the tests notice each of these when removed:

- the pending-wrap restore;
- the UTF-8 carry (synthetic unit);
- the overline workaround;
- 3.2's blank trimming.

**T1, live floods.** The pane's raw output is piped (`pipe-pane`) to a file from its first byte. The driver attaches on its own SSH connection while the flood runs. At the end, its emulator is compared with a fresh emulator fed the whole piped stream, scrollback 5,000 / `history-limit` 5,000:

| Flood (driver attached mid-flood) | tmux | Stream | Dropped before `%begin` | Applied after `%end` | Capture / build | Scrollback compared | Diffs |
|---|---|---|---|---|---|---|---|
| `seq 1 300000 \| awk` (UTF-8 + SGR reset per line) | 3.2a | 6.79 MB | 57–135 KB | 6.2–6.3 MB | 26–65 ms / 217–460 ms | 5,000 lines + screen | 0 |
| same | 3.4 | 6.79 MB | 70–89 KB | 6.2 MB | 29–49 ms / 253–304 ms | 5,000 lines + screen | 0 |
| same | 3.8 | 6.79 MB | 53–102 KB | 6.3–6.4 MB | 28–66 ms / 38–231 ms | 5,000 lines + screen | 0 |
| `yes` in bursts with sleeps | 3.2a | 1.1–4.3 MB | 4–74 KB | 0.8–3.8 MB | 17–51 ms / 42–66 ms | 5,000 lines + screen | 0 |
| same | 3.4 | 1.1 MB | 13–16 KB | 0.8 MB | 27–31 ms / 46–76 ms | 5,000 lines + screen | 0 |
| same | 3.8 | 1.1–4.3 MB | 0–78 KB (0 = captured between bursts) | 0.8–3.8 MB | 29–59 ms / 17–117 ms | 5,000 lines + screen | 0 |

Over all runs, 28 live mid-flood captures on 3.2a, 3.4 and 3.8 gave 0 diffs and 0 violations. Also under S5, a reattach after an abrupt TCP drop, captured while an application was drawing, matched the live stream (0 diffs).

### tmux quirks found by S3 (handled in `rebuild.ts`)

1. **`capture-pane -e` writes overline as `5:3`** (3.2a, 3.4 and 3.8). It formats every attribute code ≥ 10 as `a:b`, which is meant for the underline styles 42–45 (`4:2`…`4:5`), so 53 becomes `5:3`, which terminals read as blink. `fixCaptureSgr` rewrites it to `53`.
2. **`-S - -E -1` with an empty history returns the first screen row**: `-E -1` clamps to line 0. The history block is ignored when `history_size` is 0.
3. **3.2 pads captured lines** with default-attribute spaces up to its line allocation; 3.4+ stop at the last used cell. Writing the padding would overwrite what the rebuild itself paints there (see BCE below), so trailing default-pen blanks are trimmed. Spaces with any attribute are kept, and so is a line that soft-wraps into the next one.
4. **ED 2 and ED 0 at home push the screen into history** in tmux, but not in xterm.js. tmux ≥ 3.3 has `scroll-on-clear`: the launch now sets `set-option -gqw scroll-on-clear off` (`-q`: 3.2 ignores the unknown option and the launch continues; verified). 3.2 keeps the divergence.
5. **3.2a ignores `new-session -x/-y` from a control client** (`default-size` 80×24 applies until `refresh-client -C`). 3.4+ honour them. The driver always sends `refresh-client -C` before capturing.
6. **The default `pane_title` is the host name.** The title is restored only when it differs from `host` / `host_short`.
7. **`#{q:pane_title}` escaping differs:** 3.8 also escapes braces and doubles backslashes. One generic `\X → X` unescape gives the raw title on all three.

## Unrecoverable state (accepted, documented to users)

Applies to a rebuild only (reattach after a drop, daemon restart, `%pause`). Plain browser reattach still uses the server emulator (ADR-0001).

1. **The current SGR pen.** tmux does not expose it, so the rebuild ends with the default pen. Text that continues an SGR segment right after the boundary is drawn with default attributes until the next SGR.
2. **G0–G3 designations and GL/GR shift state.** After a rebuild G1 is DEC Special Graphics and G0 is ASCII.
3. **The DECSC saved cursor.** Only the alternate screen's saved position is exposed, and not the SGR saved with `?1049h`.
4. **Scrollback above tmux's trimmed history.** tmux drops 10 % of `history-limit` at a time, so a rebuilt scrollback holds 90–100 % of the lines. The lines it holds are identical.
5. **tmux 3.2 only: screens cleared by ED 2 / ED 0 at home** appear as extra history after a rebuild (quirk 4).
6. **Soft-wrap flags of revisited rows.** When output continues on a row after an explicit LF, xterm clears the row's wrapped state, but tmux keeps the stale wrapped flag on the row above (e.g. a shell redrawing over a row that used to wrap). Cells are identical; only reflow after a later resize and copy/paste line joining can differ. Seen once in the fixtures, on all three versions.
7. **Erased cells vs spaces.** tmux reports erased cells inside a line as spaces. They look the same; only copy/paste of trailing whitespace can differ.
8. **Background of rows created by a soft wrap.** xterm paints a row scrolled in by a wrap with the current background (BCE), tmux does not. The rebuild reproduces it for wraps at the bottom margin; rows at the top of the rebuilt content may lack it.
9. **Modes the tmux version does not report:**
   - bracketed paste before 3.7: heuristic, on in the normal screen (shells at a prompt enable it) and off in the alternate screen;
   - focus reporting (`?1004`) before 3.8;
   - cursor style (DECSCUSR) before 3.6;
   - synchronized output (`?2026`), reverse wrap (`?45`), and extended keys (no xterm.js equivalent).
10. **Tab stops.** Restored on the active buffer only. Column 0 is ambiguous: tmux never reports it.
11. **Title.** A title equal to the host name is not restored (indistinguishable from tmux's default). The icon name and the title stack are not restored.
12. **Hyperlinks (OSC 8)** are restored on ≥ 3.4 (tmux emits them in captures), not on 3.2.
13. **Width tables.** tmux's wcwidth and xterm's Unicode 11 agreed on CJK, 😀 and combining marks in every fixture. Newer emoji may still differ (plan §17).
14. **Images (sixel and others)** are not captured.

These are **restored**, contrary to the plan's earlier list:

- the pending-wrap flag (`cursor_x == pane_width`);
- an escape sequence cut by the boundary (`-P`);
- a UTF-8 character cut by the boundary (carry);
- overline (quirk 1), underline styles and underline colour (`4:x`, `58`).

## S4 — flow control

**Pausing the exec channel works as designed.** `pauseOutput()` pauses the SSH stream (ssh2 stops replenishing the window) and the driver's read loop. **0 bytes** arrived or queued on the channel during 2–3.5 s pauses of an endless `yes`, measured on the channel's queue with `TrackingTransport`. Daemon RSS moved by +0…+10 MiB, which is GC noise.

**What tmux does next depends on the other clients**:

| Case | tmux behaviour (3.2a and 3.8) | Driver |
|---|---|---|
| Our client alone, channel paused | tmux stops reading the pane's pty when every attached client is a control client with a full buffer (`server_client_check_pane_buffer`), so the application blocks and nothing is lost. A `%pause` still comes **sometimes**: when tmux resumes writing, it may hold blocks queued before it stopped the pane that are older than `pause-after`. | No rebuild needed: flowing again 66–716 ms after resume, state equal to tmux's (0 diffs). When the race produces a `%pause`, continue + rebuild (seen on 3.2a and 3.8). |
| A second client keeps the pane busy | Our client falls behind; after `pause-after` (1 s in the test) tmux discards our pane output and sends `%pause %0`. On 3.8 the pause sometimes needed more than 2 s of stall (3.5 s was reliable). | On resume: one line `refresh-client -A '%0:continue' ; <snapshot batch>`. The successful continue reply is the acknowledgement: 3.2a/3.4 carry `%continue` inside it, 3.8 after it. Rebuilt 158–939 ms after resume, with capture 68–116 ms and build 39–507 ms at about 4,600–5,000 history lines. State equal to tmux's (0 diffs) on 3.2a, 3.4 and 3.8. |

- **Remote memory:** the tmux server grew by 1.2–3.9 MiB during a 3.5 s stall, in both cases.
- **Daemon memory:** bounded by the channel's local queue (4 MiB high-water), one SSH window, and the 8 MiB hold cap during a rebuild.
- **What was measured.** The paused intervals were 2–5 s; there was no minutes-long run. The bound does not depend on duration: while paused, nothing reaches the daemon (0 bytes measured on the channel), and tmux either stops the pane or discards our output after `pause-after`. Neither side accumulates over time.
- **`too far behind`:** cannot happen with `pause-after` set; not observed.

**Rebuild cost at about 5,000 history lines** (80 columns, SGR-heavy):

- idle attach: 411–570 ms for the whole `start()`, with capture 103–104 ms and build 53–203 ms for 420–520 KB of rebuild bytes;
- mid-flood attach: capture 26–65 ms, build 17–460 ms. The 460 ms is on 3.2a, whose captures carry more SGR (`\e[0m\e[39m\e[49m`).

The 3.8 cap of 64 MiB on buffered replies is far above a 5k-line history (about 0.5 MB). Paging by range is a follow-up for very large scrollback settings.

## S5 — lifecycle

All checks pass on 3.2a and 3.8, and ran once on 3.4 (below). `driver-lifecycle.int.test.ts`:

1. **Daemon death mid-output.** Setup: the first driver connects through a local TCP proxy and creates the session; `seq 1 3000` runs, then an alternate-screen application with modes, a scroll region and a 50 ms tick. The proxy drops both sockets mid-tick.

   A **new** `SshTransport` and a **new** driver, given the persisted identity, reattach:
   - `rebooted=false`, `created=false`;
   - the in-application screen equals the live stream (0 diffs);
   - after quitting the application, the normal screen and scrollback (`1`…`3000`) equal it as well (0 diffs).
2. **Remote reboot.** `detach()` leaves the server running (`has-session` = 0). After `kill-server`, a driver with the previous identity reports `rebooted=true` and `created=true`, and writes no banner (the runtime does).
3. **Stale client.** A control client already attached is detached at start (`%exit`, exit 0) and only the driver's client remains. An external `detach-client` makes the driver's client exit; `has-session` = 0 leads to `onDesync`, with no `onShellExit`.
4. **Shell exit and terminate.** `exit` in the shell leads to `%exit`; `has-session` = 1 leads to `onShellExit({code: null})`. `terminate()` leaves no server (`tmux -L … ls`: no server running).
5. **Nested tmux.** `TMUX` is unset in the pane. The user's own `tmux new-session` runs inside the session (rc 0) without the nesting warning.
6. **csh-family startup.** The command is typed once into a new session, and not again on reattach.
7. **Resize and copy mode.** `resize()` is confirmed through `%layout-change`, which reaches `ctx.resized`. Input while the pane is in copy mode is preceded by `send-keys -X cancel`.

**Untested:**

- **logind** (`KillUserProcesses`, linger, `systemd-run --scope`). The approved images have no systemd. The §5.11 rules are implemented (`logindPolicy`), and the launch prefix is covered by `commands.test.ts`.
- **Socket deletion** (plan §6.10, SIGUSR1 recovery). Not implemented; see Follow-ups.

## Per-version deviations

- **3.2a:**
  - ED 2 / ED 0 at home go to history (no `scroll-on-clear`);
  - padded captures;
  - `-x/-y` ignored for control clients;
  - no OSC 8 in captures;
  - bracketed paste, focus and cursor style are not reported.
- **3.4:**
  - `scroll-on-clear` works and OSC 8 is captured;
  - bracketed paste, focus and cursor style are not reported.
- **3.8:**
  - full mode reporting (`bracket_paste_flag`, `cursor_shape` / `cursor_blinking`, `pane_private_modes` including 1004);
  - `%continue` after the reply block;
  - `%pause` may need more than 2 s of stall.

## 3.4 run

Ran at delivery: `TD_TMUX_IMAGES=tmux-3.4 pnpm exec vitest run --project t1` on the three driver suites. All 10 checks passed, twice (35 s, then 32 s after the final source changes):

- S3: both floods, 0 diffs;
- S4: both pause cases, 0 diffs vs tmux, 0 bytes queued while paused;
- S5: all 7 checks.

The T0 fixtures include a 3.4 transcript.

## Decision

**GO.** Capture plus rebuild reproduces the live terminal cell by cell on 3.2a, 3.4 and 3.8:

- at rest;
- mid-flood, across the boundary (including cut escape sequences and UTF-8 characters);
- after `%pause`;
- after a daemon death;

minus the documented list above. The boundary rule needs no fallback. Flow control is bounded on both sides, and the lifecycle edge cases behave as plan §6.10 requires.

## Follow-ups

- **Socket deletion** (plan §6.10). Today a deleted socket looks like a dead server: the launch creates a new session (`rebooted=true`) and orphans the old server. Before relaunching with a previous identity, try `pkill -USR1 -u "$(id -u)" -f 'tmux.*-L <socket> '` (tmux recreates its socket), then reattach.
- **Exec-channel EOF without `%exit`** while the SSH connection stays up (e.g. tmux crashed). The driver does nothing, as specified, so the runtime should treat the control channel's close as a transport loss.
- **Reboot banner.** In tmux-control the emulator mirrors tmux's grid. A banner written into it is lost at the next rebuild and moves the cursor away from tmux's. An out-of-band UI notice is safer.
- **History paging** by `history_size` ranges for scrollback settings well above 5k lines (3.8's 64 MiB reply cap).
- **Bracketed paste before 3.7:** the heuristic (on in the normal screen) is an owner decision.
- **ADR-0002's "Final launch command"** predates two launch additions: `set-option -gqw scroll-on-clear off`, and `-P -F td-created` on `new-session`.
