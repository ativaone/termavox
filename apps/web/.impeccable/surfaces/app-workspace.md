---
version: 1
slug: "app-workspace"
primary_target: "app/workspace"
related_targets: ["app/login","app/setup"]
---

# Workspace — surface brief

**Scope and mode.** `/workspace` (desktop and phone) and the in-pane overlays; Operate. The auth surfaces (`/login`, `/login/two-factor`, `/setup`, forced password/TOTP flows) inherit this world.

**Audience and job.** Developers/operators returning to long-lived sessions (typically up to ~10). After login they land straight in their last layout with sessions already restored. On a phone they mostly check health and run quick commands during incidents.

**Constraints.** Standard web controls only; the terminal owns every key when focused (app shortcuts use Ctrl+Shift); no modals for routine flows (host-key trust and OTP prompts are in-pane panels); protection state always visible; English default with pt-BR.

**Kept disciplines.** Terminate is isolated by deliberate space; ended sessions stay listed, stamped Ended (collapsed lane, last 20); state colours are used for state only; the followed session stays highlighted from bay to tab to pane; unfocused panes dim slightly; state changes are crisp two-step transitions, never fades; tabular figures for every live value.

## Direction contract

THESIS: Every session is a strip in a bay: a compact, state-coded record read in one glance and returned to exactly as it was left. Refuses the neon hacker console and the white SaaS card dashboard.

OWN-WORLD: Slate-blue shell (bay, tab bar); warm buff strips for sessions with a 4 px state edge (green connected, amber reconnecting, signal orange action required, slate ended); condensed grotesk caps on strip labels, a workhorse grotesk for UI, tabular figures; hairline cell rules inside strips; near-black terminal panes framed by the slate.

STORY: The operator sees every session's state at a glance, keeps typing in restored panes, and notices trouble as a strip changing edge colour and moving to Action required.

FIRST VIEWPORT: Left, the bay: state lanes (Action required, Reconnecting, Connected, Ended collapsed), only non-empty lanes, each strip showing label, user@host, protection mark and uptime; "New session" and the Ctrl+K hint at its top. Right, slate tab bar over split terminal panes; overlays as buff panels inside panes. Phone: the bay is the switcher screen; one pane full screen with a lean key bar.

FORM: Air-traffic flight progress strip board, position 1 of the ordered list; seed:d4e92b2e5ae919ea. Signature move: a state change slides the strip to its new lane while its edge recolours, in a two-step 120 ms motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
