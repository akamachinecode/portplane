# Security model

Portplane starts and stops processes, reads process information and connects to other machines. This page says what it trusts, what it exposes and what it never does. Report vulnerabilities privately (see [SECURITY.md](../SECURITY.md)).

## What runs where

| Component | Runs as | Listens on |
|---|---|---|
| `portplane` (app) | You | `127.0.0.1:<random port>`, plus a portless alias `portplane.localhost` |
| `portplane agent --stdio` (remote) | Your SSH user on that machine | Nothing: it speaks over the SSH session's stdin and stdout |
| Remote app forwards | You | `127.0.0.1:<random port>` per running remote app, aliased by portless |

Portplane never binds to a non-loopback address and refuses to (`portplane serve --listen 0.0.0.0:…` is an error).

## The local API

The UI talks to the binary over HTTP on loopback ([ADR-0008](adr/0008-local-api-security.md)):

- **Host allowlist.** Only `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>` and `portplane.localhost` are accepted, which defeats DNS rebinding.
- **Per-run token.** A random 256-bit token is written into the page and required on every API call, which defeats cross-site requests: other sites cannot read the page.
- **JSON only** for writes, a matching `Origin` when present, no CORS headers, and a strict Content Security Policy.
- **Validated actions.** Start, stop and restart only reach tasks that exist in the dekit projects of your chosen folders; nothing else is run. Commands go to dekit as separate arguments, never through a shell.

**Limit:** another user of the same computer can connect to loopback and read the token from the page. Portplane is meant for single-user developer machines.

The running instance also writes its port and token to `<user cache dir>/portplane/instance.json` (readable only by you), so a second `portplane` can ask it to show its window instead of starting twice.

## The window on macOS

On macOS the UI opens in Portplane's own window, a system web view (WKWebView) that loads only `http://127.0.0.1:<port>` ([ADR-0017](adr/0017-native-window-macos.md)). Any other web address opens in your default browser, and other schemes are refused. The web view keeps nothing on disk.

## Remote machines

- Reached only with your system `ssh`, your keys and your `~/.ssh/config` ([ADR-0015](adr/0015-remote-transport.md)). Portplane stores the host name, never credentials.
- The agent binary is uploaded to `~/.cache/portplane/<version>-<hash>/` and its SHA-256 is checked on the remote side before use. For another platform, the binary comes from the same GitHub release and is checked against its `checksums.txt`.
- The agent can only do what that SSH user can do: list ports and processes, run dekit there, and connect to loopback ports there.
- Opening a remote app goes through the same SSH session to a local loopback proxy ([ADR-0016](adr/0016-remote-urls.md)); nothing is exposed on either network.

## What Portplane writes

- Its settings: `<user config dir>/portplane/settings.json`.
- While it runs: `<user cache dir>/portplane/instance.json` (port, URL and token), removed when it quits.
- With your confirmation, after showing the diff: `<folder>/.portplane/tasks.yaml` and one `load:` line in `<folder>/dekit.yaml` ([ADR-0009](adr/0009-generated-config-location.md)).
- With `autostart on`: a LaunchAgent, an XDG autostart file or a `Run` registry value.
- portless aliases for itself and for open remote apps, removed when it quits.

## What Portplane never does

- Run anything with elevated privileges. `sudo portless service install` is shown to you, never run.
- Send data anywhere: no accounts, no telemetry, no update checks. The only outgoing requests are to your SSH hosts and, when you add a machine of another platform, to GitHub Releases.
- Install or change dekit, portless or Node.js.
