# ADR-0006: Read dekit and portless through adapters, and parse dekit config ourselves

- **Status:** Accepted
- **Date:** 2026-11-11
- **Resolves:** A6 in [open-questions.md](../open-questions.md)

## What it has to do

For each folder the user picks, the local agent needs:

- the tasks, with their path, label, type, working directory and command (to know the app's URL and folder);
- each task's live state;
- start, stop and restart;
- the last lines of a task's terminal when it fails;
- the URL and internal port of each app.

Facts checked against dekit 0.10.3 and portless 0.16.0:

- `dekit ls --json` returns `{"tasks": [{id, path, label?, kind, state, exit_code?, signal?, reason?}]}`. It does **not** include `cmd` or `cwd`.
- `dekit screen --json <task>` returns `{"screen": "..."}`: what the task's terminal shows now.
- dekit's embedded JavaScript API (`std.dekit`) can act on tasks but cannot read the config.
- Each project has its own runner, found from the nearest `dekit.yaml`; `-C <dir>` names it.
- `dekit.yaml` may use `!js` tags and `load:` fragments with an `at:` mount path; `cmd` is an array or a string split by sh-like rules; relative paths resolve from the declaring file.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| Only released, documented interfaces where they exist | High | No forks, no private state when avoidable |
| Correct cwd and command per task | High | Needed to map tasks to projects and URLs |
| Room for other runners and routers later | Medium | mprocs, overmind and Compose are on the list |

## Verdict

Two small interfaces inside the agent:

- **Runner** (dekit first): `Projects(folders)`, `Tasks(project)`, `States(project)`, `Act(project, target, verb)`, `Screen(project, task)`.
- **Router** (portless first): `Routes()`, `NameFromCommand(argv, cwd)`, `Alias(name, port)`, `RemoveAlias(name)`.

The dekit adapter calls the CLI for everything live (`ls --json`, `start`, `stop`, `restart`, `screen --json`, `up`) and parses `dekit.yaml` and its fragments itself for `cmd`, `cwd`, `label`, `type` and `deps`, following the documented rules. A value written with `!js` is treated as unknown, not evaluated; the task still appears, only its command-derived URL may be missing.

The collector and the hub never import an adapter; the agent wires them.

**Cost we accept:** our reader can drift from dekit's real parser. Tests use recorded configs, and the gap is reported upstream: a `dekit ls --json` that includes `cmd` and `cwd` would let us delete the parser.

**What would make us revisit it:** dekit exposing resolved task config in JSON.
