# ADR-0002 — tmux control-mode protocol core (spike S2)

- **Status:** accepted. Decision: **GO** for tmux control mode (`tmux -u -C` over an SSH exec channel without a PTY).
- **Date:** 2026-10-15
- **Scope:** plan §5.11 (remote command rule, probe), §6.3 (launch), §6.4 (parser), §6.5 (input), §6.6 (resize), parts of §6.7 and §6.10.
- **Code:** `apps/session-manager/src/drivers/tmux-control/` (`lines`, `unescape`, `parser`, `correlator`, `input`, `commands`), `src/probe/`, `src/transport/ssh/`.
- **Evidence:** the recorded transcripts in `apps/session-manager/test/fixtures/tmux/<image>/` (`session.*`, `attach.*`), re-recordable with `node apps/session-manager/test/tmux/record-fixtures.ts`. T0 tests replay them; T1 tests run a live session.

## Context

Termavox protects sessions with an invisible per-session tmux server driven in control mode (plan §6.1). Before building `TmuxControlDriver`, S2 had to confirm the byte framing, reply correlation, escaping and launch quoting against real tmux builds, and find the version quirks.

## Versions tested

All images use distro packages only (`test/sshd/*.Dockerfile`). The user shell is bash, with no systemd or logind.

| Image | Base | `tmux -V` (package) | Probe `utf8_locale` | openssh-server | bash |
|---|---|---|---|---|---|
| `no-tmux` | alpine:3 (3.24) | absent | `C.UTF-8` (musl-locales 0.1.0-r1) | 10.3_p1-r1 | 5.3.9-r1 |
| `tmux-3.2a` | ubuntu:22.04 | `tmux 3.2a` (3.2a-4ubuntu0.2) | `C.utf8` | 1:8.9p1-3ubuntu0.18 | 5.1-6ubuntu1.1 |
| `tmux-3.4` | ubuntu:24.04 | `tmux 3.4` (3.4-1ubuntu0.1) | `C.utf8` | 1:9.6p1-3ubuntu13.20 | 5.2.21-2ubuntu4 |
| `tmux-edge` | alpine:edge | `tmux 3.8` (3.8-r0) | `C.UTF-8` (musl-locales 0.1.0-r1) | 10.6_p1-r1 | 5.3.9-r2 |

On every tmux image the probe reported `ti_tmux256=yes`, `systemd_run=no`, `kill_user_processes=unknown` and `linger=unknown`. The probe also ran unchanged under fish, tcsh and zsh as the login shell (a throwaway alpine:edge container).

## Framing confirmed (identical on 3.2a, 3.4 and 3.8)

