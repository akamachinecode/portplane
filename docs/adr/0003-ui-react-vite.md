# ADR-0003: Build the UI as a React + Vite SPA embedded in the binary

- **Status:** Accepted
- **Date:** 2026-11-11
- **Resolves:** A2 in [open-questions.md](../open-questions.md)

## What it has to do

- Show a live list of machines, projects, worktrees and apps, updated within a second of a change.
- Offer a few actions per row and a setup flow with forms and diffs.
- Work in any modern browser, and later inside a native window (ADR-0004).
- Ship inside the Go binary, with no files to install next to it.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| Delivered as static files | High | Embedded with `go:embed`, served by the binary |
| Developer speed and hot reload | High | Most of the product's surface is UI |
| Bundle size | Low | Loaded from loopback |
| Reuse | Medium | Same stack as Exhale |

## Options

| | React + Vite | Svelte + Vite | Server-rendered HTML (Go templates + htmx) |
|---|---|---|---|
| Static output | Yes | Yes | No: HTML comes from Go |
| Live updates | Server-sent events into state | Same | Partial page swaps |
| Familiarity and reuse | High | Low | Medium |
| Size | ~60 KB gzipped for React | ~10 KB | Smallest |

## Verdict

**React 19 + Vite 8 + TypeScript**, built into `web/dist` and embedded with `go:embed`. Plain CSS with custom properties for light and dark themes; no component framework. The UI talks to the binary only through the JSON API and a server-sent events stream (ADR-0008).

**Cost we accept:** a Node toolchain to build the UI, and a heavier runtime than Svelte for a small UI.

**What would make us revisit it:** a native window that cannot host a web view (see ADR-0004).
