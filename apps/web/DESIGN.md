---
name: Termdock
description: Persistent terminal sessions read as flight progress strips on a slate board, beside near-black terminal panes.
colors:
  board-0: "#111923"
  board-1: "#1a2431"
  board-2: "#223042"
  board-3: "#2b3b50"
  board-rule: "#33465e"
  board-rule-strong: "#6b819e"
  board-ink: "#e3e9f0"
  board-ink-muted: "#9aabbf"
  board-ink-faint: "#6a7c92"
  stock: "#eee2c0"
  stock-hover: "#f4ead0"
  stock-pressed: "#e2d3ab"
  stock-followed: "#fbf4df"
  stock-ended: "#d8d2c2"
  stock-field: "#fbf6e6"
  stock-rule: "#cdbd93"
  stock-rule-strong: "#8c7d58"
  stock-ink: "#241f14"
  stock-ink-muted: "#5f5440"
  stock-ink-faint: "#8a7d62"
  pane: "#0c1015"
  pane-ink-dim: "#7d8a99"
  state-connected: "#34a266"
  state-progress: "#4c8fd6"
  state-reconnecting: "#e0a526"
  state-action: "#f2681f"
  state-disconnected: "#d9473f"
  state-ended: "#7c8899"
  tint-danger: "#f3d2c4"
  tint-warning: "#f5dfa8"
  tint-info: "#dce5ee"
  tint-success: "#d5e8cf"
  danger-on-stock: "#a3271f"
  danger-on-board: "#ff8a80"
  danger-fill: "#b3332a"
  focus-board: "#8cc8ff"
  focus-stock: "#1d5fb4"
typography:
  title:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: "1.75rem"
  subtitle:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: "1.5rem"
  body:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
  body-form:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: "1.5rem"
  label:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: "1.125rem"
  help:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.125rem"
  strip-label:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: "1.125rem"
    letterSpacing: "0.02em"
    fontVariation: "'wdth' 72"
  lane-label:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 700
    lineHeight: "1rem"
    letterSpacing: "0.08em"
    fontVariation: "'wdth' 80"
  data:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: "1.125rem"
    fontFeature: "'tnum'"
  code:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
rounded:
  strip: "2px"
  key: "3px"
  control: "4px"
  panel: "6px"
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
    backgroundColor: "{colors.stock}"
    textColor: "{colors.stock-ink}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.stock-hover}"
    textColor: "{colors.stock-ink}"
  button-primary-on-stock:
    backgroundColor: "{colors.board-1}"
    textColor: "{colors.stock-hover}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "44px"
  button-primary-on-stock-hover:
    backgroundColor: "{colors.board-2}"
    textColor: "{colors.stock-hover}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.stock-ink}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.stock-ink-muted}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  button-destructive:
    backgroundColor: "transparent"
    textColor: "{colors.danger-on-stock}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "36px"
  button-destructive-hover:
    backgroundColor: "{colors.danger-fill}"
    textColor: "#ffffff"
  input:
    backgroundColor: "{colors.stock-field}"
    textColor: "{colors.stock-ink}"
    typography: "{typography.body-form}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "44px"
  input-compact:
    backgroundColor: "{colors.board-0}"
    textColor: "{colors.board-ink}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  strip:
    backgroundColor: "{colors.stock}"
    textColor: "{colors.stock-ink}"
    typography: "{typography.strip-label}"
    rounded: "{rounded.strip}"
    height: "48px"
  strip-hover:
    backgroundColor: "{colors.stock-hover}"
  strip-followed:
    backgroundColor: "{colors.stock-followed}"
  strip-ended:
    backgroundColor: "{colors.stock-ended}"
  lane-count:
    backgroundColor: "{colors.board-0}"
    textColor: "{colors.board-ink-muted}"
    rounded: "{rounded.key}"
    padding: "0 6px"
    height: "20px"
  status-chip:
    textColor: "{colors.board-ink}"
    typography: "{typography.help}"
  panel:
    backgroundColor: "{colors.stock}"
    textColor: "{colors.stock-ink}"
    rounded: "{rounded.panel}"
    padding: "20px 24px"
  tab:
    backgroundColor: "{colors.stock-followed}"
    textColor: "{colors.stock-ink}"
    typography: "{typography.strip-label}"
    height: "32px"
  key:
    backgroundColor: "{colors.board-3}"
    textColor: "{colors.board-ink}"
    rounded: "{rounded.control}"
    height: "44px"
  key-sticky:
    backgroundColor: "{colors.stock}"
    textColor: "{colors.stock-ink}"