- `-C` (not `-CC`) over a PTY-less exec channel produces plain `\n`-terminated lines: no DCS prefix, no `\r`. stdout carries the protocol and stderr stays empty.
- **Guards.** The triple is `%begin <time> <num> <flags>` and `%end|%error` with the same triple. `time` is epoch seconds when the command fired. `num` is a **server-global** counter with gaps (e.g. 270 → 272 between two of our commands), so it cannot detect lost replies. Correlation is FIFO.
- **Launch blocks.** Each argv command of the launch line (`start-server` + 6 × `set-option` + `new-session`) produces its own block with **flags 0**. All 8 were `%end` on every version, so every option is accepted on 3.2a. Every command written to stdin gets flags 1.
- **One block per command.** A stdin line `a ; b ; c` produces **one block per command**, not one per line.
- **Execution error mid-line.** If a command fails at runtime, tmux **drops the rest of that line**: no blocks for the remaining commands. The correlator therefore finishes a multi-command entry at the first `%error`; waiting for N blocks would hang.
- **Parse error.** A parse error (e.g. an unknown command) yields **one** `%error` block for the whole line, with the text `parse error: unknown command: …`.
- **`%output` escaping.** Bytes < 0x20 and `\` are written as `\ooo` (three octal digits). Everything else is raw, including UTF-8 and DEL. Wide CJK and emoji arrived raw and intact.
- **`%extended-output`.** After `refresh-client -f pause-after=N`, output arrives as `%extended-output %<pane> <age-ms> : <data>`. 3.8 splits output more finely (`ec` / `ho after…`). Ages were 0–1 ms locally.
- **`%layout-change`.** After `refresh-client -C 100x30`, the `%end` of the reply comes first, then `%layout-change @0 a87d,100x30,0,0,0 a87d,100x30,0,0,0 *` (layout, visible layout, window flags), then a redraw `%output` (bash reacts to SIGWINCH).
- **`kill-server`.** Its reply block arrives **before** `%exit`. 3.2a and 3.4 send `%sessions-changed` in between; 3.8 does not. The control client exits with code 0.
- **Attach.** Attaching to an existing session (`new-session -A`) sends the 8 flags-0 blocks and `%session-changed $0 main`, with **no screen content**. This confirms that a snapshot via `capture-pane` is required (§6.8).
- **Startup notifications for a new server.**
  - 3.2a and 3.4: `%window-add @0`, `%sessions-changed`, `%session-changed $0 main`, `%window-renamed @0 bash`.
  - 3.8: the same without `%window-add`.
  - Ids always start at `$0 @0 %0`.
- **Stale control clients.**
  - Control clients without a tty are named `client-<pid>`.
  - `detach-client -t client-N` makes the detached client print `%exit` (no reason) and exit 0. The other client sees `%client-detached client-N`.
  - Closing stdin (EOF) detaches the same way. The session survives (`has-session` exits 0).
- **Shell exit.** With `detach-on-destroy on`, a shell `exit` ends the session and the client gets `%exit` (no reason). On 3.8 the shell's **last output was cut** (`ex` arrived, then `%exit`, without `it\r\nlogout`). The final bytes of a dying shell are not guaranteed.
- **Paused panes.** Output produced while a pane is paused is **discarded** by tmux (`echo paused` never arrived). After `continue`, a full resync is mandatory, as plan §6.7 assumes.
- **`has-session`** as a separate exec exits 0 while the session exists. Otherwise it exits 1 with `no server running on /tmp/tmux-<uid>/<socket>` on stderr.
- **Sentinel.** The `snapshot`-style batch (4 captures + `display-message -p 'tv-<nonce>'` on one line) returned 4 blocks followed by the sentinel on all versions.

## Contradictions with the research and plan

1. **Notifications do occur inside reply blocks.** This contradicts the tmux manual ("a notification will never occur inside an output block"). Notifications generated synchronously by our own command are written between its `%begin` and `%end`:

   | Command | 3.2a | 3.4 | 3.8 |
   |---|---|---|---|
   | `refresh-client -A '%0:pause'` → `%pause %0` | inside block | inside block | after `%end` |
   | `refresh-client -A '%0:continue'` → `%continue %0` | inside block | inside block | after `%end` |
   | `display-message 'x'` (no `-p`) → `%message x` | not emitted | inside block | inside block |

   The parser keeps the plan's rule: every line inside a block is data. The alternative would let pane text spoof notifications. **Driver consequence:** after sending `refresh-client -A '%<pane>:continue'`, treat a successful reply as the continue acknowledgement. It may carry `%continue %<pane>` as a data line (≤ 3.4) or be followed by a real `%continue` event (3.8). Never wait for the event alone. Automatic `%pause` (from `pause-after`) is emitted outside any command; S4 must still record it under load.
2. **Correlation granularity.** The plan says "one queue entry per command" and "a `%begin` with flags & 1 pops the head". The implementation uses one queue entry per **line**, which knows how many commands it holds. Every flags-1 block is attributed to the head entry. The entry completes after N blocks or at the first `%error` (see "Framing confirmed"). This is equivalent for single commands and correct for batches.
   - **`sendBatch` results.** A batch whose command fails resolves `{ ok: false, blocks }` (the blocks received, ending with the `%error`) instead of rejecting with a desync error. tmux skips the rest of the line, so the sentinel never arrives, and that is a command failure, not a desync.
   - `TmuxDesyncError` is reserved for: a final block that is present but is not exactly the sentinel line, or a solicited block with nothing pending. The driver can treat either as a resync trigger.
3. **`display-message -p` expands strftime as well as formats.** `'%end 1 2 1'` printed `15nd 1 2 1` (`%e` is the day of the month). Sentinels must not contain `%`. The nonce uses `[a-z2-7]` only.
4. **csh-family login shells reject `-lc`.** tcsh accepts `-l` only as the sole flag. The pane command without a startup command (`"$SHELL" -l`) works under tcsh. The startup-command form `"$SHELL" -lc '<cmd>'` fails there with `Unknown option: -lc`. The driver workstream should use `-c` (non-login) for csh/tcsh when a startup command is set (the probe reports `shell`).
5. **OpenBSD version strings.** `openbsd-X.Y` has no tmux version number. `parseTmuxVersion` maps it to the newest portable tmux release published before that OpenBSD release, as an **approximate lower bound** (`approximate: true`). The mapping table was written from memory, not verified against OpenBSD sources or release notes. Verify it before relying on 3.5–3.7 gates for OpenBSD hosts. The 3.2 gate (OpenBSD ≥ 6.9) is the only one that matters today.
6. **Alpine.** musl has no `locale -a` unless `musl-locales` is installed. The probe falls back to `C.UTF-8` when `/lib/ld-musl-*` exists, because musl always supports UTF-8. Ubuntu lists `C.utf8`, and the probe returns names exactly as `locale -a` lists them.

## Remote quoting (plan §5.11 remote command rule)

The launch command passes through four layers:

1. the login shell parses `exec sh -c '<script>'`;
2. `sh` parses the script;
3. tmux receives argv and splits commands on `;` arguments;
4. tmux runs the pane command with `default-shell -c` (the user's `$SHELL`).

`shQuote` emits only constructs that sh, bash, zsh, fish and csh read the same way:

- `'` becomes `'\''`.
- `\` becomes `'\\'`. fish treats `\\` and `\'` as escapes even inside single quotes, so a backslash never stays inside quotes.
- Scripts stay on one line (csh cannot hold a newline inside quotes) and contain no `!`.

