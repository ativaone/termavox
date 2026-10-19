---
name: Termdock
description: A night cabin for persistent terminals: deep violet ground, translucent cards, one cyan reading light on the session you follow, small state lamps beside their words.
colors:
  ground: "#171431"
  ground-deep: "#110f24"
  pane: "#0c0b16"
  surface: "rgb(255 255 255 / 0.045)"
  surface-raised: "rgb(255 255 255 / 0.08)"
  surface-pressed: "rgb(255 255 255 / 0.12)"
  surface-solid: "#221e42"
  field: "rgb(12 10 24 / 0.55)"
  line: "rgb(255 255 255 / 0.09)"
  line-strong: "rgb(255 255 255 / 0.36)"
  ink: "#f2f0fb"
  ink-muted: "#aba7cb"
  ink-faint: "#7a76a0"
  accent: "#4cc9ff"
  accent-strong: "#22b5f2"
  accent-soft: "rgb(76 201 255 / 0.14)"
  accent-ring: "rgb(76 201 255 / 0.55)"
  on-accent: "#0a1226"
  attention: "#ff5fae"
  attention-soft: "rgb(255 95 174 / 0.18)"
  state-connected: "#3ddc97"
  state-progress: "#5aa8ff"
  state-reconnecting: "#f5b84a"
  state-action: "#ff5fae"
  state-disconnected: "#ff6b7d"
  state-ended: "#8984b0"
  danger: "#ff8a98"
  danger-fill: "#c9304b"
  danger-soft: "rgb(255 107 125 / 0.16)"
  warning-soft: "rgb(245 184 74 / 0.16)"
  info-soft: "rgb(76 201 255 / 0.14)"
  success-soft: "rgb(61 220 151 / 0.14)"
  focus: "#7fd9ff"
  selection: "rgb(76 201 255 / 0.32)"
  glow-magenta: "rgb(255 79 163 / 0.24)"
  glow-violet: "rgb(124 92 255 / 0.24)"
  white: "#ffffff"
typography:
  title:
    fontFamily: "Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: "1.75rem"
    letterSpacing: "-0.01em"
  subtitle:
    fontFamily: "Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: "1.5rem"
  body:
    fontFamily: "Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
  body-form:
    fontFamily: "Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: "1.5rem"
  label:
    fontFamily: "Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: "1.125rem"
  help:
    fontFamily: "Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.125rem"
  row-label:
    fontFamily: "Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: "1rem"
  group-label:
    fontFamily: "Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: "1rem"
  data:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: "1rem"
    letterSpacing: "-0.01em"
    fontFeature: "'tnum'"
  code:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
rounded:
  xs: "6px"
  sm: "8px"
  control: "10px"
  row: "12px"
  card: "16px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
  3xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "36px"
  button-primary-active:
    backgroundColor: "{colors.accent-strong}"
    textColor: "{colors.on-accent}"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-pressed}"
    textColor: "{colors.ink}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  button-quiet-hover:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
  button-destructive:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "36px"
  button-destructive-hover:
    backgroundColor: "{colors.danger-fill}"
    textColor: "{colors.white}"
  input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    typography: "{typography.body-form}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "44px"
  input-compact:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "20px 24px"
  card-solid:
    backgroundColor: "{colors.surface-solid}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "16px 20px"
  session-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.row-label}"
    rounded: "{rounded.row}"
    height: "48px"
  session-row-hover:
    backgroundColor: "{colors.surface-raised}"
  session-row-followed:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.ink}"
  session-tile:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.control}"
    size: "36px"
  group-count:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.pill}"
    padding: "0 6px"
    height: "18px"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    typography: "{typography.row-label}"
    rounded: "{rounded.control}"
    height: "32px"
  tab-active:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
  tag:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "20px"
  notice:
    backgroundColor: "{colors.info-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "12px 14px"
  nav-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.control}"
    padding: "0 8px 0 10px"
    height: "36px"
  nav-row-current:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
  menu-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "36px"
  key:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "44px"
  key-armed:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
  kbd:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.xs}"
    height: "20px"
---

# Design System: Termdock

## Overview

**Creative North Star: "The Night Cabin"**

Termdock is used in dim rooms, at night, next to near-black terminals. The interface is a cabin at cruise: the room is dimmed to a deep violet-navy with a faint magenta and violet glow at two frame edges, every working surface is a translucent card lit from within (a faint white fill and a 1 px light line), and one cyan reading light marks the seat you are in: the session you follow. Everything else that carries meaning is a small lamp beside its word: green, blue, amber, magenta, red or slate for session state, never for decoration.

The system refuses two category defaults. It is not the neon hacker console (near-black, glowing edges, monospace as a costume): the terminal keeps its own near-black pane and the chrome around it is calm, sentence-case and proportional. It is not the white SaaS dashboard either (grey ground, blue buttons, a card for everything): there is one ground, one accent, and cards hold forms, tables and overlays, never the page's structure.

Density is operator density on a compact fixed scale: 48 px session rows, 36 px navigation rows, 32 px tabs, one or two type sizes per component with hierarchy carried by weight and ink level. Motion is two crisp steps on an exponential ease-out (120 ms to recolour or press, 180 ms to move) and stills completely under reduced motion. Dark only (plan D-26).

