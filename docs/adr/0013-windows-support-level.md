# ADR-0013: Windows is beta until someone uses it daily

- **Status:** Accepted
- **Date:** 2026-11-11
- **Resolves:** R3 in [open-questions.md](../open-questions.md)

## What it has to do

The vision promises macOS, Linux and Windows. The maintainers use macOS and Linux daily; nobody on the project uses Windows for development yet. Facts: dekit runs on Windows but does not start `.cmd` shims directly (ADR-0010); portless supports Windows with a different state directory and no `/etc/hosts`.

## Verdict

- Windows builds ship from the first release, and CI runs the Go unit tests on `windows-latest` on every pull request.
- The README, the landing page and the release notes label Windows **beta** until at least one person reports using it daily for two weeks; the label is then removed in a release note.
- Windows-only bugs are fixed, but do not block a release unless they break install or start-up.

**Cost we accept:** rough edges on Windows during 0.x and possibly v1.0.

**What would make us revisit it:** a regular Windows user or contributor.
