# AGENTS.md

Guidance for AI coding agents working on this repository (Claude Code, Codex, Cursor…).

## What this is

Portplane is a cross-platform desktop app (macOS, Linux, Windows). It shows every local dev server across the user's project folders and SSH machines, at stable `.localhost` URLs. It builds on dekit (processes) and portless (URLs) and never forks or replaces them.

**Status: early development** towards v1.0, following `docs/roadmap.md`. Read `docs/vision.md`, `docs/field-notes.md` and the ADRs in `docs/adr/` before changing architecture. New decisions become ADRs using the first-principles template in `docs/adr/README.md`; pending ones are in `docs/open-questions.md`.

## Layout and commands

- `cmd/portplane`: the binary that is the desktop app, the CLI and the remote agent. It stays static on Linux.
- `cmd/portplane-window`: the Linux window (GTK 4 and WebKitGTK loaded at run time), a second binary so `portplane` never links desktop libraries (ADR-0018).
- `internal/`: Go packages. `internal/webui/dist` holds the built UI that the binary embeds.
- `web/`: the React + Vite UI (`pnpm -C web dev|build|test|typecheck`).
- `site/`: the website on GitHub Pages (landing page and downloads). Its docs pages (`site/docs/`, not committed) come from the guides in `docs/` through `mise run site` (`scripts/sitedocs`); the Pages workflow runs it on deploy.
- `mise run build|test|lint`: everything CI checks. Dev servers run under dekit (`dekit.yaml` at the root), never started directly.

`prototype/` is the single-machine Node prototype that started the project. It is reference material: do not extend it into the product.

## Rules

- Everything in the repo is public and in English. Never commit names of clients, employers, private projects, hostnames or personal paths. Use generic examples (`web`, `api`, `my-monorepo`).
- Commits: Conventional Commits, signed off (`git commit -s`).
