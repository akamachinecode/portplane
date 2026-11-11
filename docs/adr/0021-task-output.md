# ADR-0021: Show a task's output on demand, in an Output panel

- **Status:** Accepted
- **Date:** 2026-11-12
- **Supersedes:** the "never a log view" part of [ADR-0011](0011-failures-not-logs.md): "Running apps show no output at all", with `dekit attach` in a terminal as the only way to see more. The failure excerpt and its copy button stand.

## What it has to do

M5 makes Portplane a full GUI for dekit, and seeing what a task prints is part of what dekit does (`dekit screen`, `dekit attach`). ADR-0011 sent users to a terminal for it. Without output in the app, M5's "no terminal" goal fails the first time a running app misbehaves.

- Show what a task prints, running or stopped, one app at a time, without a terminal.
- Keep output out of the main view: the state at a glance is still the point (vision).
- Cost nothing while closed.
- Use dekit's released interfaces only (ADR-0006).
- Later, type into a task (answer a prompt, press a key) without a terminal.

Facts checked against dekit 0.10.3:

- `dekit screen --json <task>` returns what the task's terminal shows now, with colours. It is part of the published CLI.
- `dekit attach <task>` connects a terminal to a task. dekit marks the RPC behind it as "not public yet and may still change".
- dekit's `log` setting can write a task's output to a file. It is off unless the task's config turns it on.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| No terminal needed | High | M5's goal |
| The main view stays calm | High | Vision: state at a glance |
| Released dekit interfaces only | High | ADR-0006 |
| Cost while closed | Medium | The roadmap's CPU and memory budgets |
| Typing into a task | Low, for now | Useful, not needed for M5.4 |

## Options

| | Poll `dekit screen --json` while the panel is open | dekit's attach RPC | Read dekit's `log` files | Keep ADR-0011 |
|---|---|---|---|---|
| Released interface | Yes | No: not public yet | Yes | Yes |
| Shows | The task's current screen | A live stream | Everything the task wrote | The last 15 lines after a failure |
| Typing into the task | No | Yes | No | No |
| Needs a config change | No | No | Yes, per task | No |
| Cost while closed | None | None | None | None |
| Terminal needed for more | No | No | No | Yes |

## Verdict

**An Output panel in the app's detail drawer (ADR-0024), closed by default, in two phases.**

- **Phase 1 (M5.4).** While the panel is open, the UI asks for the task's screen once a second, which runs `dekit screen --json`. xterm.js draws it, colours included. The panel has search, copy, "Go to the end", pause, and "Open in a terminal", which copies `dekit -C <project> attach <task>`. Closing the panel stops the requests.
- **Phase 2.** An interactive terminal (typing, resizing) over dekit's attach RPC, once dekit publishes it as stable. We ask for that upstream ([upstream.md](../upstream.md)). Anything built on the RPC before then stays behind the runner adapter (ADR-0006) and a setting.
- **The failure excerpt stays** as ADR-0011 has it: the last 15 non-empty lines, fetched when a failed row is expanded, with a copy button. It gains a "Show output" link to the panel.
- **The main view shows no output.** Output is one click away, never on by default, never inside the list.
- **Local machine first.** Remote machines keep the excerpt. The panel follows when the agent protocol carries it (M5.6).

**Cost we accept:**

- Phase 1 shows the task's current screen, not its history. Output that scrolled off is gone, as with the excerpt.
- One `dekit screen` process a second while the panel is open. It has not been measured yet; M5.4 measures it against the CPU budget.
- xterm.js, a new UI dependency, loaded only when the panel first opens.
- The vision's "no logs" line becomes "no logs in the main view".

**What would make us revisit it:** dekit publishing the attach RPC as stable (which starts phase 2), or a JSON interface that streams a task's output with its scrollback; the polling showing up in the CPU budget; people keeping the panel open as their main view.
