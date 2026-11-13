# ADR-0032: Calm by default: every fact said once, colour only for state, details on demand, and type that is easy to read

- **Status:** Accepted
- **Date:** 2026-11-13
- **Builds on:** [ADR-0028](0028-information-architecture.md) (one home per object), [ADR-0029](0029-visual-system.md) (neutral greys, green as the one colour, Inter at 13px), [ADR-0030](0030-app-icons.md) (icons of initials on eight tints)

## What it has to do

An audit of every screen on the owner's Mac (332 screenshots, about 160 states) found that the M5.8 layout put its objects in the right places, but each screen still said too much, too often:

- **One fact said up to 8 times.** A failed app showed in the toolbar ("1 failed"), a banner, the Health badge, the project's count in the sidebar, a dot on the project's icon, a red border around the project, a dot on the app's icon, and the word "Failed". The counts disagreed: the Health title counted 2 problems while it listed 5 cards, because notes were listed but not counted.
- **Colour that looked like state.** Icons of initials took one of eight tints from their name; the amber one matched "starting", the green one "running", the pink one "failed".
- **A paragraph on top of almost every page,** sometimes twice (Certificates said the same sentence in the page and in its first section).
- **Labels in capitals in every row** (APP ×32 in Addresses, STEP, ALIAS, OTHER MACHINE), and group titles in small capitals.
- **About 25 icon buttons on one screen of Apps,** with Start and Stop at the project, the checkout and the app, and a ragged column of 1 to 4 actions per row in Addresses.
- **Expert data at the weight of the rest:** PID, the full command and the dekit command next to the state and the address; absolute worktree paths in every checkout header.
- **Three counts of setup progress** (3 of 4 in the sidebar, 8 of 8 in the title, "Step 1 of 10" on the open step) and a sidebar card that went back to 3 of 4 whenever nothing ran.
- **Text at 10.5 to 12.5px** for counts, tags, branch names and paths.

The owner's requirement: the amount of information and the way it is shown must be easy for everyone, people with ADHD or dyslexia included, **as the default and not as a mode to turn on**, with clear separation between features, and without breaking any accessibility rule.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| Each fact said once on a screen, the same count everywhere | High | The audit; trust in the numbers |
| Easy to read for people with ADHD or dyslexia, by default | High | The owner's requirement |
| No loss of function: everything still one click or one key away | High | Portplane's promise: no terminal needed |
| WCAG 2.2 AA (colour is never the only cue, keyboard reaches everything) | High | M5.5's accessibility pass |
| Small change to the structure of ADR-0028 | Medium | It works; this is about density |

## Options

| | A reading mode (a setting) | Trim screen by screen | Rules for the whole app, then screen by screen |
|---|---|---|---|
| Helps people who never open Settings | No | Yes | Yes |
| Consistent across screens | Yes | No | Yes |
| Two designs to keep working | Yes | No | No |

## Verdict

**Rules for the whole app first; each screen is then reviewed against them.** The rules:

1. **Say it once.** A row shows its state by the dot on its icon; the word is written only when something needs a look (Starting, Failed, Stopping). Running is the green dot and a live address; off is neither. Screen readers still hear the state. Projects and checkouts have no state of their own: no coloured border, no dot on their icon; a count shows only while something runs ("2/5"), and nothing when nothing runs. The Apps title has no counts.
2. **One count of problems.** The Health badge, the one line above the apps and the Health title count the same things: errors and warnings. Notes are listed on Health under "Good to know" and counted nowhere.
3. **Colour means state.** Icons of initials are neutral grey unless the user picks a colour in the icon dialog. Green is for "alive" and for the one main action of a view; rare or risky actions (change a name, apply a service change, turn on LAN mode) are neutral buttons, and a destructive action at rest is red text, never a red button (the red button is in the confirmation). Favicons sit on a light tile in both themes, because many are drawn in black.
4. **Details on demand.** A page's explanation is behind the ⓘ next to its title. Row actions appear where the pointer or the keyboard is (hover, focus, the keyboard cursor, a selection); a failed row and anything in flight keep theirs; touch screens show them all. Addresses has two fixed slots per row: Open while live, then ⋯ with the rest. The app's PID, command, kind, dependencies and dekit command are under "Technical details", folded. Every check on Health is folded under "Every check". Paths move to tooltips.
5. **Text that is easy to read.** Inter at 14px for the UI (from 13px), a scale of 13/14/15/17/22/26px, nothing below 12px, line height 1.55, no capitals for labels or group titles, no negative letter spacing on body text. Group titles are sentence case at 14px, semibold. Tags are quiet words, not filled boxes.
6. **Room and separation.** Rows are 60px (46px compact), controls 32px, sections 48px apart; each feature sits in its own card or group.
7. **One model of setup progress.** Setup's title says "N of M done", or "All set", counted the same whatever step is open; steps show their name, not "Step 1 of 10". Once completed, Setup opens on its record. The sidebar card counts the setup itself (tools, HTTPS, projects); starting an app is the work, not setup, so the card no longer goes back when nothing runs. It says what comes next, not a second count.
8. **Questions asked once stay small.** The question about checking for updates is one line with neutral buttons, not a card with a green button.

**Cost we accept:**

- Actions that appeared at rest now appear on hover or focus: one more movement for a mouse user who never noticed them; keyboard and touch users see them as before.
- Fewer rows per screen (60px rows, 14px text).
- Icons of initials lose the variety of eight colours unless the user picks one.
- The ⓘ hides each page's explanation from people who never open it; Setup and the docs explain the same.

**What would make us revisit it:** people asking where an action went (it should then stay visible), contrast or size complaints at 14px, or a screen where the folded details are needed every time.
