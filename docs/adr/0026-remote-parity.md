# ADR-0026: Serve setup, dekit and portless on every machine by tunnelling API requests to the agent

- **Status:** Accepted
- **Date:** 2026-11-12
- **Builds on:** [ADR-0005](0005-every-machine-is-an-agent.md) (every machine is an agent), [ADR-0015](0015-remote-transport.md) (system ssh, an uploaded agent, yamux over stdio), [ADR-0020](0020-privileged-steps.md) (privileged steps), [ADR-0024](0024-app-shell.md) (app shell, jobs)

## What it has to do

Until M5.6, the guided setup (M5.1), the portless center (M5.2) and the dekit center (M5.3) worked on the computer Portplane runs on. Machines reached over SSH showed their apps, started and stopped them, and showed their output (M5.4), and nothing more. Remote parity means everything those three areas do also works on a machine over SSH:

- **Setup:** the system check, scanning and writing a watched folder, and installing dekit, a private Node.js and portless into that machine's home, without privileges.
- **Privileged steps** (the proxy service, trusting the CA, the hosts file): nobody sits at a remote machine's screen to answer a password dialog, and no password may travel.
- **dekit:** runners and their actions, why, the task and project config editors with their diff and reload review, adding an app, running a command, dekit's version and update.
- **portless:** status and options, routes, aliases, renames, `portless.json`, certificates (exporting a remote CA to this computer), doctor.
- **Long operations** (installs, runner actions, proxy steps) run on that machine as jobs and show in the UI like local ones.

Facts that shape it:

- The agent is the Portplane binary itself (ADR-0015): the handlers that serve these areas for this computer (`cmd/portplane/wire_*.go` → `internal/server/*.go`) are already in it.
- The agent speaks JSON over yamux over the SSH session's stdin and stdout, and never listens on a port.
- The three areas are about 55 HTTP endpoints, and part A of M5.6 (sharing, Compose, LAN mode) adds more under `/api/portless/`.
- Agents and Portplane are almost always the same build: the agent is uploaded per version and checksum (ADR-0015). An agent from before this decision is still reachable while its session lasts, or when a machine runs one started by another Portplane.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| One implementation per feature | High | 55 endpoints and growing; two code paths drift |
| Security model unchanged | High | ADR-0008's token and Host checks; nothing new listening anywhere; no password over the wire |
| New endpoints work remotely with no extra work | High | M5.6 part A and later milestones land in parallel |
| Version skew is visible and fixable | Medium | An older agent must say so, not fail obscurely |
| Latency | Medium | Each action already crosses SSH; one round trip per request is fine, more is not |
| Streaming | Low | The areas answer with whole JSON documents; long operations are jobs |

## Options

| | 1. One protocol method per feature | 2. Tunnel API requests to the agent's own handlers | 3. The agent listens on a loopback port, forwarded over SSH | 4. Run the CLIs over `ssh host dekit …` |
|---|---|---|---|---|
| Implementations per feature | Two (handler + method) | One | One | Two (local Go + remote shell) |
| Endpoints added later | Need a method each | Work if under a per-machine area | Work | Need a port each |
| Listens on a port | No | No | Yes, on the remote loopback | No |
| Token / Host checks | Local | Local | Local and a second token on the agent | Local |
| Jobs | Per method | Mirrored over the existing connection | Need their own stream | None |
| Shell strings | No | No | No | Yes (ADR-0010 forbids) |
| Version skew | Unknown method | Unknown method, once, for every area | Connection refused | Errors from the shell |

## Verdict

**Option 2.** The agent serves the same area handlers, built with its own machine's dependencies, and Portplane carries API requests to it over the existing protocol.

**Protocol (compatible with protocol 1).**

