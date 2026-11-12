# Install Portplane

Portplane is one binary per OS. Releases live on [GitHub Releases](https://github.com/akamachinecode/portplane/releases); the [landing page](https://akamachinecode.github.io/portplane/) picks the right one for you.

## macOS

**App (menu bar):** download `portplane_<version>_darwin_arm64.dmg` (Apple silicon) or `…_darwin_amd64.dmg` (Intel), open it and drag Portplane to Applications.

Portplane is not notarized by Apple ([ADR-0012](adr/0012-tooling-and-releases.md)), so the first launch is blocked: open **System Settings → Privacy & Security**, scroll to the message about Portplane and choose **Open Anyway**. You only do this once.

**Command line:**

```sh
curl -fsSL https://akamachinecode.github.io/portplane/install.sh | sh
```

It installs `~/.local/bin/portplane` (set `PORTPLANE_INSTALL_DIR` to change it). Files downloaded by `curl` are not quarantined, so Gatekeeper does not ask.

## Linux

```sh
curl -fsSL https://akamachinecode.github.io/portplane/install.sh | sh
```

Or install the `.deb` or `.rpm` from the release, which also adds Portplane to your applications menu.

Portplane opens in its own window, which uses WebKitGTK 6.0 from your system. The `.deb` and `.rpm` pull it in. With `install.sh`, install it yourself if the script says it is missing (Fedora: `sudo dnf install webkitgtk6.0`; Debian 12 or later, Ubuntu 24.04 or later: `sudo apt install libwebkitgtk-6.0-4`). Without it, Portplane opens in your browser instead. `install.sh` puts `portplane-window` next to `portplane`; keep them together.

The tray icon needs a desktop with a StatusNotifier host (KDE, most others; GNOME needs the AppIndicator extension). Without one, Portplane works the same, just without the icon, and closing its window quits it.

## Windows (beta)

```powershell
irm https://akamachinecode.github.io/portplane/install.ps1 | iex
```

It installs to `%LOCALAPPDATA%\Programs\Portplane` and adds it to your user PATH. The binary is not code-signed, so SmartScreen may warn you: choose **More info → Run anyway**. Windows support is beta ([ADR-0013](adr/0013-windows-support-level.md)).

Portplane opens in its own window, using the WebView2 runtime that comes with Windows 10 and 11. Without it, Portplane opens in your browser instead.

## Verify a download by hand

Every release has a `checksums.txt` signed with [cosign](https://docs.sigstore.dev/) by the release workflow (keyless, recorded in the public transparency log):

```sh
cosign verify-blob --bundle checksums.txt.sigstore.json \
  --certificate-identity-regexp '^https://github.com/akamachinecode/portplane/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  checksums.txt
sha256sum --check --ignore-missing checksums.txt
```

`install.sh` checks the SHA-256 always, and the signature too when a working `cosign` is installed (v2.5 or later). A `cosign` shim that does not run, such as one from mise or asdf with no version set, is treated as no `cosign`. If the signature check fails because your network blocks sigstore.dev, set `PORTPLANE_SKIP_SIGNATURE=1` to install with the checksum check only.

## What else you need

- **[dekit](https://dekit.run)** runs your dev servers.
- **[portless](https://github.com/vercel-labs/portless)** (Node.js 24+) gives them `https://<name>.localhost` URLs. Its proxy is installed once as a service, so it starts with your computer and its certificate is trusted. Portplane's guided setup does it for you, or click **Install the service** in **Domains → Proxy**. **Domains → Maintenance** updates or removes portless later, with the tool that installed it.

You don't have to install them first: the guided setup does it (below). Without dekit and portless, Portplane still lists the ports open on your machine.

Once dekit is installed, **Runners → Update…** updates it: with dekit's own updater when it came from the install script, or with Homebrew, npm or pip when it came from one of them, and then switches the running projects to the new version.

## First run

Open Portplane. On a first run it shows a guided setup that takes about five minutes and no terminal:

1. **Check your computer:** dekit, Node.js, portless, git, port 443, the proxy, the local certificate and your browsers.
2. **Install tools,** without a password: dekit through its official installer, a private Node.js 24 if yours is missing or older (it doesn't touch your own Node), and portless with npm. Each card says where the download comes from, how it is checked and where it goes before you click.
3. **HTTPS and the proxy:** your password once, through your system's dialog, after showing the exact command. Or **without a password** on port 1355, with addresses like `https://web.localhost:1355`.
4. **Browser trust,** for browsers that keep their own certificates (see [troubleshooting](troubleshooting.md#browsers-and-the-local-certificate)).
5. **Your folders, your apps, review and write:** the folders where your projects live, the dev servers found in them, and the exact files Portplane writes.
6. **First start:** start a few apps and open the first one.

"Skip for now" leaves a notice until you finish; **Settings → General → Run setup again** opens it later. From a terminal, the same steps are:

```sh
curl -fsSL https://dekit.run/install.sh | sh   # dekit
npm install -g portless                        # portless (Node.js 24+)
sudo portless service install                  # the proxy, once
portplane folders add ~/code                   # where your projects live
portplane                                      # opens https://portplane.localhost
portplane autostart on                         # optional: start at login
```

`portplane setup <folder>` finds the apps in a folder and proposes their dekit tasks.

## Uninstall

Run `portplane autostart off` first if you turned it on, then remove the binary (or the app) and Portplane's own folders:

| OS | Settings | Cache |
|---|---|---|
| macOS | `~/Library/Application Support/portplane` | `~/Library/Caches/portplane` |
| Linux | `~/.config/portplane` | `~/.cache/portplane` |
| Windows | `%AppData%\portplane` | `%LocalAppData%\portplane` |

On Windows, the installer also added `%LocalAppData%\Programs\Portplane` to your user PATH. On machines you added over SSH, Portplane only wrote `~/.cache/portplane` (on macOS and Linux alike).