---

# Design System: Termdock

## Overview

**Creative North Star: "The Strip Board"**

Every terminal session is a flight progress strip racked in a bay: a compact, state-coded record of buff stock that an operator reads in one glance and returns to exactly as it was left. The shell is the board the strips sit on (slate blue, darkest at the edges), the strips and every sheet the user reads or fills in are the same warm buff stock, and the terminal itself is a near-black pane framed by the slate. The system refuses both the neon hacker console and the white SaaS card dashboard: there is no glow, no gradient, no card grid, and no colour that is not doing a job.

The physical scene decides the scheme: operators keep long sessions open on laptops in dim rooms and check them from a phone at night during an incident, always next to near-black terminal panes, so the board is dark and the reading surfaces are light paper on it. The page declares `color-scheme: dark` (scrollbars, pickers and autofill follow) and deliberately does not flip on `prefers-color-scheme: light`: the dark-board / light-stock contrast is the information structure, not a theme, and the buff stock already gives a light reading surface for every form and strip. All colour is reached through surface roles (`.surface-board`, `.surface-stock`, `.surface-pane`), so a day board can later be added as a remap of the board roles alone when the account theme setting arrives.

Density is operator density: 48 px strips, 6 px between strips, condensed caps for labels, tabular figures for every live value. Motion is two crisp steps (about 60 ms to recolour or press, 120 ms to move), never a fade.

**Key Characteristics:**
- Slate board shell, buff strip stock, near-black panes: three materials, nothing else.
- A 4 px state edge on every session strip and tab; state colours appear nowhere else.
- One family (Archivo) in two widths: workhorse UI and condensed strip caps.
- Hairline cell rules divide strips and sheets the way a printed strip is ruled.
- The followed session is "cocked": slid out of its row in the bay, buff in the tab bar, ruled into its pane.
- State changes slide the strip to its new lane, the edge recolouring first.

## Colors

A restrained three-material palette (board, stock, pane) carrying a six-colour state vocabulary that is used for state and nothing else.

### Primary
- **Strip Buff** (`stock`): the paper of the world. Session strips, auth sheets, empty-state and in-pane panels, the active tab, and the primary button on the board. Its hover (`stock-hover`), pressed (`stock-pressed`), followed (`stock-followed`, the brightest: the strip you follow) and ended (`stock-ended`, greyed: history) variants are the only fills strips ever take.
- **Writing Field** (`stock-field`): inputs, the QR plate and code wells on stock; a lighter sheet you write on.

### Secondary
- **Slate Board** (`board-0` to `board-3`): the shell. `board-0` is the ground and pane frame, `board-1` the bay and the primary button on stock, `board-2` the tab bar and pane surround, `board-3` hover and key caps.
- **Board Rules** (`board-rule`, `board-rule-strong`): hairlines on the board, and control borders on the board (3.9:1 against the bay).

### Tertiary
- **State colours**, fills only, always beside a word: Connected (`state-connected`, green), Connecting and Restoring (`state-progress`, blue), Reconnecting (`state-reconnecting`, amber), Action required (`state-action`, signal orange), Disconnected (`state-disconnected`, red), Ended (`state-ended`, slate).
- **Feedback tints** on stock (`tint-danger`, `tint-warning`, `tint-info`, `tint-success`): notice slips; their text stays stock ink. `danger-on-stock`, `danger-on-board` and `danger-fill` carry error text, destructive strokes and the destructive hover.

