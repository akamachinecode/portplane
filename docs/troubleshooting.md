# Troubleshooting

**`https://portplane.localhost` does not open.** The portless proxy is not running. In **Domains → Proxy**, click **Start the proxy**, or **Install the service** so it starts with your computer (both show the exact command first). By hand: `sudo portless service install` once, or `portless proxy start` for this session. Portplane also prints its direct `http://127.0.0.1:<port>` URL when it starts.

**Something is off with portless and you don't know what.** **Domains → Doctor** runs `portless doctor` and offers a fix next to each problem. The palette's **Run diagnostics** does the same.

**The proxy stopped starting with the computer after an upgrade.** The service still points to the Node.js or portless that the upgrade removed (Homebrew keeps versioned folders). **Domains → Proxy** marks the missing path; click **Reinstall**.

**Browsers warn about the certificate.** Your system doesn't trust portless's local certificate authority yet: **Domains → Certificates → Trust the certificate**. Firefox keeps its own list of trusted certificates. On Linux, if Portplane says the trusted copy belongs to your user, click **Fix ownership**.

**Names under `.test` (or another domain) don't load.** Only `.localhost` reaches your computer without help; other domains need portless's block in the hosts file: **Domains → Hosts file → Sync**.

**An old address still shows up, or a port stays taken after an app crashed.** Its route is stale: **Domains → Routes → Clean stale routes** removes it and asks the leftover server to stop.

**Change an app's URL.** Open the app, then its **URL** tab, and click **Change name**. Portplane edits the name where it lives (its task, `portless.json` or an alias), shows the change first, then reloads dekit and restarts the app.

**"dekit isn't running for …".** Each dekit project has its own runner, which stops after a reboot until something starts it. Click **Start runner**, or run `dekit -C <folder> up`.

**An app stays "starting".** Its process is alive but its port is not listening yet. If it never gets there, it usually ignores the `PORT` variable portless sets: run `portplane setup <folder>` to see the suggested command, or start the framework directly (`pnpm exec next dev`) instead of a script that pins `--port`.

**An app shows as on, but its URL says "no app registered".** The app was started outside portless, or under a different name. Its row shows the internal port; open that, or wrap the command with `portless <name>` in `dekit.yaml`.

**A remote machine stays offline.** Check `ssh <host> true` works without a prompt: Portplane runs ssh with `BatchMode=yes`, so passwords and host-key questions fail. The error under the machine's name is ssh's own message.

**A remote app opens but logins or cookies break.** Cookies set for a parent domain on the remote machine (`shop.localhost`) do not apply under `shop.<machine>.localhost`; see [ADR-0016](adr/0016-remote-urls.md).

**No tray icon on Linux.** Your desktop needs a StatusNotifier host; on GNOME install the AppIndicator extension. Portplane works without it, and closing its window then quits it.

**Portplane opens in the browser instead of its own window (Linux).** The window needs `portplane-window` next to `portplane` and WebKitGTK 6.0 (`sudo dnf install webkitgtk6.0`, or `sudo apt install libwebkitgtk-6.0-4`). Portplane prints why the window did not open when you start it from a terminal. If the window opens blank on some graphics drivers, start Portplane with `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

**Portplane opens in the browser instead of its own window (Windows).** The WebView2 runtime is missing; install it from Microsoft (Evergreen runtime).

**Portplane cannot find dekit or portless when started at login.** Login items get a minimal PATH. Portplane adds your login shell's PATH and the usual install folders (`~/.local/bin`, Homebrew, mise shims); if your tools live elsewhere, add that folder to the PATH your login shell sets.

**Start from a clean state.** Quit Portplane, remove `<user config dir>/portplane/settings.json`, start it again.
