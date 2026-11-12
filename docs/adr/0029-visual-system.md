# ADR-0029: A quieter visual system: neutral greys, Portplane's green as the one colour, Inter and Geist Mono, more room

- **Status:** Accepted
- **Date:** 2026-11-12
- **Builds on:** [ADR-0024](0024-app-shell.md) (tokens in plain CSS, theme and density), [ADR-0027](0027-projects-first-layout.md) (the inset panel)

## What it has to do

The owner asked for a more professional look, closer to Linear: lots of information that still reads clearly, with more room inside the panels and windows. They asked to keep the green, which they see as Portplane's own, and for a new typeface.

Facts:

- The UI is plain CSS with custom properties (ADR-0003). Every colour, size and space is a token in `web/src/styles.css`, as `light-dark()` pairs.
- The accent was a violet; green only marked running apps. Every primary button, focus ring and selected tab was violet.
- The font was the system's (`-apple-system`, Segoe UI…), so each OS showed another typeface and other widths.
- The native windows keep no web storage and load nothing from the network (ADR-0017, ADR-0018, ADR-0025): fonts must be bundled.
- Portplane shows many addresses, ports, paths and commands: the monospace face is on screen as much as the text face.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| Reads as a current, professional tool | High | The owner's request |
| Green stays Portplane's colour | High | The owner's request |
| AA contrast in both themes | High | M5.5's accessibility pass |
| Works offline, the same on every OS | High | Native windows |
| Size added to the binary | Low | Fonts load only when used |

## Options

**Typeface**

| | System fonts (today) | Inter + Geist Mono | Geist + Geist Mono |
|---|---|---|---|
| Same on every OS | No | Yes | Yes |
| Dense UI at 13px | Varies | Made for it; optical sizes for titles | Good |
| Close to Linear | On macOS only | Yes (Linear uses Inter) | No |
| Bundled size (Latin, Latin Extended) | 0 | ~245 KB | ~150 KB |

**Colour**

| | Violet accent, green for state (today) | Green as the one colour | Monochrome, green for state only |
|---|---|---|---|
| Keeps the green | Partly | Yes | Partly |
| One meaning per colour | Two colours to learn | Green means "alive" and "the main action" | Yes |
| Contrast of a green button | n/a | Dark text on bright green in the dark theme; white on deep green in the light one | n/a |

## Verdict

**Neutral greys, Portplane's green as the only colour, Inter for text and Geist Mono for code, and more room everywhere.**

- **Colour.** Greys step from the window (the sidebar's colour) to the panel to cards, with hairline borders and no card shadows. Green (`#3dd68c` dark, `#10804a` light) is the accent: primary buttons, focus, the selected tab, and the state of running apps, so green always means "alive" or "do this". Amber and red only carry state. Eight tints exist for icons of initials (ADR-0030).
- **Type.** Inter Variable with optical sizes (titles get its display cut) at 13px for the UI, weights 510 and 590; Geist Mono for addresses, ports, paths and commands. Both are bundled from Fontsource (`@fontsource-variable/inter`, `@fontsource-variable/geist-mono`, OFL), Latin and Latin Extended only: other scripts fall back to the system's fonts, and a file loads only when a page uses its characters.
- **Room.** List pages run up to 1200 px wide with 32 px gutters; settings, Health, Setup and the portless pages are one 760 px column. App rows are 56 px with a 28 px icon; sections are 40 px apart; settings are a heading over one card of 60 px rows (label and explanation on the left, the control on the right), as in Linear's settings. The app drawer is 640 px wide. Compact density keeps today's tighter values.
- **Fewer accents.** Problem fixes, runner actions and secondary actions are neutral buttons; one primary button per view at most.

**Cost we accept:**

- About 245 KB of fonts in the binary, and a moment of the fallback font on the very first paint (`font-display: swap`).
- Green for both "running" and "primary action": a running app and a primary button share a colour.
- Lists show fewer rows per screen in the comfortable density; compact is one click away in Settings.

**What would make us revisit it:** a contrast failure in either theme; users of non-Latin scripts finding the fallback mix jarring; the binary size budget.