### Neutral
- **Board Ink** (`board-ink` 12.8:1 on the bay, `board-ink-muted` 6.7:1, `board-ink-faint` for disabled only).
- **Stock Ink** (`stock-ink` 12.7:1 on buff, `stock-ink-muted` 5.8:1, `stock-ink-faint` for disabled only).
- **Stock Rules** (`stock-rule` hairlines, `stock-rule-strong` control borders, 3.1:1 or better).
- **Terminal Pane** (`pane`, with `pane-ink-dim` 5.4:1 for pane captions).
- **Focus** (`focus-board` on slate, `focus-stock` on buff): a 2 px outline 2 px off the element; each surface sets its own, and strips (stock objects outlined on the board) always use `focus-board`.

### Named Rules
**The State-Only Rule.** The six state colours mean session state. Never use them for brand, emphasis, links or decoration; the wordmark's strip has a slate edge for that reason.

**The Opposite Stock Rule.** A primary action is drawn in the opposite material of its surface: buff on the board, slate on buff. Nothing else on a surface uses that fill.

**The Word Beside the Colour Rule.** A state swatch or edge is always accompanied by the state word (lane header, chip, or screen-reader text).

## Typography

**Body Font:** Archivo (variable, width 62 to 125), self-hosted through `next/font`, with `ui-sans-serif, system-ui` fallback.
**Label Font:** the same Archivo at width 72 (strip labels) and 80 (lane labels), uppercase.
**Mono Font:** JetBrains Mono, only for codes, keys and secrets (TOTP key, backup codes).

**Character:** one technical grotesk does all the talking; pulling its width axis gives the printed-strip voice without a second family.

### Hierarchy
- **Title** (600, 1.375rem / 1.75rem): auth sheet headings, empty-state headings.
- **Subtitle** (600, 1rem / 1.5rem): steps inside a sheet ("Scan the code"), fieldset legends.
- **Body** (400, 0.875rem / 1.25rem): UI copy, intros, notices; prose capped at 52ch.
- **Body form** (400, 1rem / 1.5rem): typed values in inputs (16 px: no zoom-on-focus on phones).
- **Label** (600, 0.8125rem): field labels. **Help** (400, 0.8125rem): help and error text.
- **Strip label** (600, 0.9375rem, width 72, caps, 0.02em): session labels in strips, tabs and the phone header.
- **Lane label** (700, 0.6875rem, width 80, caps, 0.08em): lane headers and the wordmark.
- **Data** (500, 0.8125rem, tabular figures): uptimes, ages, counts.

### Named Rules
**The Tabular Rule.** Every live value (uptime, age, count, code) is set in tabular figures so changing digits never shift.

**The Caps Belong to Strips Rule.** Uppercase is only for strip labels, lane labels and the wordmark. Headings, buttons and body copy stay in sentence case; no kicker or eyebrow above a heading.

## Layout

The type scale is fixed rem; spacing runs on a 4 px base (4, 6, 8, 12, 16, 20, 24, 32).

- **Workspace (≥ 48rem):** the bay is a 20rem slate column on the left (wordmark, full-width New session with its Ctrl/⌘K hint, scrolling lanes, account footer with the language picker). The right side is a 2.5rem slate tab bar over the pane area; panes sit inset 6 px in the slate with 3 px corners. Lanes stack 16 px apart, strips 6 px apart, in urgency order (Action required, Disconnected, Reconnecting, Restoring, Connecting, Connected, Ended collapsed with the latest 20). Only non-empty lanes render.
- **Phone (< 48rem):** the bay is the whole screen and acts as the switcher. Following a session swaps to a full-screen pane with a 48 px header (back to Sessions, label, status chip) and the extra-key bar at the bottom, nine keys sharing the width, padded for the safe area.
- **Auth:** one buff sheet centred on the board ground under the wordmark, 25rem wide (30rem for setup and enrollment), language picker in the page footer. Sheets divide heading, form and footer with hairline rules; fields stack 20 px apart.
- **Empty states** live inside the pane as buff panels, never as a bare message on the board.