- `http`: one request, `{method, path, query, body}`, answered with `{status, header, body}`. The agent runs it through an in-memory `http.Handler`; it never listens. Only `/api/…` paths without `..`, only GET, POST, PUT and DELETE, bodies up to 1 MiB in and 16 MiB out, five minutes at most per request, and only `Content-Type`, `Content-Disposition` and `Cache-Control` travel back.
- `hello` carries the id Portplane knows the machine by, so the agent's answers (app ids, job ids, `machine` fields) match the UI's.
- `watchJobs` and the `job` notification: the agent's jobs manager names its jobs `<machine>:<id>` and pushes every change. Portplane mirrors them into its own manager, so the event stream, `GET /api/jobs/{id}` and cancel work as for a local job; cancel travels back as a tunnelled request. Jobs still running when the connection drops end as failed, saying so.

**Routes.** `/api/m/{machine}/<area path>`, a path prefix rather than a `?machine=` parameter: one place routes it, the handlers stay unchanged, and the UI rewrites a prefix instead of adding a parameter to every call. For this computer (`local`) it is served by the same routes as `/api/<area path>`; for another machine the request goes to its agent. Only the per-machine areas travel (`MachineAreas` in `internal/server/machine_api.go`: `setup/`, `tools/`, `proxy/`, `trust/`, `path/`, `folders/suggestions`, `dekit/`, `portless/`); preferences, settings, machines, the event stream, jobs, diagnostics, updates, notifications and the window stay with Portplane. Anything new under those prefixes is reachable on every machine with no extra work, as part A's `/api/portless/…` endpoints are.

**What stays on this computer, and why.**

- ADR-0008's token and Host checks run in Portplane before a request is tunnelled. The agent trusts its stdin, which only the Portplane that started it over SSH can write to.
- Exporting a remote CA reads `GET /api/portless/certificates/ca.pem` through the tunnel, checks it is a PEM certificate, and saves it in this computer's Downloads folder as `portless-ca-<machine>.pem`.
- Diagnostics, update checks and notifications (M5.5) are about this Portplane and this desktop. The diagnostic report already holds every machine's snapshot with its agent version; remote jobs reach notifications because they are mirrored into the local jobs manager. Opening a file in an editor, revealing a folder and browser trust need a desktop the remote machine doesn't have, and say so.

**A headless agent.** The agent calls `privileged.Headless()`: `privileged.Run` returns `ErrUnavailable` without trying a dialog, and the plan's `method` is empty. The UI then shows each privileged step as `ssh -t <host> 'sudo …'` to copy into a terminal on this computer, where sudo asks for the password on that machine, and a "Check again" button. No password is ever sent anywhere.

**Version skew.** An agent from before this ADR answers `http` with "unknown method". Portplane turns that into `501` with `{"code": "agent-outdated"}`, and the UI marks the machine: its views show "Update the agent on <machine>", Health lists it, and the button uploads the agent again (`POST /api/m/{machine}/agent/update`: forget the cached start command and reconnect). The mark comes from an answer, not from comparing version strings: a version says nothing about which methods an agent serves, the answer does.

**UI.** `api.forMachine(id)` returns the same API with the setup, dekit, tools and portless parts sent to `/api/m/<id>/…`; `<MachineScope machine>` puts that API and the machine's snapshot in context, so sections and dialogs need no machine parameter. Runners and Domains get a machine picker, remembered per view and also in the URL (`#/runners/<machine>`, `#/domains/<section>/<machine>`) so Health and the palette can link to a machine's page; Projects and the app detail drawer already have the machine in their route; a remote machine's guided setup is `#/setup/<machine>/<step>`. Health loads each online remote machine's portless status, certificates and runners once per connection, and its problems name the machine and link to its pages.

**Cost we accept:**

- One SSH round trip per request; a page that makes several requests pays each one.
- Answers are buffered whole: nothing streams through the tunnel. Long operations are jobs, whose updates come as notifications.
- An agent restart (the SSH session dropped) loses its running jobs; they end as failed and the user checks the machine.
- A remote machine's setup progress is not saved in the preferences: the setup starts at its check each time, which is quick because the check shows what is already done.
- Remote machines are still Linux and macOS only (ADR-0015).

**What would make us revisit it:** a feature that needs a stream (an interactive terminal, ADR-0021 phase 2) adds a stream method next to `http` rather than changing it; round trips showing up as slow pages (batch requests per view); agents that must be updated apart from Portplane (per-area capability negotiation instead of "unknown method").
