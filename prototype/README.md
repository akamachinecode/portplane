# Prototype

The single-machine panel that started the project: a zero-dependency Node server (`server.mjs`) with one HTML page (`index.html`). It is kept as reference for behaviour and layout; the product will not grow out of this code.

It runs as a dekit task, wrapped by portless, from a folder that has a `dekit.yaml`:

```yaml
tasks:
  panel:
    cmd: portless panel node .dekit/panel/server.mjs
    autostart: true
```

Then open `https://panel.localhost`. The UI text is in Spanish.

## What it does

- Reads tasks from `dekit.yaml` and its `load:` fragments with a minimal line parser: task keys at two spaces, `cmd`/`cwd`/`label`/`type`/`deps` at four. Folder entries end in `/`.
- Takes each task's live state from `dekit ls --json`.
- Gets each URL from `portless <name> …` in the command, or from a `portless alias` job the task depends on. Internal ports come from `~/.portless/routes.json`.
- Uses `lsof` for listening ports and each process's working directory. That tells "starting" apart from "on", attributes servers that are not wrapped by portless, and lists servers inside the folder that dekit did not start, plus the rest of the machine's ports.
- Offers start, stop and restart per app or per project, "open everything running" per project, reveal in Finder, a native folder picker (`osascript`), and "stop all", which goes project by project so it does not stop itself.
- Guards actions: they only target known task paths, and they need a custom `x-panel` header, which forces a CORS preflight and so blocks other sites.

## Known limits

- macOS only (`lsof`, `osascript`, `open`).
- It lives inside dekit, so it is down whenever the dekit runner is.
- The YAML parsing only understands the layout described above.
- One folder, one machine.