## Elevation & Depth

Paper on a board: depth is the short shadow a strip casts on the board, and nothing is raised by a border. Inside a strip or sheet, structure comes from hairline cell rules, not from nested containers.

### Shadow Vocabulary
- **Strip** (`0 1px 0 rgb(5 9 14 / 0.45), 0 3px 8px -3px rgb(5 9 14 / 0.55)`): every strip at rest.
- **Strip followed** (`0 1px 0 rgb(5 9 14 / 0.45), 0 6px 14px -4px rgb(5 9 14 / 0.65)`): the cocked strip, lifted slightly.
- **Panel** (`0 2px 0 rgb(5 9 14 / 0.4), 0 18px 40px -16px rgb(5 9 14 / 0.75)`): auth sheets and in-pane panels.

### Named Rules
**The One Elevation Rule.** An element is lifted by its shadow or bounded by a border, never both.

## Shapes

Crisp, printed geometry. Strips have 2 px corners, key caps and tabs 3 px, controls 4 px, sheets 6 px; there are no pills and no large radii. Swatches are squares (8 px in chips, 6 px in lane headers). The strip's state edge is a 4 px grid cell flush with its left side, and its cells are divided by 1 px rules. The QR plate keeps the standard four-module quiet zone and crisp-edge rendering.

## Components

### Buttons
- **Shape:** gently squared (4 px), 32 / 36 / 44 px tall (sm / md / lg), medium weight.
- **Primary:** opposite stock (buff on the board, slate on buff); hover one step lighter, pressed one step deeper; disabled falls to the surface's disabled fill.
- **Secondary:** transparent with a `rule-strong` border; hover and press tint the surface (`quiet-hover`, `quiet-pressed`).
- **Quiet:** text only in muted ink; hover tints and darkens the ink. Used for "Sign out", "Use a backup code instead", the phone back button.
- **Destructive:** danger stroke and text, filled red on hover with white text; it carries 2rem of leading margin so it always stands apart from neighbouring actions.
- **States:** focus is the surface's 2 px outline; loading swaps the icon for a spinner, keeps the label, sets `aria-busy` and blocks repeat submits (`SubmitButton` reads the form status).

### Inputs / Fields
- **Style:** writing-field fill, `rule-strong` 1 px border, 4 px corners, 44 px tall, 16 px text; label above (semibold 0.8125rem), then the error, then help.
- **Focus:** border and 2 px outline in the surface's focus colour.
- **Error:** `aria-invalid` turns the border danger with a 1 px inner stroke; the message sits under the control with an alert icon and a screen-reader "Error:" prefix, linked by `aria-describedby`.
- **Password field:** a reveal toggle inside the field (`aria-pressed`, labelled Show/Hide password). **Select:** the native select restyled with a drawn chevron; compact 32 px variant in footers. **Checkbox:** native input drawn as a 20 px square, filled with the primary material and a check when on.

### Notices
Inline slips of tinted stock with an icon; danger announces as `role=alert`, the rest as `role=status`. Form-level messages from Server Actions use the same slip. There are no toasts.

### Cards / Containers
- **Panel:** buff sheet, 6 px corners, panel shadow, sections 20 to 24 px padded and divided by hairline rules. Empty states and in-pane overlays use it inside the near-black pane.

