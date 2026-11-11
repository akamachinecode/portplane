# ADR-0010: Generate shell-free commands, with a `portplane port-exec` wrapper for tools that ignore `PORT`

- **Status:** Accepted
- **Date:** 2026-11-11
- **Resolves:** A8 in [open-questions.md](../open-questions.md)

## What it has to do

Some dev servers ignore the `PORT` that portless sets (Sanity and Remotion, for example). By hand, the fix was `sh -c 'exec pnpm exec sanity dev --port "$PORT"'`, which does not work on Windows.

Facts checked against dekit 0.10.3:

- dekit runs `cmd` without a shell on every OS. A string `cmd` is split into words with sh-like rules; anything a shell would interpret (`$`, `|`, `&`…) is an error.
- On Windows, dekit only starts `.exe` files, so `npm`, `pnpm`, `yarn` and `portless` (all `.cmd` shims) must be run as `cmd /c "<command>"`.

## Options

1. `sh -c` on Unix and `cmd /c` with `%PORT%` on Windows: two quoting dialects to generate and test.
2. A tiny wrapper in the Portplane binary that substitutes placeholders from the environment and then runs the program directly.
3. Ask every tool upstream to read `PORT`: right in the long run, not in our control.

## Verdict

**Option 2, plus upstream issues where it makes sense.** `portplane port-exec -- <program> <args…>` replaces `{PORT}` and `{HOST}` in the arguments with the `PORT` and `HOST` environment variables (portless sets both) and then runs the program, forwarding signals and the exit code. Generated commands are always YAML arrays, never strings.

On Windows, the generator wraps the whole argv in `["cmd", "/c", …]` while dekit needs it, with arguments quoted for `cmd`.

**Cost we accept:** generated config for those few tools depends on the `portplane` binary being on `PATH`. The setup flow checks this and the docs say so.

**What would make us revisit it:** dekit or portless offering placeholder expansion themselves, or dekit starting `.cmd` files on Windows.
