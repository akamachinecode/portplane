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

## portless

### `portless list --json`

- **State:** draft, not filed yet.
- **Ask:** `portless list --json` printing the active routes with `hostname`, `url`, `port`, `pid`, `registeredAt` and whether each is a static alias, plus the proxy's port and TLS state.
- **Why:** dashboards and agents need routes without reading `routes.json`, which is internal.
- **Workaround:** Portplane reads `routes.json`, `proxy.port` and `proxy.tls` from the state directory ([ADR-0007](adr/0007-portless-state.md)).

## Framework tools that ignore `PORT`

Sanity and Remotion start on their own default port even when `PORT` is set. Portplane passes the port explicitly with `portplane port-exec` ([ADR-0010](adr/0010-cross-platform-commands.md)). Proposals to read `PORT` and `HOST` when no flag is given are worth filing with each project.
