# ADR-0011: Show the last lines of a failed app, never a log view

- **Status:** Accepted. Its "never a log view" part, that running apps show no output, is superseded by [ADR-0021](0021-task-output.md). The failure excerpt stands.
- **Date:** 2026-11-11
- **Resolves:** P4 in [open-questions.md](../open-questions.md)

## What it has to do

The vision rules out terminal output on screen. But when an app fails, the user needs to know why without opening a terminal.

Facts: `dekit screen --json <task>` returns what the task's terminal shows now, with colours. `dekit ls --json` reports `exit_code`, `signal` and `reason` (for example `ready_timeout`).

## Verdict

- A failed app (`exited` with a non-zero code, `backoff`, or a ready timeout) shows its state, the exit code or reason, and an **excerpt**: the last 15 non-empty lines of its screen, with escape codes stripped, fetched on demand when the row is expanded.
- The excerpt has a **copy** button, so it can go straight into a coding agent.
- Running apps show no output at all. For full logs, the user has `dekit attach` and `dekit screen`; the UI shows the exact command to run.

**Cost we accept:** a failure whose cause scrolled off the visible screen is not shown.

**What would make us revisit it:** repeated reports that the excerpt misses the cause.