### Session strip (signature component)
A 48 px grid: 4 px state edge | label in strip caps over `user@host` in muted ink | protection cell (filled shield protected, outline shield compatibility mode, dashed slashed shield not protected, dashed shield not yet decided) | time cell (uptime, or "2h ago" for ended), cells divided by hairlines. The whole strip is one link with the protection explanation and the full time sentence as screen-reader text. Hover lightens the stock, press nudges it down 1 px, focus draws the board focus outline. The followed strip is cocked 12 px out of the row in the brightest stock; ended strips are grey stock with a bordered ENDED stamp.

**Signature move:** when fresh data moves a session to another lane, the bay commits the change inside a view transition: the new edge colour shows at once (no cross-fade), then the strip slides to its lane in 120 ms on an exponential ease-out. Reduced motion, or a browser without view transitions, applies the change instantly.

### Lane
A header row with a 6 px state swatch, the lane name in lane caps and a tabular count well, then its strips. The Ended lane is a native disclosure with a rotating chevron, closed by default and opened when it holds the followed session; when more than 20 have ended it notes "Latest 20 of N".

### Status chip
An 8 px state square beside the status word in the surface ink (Connecting…, Restoring…, Connected, Action required, Reconnecting…, Disconnected, Ended).

### Navigation
- **Tab:** a 32 px buff tab with the 4 px state edge, the label in strip caps and a close control that only detaches. The followed pane carries a 2 px buff rule along its top edge on desktop, joining tab and pane.
- **Phone extra-key bar:** Esc, Tab, sticky Ctrl, four arrows, pipe and paste as 44 px slate key caps; sticky Ctrl turns buff while armed.
- **Kbd:** 20 px key caps with a 1 px border, muted on surfaces and inheriting the colour inside a primary button.

### Wordmark
A blank strip drawn in SVG (buff, slate edge cell, two cell rules) beside TERMDOCK in lane caps.

### Live workspace (tabs, splits, in-pane states, palette)
- **Tabs, more than one:** the active tab is the buff one described above; the others are slate key caps (`board-3` at 55 %, muted board ink, full `board-3` on hover) that keep their 4 px state edge. A tab is labelled by its focused pane's session, then the terminal's OSC title in muted ink, a tabular pane-count well when it holds a split, and a bell mark when a pane rang out of sight. The split controls (right, down) are quiet icon buttons on the tab bar's trailing edge; the WebSocket's own state (offline countdown with Retry now, restarting) sits beside them in muted board ink.
- **Split panes:** dividers are the 6 px slate gap itself; hovering draws a 2 px `board-rule-strong` grip, dragging or focusing turns it buff. They take pointer and keyboard (arrows, Shift for large steps, Home/End). A pane of a split carries a 28 px slate caption (state mark, label in strip caps, state word, OSC title, close); the focused pane keeps the 2 px buff top rule and full strength, the others dim slightly (`brightness .72`), never fade.
- **In-pane states** never replace the terminal's last screen. Progress (Connecting…, Restoring…) is a slate chip with a spinner in the pane's top corner; Reconnecting is a slip docked at the top (countdown, Retry now); Disconnected and Ended are slips docked at the bottom (reason, Retry or Reopen) so the last output stays readable; a decision (host key, keyboard-interactive sign-in, a link to open) is a centred buff panel over a pane-local scrim. A slip whose title already names the state shows the state swatch beside the title instead of a separate chip. Fingerprints use the 12 px mono of the diagnostics page.
- **Strip actions:** a 32 px menu cell at the end of every strip (and right-click on the strip) opens a native popover menu on stock: open in a new tab, split right or down, retry, reopen, then terminate, set apart by a rule and space. Terminate swaps the menu for a danger-tint confirmation slip; no modal.
- **Command palette:** a buff sheet floating near the top of the pane area (Ctrl/⌘K outside terminals, Ctrl+Shift+K inside), a borderless search field over a grouped list: open sessions as mini strips (state edge, strip caps, `user@host`, status chip), then profiles as sentence-case rows with a plus mark. The highlighted row takes `stock-followed`; key hints sit in a ruled footer. It never blocks the workspace: Escape or a click outside closes it and the focus returns where it was.
- **Phone pane:** one session full screen under the 48 px header, never touching the desktop layout; the key bar's keys keep the focus in the terminal so the soft keyboard stays up, and a refused clipboard read becomes a warning slip above the bar.

