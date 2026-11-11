# Troubleshooting

**`https://portplane.localhost` does not open.** The portless proxy is not running. Run `sudo portless service install` once (or `portless proxy start` for this session). Portplane also prints its direct `http://127.0.0.1:<port>` URL when it starts.

**"dekit isn't running for …".** Each dekit project has its own runner, which stops after a reboot until something starts it. Click **Start runner**, or run `dekit -C <folder> up`.

**An app stays "starting".** Its process is alive but its port is not listening yet. If it never gets there, it usually ignores the `PORT` variable portless sets: run `portplane setup <folder>` to see the suggested command, or start the framework directly (`pnpm exec next dev`) instead of a script that pins `--port`.

**An app shows as on, but its URL says "no app registered".** The app was started outside portless, or under a different name. Its row shows the internal port; open that, or wrap the command with `portless <name>` in `dekit.yaml`.

**A remote machine stays offline.** Check `ssh <host> true` works without a prompt: Portplane runs ssh with `BatchMode=yes`, so passwords and host-key questions fail. The error under the machine's name is ssh's own message.

**A remote app opens but logins or cookies break.** Cookies set for a parent domain on the remote machine (`shop.localhost`) do not apply under `shop.<machine>.localhost`; see [ADR-0016](adr/0016-remote-urls.md).

**No tray icon on Linux.** Your desktop needs a StatusNotifier host; on GNOME install the AppIndicator extension. Portplane works without it.

**Portplane cannot find dekit or portless when started at login.** Login items get a minimal PATH. Portplane adds your login shell's PATH and the usual install folders (`~/.local/bin`, Homebrew, mise shims); if your tools live elsewhere, add that folder to the PATH your login shell sets.

**Start from a clean state.** Quit Portplane, remove `<user config dir>/portplane/settings.json`, start it again.
