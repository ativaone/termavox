---
version: 1
slug: "site-help"
primary_target: "site/help"
related_targets: ["site/pt-BR/help","site/src/index.html"]
---

# Help site — surface brief

**Scope and mode.** The project site's user help, `site/src/docs/help/` (English) and `site/src/pt-BR/docs/help/`, served by GitHub Pages after `site/build.ts` fills the shared chrome; Read. The app's "Learn more" links land here in a new tab, often on an anchor; its help button opens the documentation index. The home pages (`site/src/index.html`, a Persuade surface that sums up the README with the repository's screenshots), the documentation index and the guides rendered from `docs/` share this world and its chrome; the home opens on the claim, the actions and the workspace capture at full width.

**Audience and job.** Termdock users with a doubt about a session (what happens if…, what a notice means), on a laptop or a phone, often at night. Answer the question at the anchor in the UI's own words, then let them go back to the terminal.

**Constraints.** The app's world (`apps/web/DESIGN.md`, dark only); self-hosted fonts and no third-party requests; anchors are stable English ids shared by both languages and linked from the app (`HELP_SECTIONS`); statuses and messages quoted verbatim from the catalogs (`apps/web/test/help.test.ts`); only shipped features.

## Direction contract

THESIS: The cabin's own manual: the app's night cabin as one reading column of answers beside a fixed index. Refuses the default docs theme (white page, left nav tree, blue links) and the marketing card grid.

OWN-WORLD: The violet-navy ground with its two edge glows; translucent cards only for the tables and the diagram; notices as soft-tinted slips with a toned icon and ink text; state lamps beside their words; key caps; Plus Jakarta Sans in sentence case, JetBrains Mono for commands only.

STORY: The visitor learns where a session lives (in Termdock, not the browser), finds their situation in "What happens when…", matches the notice they saw, and knows which button to press.

FIRST VIEWPORT: A 56 px top bar (mark, "Termdock help", the language pair, the GitHub source link); the title and one line; the lead sentence over the three-node diagram browser ⇄ Termdock ⇄ server naming both connections and the one protection covers; on desktop the sticky index on the right.

FORM: The owner-approved sketch (artifact DHZH4rM8UDBFsTadfzKRAm), position 1 of 1; seed: none (not rolled: the owner approved a concrete sketch, a precisely specified request). Signature: the reading light lands on the section a link brought you to (`:target`), and the index lights the section being read.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
