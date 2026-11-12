# Security model

Portplane starts and stops processes, reads process information, connects to other machines and, when you ask, installs dekit and portless and runs portless's admin steps. This page says what it trusts, what it exposes and what it never does. Report vulnerabilities privately (see [SECURITY.md](../SECURITY.md)).

> Installs, privileged steps and update checks arrive with milestone M5 ([roadmap](roadmap.md)). Until a release includes them, Portplane shows the commands for you to run instead.

## What runs where

| Component | Runs as | Listens on |
|---|---|---|
| `portplane` (app) | You | `127.0.0.1:<random port>`, plus a portless alias `portplane.localhost` |
| `portplane agent --stdio` (remote) | Your SSH user on that machine | Nothing: it speaks over the SSH session's stdin and stdout |
| Remote app forwards | You | `127.0.0.1:<random port>` per running remote app, aliased by portless |
| Installs of dekit, Node.js and portless | You | Nothing |
| Privileged portless steps, on your click | root, after the system's password dialog | Nothing of Portplane's; the portless proxy listens where you chose |

Portplane never binds to a non-loopback address and refuses to (`portplane serve --listen 0.0.0.0:…` is an error).

## The local API

The UI talks to the binary over HTTP on loopback ([ADR-0008](adr/0008-local-api-security.md)):

- **Host allowlist.** Only `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>` and `portplane.localhost` are accepted, which defeats DNS rebinding.
- **Per-run token.** A random 256-bit token is written into the page and required on every API call, which defeats cross-site requests: other sites cannot read the page.
- **JSON only** for writes, a matching `Origin` when present, no CORS headers, and a strict Content Security Policy.
- **Validated actions.** Start, stop and restart only reach tasks that exist in the dekit projects of your chosen folders. Commands go to dekit and portless as separate arguments, never through a shell. Installs and privileged steps take your choices (which tool, which proxy options), never a command, so the page cannot ask for anything else.

**Limit:** another user of the same computer can connect to loopback and read the token from the page. Portplane is meant for single-user developer machines.

The running instance also writes its port and token to `<user cache dir>/portplane/instance.json` (readable only by you), so a second `portplane` can ask it to show its window instead of starting twice.

## The window on macOS

On macOS the UI opens in Portplane's own window, a system web view (WKWebView) that loads only `http://127.0.0.1:<port>` ([ADR-0017](adr/0017-native-window-macos.md)). Any other web address opens in your default browser, and other schemes are refused. The web view keeps nothing on disk.

## Remote machines

- Reached only with your system `ssh`, your keys and your `~/.ssh/config` ([ADR-0015](adr/0015-remote-transport.md)). Portplane stores the host name, never credentials.
- The agent binary is uploaded to `~/.cache/portplane/<version>-<hash>/` and its SHA-256 is checked on the remote side before use. For another platform, the binary comes from the same GitHub release and is checked against its `checksums.txt`.
- The agent can only do what that SSH user can do: list ports and processes, run dekit there, and connect to loopback ports there.
- Opening a remote app goes through the same SSH session to a local loopback proxy ([ADR-0016](adr/0016-remote-urls.md)); nothing is exposed on either network.
- Installs and privileged steps run on your local machine only.

## Installing tools

Portplane installs dekit, portless and, when you have no Node.js 24 or later, a private Node.js for portless ([ADR-0019](adr/0019-install-tools.md)).

