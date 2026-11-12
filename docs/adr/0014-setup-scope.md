# ADR-0014: Setup understands JavaScript workspaces in v1 and guides installs without running them

- **Status:** Accepted. Installing dependencies (P5) is superseded by [ADR-0019](0019-install-tools.md) for installs and [ADR-0020](0020-privileged-steps.md) for privileged steps. The scanner scope and the generated tasks stand.
- **Date:** 2026-11-11
- **Resolves:** P3 and P5 in [open-questions.md](../open-questions.md)

## What it has to do

Turn a folder of projects into working dekit tasks wrapped by portless, applying the field notes, and get the user from "nothing installed" to "every app at its URL" without surprises.

## Scanner scope (P3)

**Verdict:** v1 detects what the field notes were written against:

- package managers from `packageManager` and lockfiles: pnpm, npm, yarn (classic and Berry), bun;
- workspaces from `pnpm-workspace.yaml` and `package.json` `workspaces`; root scripts that only fan out (`turbo dev`, `pnpm -r`, `nx`…) are skipped in favour of each app;
- frameworks from the dev script, then dependencies: Next, Vite, Astro, React Router/Remix, Nuxt, SvelteKit, Sanity, Remotion; anything else is "node" with a note that it must read `PORT`;
- a port hard-coded in the dev script (`--port`, `-p`, `PORT=`), which is bypassed by calling the framework directly;
- git worktrees from `git worktree list --porcelain`, each with its own tasks and names (`<app>.<worktree>.<project>.localhost`).

Python, Ruby, PHP and Go detection, and adding an app by hand from the UI, come after v1; a hand-written task in `dekit.yaml` always works and always wins.

## Installing dependencies (P5)

**Verdict:** guide, never install. Setup checks Node.js (24+, for portless), dekit, portless, the portless proxy and `portplane` on PATH, explains in one sentence why each is needed, and gives the exact command for the OS (the official dekit install script, `npm install -g portless`, `sudo portless service install`). Privileged commands are marked as such and only ever shown.

**Cost we accept:** a few copy-and-paste steps on first run.

**What would make us revisit it:** official installers for dekit and portless that run without privileges and can be verified.

## Generated tasks

Following the field notes, every generated task:

- runs from the app's own folder, as `portless <name> <pm> run dev` (with `run` spelled out);
- depends on one install job per checkout;
- unsets the variables that make tools change behaviour under coding agents;
- uses `portplane port-exec` for tools that ignore `PORT` (ADR-0010) and `cmd /c` on Windows.

Writes go to `.portplane/tasks.yaml` (ADR-0009) only after the user reviews the diff, and only if the folder has not changed since (a digest of the reviewed files must match).
