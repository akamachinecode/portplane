# ADR-0023: Act on portless through its CLI, read its state files, and parse its text with versioned fixtures

- **Status:** Accepted
- **Date:** 2026-11-12
- **Extends:** [ADR-0007](0007-portless-state.md). Routes are still read from the state directory. This ADR adds every action and every read that M5 needs.

## What it has to do

M5 puts every daily portless operation in the app. Portplane must do each one the way portless does it, without forking or re-implementing it (vision, principle 1).

- Start and stop the proxy. Install, reinstall and uninstall its service, with its options: port, HTTPS, TLDs, wildcard, LAN, own certificate.
- Add and remove aliases.
- Trust the CA. Sync and clean `/etc/hosts`.
- Show the diagnosis (`doctor`) as a list of checks, each with a fix.
- Show whether the service is installed and running, and whether the Node it points at still exists.
- Prune stale routes, kill orphaned servers, clean up everything.

Facts checked against portless 0.16.0:

- The commands: `proxy start` and `stop`, `service install`, `uninstall` and `status`, `alias` and `alias --remove`, `trust`, `hosts sync` and `clean`, `doctor`, `prune` and `prune --force`, `clean`, `get` and `list`.
- None of them has a `--json` option. `doctor` and `service status` print text meant for people.
- The state directory (ADR-0007) holds `routes.json`, `proxy.port` and `proxy.tls`, the CA in `ca.pem` with the fingerprint last trusted in `ca.trusted`, and `host-certs/`.
- `portless mcp` exposes the same operations over MCP. Its structured output wraps the same text.
- portless keeps the proxy's options in the service it installs. Changing an option means reinstalling the service.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| Released interfaces only | High | Vision, principle 1: no forks |
| Same behaviour as in the terminal | High | Someone mixing app and terminal sees one truth |
| Survives portless releases | High | Text output is not a contract |
| A parse failure does not hide the problem | Medium | The diagnosis is where users go when things break |
| Code to maintain | Medium | One maintainer |

## Options

| | CLI for actions, state files for reads | `portless mcp` | Import portless's JavaScript modules | Do it ourselves: write `routes.json`, install the service |
|---|---|---|---|---|
| Released interface | Yes | Yes | No: internal modules | No: re-implements portless |
| Structured output | No, for `doctor` and `service status` | Wraps the same text | Yes | Yes |
| Runtime | One process per action | A long-running Node process | Node next to Portplane | None |
| Follows portless's behaviour | Yes | Yes | Until the internals change | No |

## Verdict

**Actions go through the portless CLI. Reads come from its state files, as ADR-0007 does for routes.**

- **Actions.** `proxy start` and `stop`, `service install`, `uninstall` and `status`, `alias` and `alias --remove`, `trust`, `hosts sync` and `clean`, `doctor`, `prune` and `prune --force`, `clean` and `get`. Each one runs as argv, by absolute path, never through a shell (ADR-0010). The ones that need admin rights go through ADR-0020.
- **Reads.** `routes.json`, `proxy.port`, `proxy.tls`, `ca.pem`, `ca.trusted` and `host-certs/`, behind the router adapter (ADR-0006). The reader tolerates missing and unknown fields, as today.
- **Parsing text.** The output of `doctor` and `service status` becomes a list of checks (name, state, message). One parser per output format, tested against fixtures recorded from each supported portless version. When a line, or the whole output, does not match, Portplane shows the raw text, with no fix button for what it could not read.
- **Minimum version.** Portplane reads `portless --version`. The health view flags a version older than the oldest fixtures.
- **Options.** The proxy form explains that portless keeps its options in the service, so "Apply" reinstalls the service and asks for the password (ADR-0020).
- **Not used.** `portless mcp` is for coding agents (open question P6). `list` is not parsed: `routes.json` gives the same data.
- **Upstream.** We ask for `--json` on `list`, `doctor` and `service status` ([upstream.md](../upstream.md)). When it ships, the parsers go.

**Cost we accept:**

- A portless release can change its text. Until the fixtures catch up, the user sees raw text instead of checks with fixes.
- One process per action. Actions happen on a click, and reads stay on files.
- More of portless's internal files to follow: ADR-0007's cost, for more files.

**What would make us revisit it:** `--json` shipping for those commands; portless offering a library or a local API.