- **Only on your click,** after a card shows the source, the version and the folder.
- **As you, without a password,** into your home: dekit and a `portless` launcher in `~/.local/bin`; the private Node.js and its npm prefix in Portplane's data folder (`~/.local/share/portplane` on Linux).
- **Only from official sources:** see [Network](#network).
- **Checked before it runs:**
  - dekit's installer checks the dekit binary against the release's `SHA256SUMS`;
  - Node.js archives are checked against the release's `SHASUMS256.txt` before they are unpacked;
  - npm checks each package against the integrity hash the registry lists.
- **dekit's install script** is the one download without a checksum of its own, because dekit publishes none. Portplane fetches it only from `https://dekit.run` over HTTPS, saves it to a file and runs that file as argv. It never pipes a download into a shell.
- **No second copies.** A tool you installed another way (Homebrew, npm, pip, mise) is updated through that method, never replaced.
- **Your shell profile** changes only if you say yes: one line that adds `~/.local/bin` to PATH, shown before it is written.

## Privileged steps

A few portless steps need admin rights ([ADR-0020](adr/0020-privileged-steps.md)): `service install` and `uninstall`, `trust`, `hosts sync` and `clean`, and `proxy start` and `stop` on a port below 1024.

- **Only on your click,** on a button that says it will ask for your password.
- **The exact command first.** A confirmation shows the argv, one argument per line, and the environment that goes with it.
- **Through the system's own dialog:** `pkexec` on Linux, `osascript … with administrator privileges` on macOS, UAC on Windows. Your password goes to the operating system. Portplane never asks for it, sees it or stores it.
- **Argv only,** with absolute paths. Portplane never builds a shell string. On macOS, `do shell script` starts `/bin/sh`; each argument reaches it quoted by AppleScript's `quoted form of`.
- **Environment passed:** `HOME`, `PORTLESS_STATE_DIR`, `SUDO_UID` and `SUDO_GID`, with your values, so portless keeps its state in your home and owned by you. Nothing else.
- **Fallbacks.** When no dialog can open, Portplane shows the `sudo` command to copy. To avoid admin rights altogether, the proxy can run as you on port 1355, with URLs such as `https://web.localhost:1355`.

**Limit:** the Node.js and portless that run as root can live in folders you can write (Portplane's data folder, a user-owned npm prefix, Homebrew). A program running as you could change them before the next privileged step, or before the portless service restarts. Running `sudo portless service install` with a user-installed Node.js has the same weakness. The security review before M5.1 decides whether privileged steps need a root-owned copy.

## Network

Portplane makes outgoing requests only to your SSH hosts and, when you start a download or an update check, to these official sources ([ADR-0025](adr/0025-network-use.md)):

| Host | What for |
|---|---|
| GitHub, Portplane's releases | Agent binaries for other platforms; Portplane's latest version |
| `dekit.run` | dekit's install script |
| GitHub, dekit's releases | The dekit release its installer downloads; dekit's latest version |
| `registry.npmjs.org` (or the registry in your npm config) | portless and its dependencies; portless's latest version |
| `nodejs.org` | Node.js builds and the list of releases |

- **Update checks** run when you click "Check for updates". Automatic checks are off by default; turned on, they run at most once a day.
- **What is sent:** HTTPS `GET` requests with no cookies and no identifiers, and a `User-Agent` of `portplane/<version>`. Each one tells that host your IP address and that you run Portplane.

## What Portplane writes

- Its settings: `<user config dir>/portplane/settings.json`.
- While it runs: `<user cache dir>/portplane/instance.json` (port, URL and token), removed when it quits.
- With your confirmation, after showing the diff: `<folder>/.portplane/tasks.yaml` and one `load:` line in `<folder>/dekit.yaml` ([ADR-0009](adr/0009-generated-config-location.md)), and the tasks you edit from the app in the file that declares them ([ADR-0022](adr/0022-edit-dekit-config.md)).
- On your click: the tools it installs ([Installing tools](#installing-tools)), and the line in your shell profile if you accept it.
- With `autostart on`: a LaunchAgent, an XDG autostart file or a `Run` registry value.
- After an update check: its result, `<user cache dir>/portplane/updates.json`.
- On your click, where you choose: the diagnostic report, a zip from which environment values, secret-looking keys and tokens, URL credentials, private keys, the API token and your home folder's path are removed. It is never sent anywhere.
- portless aliases for itself and for open remote apps, removed when it quits.

## What Portplane never does

- Run anything with elevated privileges without your click and the system's password dialog, or run any privileged command other than the portless steps above.
- Ask for, see or store your password.
- Download from a host not listed under [Network](#network), run a download whose checksum does not match, or pipe a download into a shell.
- Make a request you did not start, unless you turned on automatic update checks.
- Send data about you or your projects anywhere: no accounts, no telemetry. System notifications stay on this computer, and their text travels to the notification service as arguments or environment, never inside a script.
