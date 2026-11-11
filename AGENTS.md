# AGENTS.md

Guidance for AI coding agents working on this repository (Claude Code, Codex, Cursor…).

## What this is

Portplane is a cross-platform desktop app (macOS, Linux, Windows). It shows every local dev server across the user's project folders and SSH machines, at stable `.localhost` URLs. It builds on dekit (processes) and portless (URLs) and never forks or replaces them.

**Status: design phase.** Read `docs/vision.md`, `docs/field-notes.md` and `docs/open-questions.md` before proposing architecture. Decisions become ADRs in `docs/adr/` using the first-principles template in `docs/adr/README.md`.

`prototype/` is the single-machine Node prototype that started the project. It is reference material: do not extend it into the product.

## Rules

- Everything in the repo is public and in English. Never commit names of clients, employers, private projects, hostnames or personal paths. Use generic examples (`web`, `api`, `my-monorepo`).
- Commits: Conventional Commits, signed off (`git commit -s`).