Verification:

- On all three tmux images, a startup command containing `'`, `$`, `\` and `"`, plus an `-e` value with a space and quotes, reached the pane intact (`[x y] [a'b $HOME \x] [unset]`). `TMUX` is unset in the pane.
- Under fish and tcsh as the login shell, layers 1–4 worked. Layer 5 (the startup command itself) is parsed by the user's own shell by design.
- T0 tests check the exact argv tmux receives (a fake `tmux` dumps its argv through a real local `sh`), and that the pane command reaches tmux as **one** argument. If it arrived as several arguments, tmux would exec them directly with `exec` as the program.

### Final launch command (as executed on tmux-3.2a; values from the probe)

> **Superseded detail (2026-10-15):** the driver (ADR-0003) extended this command with `new-session -A -P -F tv-created` (to know whether the session was created) and `set-option -gqw scroll-on-clear off`. `launchCommand()` in `commands.ts` is the source of truth.

The script, before the outer quoting layer:

```sh
export LC_CTYPE=C.utf8; exec /usr/bin/tmux -u -L tv-fixture-xcymx6hs -f /dev/null -C start-server \; set-option -g history-limit 2000 \; set-option -g default-terminal tmux-256color \; set-option -g aggressive-resize off \; set-option -g detach-on-destroy on \; set-option -g window-size latest \; set-option -g status off \; new-session -A -s main -x 80 -y 24 -e TV_FIXTURE=yes 'exec env -u TMUX -u TMUX_PANE "$SHELL" -l'
```

The remote command sent on the exec channel:

```sh
exec sh -c 'export LC_CTYPE=C.utf8; exec /usr/bin/tmux -u -L tv-fixture-xcymx6hs -f /dev/null -C start-server '\\'; set-option -g history-limit 2000 '\\'; set-option -g default-terminal tmux-256color '\\'; set-option -g aggressive-resize off '\\'; set-option -g detach-on-destroy on '\\'; set-option -g window-size latest '\\'; set-option -g status off '\\'; new-session -A -s main -x 80 -y 24 -e TV_FIXTURE=yes '\''exec env -u TMUX -u TMUX_PANE "$SHELL" -l'\'
```

Variants produced by `launchCommand()`:

- With a startup command, the pane command becomes `exec env -u TMUX -u TMUX_PANE "$SHELL" -lc <quoted>`.
- With the logind rule (§5.11), `exec /usr/bin/tmux` becomes `exec systemd-run --user --scope --quiet /usr/bin/tmux`. The containers have no systemd, so S5 must verify this prefix.

`has-session` is sent as `exec sh -c 'exec /usr/bin/tmux -L <socket> has-session -t main'`.

## Other implementation notes

- **Input.** `send-keys -H -t %<pane> <hex> …`, at most 1024 input bytes per command. Control bytes, ESC and UTF-8 typed through it were echoed correctly on all versions.
- **Login-shell noise.** A login shell's rc files run before `exec sh` (bash sources `.bashrc` for sshd commands). Anything they print reaches stdout before tmux starts. The probe parser ignores unknown lines. The parser reports stray non-`%` lines as `unknown` events, which the driver should ignore before the first block.
- **SSH transport.**
  - Host-key verification is a callback on the raw key blob. The fingerprint is OpenSSH `SHA256:<unpadded base64>` and matched `ssh-keygen -lf`.
  - An `unknown` key aborts the handshake with `HOST_KEY_REJECTED` and `details.pending`; a `mismatch` fails with `HOST_KEY_MISMATCH`. The handshake is never held open.
  - `pause()` on an exec channel stops ssh2 from replenishing the SSH window: 0 bytes arrived during a 1.5 s pause of `yes`.

## Decision

**GO.** Control mode works as designed on tmux 3.2a, 3.4 and 3.8.

- Framing, octal escaping, FIFO correlation (including flags-0 blocks), `send-keys -H` input, `refresh-client -C` resize and `%exit` handling all behave as specified, with the quirks above.
- The fixtures make the parser and correlator testable in milliseconds.

**Follow-ups:**

- S3: snapshot boundary under load.
- S4: automatic `%pause` with `pause-after`, under real backpressure.
- S5: systemd-run and logind, socket loss, and reboot detection.
- Driver workstream: the in-block `%continue` handling and csh `-c` (both described above).
