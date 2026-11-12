# Troubleshooting

**`https://portplane.localhost` does not open.** The portless proxy is not running. Run `sudo portless service install` once (or `portless proxy start` for this session). Portplane also prints its direct `http://127.0.0.1:<port>` URL when it starts.

**"dekit isn't running for …".** Each dekit project has its own runner, which stops after a reboot until something starts it. Click **Start runner**, or run `dekit -C <folder> up`.

**An app stays "starting".** Its process is alive but its port is not listening yet. If it never gets there, it usually ignores the `PORT` variable portless sets: run `portplane setup <folder>` to see the suggested command, or start the framework directly (`pnpm exec next dev`) instead of a script that pins `--port`.

**An app shows as on, but its URL says "no app registered".** The app was started outside portless, or under a different name. Its row shows the internal port; open that, or wrap the command with `portless <name>` in `dekit.yaml`.

**A remote machine stays offline.** Check `ssh <host> true` works without a prompt: Portplane runs ssh with `BatchMode=yes`, so passwords and host-key questions fail. The error under the machine's name is ssh's own message.

**A remote app opens but logins or cookies break.** Cookies set for a parent domain on the remote machine (`shop.localhost`) do not apply under `shop.<machine>.localhost`; see [ADR-0016](adr/0016-remote-urls.md).

**No tray icon on Linux.** Your desktop needs a StatusNotifier host; on GNOME install the AppIndicator extension. Portplane works without it, and closing its window then quits it.

**Portplane opens in the browser instead of its own window (Linux).** The window needs `portplane-window` next to `portplane` and WebKitGTK 6.0 (`sudo dnf install webkitgtk6.0`, or `sudo apt install libwebkitgtk-6.0-4`). Portplane prints why the window did not open when you start it from a terminal. If the window opens blank on some graphics drivers, start Portplane with `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

**Portplane opens in the browser instead of its own window (Windows).** The WebView2 runtime is missing; install it from Microsoft (Evergreen runtime).

**Portplane cannot find dekit or portless when started at login.** Login items get a minimal PATH. Portplane adds your login shell's PATH and the usual install folders (`~/.local/bin`, Homebrew, mise shims); if your tools live elsewhere, add that folder to the PATH your login shell sets.

**A task's form is read-only, or a field says "Written with !js".** Portplane edits `dekit.yaml` entry by entry and keeps your comments, but it does not rewrite `!js` values, YAML anchors and aliases, or entries written in flow style (`{…}`). Change those in the **YAML** tab of the project, or click **Open in your editor**; Portplane picks up the change.

**"Configuration changed: review and reload".** A runner reads `dekit.yaml` when it starts; after that, changes on disk wait until a reload. The banner lists what a reload would change; **Review and reload** applies it, and can restart the running tasks it changes. From a terminal: `dekit -C <folder> reload --yes`.

**A runner shows "Stale record".** dekit has a record for a runner whose process is gone (it crashed, or the computer restarted). Start it again, or use **Clean stale records** in Runners (`dekit runner clean`), which never touches running runners.

**A runner shows "Needs restart".** The project now selects another dekit binary (its `kernel:`, or the default you set). **Restart runner** or **Upgrade** switches it without stopping its tasks. On Windows dekit cannot do this in place: stop the runner and start it again.

**Remove is missing from an app's menu.** Portplane only removes tasks it added (in `.portplane/tasks.yaml`) or ones started with **Run a command**. A task you wrote in `dekit.yaml` stays yours: delete it there, or from the project's **Tasks** tab.

**Start the runner from Runners and it says some tasks didn't start.** Start waits until every task is ready; the job names the ones that failed, and their app shows why (**Why it is like this**) and their last output.

**Start from a clean state.** Quit Portplane, remove `<user config dir>/portplane/settings.json`, start it again.
