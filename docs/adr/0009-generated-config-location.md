# ADR-0009: Write generated tasks to a `.portplane/tasks.yaml` fragment loaded from `dekit.yaml`

- **Status:** Accepted
- **Date:** 2026-11-11
- **Resolves:** P2 in [open-questions.md](../open-questions.md)

## What it has to do

The setup flow (M2) writes dekit tasks for the apps it finds. The result must keep working without Portplane (vision: no lock-in), survive re-scans that add and remove apps, and never overwrite what the user wrote by hand.

Facts checked against dekit 0.10.3:

- A project is the nearest `dekit.yaml`; `dekit ls` and the TUI work from anywhere inside it.
- `load:` pulls tasks from fragment files (globs, relative to the declaring file). A fragment may contain only `tasks` and `load`, must be inside the project and must not be named `dekit.yaml`.
- Two tasks with the same path are an error. Relative paths in a fragment resolve from the fragment's own folder.
- `dekit reload` shows a diff of config changes and applies it with `--yes`.

## Options

1. **Write everything into `dekit.yaml`.** One file, but every re-scan edits a file the user also edits.
2. **A fragment owned by Portplane, plus one `load:` line in `dekit.yaml`.** Hand-written tasks and generated tasks live apart.
3. **Config in the app's data directory.** `dekit` in a terminal would not see the tasks; breaks "no lock-in".

## Verdict

**Option 2.** For each chosen folder:

- Portplane owns `<folder>/.portplane/tasks.yaml`. It starts with a header saying it is generated and that a task moved into `dekit.yaml` becomes the user's.
- `dekit.yaml` gets a single `load:` entry for it, added once; if `dekit.yaml` does not exist, Portplane creates a minimal one.
- A task path that already exists anywhere else in the project's config is never generated: hand-written wins.
- Every write is shown first as a diff (added, changed and removed tasks, plus the raw file) and needs confirmation; afterwards Portplane runs `dekit reload --yes` if the runner is up.

**Cost we accept:** one extra hidden folder per chosen folder, which users may want to commit or ignore; the docs explain both.

**What would make us revisit it:** dekit gaining a native notion of generated or external task sources.