### Management pages (hosts, credentials, activity, settings, admin)
The secondary pages stay on the same board and use the same stock; nothing about them competes with the workspace.
- **Way in:** the bay footer's username is a native disclosure that opens, inline, the list of secondary pages (never a popover over the strips).
- **Frame:** a 48 px slate bar whose first control leads back to the workspace, then the section links in muted board ink; the current one is board ink over a 2 px buff rule (the board's "you are here", never a state colour). On phones the links move to a second, sideways-scrolling row. Content sits on `board-0` in a 76rem column.
- **Page header:** the title in board ink (Title size), one line of context in board ink muted, page actions on the trailing edge (primary in buff, secondary bordered). Sections inside a page use the same 2 px buff rule as tabs (`SubNav`).
- **Sheet table:** a ruled table on stock, like a printed log: column labels in sentence case, muted, semibold; hairline rules between rows; tabular figures; counts right-aligned. Below 48rem every row becomes a block with each cell carrying its own label, so nothing scrolls sideways. Long machine values (fingerprints, hostnames, audit details) wrap anywhere instead of widening the sheet.
- **Tag:** a 20 px, 3 px-cornered, sentence-case label for the state of a record that is not a session: host key Trusted / Pending / Revoked / Mismatch, account Active / Disabled, role, profile protection mode. Feedback tints only (success, warning, danger, info) or a bordered neutral; the six state colours stay with sessions, and the word always carries the meaning.
- **Confirm action:** a destructive action behind a native disclosure. The first press opens a danger-tint slip that names exactly what will happen; the destructive button inside it submits; a server refusal (409 "still in use") shows in the same slip. No modal. It keeps the 2rem isolation beside other actions and drops it (`isolated={false}`) when it stands alone on its row.
- **Radio:** native, drawn like the checkbox: an empty writing-field ring at rest, the primary material with a field-coloured centre when chosen; disabled is a pale disc (the browser's dark disabled disc reads as "selected" on buff). Choice cards (credential type, colour scheme) are bordered stock rows; the chosen one takes `stock-followed` with an ink border.
- **Fingerprints and keys:** JetBrains Mono at 12 px so a SHA256 fingerprint fits one line in the 28rem diagnostics column; public keys and install commands sit in writing-field wells with a Copy button beneath.
- **Success after a redirect:** a success notice slip at the top of the page, from a whitelisted `?done=` key (the query string never injects text).

## Do's and Don'ts

### Do:
- **Do** read every colour through the surface roles (`ink`, `ink-muted`, `rule`, `primary`, `focus`); put new reading surfaces in `.surface-stock` and new shell areas in `.surface-board`.
- **Do** give every session a strip with its 4 px state edge and its state word nearby, and every live value tabular figures.
- **Do** keep transitions at the two tokens (`--duration-step` 60 ms, `--duration-move` 120 ms) on `cubic-bezier(0.16, 1, 0.3, 1)`; both drop to 0 under reduced motion.
- **Do** draw icons from `components/icons` (24-unit grid, 1.75 stroke, round caps) and keep them decorative with the name on the control.
- **Do** put empty states and in-pane prompts on a buff panel inside the pane.

### Don't:
- **Don't** use a state colour for anything but session state, or show a state colour without its word.
- **Don't** fade between states: recolour first, then move.
- **Don't** add a second sans family, a display face, or monospace outside codes, keys and secrets.
- **Don't** combine a border with a shadow, nest panels, or round anything past 6 px.
- **Don't** put a coloured side edge on panels, notices or list items; the 4 px edge belongs to strips and tabs, where it carries state.
- **Don't** set uppercase anywhere except strip labels, lane labels and the wordmark.
