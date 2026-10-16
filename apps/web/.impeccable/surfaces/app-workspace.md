---
version: 1
slug: "app-workspace"
primary_target: "app/workspace"
related_targets: ["app/login","app/setup","app/hosts"]
---

# Workspace — surface brief

**Scope and mode.** `/workspace` (desktop and phone), its in-pane overlays and the Ctrl+K palette; Operate. The auth surfaces (`/login`, `/login/two-factor`, `/setup`, forced password and TOTP flows) and the management pages (hosts, credentials, activity, settings, admin) inherit this world through the same shell vocabulary.

**Audience and job.** Developers and operators returning to long-lived sessions (typically up to ~10). After login they land straight in their last layout with sessions already restored. On a phone they check health and run quick commands during incidents, often at night.

**Constraints.** Standard web controls only; the terminal owns every key when focused (app shortcuts use Ctrl+Shift); no modals for routine flows (host-key trust and OTP prompts are in-pane panels); protection state always visible; English default with pt-BR; dark only (D-26); Plus Jakarta Sans for the UI, JetBrains Mono for codes and keys; no `backdrop-filter`, gradient animation or glow over a live terminal; every motion stills under reduced motion.

**Kept disciplines.** Terminate is isolated by deliberate space; ended sessions stay listed, marked Ended (collapsed group, last 20); state colours mean session state only; the followed session is marked by fill and outline, never by shifting it sideways (D-28); unfocused panes dim slightly; a state change moves a row to its new group in one crisp step; tabular figures for every live value.

**Owner decisions carried (D-26, D-28).** Account menu (name + gear) holding settings (with a "Language…" item that opens a dialog), admin and sign-out; the session list collapses to a narrow rail from a toggle at its left, remembered per browser; auth pages keep a discreet language control; signed-in pages expose language only through that dialog and account settings, never as a top-level choice.

## Direction contract

THESIS: A night cabin at cruise: the room is dimmed to deep violet, one cyan reading light marks the seat you are in, and every other signal is a small coloured lamp with its word beside it. Refuses the neon hacker console (near-black with glowing edges and mono costume) and the white SaaS card dashboard (grey ground, blue buttons, border-plus-shadow cards everywhere).

OWN-WORLD: Deep violet-navy ground (#171431) with a static magenta glow bleeding in at the top-right frame edge and a violet glow at the bottom-left; translucent cards (white at 4.5 % with a 1 px white line at 9 %, 16 px corners); sky-cyan (#4cc9ff) as the one accent, owning primary actions, selection, focus and the followed session; magenta (#ff5fae) for attention only (Action required, bells); state lamps green / blue / amber / magenta / red / slate as 8 px dots beside their words; Plus Jakarta Sans in sentence case, 400 / 500 / 600, a compact fixed scale (11–22 px), tabular figures; near-black terminal panes (#0c0b16) framed by a 1 px line. Raised by the midnight transit diagram's discipline, "the chosen line burns brightest": one accent owns selection and nothing else competes with it. Raised by the datamatics' data discipline: every live value is tabular at one size. Raised by the timetable's rank-by-weight: rows use at most two sizes and carry hierarchy through weight and ink level.

STORY: The operator sees every session's state at a glance from the lamps and group headers, follows one by its light, keeps typing in restored panes, and notices trouble as a row moving up into Action required under a magenta lamp. From the same sidebar they reach hosts, credentials and activity, and from their name the account menu.

FIRST VIEWPORT: Left, an 18 rem sidebar on the ground: the toggle glyph and the Termdock mark on the first row, New session (cyan, with its Ctrl/⌘K keys) under it, then the session groups (Action required, Disconnected, Reconnecting, Restoring, Connecting, Connected, Ended collapsed) as 48 px rows: state dot, label over user@host, protection mark, uptime, row menu; the followed row filled with cyan at 14 % inside a 1 px cyan ring. Below the groups, three nav rows (Hosts, Credentials, Activity) and the account row (avatar initial, name, gear) that opens the account menu. Right, a 44 px tab row whose active tab is a translucent segment with a cyan underline, over split terminal panes in near-black frames with 12 px corners; overlays are translucent cards inside the pane. The rail: 3.5 rem wide, the mark, the toggle, a round New session, then one 36 px tile per session (initials plus its state dot, the followed one lit), the nav icons and the avatar. Phone: the sidebar is the switcher screen (brand and avatar on the first row); one session opens full screen under a 48 px header with the extra-key bar at the bottom.

FORM: Night cabin at cruise, position 1 of the ordered grounded list (cabin, aurora field, midnight transit diagram, control-room annunciator, instrument cluster, dark production console, arcade marquee). The roll assigned index 7 (arcade marquee), which cannot carry a calm terminal runtime and is overruled by the owner's brief-pinned world (D-26: the reference screenshot's palette, materials and type); seed:ac042af21baf3d32. Signature move, "the reading light": one cyan light marks the followed session and travels with it, from the row (fill and ring) to its tab (underline) to its pane (top rule); following another session moves the light in a 180 ms view transition, instant under reduced motion. Challengers: ikeda-datamatics declined (donated tabular discipline); emigre-bitmap-specimen declined; rw-timetable-slide-rack declined (donated rank-by-weight); midnight-transit-diagram competitive on audience identification, declined on clarity (donated "the chosen line burns brightest"); rw-centre-rail-reference-setting declined; doujin-event-catalog declined (its packed grid honesty informs the rail's tiles).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
