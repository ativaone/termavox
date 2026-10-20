# Architecture decision records

Each ADR records a spike outcome or a design decision: the context, the evidence (tests and
recorded fixtures), the decision and its consequences. The plan they refine is
[`docs/implementation-plan.md`](../implementation-plan.md); the
[architecture overview](../architecture.md) shows where each decision lands in the code.

| ADR | Title | Status | Summary |
|---|---|---|---|
| [0001](0001-emulator-fidelity.md) | Emulator fidelity, snapshot barrier and query silencer (spike S1) | Accepted (2026-10-15) | GO for `@xterm/headless` 6 with the serialize addon as the authoritative server emulator, provided snapshots carry a mode epilogue and parser tail, both sides write UTF-8-aligned chunks, and snapshots are cached. |
| [0002](0002-tmux-control-protocol.md) | tmux control-mode protocol core (spike S2) | Accepted (2026-10-15) | GO for `tmux -u -C` over an SSH exec channel without a PTY: framing, escaping, reply correlation, `send-keys -H` input and resize verified on tmux 3.2a, 3.4 and 3.8. |
| [0003](0003-tmux-control-driver.md) | TmuxControlDriver: snapshot boundary, flow control and lifecycle (spikes S3, S4, S5) | Accepted (2026-10-15) | GO for protecting sessions by rebuilding the emulator from `capture-pane` at every attach and after `%pause`, with the snapshot boundary rule and the listed unrecoverable state. |
| [0004](0004-auth-better-auth.md) | Web authentication on Better Auth (spike S6) | Accepted (2026-10-15) | GO on Better Auth 1.7.7 for username sign-in, TOTP and admin user management; Termavox adds the per-(username, IP) lockout, forced password change and TOTP enrollment, the setup token and the WebSocket ticket issuer. |

New ADRs take the next number, use the same header (status, date, scope, code, evidence), and
are added to this table.
