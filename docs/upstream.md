# Upstream proposals

Portplane never forks dekit or portless (vision, principle 1). When it needs something they lack, the request goes upstream. This page keeps the proposals and their state; each one names the workaround Portplane uses meanwhile.

## dekit

### Resolved task config in `dekit ls --json`

- **State:** draft, not filed yet.
- **Ask:** add the resolved `cmd` (argv), `cwd` (absolute) and `deps` of each task to `dekit ls --json`, after `!js`, `defaults` and `load` mounts are applied.
- **Why:** tools that show or open a project's servers need to know which folder and command each task runs. Today they must re-implement dekit's config reader, including the `load`/`at` and string-splitting rules, and cannot evaluate `!js` at all.
- **Workaround:** Portplane parses `dekit.yaml` and its fragments itself and treats `!js` values as unknown ([ADR-0006](adr/0006-adapters.md)).

### Stable JSON contract

- **State:** draft, not filed yet.
- **Ask:** document `dekit ls --json`, `dekit screen --json` and `dekit wait --json` as a stable, versioned interface (for example a `"version": 1` field), with additive changes only within a version.
- **Workaround:** Portplane tolerates unknown fields and unknown states, and tests against recorded output.

### A stable attach RPC

- **State:** draft, not filed yet.
- **Ask:** publish the RPC behind `dekit attach` as a stable, documented interface: stream a task's output with its scrollback, send input, and resize.
- **Why:** a GUI that shows a task's output can only poll `dekit screen --json`, which gives the current screen, without history and without a way to type into the task. dekit marks the RPC as "not public yet and may still change", so nothing outside dekit can build on it.
- **Workaround:** Portplane's Output panel shows `dekit screen --json` once a second while it is open ([ADR-0021](adr/0021-task-output.md)). The interactive terminal waits for this.

## portless

### `portless list --json`

- **State:** draft, not filed yet.
- **Ask:** `portless list --json` printing the active routes with `hostname`, `url`, `port`, `pid`, `registeredAt` and whether each is a static alias, plus the proxy's port and TLS state.
- **Why:** dashboards and agents need routes without reading `routes.json`, which is internal.
- **Workaround:** Portplane reads `routes.json`, `proxy.port` and `proxy.tls` from the state directory ([ADR-0007](adr/0007-portless-state.md)).

### `portless doctor --json` and `portless service status --json`

- **State:** draft, not filed yet.
- **Ask:**
  - `portless doctor --json`: one object per check, with its name, a status (`ok`, `warn`, `fail`), a message, and the command that fixes it when there is one.
  - `portless service status --json`: whether the service is installed, its state in the service manager, whether the proxy answers, its port, TLS and TLDs, the options it was installed with, and the Node path it runs with and whether that path exists.
- **Why:** dashboards and agents need to show a diagnosis and offer fixes without parsing text written for people, which changes between releases.
- **Workaround:** Portplane parses the text with one parser per output format, tested against fixtures from each supported version, and shows the raw text when parsing fails ([ADR-0023](adr/0023-portless-cli.md)).

## Framework tools that ignore `PORT`

Sanity and Remotion start on their own default port even when `PORT` is set. Portplane passes the port explicitly with `portplane port-exec` ([ADR-0010](adr/0010-cross-platform-commands.md)). Proposals to read `PORT` and `HOST` when no flag is given are worth filing with each project.
