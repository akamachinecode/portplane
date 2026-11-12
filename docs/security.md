# Security model

Portplane starts and stops processes, reads process information, connects to other machines and, when you ask, installs dekit and portless and runs portless's admin steps. This page says what it trusts, what it exposes and what it never does. Report vulnerabilities privately (see [SECURITY.md](../SECURITY.md)).

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
- The agent can only do what that SSH user can do: list ports and processes, run dekit and portless there, read and write the dekit and portless config of the folders Portplane watches there, install dekit, Node.js and portless into that user's home, and connect to loopback ports there.
- Setup, dekit and portless requests for a remote machine pass ADR-0008's token and Host checks in Portplane first, then travel over the SSH session to the agent, which serves them in memory: it opens no port ([ADR-0026](adr/0026-remote-parity.md)). Only those areas travel, under `/api/m/<machine>/`, with size and time limits.
- The agent never asks for a password and Portplane never sends one: a step that needs an administrator on a remote machine is shown as an `ssh -t <machine> 'sudo …'` command for you to run.
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

A few portless steps need admin rights ([ADR-0020](adr/0020-privileged-steps.md)): `service install` and `uninstall`, `trust`, `hosts sync` and `clean`, `clean` when you uninstall portless, and `proxy start` and `stop` on a port below 1024 or when the proxy runs as root. Two more, from the portless center (M5.2):

- `chown root:root` on the system's copy of portless's certificate (Linux), offered only when that file belongs to you, since any program of yours could then replace it;
- updating or removing portless with the npm that installed it, only when that npm's folder belongs to the administrator (a system-wide npm);
- `tailscale set --operator=<your user>` on Linux, offered in Sharing only when Tailscale doesn't let your user share yet (M5.6);
- `dpkg -i` or `rpm -U` of Portplane's own new package, when you update a Portplane installed from the `.deb` or `.rpm` ([ADR-0031](adr/0031-self-update.md)).

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

- **Update checks** run when you click "Check for updates". Automatic checks are off by default. The sidebar asks once whether to turn them on, and turned on, they run at most once a day.
- **Updating Portplane** ([ADR-0031](adr/0031-self-update.md)) happens only on your click on "Update and restart". It downloads the release file from GitHub and checks it against that release's `checksums.txt`, then replaces Portplane the way it was installed: the files in its folder, the `.app`, or the `.deb` or `.rpm` through the password dialog. The new binary must run and report the new version, or the old one is put back. The app checks the SHA-256, not the cosign signature (see [Verify a download by hand](install.md#verify-a-download-by-hand)).
- **What is sent:** HTTPS `GET` requests with no cookies and no identifiers, and a `User-Agent` of `portplane/<version>`. Each one tells that host your IP address and that you run Portplane.

## Sharing and LAN mode

Sharing an app (M5.6) makes it reachable from other devices, so Portplane treats it as a change you confirm, never a default.

- **Portplane itself contacts no sharing service.** portless starts Tailscale Serve or Funnel, ngrok or a Cloudflare quick tunnel when the app's command carries the flag; those programs talk to their services. To check what they need, Portplane only reads: `tailscale status --json` and `tailscale debug prefs`, ngrok's config file (whether it holds an authtoken, never the token itself) and whether `cloudflared` is on PATH.
- **Public shares need a confirmation** that says the app becomes reachable from the internet (Funnel, ngrok, Cloudflare); the server refuses one without it. Health lists apps open to the internet.
- **The ngrok authtoken** you paste goes to `ngrok config add-authtoken`, as an argument, and is not logged, stored by Portplane or sent back to the page.
- **LAN mode** makes the proxy answer on your network address, so anyone on that network can open your apps; the section says so. The QR codes are drawn in the page and hold only an app's `.local` address. Exporting `ca.pem` copies the certificate, never its private key.

## What Portplane writes

- Its settings: `<user config dir>/portplane/settings.json`.
- While it runs: `<user cache dir>/portplane/instance.json` (port, URL and token), removed when it quits.
- With your confirmation, after showing the diff: `<folder>/.portplane/tasks.yaml` and one `load:` line in `<folder>/dekit.yaml` ([ADR-0009](adr/0009-generated-config-location.md)), and the tasks you edit from the app in the file that declares them ([ADR-0022](adr/0022-edit-dekit-config.md)).
- With your confirmation, after showing the diff: a project's `portless.json`, or the `"portless"` key of its `package.json` (the rest of the file stays byte for byte), when you edit it or rename an app whose name lives there.
- With your confirmation, after showing the diff: a share flag (`--tailscale`, `--funnel`, `--ngrok`, `--cloudflare`) in a task's command, and a compose service's `portless.name` label in its compose file.
- After you start a compose project from Portplane: which file started it, in `<user config dir>/portplane/compose-files.json`.
- On your click: the tools it installs ([Installing tools](#installing-tools)), the line in your shell profile if you accept it, and portless's CA in a browser profile's own certificate database (`certutil -A`, no password; the browser and profile come from Portplane's own list, never a path from the page).
- On your click, in portless's state folder: the certificate authority moved to a `ca-backup-<time>` folder before **Regenerate** (nothing is deleted); a copy of `ca.pem` in your Downloads folder for **Export**.
- With `autostart on`: a LaunchAgent, an XDG autostart file or a `Run` registry value.
- After an update check: its result, `<user cache dir>/portplane/updates.json`.
- On your click on "Update and restart": the release file in `<user cache dir>/portplane/update/` while it installs, and the new Portplane in place of the old one (files named `.portplane*.new-*` and `.portplane*.old-*` next to it during the swap, removed afterwards or at the next start).
- On your click, where you choose: the diagnostic report, a zip from which environment values, secret-looking keys and tokens, URL credentials, private keys, the API token and your home folder's path are removed. It is never sent anywhere.
- portless aliases for itself and for open remote apps, removed when it quits.

## What Portplane never does

- Run anything with elevated privileges without your click and the system's password dialog, or run any privileged command other than the steps above and installing its own `.deb` or `.rpm` when you update it.
- Replace itself without your click.
- Ask for, see or store your password.
- Download from a host not listed under [Network](#network), run a download whose checksum does not match, or pipe a download into a shell.
- Make a request you did not start, unless you turned on automatic update checks.
- Send data about you or your projects anywhere: no accounts, no telemetry. System notifications stay on this computer, and their text travels to the notification service as arguments or environment, never inside a script.
