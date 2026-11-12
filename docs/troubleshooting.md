# Troubleshooting

**`https://portplane.localhost` does not open.** The portless proxy is not running. Open **Settings → General → Run setup again** and set up the proxy: it shows the exact command, then asks for your password once through your system's dialog. By hand, run `sudo portless service install` once. Portplane also prints its direct `http://127.0.0.1:<port>` URL when it starts.

**The password dialog does not open.** Portplane asks through `pkexec` on Linux, which needs a polkit agent in your desktop session (most desktops run one; minimal window managers may not). Without one, the proxy step shows the `sudo …` command to run in a terminal; then click **I ran it: check again**. You can also choose **Without a password (port 1355)**: the proxy runs as you and addresses carry `:1355`.

**The proxy service stopped working after a Node.js upgrade.** The service starts the proxy with the Node.js that installed it. A versioned path (Homebrew's `Cellar/node/<version>`, a version manager's folder) disappears on upgrade. The system check says so; install the service again from the proxy step, or run `sudo portless service install`.

**An install failed.** The card shows the error and the installer's output. **Retry** runs it again; **Copy the command to do it by hand** copies the official command (`curl -fsSL https://dekit.run/install.sh | sh`, `npm install -g portless`). Portplane downloads only from `dekit.run`, GitHub, `nodejs.org` and the npm registry, and refuses a Node.js archive whose SHA-256 does not match `SHASUMS256.txt`.

**dekit or portless work in Portplane but not in a terminal.** Portplane installs them in `~/.local/bin` and uses them by full path. If your shell does not have that folder on `PATH`, the install step offers to add one line to your shell profile (`~/.zshrc`, `~/.bashrc`, `~/.bash_profile` on macOS, `~/.profile`, or `~/.config/fish/conf.d/portplane.fish`); it shows the line first and never adds it twice. On Windows, dekit's installer adds the folder to your user `Path`.

**"dekit isn't running for …".** Each dekit project has its own runner, which stops after a reboot until something starts it. Click **Start runner**, or run `dekit -C <folder> up`.

**An app stays "starting".** Its process is alive but its port is not listening yet. If it never gets there, it usually ignores the `PORT` variable portless sets: run `portplane setup <folder>` to see the suggested command, or start the framework directly (`pnpm exec next dev`) instead of a script that pins `--port`.

**An app shows as on, but its URL says "no app registered".** The app was started outside portless, or under a different name. Its row shows the internal port; open that, or wrap the command with `portless <name>` in `dekit.yaml`.

**A remote machine stays offline.** Check `ssh <host> true` works without a prompt: Portplane runs ssh with `BatchMode=yes`, so passwords and host-key questions fail. The error under the machine's name is ssh's own message.

**A remote app opens but logins or cookies break.** Cookies set for a parent domain on the remote machine (`shop.localhost`) do not apply under `shop.<machine>.localhost`; see [ADR-0016](adr/0016-remote-urls.md).

**No tray icon on Linux.** Your desktop needs a StatusNotifier host; on GNOME install the AppIndicator extension (on Fedora, `sudo dnf install gnome-shell-extension-appindicator`, then log out and in; Ubuntu ships it). Portplane works without it, and closing its window then quits it.

**Portplane opens in the browser instead of its own window (Linux).** The window needs `portplane-window` next to `portplane` and WebKitGTK 6.0 (`sudo dnf install webkitgtk6.0`, or `sudo apt install libwebkitgtk-6.0-4`). Portplane prints why the window did not open when you start it from a terminal. If the window opens blank on some graphics drivers, start Portplane with `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

**Portplane opens in the browser instead of its own window (Windows).** The WebView2 runtime is missing; install it from Microsoft (Evergreen runtime).

**Portplane cannot find dekit or portless when started at login.** Login items get a minimal PATH. Portplane adds your login shell's PATH and the usual install folders (`~/.local/bin`, Homebrew, mise shims); if your tools live elsewhere, add that folder to the PATH your login shell sets.

**Start from a clean state.** Quit Portplane, remove `<user config dir>/portplane/settings.json`, start it again.

## Browsers and the local certificate

portless signs every `https://….localhost` certificate with its own local CA. `portless trust` (and `portless service install`) adds that CA to the system's store: the login keychain on macOS, the user's `Root` store on Windows, and `/etc/pki/ca-trust` or `/usr/local/share/ca-certificates` on Linux. Whether a browser then trusts it depends on where the browser reads certificates:

| Browser | macOS | Windows | Linux |
|---|---|---|---|
| Chrome, Chromium, Brave, Edge | The system's store: nothing else to do | The system's store: nothing else to do | Its NSS database, `~/.pki/nssdb` (Snap and Flatpak builds keep their own) |
| Firefox | The system's store, through "Allow Firefox to automatically trust third-party root certificates you install" (`security.enterprise_roots.enabled`, on by default since Firefox 120) | Same as macOS | Its own database per profile (`cert9.db`) |

On Linux, NSS loads the system's trust when its root module is p11-kit's (`libnssckbi.so` links to `p11-kit-trust.so`), as on Fedora, Arch and openSUSE: browsers installed from the distribution then trust the CA after `portless trust`. Debian, Ubuntu, Firefox's own builds, and Snap or Flatpak browsers bring their own NSS and need the CA in their database.

The guided setup's **Browser trust** step lists each browser and profile it finds (Firefox in `~/.mozilla/firefox`, `~/.config/mozilla/firefox`, Snap and Flatpak; the Chrome family's databases) and says which trust the CA. For one that does not, **Add Portplane's certificate to …** runs, without a password:

```sh
certutil -A -d sql:<profile folder> -n "portless Local CA" -t "C,," -i ~/.portless/ca.pem
```

It needs `certutil` from NSS's tools: `sudo dnf install nss-tools` on Fedora, `sudo apt install libnss3-tools` on Debian and Ubuntu, `brew install nss` on macOS. Restart the browser if it was open. A profile that has an older portless CA (after `portless clean`, say) gets it replaced.

To check for real, open `https://portplane.localhost` in the browser: no warning means it trusts the CA.