**Key Characteristics:**
- One ground (#171431) with two static edge glows; opaque near-black panes (#0c0b16) for terminals.
- Translucent cards: white at 4.5 % with a 1 px white line at 9 % and 16 px corners.
- One accent, sky cyan (#4cc9ff): primary actions, selection, focus and the followed session.
- Magenta (#ff5fae) means attention: Action required and bells, nothing else.
- Plus Jakarta Sans, sentence case, 400 / 500 / 600; JetBrains Mono only for codes, keys and fingerprints.
- The reading light: the followed session's fill and cyan ring travel with it from row to tab to pane.

## Colors

A dark restrained palette: violet-tinted neutrals, one cyan accent, magenta for attention, and six state lamps.

### Primary
- **Sky Cyan** (`accent` #4cc9ff): the one filled control on a screen (primary buttons, the armed Ctrl key), links, the search mark, the active tab's underline, the focused pane's top rule and the followed session's ring (`accent-ring`) and fill (`accent-soft`, 14 %). Pressed is `accent-strong` (#22b5f2); text on it is `on-accent` (#0a1226, 9.9:1).

### Secondary
- **Attention Magenta** (`attention` #ff5fae): the Action required lamp and group count, the bell mark. It is also the top-right edge glow at 24 % (`glow-magenta`), where it sits behind nothing that must be read.
- **Violet Glow** (`glow-violet`, rgb(124 92 255 / 0.24)): the bottom-left edge glow of the ground.

### Tertiary
- **State lamps**, 8 px dots and nothing else, always beside their word: Connected (`state-connected` #3ddc97), Connecting and Restoring (`state-progress` #5aa8ff), Reconnecting (`state-reconnecting` #f5b84a), Action required (`state-action`, the attention magenta), Disconnected (`state-disconnected` #ff6b7d), Ended (`state-ended` #8984b0). Every lamp reads at 3:1 or better on every surface it sits on.
- **Feedback**: `danger` (#ff8a98) for error text and destructive strokes, `danger-fill` (#c9304b, white text 5.2:1) for the destructive hover; soft fills `danger-soft`, `warning-soft`, `info-soft`, `success-soft` for notices and tags, whose text stays plain ink or the matching lamp colour.

### Neutral
- **Ground** (`ground` #171431): the page, the sidebar and the tab row. `ground-deep` (#110f24) is the phone key bar. `pane` (#0c0b16) is the terminal.
- **Surfaces**: `surface` (white 4.5 %) is a resting card, `surface-raised` (8 %) a hover or a lit control, `surface-pressed` (12 %) a press; `surface-solid` (#221e42, the card composited on the ground) is for anything that floats over a live terminal (menus, the palette, in-pane overlays), because nothing translucent may sit over a terminal. `field` (rgb(12 10 24 / 0.55)) is the dark well of an input.
- **Lines**: `line` (white 9 %) for hairlines and card edges; `line-strong` (white 36 %, 3.3:1 on a card) for control borders.
- **Ink**: `ink` (#f2f0fb, 14:1 on a card), `ink-muted` (#aba7cb, 6.9:1 on a card and 4.9:1 on the brightest notice), `ink-faint` (#7a76a0) for disabled text only.
- **Focus** (`focus` #7fd9ff): a 2 px outline 2 px off the element, everywhere.

### Named Rules
**The Reading Light Rule.** The accent owns selection: the followed session, the active tab, the focused pane, the highlighted palette row and the chosen choice card all use `accent-soft` and `accent-ring`. Nothing else is cyan but primary actions, links and focus.

**The Lamp Beside the Word Rule.** A state colour appears only as a lamp (or the ring of a group count) and always with its state word in reach: in the group header, the chip, the tab's screen-reader text or the tile's accessible name.

**The Opaque Over Terminals Rule.** Anything drawn over a live terminal (overlay cards, the progress chip, the palette) is `surface-solid` with no `backdrop-filter`; the scrim is a flat alpha of the pane colour.

## Typography

**Body Font:** Plus Jakarta Sans (variable, 200–800), self-hosted through `next/font`, with `ui-sans-serif, system-ui` fallback. The latin subset covers every Portuguese diacritic.
**Mono Font:** JetBrains Mono for codes, keys, fingerprints, the terminal (the terminal font is a user preference) and the Data role.

**Character:** one geometric sans in sentence case, regular for reading, medium for values, semibold for names and controls. No condensed or uppercase voice, no display face.

**Rendering:** the face ships `prep` and `gasp` tables, so FreeType takes its hinted path and Chromium rounds every advance to whole pixels at 1×; its space glyph is 0.170 em (2.4 px at 14 px), which rounded to 2 px and ran words together ("Addthis Dockerhost"). `html` therefore sets `text-rendering: geometricPrecision` (fractional advances, as the earlier Archivo build also needed), and every element carries `word-spacing: 0.06em` (declared per element, so it follows each element's own size), which brings the word space to about 0.23 em. Terminals and the terminal preview reset both (`[data-terminal]`, `.terminal-text`): the cell grid never inherits them.

### Hierarchy
- **Title** (600, 1.375rem / 1.75rem, -0.01em): page titles, auth card headings, empty-state headings.
- **Subtitle** (600, 1rem / 1.5rem): card section headings, overlay titles.
- **Body** (400, 0.875rem / 1.25rem): UI copy, intros, notices, table cells; prose capped at 65ch.
- **Body form** (400, 1rem / 1.5rem): typed values in inputs (16 px: no zoom-on-focus on phones).
- **Label** (600, 0.8125rem): field labels. **Help** (400, 0.8125rem): help and error text.
- **Row label** (600, 0.8125rem / 1rem): session labels in rows, tabs, the palette and pane captions, with `user@host` beneath in Data.
- **Group label** (600, 0.75rem, `ink-muted`): group headers, column labels, menu group labels.
- **Data** (JetBrains Mono 500, 0.75rem, tabular figures, −0.01em; the `font-data` utility): uptimes, ages, counts (group and pane counts, the activity `×n` well, numeric table cells). Plus Jakarta Sans has no alternate "1" (its GSUB carries only `calt ccmp dnom frac liga locl numr pnum tnum`, and the tabular one is still a bare stroke), so "<1m" read as "<lm"; the mono digits are unambiguous. Status words, dates and sentences stay in the sans.

### Named Rules
**The Tabular Rule.** Every live value (uptime, age, count, code) is set in tabular figures so changing digits never shift.

**The Two Sizes Rule.** A row, tab or chip uses at most two sizes; rank comes from weight and ink level (`ink` over `ink-muted`), never from a third size.

**The Mono Is Data Rule.** JetBrains Mono appears where a value is read as data or measurement (durations, counts, codes, keys, fingerprints, addresses), never as a costume for prose or labels.

## Layout

The type scale is fixed rem; spacing runs on a 4 px base (4, 8, 12, 16, 20, 24, 32).

- **Workspace (≥ 48rem):** an 18 rem sidebar on the ground (the mark, New session, the collapse toggle on its own row, the session groups with "End all sessions…" at their foot, the management rows, the account row), then the main column: a 2.75 rem tab row over the pane area, panes inset 8 px with 12 px corners. The sidebar collapses to a 3.5 rem rail (mark, round New session, toggle, one 36 px tile per live session, the management icons, the avatar); the choice persists per browser. Groups stack 12 px apart, rows 2 px apart, in urgency order (Action required, Disconnected, Reconnecting, Restoring, Connecting, Connected, Ended collapsed with the latest 20). Only non-empty groups render.
- **Phone (< 48rem):** the sidebar is the whole screen and acts as the switcher, with the account menu's avatar in its first row. Following a session swaps to a full-screen pane under a 48 px header (back to Sessions, label, protection mark, status chip) with the extra-key bar at the bottom, nine keys sharing the width, padded for the safe area.
- **Manage:** the same 18 rem sidebar (Workspace first, then Servers, Credentials, Activity, Settings, Admin, the account row at the foot); on phones a 56 px top bar (mark, avatar) over a sideways row of pill links. Content sits in a 76rem column of cards, 24 px apart.
- **Auth:** one card centred on the ground under the mark, 25rem wide (30rem for setup and enrollment), a discreet language control in the top-right corner. Cards divide heading and form by spacing alone; fields stack 20 px apart.
- **Empty states** live inside the pane as cards, never as a bare message on the ground; with no session at all the card carries the New session primary (the sidebar's button owns the shortcut). The first-run steps are plain numbered rows divided by hairlines, never cards inside the card.

## Elevation & Depth

Tonal layering with one shadow for what floats. Resting cards are a translucent fill inside a 1 px line and cast nothing; a card that floats over something else (menus, the palette, in-pane overlays, auth cards) keeps its line and adds a soft offset shadow. The followed session is lit, not lifted: its ring and a faint cyan halo are its depth.

### Shadow Vocabulary
- **Float** (`0 12px 32px -8px rgb(6 4 20 / 0.7), 0 2px 6px -2px rgb(6 4 20 / 0.5)`): menus, chips, docked notices.
- **Card** (`0 18px 48px -16px rgb(6 4 20 / 0.75), 0 2px 8px -4px rgb(6 4 20 / 0.5)`): the palette, overlay cards, auth cards.
- **Light** (`0 0 0 1px rgb(76 201 255 / 0.55), 0 0 22px -6px rgb(76 201 255 / 0.55)`): the followed session's ring and halo, on the row and the rail tile only.
- **Edge** (`±8px 0 12px -5px rgb(6 4 20 / 0.7)`): the tab row's own edge where tabs are scrolled under it.

### Named Rules
**The Float Earns Its Shadow Rule.** A card at rest has a line and no shadow; only what floats over other content gets Float or Card. Never a shadow for emphasis.

## Shapes

Generous, consistent corners: 6 px (`xs`) for key caps and small marks, 8 px (`sm`) for menu items and inner tiles, 10 px (`control`) for buttons, inputs, tabs, navigation rows and rail tiles, 12 px (`row`) for session rows and the terminal frame, 16 px (`card`) for cards, and pills for tags, counts, lamps and chips. Lamps are circles, 8 px (6 px in group headers and tile corners). Borders are 1 px; the only 2 px rule is the focused pane's cyan top edge in a split and the active tab's underline. The brand tile is an 8 px-cornered 28 px square lit from cyan to violet with the prompt glyph. As the browser icon (`app/icon.svg`) the tile fills its square on a 32-unit grid with a 2.75-unit prompt, so it holds at 16 px; `favicon.ico` carries it at 16 and 32 px for browsers without SVG icons, and the phone home-screen icon (`app/apple-icon.png`, 180 px) is the tile square-cornered, since the system rounds it. The web app manifest (`app/manifest.ts`, what a browser pins to the taskbar or installs) carries the tile at 192 and 512 px and a full-bleed 512 px maskable version (`app/_icons`). Every raster is rendered from the SVG.

## Components

### Buttons
- **Shape:** 10 px corners, 32 / 36 / 44 px tall (sm / md / lg), semibold.
- **Primary:** cyan fill with dark text; hover brightens 10 %, pressed is `accent-strong`; disabled is `surface-raised` with `ink-faint`.
- **Secondary:** `surface-raised` fill, ink text; hover and press step up to `surface-pressed`.
- **Quiet:** text only in `ink-muted`; hover fills `surface-raised` and brightens the ink. Used for Cancel, "Use a backup code instead", Retry now, the phone back button.
- **Destructive:** `danger` stroke and text, filled `danger-fill` with white text on hover; it carries 2rem of leading margin so it always stands apart from neighbouring actions.
- **States:** focus is the 2 px outline; loading swaps the icon for a spinner, keeps the label, sets `aria-busy` and blocks repeat submits (`SubmitButton` reads the form status).

### Inputs / Fields
- **Style:** `field` well, `line-strong` 1 px border, 10 px corners, 44 px tall, 16 px text; label above (semibold 0.8125rem), then the error, then help.
- **Focus:** the border turns `accent` under the 2 px focus outline.
- **Error:** `aria-invalid` turns the border `danger` with a 1 px inner stroke; the message sits under the control with an alert icon and a screen-reader "Error:" prefix, linked by `aria-describedby`.
- **Password field:** a reveal toggle inside the field (`aria-pressed`, labelled Show/Hide password). **Select:** the native select restyled with a drawn chevron; compact 32 px variant in footers and the discreet corner control. **Checkbox / Radio:** native inputs drawn as 20 px wells that fill with the accent (the radio keeps a ground-coloured centre); choice cards are lined rows that take `accent-soft` inside `accent-ring` when chosen.

### Notices
Inline cards of a soft tinted fill (`danger-soft`, `warning-soft`, `info-soft`, `success-soft`) with a toned icon and plain ink text; danger announces as `role=alert`, the rest as `role=status`. Form-level messages from Server Actions use the same notice. There are no toasts. A notice docked over a pane becomes `surface-solid` with the Float shadow.

### Cards / Containers
- **Card:** `surface` fill, `line` edge, 16 px corners, sections 20 to 24 px padded and divided by hairlines. Empty states, forms and tables live in cards; in-pane overlays and the palette use the solid card with the Card shadow.

### Session row (signature component)
A 48 px, 12 px-cornered row that is one link: an 8 px state lamp | label (row label) over `user@host` (data, muted) | protection mark (filled shield protected, outline shield compatibility mode, slashed dashed shield not protected, dashed shield not yet decided) | time (data, tabular) | a 28 px actions cell. Hover fills `surface-raised`. The followed row carries the reading light: `accent-soft` fill inside the `accent-ring` ring with its halo, **in exactly the place and size of its siblings** (plan D-28: never shifted). Ended rows dim the label to `ink-muted`; the Ended group's indent and guide line say they have ended, so `user@host` keeps the room a pill would take. The rail tile is the same session as a 36 px, 10 px-cornered square: two initials, the lamp in its corner, the light when followed, the label, target and status word as its accessible name.

**Signature move, "the reading light":** following a session moves the light to its row in a 180 ms view transition (`followed-light`), and the cyan continues to that session's tab (the underline) and pane (the top rule in a split). A state change moves a row to its new group inside a view transition too: the lamp recolours at once, then the row slides (`session-row`). Reduced motion, or a browser without view transitions, applies both changes instantly.

### Session group
A 32 px header with a 6 px lamp, the state word in group label and a pill count (`surface-raised`; `attention` for Action required), then its rows. The Ended group is a native disclosure with a rotating chevron, closed by default and opened when it holds the followed session; when more than 20 have ended it notes "Latest 20 of N". Open, its rows are indented 14 px under a 1 px `line` guide that drops from the chevron, so they read as inside the group, and a quiet sm "Remove all ended…" closes it (plan D-32): a dialog in End all's shape says how many leave the list, with their history.

### Status chip
An 8 px lamp beside the status word in data size and `ink-muted` (Connecting…, Restoring…, Connected, Action required, Reconnecting…, Disconnected, Ended).

### Navigation
- **Sidebar rows:** 36 px, 10 px corners, icon and label in `ink-muted`; hover fills `surface-raised`; the current row is lit (`surface-raised`, ink text, the icon in the accent) and carries no stripe. The rail shows the icon alone, named by its tooltip and accessible name.
- **Collapse toggle (plans D-37, D-38):** a 36 px quiet icon button on its own row under New session, drawn at exactly the same spot expanded and collapsed: the head's rows keep their heights in both modes (mark 40 px, New session 44 px with the rail's round button centred in it, toggle 36 px, 12 px then 4 px apart) and the expanded toggle sits in the rail's centred column, so the pointer stays on it and a second click undoes the first. Never on the mark's row, whose prompt glyph already reads like a chevron, and never beside New session. The glyph is the panel with its left column and a chevron inside the frame pointing where a click sends the column: in to collapse, out to expand (never a bare arrow, which reads as "back"). Hidden on phones; `aria-expanded` and `aria-controls` point at the session list.
- **Help button (plan D-40):** a 36 px quiet icon button drawn like the collapse toggle (the question mark in a circle at 18 px, `ink-muted`, hover `surface-raised` and ink) that opens the documentation on the project site, in the interface's language, in a new tab; its tooltip says Help and its accessible name adds that it opens a new tab. It sits in the same place in the workspace and on the management pages: at the end of the account row (the account menu takes the rest of the width), over the avatar on the rail, and just before the avatar in the phone header.
- **Account menu:** the avatar (a cyan-to-violet pill with the user's initial), the name and a gear open a 248 px solid card: Settings (Account settings, Terminal settings, and Language…, which opens a small modal dialog with the languages as choice cards and Apply), Admin for administrators, and Sign out (a form post), then, under a separator, one discreet row a step smaller than the others (32 px, small type, `ink-muted` until hovered or focused): "Source code on GitHub" with GitHub's mark (the icon set's one filled glyph, from Octicons) and a trailing new-tab arrow, opening the repository in a new tab. Under it, the menu's last line is information, not an action: "Termdock 0.1.0" in 12 px `ink-muted` with the version in the Data role, aligned with the text of the row above, never focused or hovered and skipped by the arrow keys, so a bug report can cite it. Only signed-in pages carry it (the server passes it to the menu); the sign-in and setup pages, error pages and `/api/health` never show the version. The language is a rare setting: it never gets its own group or inline choices in the menu. The rail and the phone header show the avatar alone.
- **Tabs:** 32 px, 10 px-cornered segments with the lamp, the label, the OSC title in muted ink, a pane-count pill and a magenta bell when a hidden pane rang; the active tab is `surface-raised` with ink text and a 2 px cyan underline. Tabs scroll in their own strip; the split controls and the connection state sit outside it, and an edge with tabs under it shows a chevron cue with the Edge shadow.
- **Section tabs** (Settings, Admin, Activity views): 40 px links under the page heading with the cyan underline on the current one.
- **Phone extra-key bar:** Esc, Tab, sticky Ctrl, sticky Alt, four arrows, pipe and paste as 44 px `surface-raised` keys on `ground-deep` that share the width (ten keys fit 390 px); an armed modifier turns cyan. Ctrl masks the next key into its control byte, Alt sends it behind an ESC prefix (D-17).
- **Kbd:** 20 px key caps with a faint line and `surface-raised` fill, muted on surfaces and inheriting the colour inside a primary button.

### Live workspace (panes, overlays, palette)
- **Panes:** a 12 px-cornered, lined, near-black frame. In a split, each pane carries a 28 px caption (lamp, label, state word, OSC title, close); the focused pane gets the 2 px cyan top rule and full strength, the others dim slightly (`brightness .78`), never fade. Dividers are the 8 px gap; hovering draws a `line-strong` grip, dragging or focusing turns it cyan.
- **In-pane states** never replace the terminal's last screen. Progress (Connecting…, Restoring…) is a solid pill chip with a cyan spinner in the pane's top corner; Reconnecting is a solid card docked at the top (countdown, Stop as secondary, Retry now as primary while waiting), and it stays up through the attempts of the round instead of trading places with the chip; a session that never connected reads "Next attempt in 15 seconds" over "Attempt 3 of 4", one that lost its connection "Reconnecting in 30 seconds" over "keeps trying until 14:32" (plan D-31); Disconnected and Ended are docked at the bottom (reason, Retry or Reopen; a session that never connected adds a quiet "Edit server" and End, since nothing runs on its server; a session whose server was deleted says so and offers End instead, since it can never connect again; an ended session whose tmux could not be ended on its server adds one line saying the next connection there ends it, plan D-30) so the last output stays readable; a decision (host key, keyboard-interactive sign-in, a link to open) is a centred solid card over a flat scrim. Every card's title row carries the lamp before the title and, when the title does not name the state, the state word trailing on the same row. Fingerprints use 12 px mono.
- **Pane tips (plan D-33):** while tmux runs inside a protected session, an info notice joins the pane's top notice stack: the title "tmux isn't needed here", one line on what works better without it, then "Got it" (this session, while the pane lives) and "Don't show again" (a terminal setting) as text actions. It never touches the tab label, the program's title on the tab or the status chip.
- **Learn more (plan D-40):** where a state needs more than its one line, a short "Learn more" link opens the user guide on the project site at that topic, in a new tab, with a 12 px new-tab arrow after the words and a screen-reader note that it opens a new tab; it never wraps inside itself. In muted prose (the Reconnecting, Disconnected and Ended cards, the host-key and changed-key cards, the file panel's "no SFTP" card, the protection choice on a server's form and the "Sessions on this server" intro) it is the inline link: accent text over a half-strength accent underline that fills on hover. Inside a notice (the server restarted, the nested tmux tip, Diagnostics' not-protected reason and linger warning) it takes the notice's ink and weight, like the notice's own text actions ("Got it"). Never a button, never more than one per place, and it never moves the actions already there.
- **Row actions:** the 28 px menu cell at the end of every row (and right-click on the row or the rail tile; on a rail tile the menu button shows at its corner only while the tile has the keyboard focus or the menu is open, never on hover, where it would cover the initials the pointer aims at) opens a solid 240 px menu (320 px while it asks to confirm): open in a new tab, split right or down, retry, reopen, rename, then end (or, for an ended session, "Remove from list…", plan D-32), set apart by a spaced separator. End and Remove swap the menu for a danger slip with the question and the destructive button; no modal. End's slip adds an info notice titled "Tip": closing the tab, the pane or even the browser keeps the session running.
- **End all sessions (plan D-30):** a quiet sm "End all sessions…" at the foot of the expanded session list (not on the rail), shown while any session has not ended. It opens a small solid dialog (the rename dialog's shape): the question as title, one line with the count and the consequence (the programs in them stop, on their servers too), a refusal as an inline danger notice, then the destructive button beside Cancel, which takes the focus. The sessions then end through their usual status updates.
- **Leftover notice (plan D-30):** when a session's connection finds Termdock sessions on its server that this installation does not run, an `info-soft` notice under the tab row names the server and the count, links to that server page's "Sessions on this server" card (carrying the way back to the workspace) and offers Dismiss. One notice per server; a dismissed server stays quiet while the tab lives.
- **Rename (plan D-28):** "Rename…" opens a small solid dialog (the language dialog's shape): the current name prefilled and selected, Enter saves, Escape cancels, the daemon's refusal (a name of only spaces) as an inline danger notice. A tab's label renames in place on double-click: the label becomes a field in the tab, Enter or blur saves, Escape cancels; a refusal shows in the workspace notice bar. Every viewer sees the new name in the list and on the tabs.
- **Command palette:** a solid 36rem card floating near the top of the pane area (Ctrl/⌘K outside terminals, Ctrl+Shift+K inside): a cyan search mark and a borderless field over a grouped list of open sessions (lamp, label, target, status chip) and servers (a cyan plus, name, `user@address`); the highlighted row takes `accent-soft` inside `accent-ring`; key hints sit in a lined footer. While a server is highlighted, a compact Name field sits above the footer (placeholder: the server's name; empty keeps it as the label); Enter in it starts the session. With no server at all, the footer links to the Add server form, carrying the way back to the workspace. It never blocks the workspace: Escape or a click outside closes it and the focus returns where it was.

### File panel (plan D-39)
A session's files beside its terminal, inside the same pane (never a split), over the session's own SSH connection. Operator density on the ground's deep tone; the selection colour is the only accent inside it besides links, the lit toggles and focus. From the top: header, path bar, toolbar, selection bar, list, transfers: navigation always first, and what the selection can do right under the panel's own actions.
- **Toggle on the pane it opens:** a quiet sm "Files" with the folder glyph on the tab row's trailing edge (before the split controls) for a tab with one pane bound to a session; in a split, a 24 px folder button in each pane caption (before close) and none on the tab row; on a phone, a 44 px folder button closing the pane header. Pressed, it is lit as a selection: `accent-soft` fill, an `accent-ring` inset line, the glyph in the accent (`aria-pressed`). Hidden when file transfer is off, for local sessions and for ended ones.
- **Dock:** the panel sits at the pane's trailing edge inside the pane's frame, on `ground-deep`, behind an 8 px divider drawn as a 1 px `line` with the split dividers' grip (hover `line-strong`, drag or focus cyan; arrows nudge 16 px, Shift 64 px, Home and End go to the ends). It opens at 440 px, never narrower than 300 px, and leaves the terminal at least 320 px; when the pane cannot do both, the panel covers that pane's terminal instead (opaque, the terminal `inert` and unresized under it). Docking narrows the terminal's box, so the session resizes to it. Open state, width, folder and the hidden-files toggle live in the tab's memory per pane; nothing is persisted.
- **Header (40 px):** "Files" in row-label weight, `user@host` in Data, a 28 px close.
- **Toolbar (48 px, under the path bar):** Upload (a multi-file picker) and New folder as secondary sm buttons with glyph and label, the path bar's Up style (no primary in the panel; New folder's label folds into the glyph below a 21 rem panel), then quiet icon buttons with tooltips: the terminal's folder (enabled only when tmux reports it), the hidden-files toggle (lit like the pane toggle when on; on by default), Refresh (a spinner in place of its glyph while it works, never disabled under the focus).
- **Path bar (first, under the header):** Up (secondary icon) and a field-like well (`field`, `line`, 10 px) holding the folder's segments as small buttons: from the home folder (a house glyph) when inside it, from `/` otherwise; the current segment in semibold ink; the well scrolls to its end. A pencil at its end turns it into a mono text field with the accent border: Enter goes (`~`, relative and absolute paths), Escape cancels, a path it cannot open says so under it.
- **List:** a multi-select listbox with one roving tab stop (arrows, Page, Home, End move; Space selects; Enter opens a folder; F2 renames; Delete asks; Escape clears; Ctrl/⌘A selects all; the hint is the list's description). Column labels in group label over the rows with the select-all checkbox (a 16 px well; a dash when some are selected). Rows are 34 px: a drawn 16 px check, the kind's glyph (folders and links to folders in the accent, since a folder name is a link; files muted), the name (folders semibold, dot-files muted; clicking a folder's name opens it, a file's name selects it), a link's "→ target" in muted xs or "broken link" in `danger`, the size in Data (folders "—"), and Modified in the sans with tabular figures ("today 09:15" in the locale's word, day and month this year, the year before) once the panel passes 22 rem. Selected rows take `accent-soft`. Folders come first, then files, in natural order. Off-screen rows skip layout (`content-visibility`), so a 10 000-entry folder stays smooth; a folder beyond that says it shows the first 10 000. A muted footer counts items and hidden ones.
- **Phone:** a full-screen view under the pane header, which reads "‹ Terminal", the lamp and label, and "Files". The path bar comes first, then the toolbar (44 px controls; Upload and New folder keep the small type and their labels, which fold to New folder's glyph below 23.5 rem), then 52 px two-line rows (a 20 px check, the glyph, the name over "size · modified", "Folder · modified" or "Link → target"); tapping a row opens a folder or selects a file. The terminal and the key bar stay where they were under it (attached, the same size, `inert`).
- **Selection bar:** an `accent-soft` strip under the toolbar (at the bottom on a phone): the count, then three labelled sm buttons: Download (secondary; files and links to files, one browser download each; folders are left out with an info notice), Rename (secondary, the same as Download; exactly one entry) and Delete (destructive, 4 px apart), and a clear ×. One row from a 30 rem panel; narrower, the count and × keep the first row and the buttons take the second, so no label is cut. On a phone always two rows, the buttons sharing the width at 44 px.
- **Inline edits:** renaming swaps the row's name for a 28 px field with the accent border (the stem selected); a new folder is a lit row above the list with the same field. Enter saves, Escape cancels, leaving saves a changed name; `fileNameProblem` is checked first, and any refusal shows under the field in `danger` with the border turned `danger`, the field staying open.
- **Delete:** always a small solid dialog in End all's shape: "Delete 1 folder and 2 files?" (the locale's list), a danger notice (naming the folder when it is the only entry, saying folders go with everything inside them and nothing comes back), a muted line that links are removed as links, then Delete (destructive) beside Cancel, which takes the focus. While it runs, a `surface-raised` strip with a cyan spinner reads "Deleting… 184 items" with Stop; a stopped delete says how many went.
- **Upload conflicts:** names already in the folder are asked once per batch in a solid dialog: the count and folder as title, the names in a mono `field` well (five, then "and N more"), choice cards (Replace, which keeps the file's permissions; Keep both, with the numbered name it would take; Skip these), Continue (primary) and Cancel upload.
- **Drop zone:** files dragged over the panel lay `ground-deep` at 85 % over it (the panel is already opaque over the terminal) with a dashed `accent-ring` card on `accent-soft`: the upload glyph, "Drop to upload", "to" and the folder in mono. Dropped folders are left out with a notice.
- **Transfers:** the tab's queue (two at a time; transfers outlive the panel) shown per session at the panel's foot on the ground, under a hairline: "Transfers", "N in progress", Clear finished; each job a `surface` row with 8 px corners: the direction glyph (named for screen readers), the name in semibold, "x of y · speed · %" in muted tabular figures (a failure's reason in `danger`), a 4 px bar (cyan running, `line-strong` done or cancelled, `danger` failed) and Cancel (×) or Retry. A download handed to the browser that this tab can no longer follow reads "Continues in your browser's downloads". On a phone the tray is a solid card with the Float shadow folded to one line ("2 transfers", the overall percent and bar, Show). Leaving the page while uploads run asks first.
- **When it cannot work:** inside the panel, never over the terminal. Not connected: a card with the session's status chip, "Files come back when the session reconnects" and a line on transfers (it reloads by itself when the session connects again; a tab offline says Termdock reconnects). No SFTP: a card "Files need SFTP on this server" saying Termdock installs nothing and the terminal keeps working, the two steps with `Subsystem sftp internal-sftp` and `sudo systemctl reload ssh` in mono wells with copy buttons, then Try again. File transfer turned off: an info notice. A folder that cannot be listed: a danger notice with Try again and Go to the home folder. A proxy that answers an upload with 413: a danger notice "A proxy refused the upload of …" pointing at "Behind a reverse proxy" in the install guide. Other failures are inline notices at the panel's top (three at most; danger stays until dismissed, the rest clear after 8 s).

### Management pages (servers, credentials, activity, settings, admin)
- **Page header:** the title in Title size, one line of context in `ink-muted`, page actions on the trailing edge (primary cyan, secondary raised).
- **Table:** inside a card: column labels in group label, a hairline between rows, a faint `surface` hover, tabular figures, counts right-aligned, machine values (addresses, fingerprints) in 13 px mono and muted. Below 48rem every row becomes a block with each cell carrying its own label, so nothing scrolls sideways.
- **Tag:** a 20 px pill in sentence case for the state of a record that is not a session: `success-soft`, `warning-soft`, `danger-soft`, `info-soft` with the matching lamp or accent text, or `surface-raised` with muted text; the word always carries the meaning.
- **Confirm action:** a destructive action behind a native disclosure; the first press opens a `danger-soft` slip that names exactly what will happen, the destructive button inside it submits, and a server refusal shows in the same slip.
- **Success after a redirect:** a success notice at the top of the page, from a whitelisted `?done=` key.
- **Back to where you came from:** a page reached with `?from=` (plan D-27) shows a quiet sm "Back to …" link with a left arrow above its title, named after that page; after its job is done the same destination becomes a large button (primary when it is the next step).

### Add server form
One page that sets up a server end to end (plan D-29), in a 46rem column with a narrow aside for the Docker host preset (below the form on phones). A server is one record holding what an `ssh user@host` command line would.
- **Two numbered cards, 24 px apart:** Server and Credential. Each heading carries its step number in a 24 px `surface-raised` pill with muted tabular digits (the first-run marker, never the accent), one line of context, then the fields under a hairline.
- **Server:** Name; the kind as two choice cards side by side (SSH server, Local shell) only where local shells are allowed; Address beside a narrow Port (one column below 40rem); User name on the server. A local shell replaces the address, port and user name with one muted line, and the Credential card leaves the form.
- **Advanced options** (protection, startup command, environment, keepalive, scrollback, reopening) sit behind a native disclosure at the foot of the Server card, in three hairline-divided groups; it opens itself when one of them has an error.
- **Credential choices are choice cards** stacked in one column: Generate a new key (with a neutral "Recommended" tag), Paste a private key, Password, Use a saved credential (only when one exists) and None (the server asks for the password in the terminal). Fields of an unchosen card are not rendered; None shows one muted line instead of fields. The optional credential name shows `user@server` as its placeholder.
- **Submit row on the ground:** a large primary "Add server" and a quiet Cancel over a muted "Nothing is saved until you add the server." (in the form, not the page intro, so it leaves with the form); a refused submit shows a danger notice counting the fields to fix above the row and moves focus to the first one. Secrets are never echoed: a short muted line asks for the key or password again.
- **Result in place:** the same column becomes one card: a success notice, a definition list of what was created (Server with its `user@address` in mono, Credential), the install command and public key in code wells with copy buttons for a generated key, the fingerprint for a generated or pasted key, then "Start a session" (primary) beside the large secondary way back, and a text link to the server's page.
- **Duplicate:** "Duplicate" (a quiet button with the copy glyph in the servers list, a secondary page action on the server page) opens this form prefilled from that server: every field copied, the name ending in "(copy)", the Credential card on "Use a saved credential" with the same credential (or None), and a page intro that names the source. Nothing is saved until Add server.

### Servers list and server page
- **Servers list:** a table card with the name (server glyph, a link to its page), `user@address` in 13 px mono (`:port` only when it is not 22; the local wording for a direct-mode server), the credential's name or a muted "None", then Edit (secondary sm) and Duplicate (quiet sm). With no server, an empty-state card leads to Add server and the Docker preset.
- **Server page header:** the name with a kind tag, `user@address` in 13 px mono as the context line, Duplicate as the page action.
- **Server page body:** two columns from 64rem (one below). Leading: the edit card, built from the Add server field components (the credential as a select of saved credentials with None last, and a "New credential" link that comes back here; Advanced; a large Save), then for an SSH server the "Sessions on this server" card, over a Delete card (confirm slip, refused with a link to the workspace while sessions from the server run).
- **Sessions on this server (plan D-30, anchor `#remote-sessions`):** the intro names `user@host:port` in mono and says what is listed: Termdock sessions running there that this installation does not run. A secondary "Check now" (it connects to the server; nothing runs before) with a muted line saying it also ends leftovers of sessions already ended in Termdock. The result: a danger notice titled "Couldn't check the server" with the likely cause (no trusted host key, no stored credential, or the connection code's wording), a success notice for the leftovers it ended, a warning when the host listed more than Termdock reads, the check time, and either a muted empty line or a hairline-divided list. Each item: a neutral origin tag ("Ended in Termdock" beside the session's name, "This installation, no record", "Other or earlier installation"), the tmux socket name in 12 px mono, Created / Last activity / Attached clients in three columns (one below 40rem), a warning notice while clients are attached, then Adopt (secondary; while someone is attached it first asks in a `warning-soft` slip; it opens the new session in the workspace through `?open=`) and End… (destructive, whose danger slip says the programs in it stop). An ended item leaves the list with a success notice. Trailing: the Diagnostics card with Test connection, then the host keys of the address under an `info-soft` notice saying that a decision applies to every server of the user at that `host:port`; each key carries its state tag, fingerprint, and trust, replace (the address typed to confirm) or revoke; pre-trust sits behind a disclosure. A local server shows one muted line instead of diagnostics.

### Project site (plan D-40)
The public site (`site/`, GitHub Pages) is the same cabin built for reading, from the same tokens restated in `site/src/assets/site.css` (no Tailwind there) and the same two self-hosted faces.
- **Chrome:** a 56 px sticky top bar on the ground (the mark and name, Docs and Help with the cyan underline on the current one, the EN · PT pair as a small segmented control, the GitHub mark), and a `ground-deep` footer with the license line and the site's links.
- **Reading pages** (the help, the documentation index, the guides): one 46rem column beside a sticky "On this page" index, folded into a disclosure under the title below 68rem. Its groups are small semibold ink headings over their entries, which sit indented on a 1 px `line` guide like the Ended group; exactly one entry is lit like a navigation row (`surface-raised`, ink, no stripe): the last heading that has passed under the top bar, the last one at the bottom of the page. Headings carry a link-to-self glyph on hover. Arriving through an anchor lights that heading or note with the reading light (`accent-soft` inside `accent-ring`) for a moment, then it settles; a steady ring under reduced motion.
- **Notes** are the app's notices (`info-soft`, `warning-soft`, `danger-soft`, or a lined `surface` card) with a toned icon and ink text; tables sit in lined cards, become labelled blocks on a phone (hand-written ones) or scroll sideways (generated ones); outcomes are tags; statuses are lamps beside their words; commands are `pane`-dark code wells with a Copy button.
- **Where a session lives:** a three-node diagram (browser, Termdock, server) with a dashed wire for your own connection and a solid one for the session's, the Termdock node raised; it stacks vertically on a phone.
- **Home:** the claim in a large semibold (up to 4.25rem, tight tracking) over one line, Install (primary) and the docs (secondary), the status tag and license, then the workspace capture at full width with a soft drop shadow (a phone shows the phone capture, 18rem wide); then bands for the idea (the comparison table from the README), how it works (the diagram over three ideas under hairlines), where it fits (four uses in two columns under hairlines, then one muted paragraph on the tools it runs alongside), real captures in a two-column gallery with the phone pair, the features in two hairline columns, and the run commands.

## Do's and Don'ts

### Do:
- **Do** read every colour through the tokens (`ink`, `ink-muted`, `line`, `surface`, `accent`, the lamps); new chrome goes on the ground, new reading surfaces in a `card`.
- **Do** give every session its lamp with the state word in reach, and every live value tabular figures.
- **Do** keep transitions at the two tokens (`--duration-step` 120 ms, `--duration-move` 180 ms) on `cubic-bezier(0.16, 1, 0.3, 1)`; both drop to 0 under reduced motion.
- **Do** draw icons from `components/icons` (24-unit grid, 1.75 stroke, round caps) and keep them decorative with the name on the control.
- **Do** make anything over a live terminal `surface-solid`, with no blur and no gradient.

### Don't:
- **Don't** use a state colour for anything but session state, or magenta for anything but attention.
- **Don't** move the followed row, tile or tab; it lights, it never shifts.
- **Don't** add a second sans family, a display face, uppercase labels, or monospace outside codes, keys, fingerprints and the terminal.
- **Don't** give a resting card a shadow, or a floating one a border heavier than `line`.
- **Don't** put `backdrop-filter`, an animated gradient or a glow behind or over a terminal pane.
