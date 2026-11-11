# Field notes

Lessons from wiring dekit and portless by hand across about twenty dev servers: several JS/TS monorepos with git worktrees, a PHP site, and Next.js, Astro, Vite, Sanity, Remotion, NestJS and Hono apps. Each note is a default the setup flow (M2) should apply on its own, or a case it should detect and explain.

Versions observed: dekit 0.10.3, portless 0.16.0, pnpm 11–12, Astro 7, Next.js 16, macOS.

## portless

- **Wrap each app, from the app's own folder.** Use `portless <name> <cmd>` with the working directory set to the app (for example `apps/web`), not the monorepo root. portless cannot see through `pnpm --filter <app> dev`, so frameworks that need a `--port` flag never get one.
- **Spell out `run`.** portless injects `--port` and `--host` for Vite and Astro only when the command is the framework binary itself, or `<pm> run <script>`. It reads the script name from the third argument, so the `pnpm dev` shorthand is not recognised. Always generate `pnpm run dev`.
- **A hard-coded port wins.** A script with `--port 3001` ignores `PORT`. Call the framework through the package manager instead (`pnpm exec next dev`), or ask the user to drop the flag.
- **Some tools never read `PORT`.** Sanity and Remotion are examples. Pass it explicitly: `sh -c 'exec pnpm exec sanity dev --host 127.0.0.1 --port "$PORT"'`. On Windows, `sh -c` will not work, so this needs a cross-platform form.
- **Some servers cannot be wrapped,** such as `php -S` with a fixed port. Register a static route instead with `portless alias <name> <port> --force`, run as a job the server depends on.
- **Named mode does not add the worktree prefix; `portless run` does.** For worktrees, the app builds the name itself. The scheme that worked: `<app>.<worktree>.<project>.localhost`, and for a project's main web app, `<worktree>.<project>.localhost`.
- **What portless sets:**
  - `PORT` in the 4000–4999 range;
  - `HOST=127.0.0.1`;
  - `PORTLESS_URL`;
  - `NODE_EXTRA_CA_CERTS`, so Node processes trust the local CA when they call each other over HTTPS.
- **One-time privileged setup.** `sudo portless service install` installs the proxy as a system service on port 443, trusts the CA and keeps `/etc/hosts` in sync. The app should explain this step and guide it, never run it silently.
- **Routes live in `~/.portless/routes.json`.** Each entry holds `hostname`, `port`, `pid` and `registeredAt`. This is an internal format: ask upstream for `portless list --json` before depending on it.

## dekit

- **pnpm 11+ installs before every `run` when dependencies are stale.** Several apps of one monorepo starting together run several installs at once, and they fail (exit 254 in `runDepsStatusCheck`). Generate one `install` job (`pnpm install --frozen-lockfile`) at the monorepo root and make every app depend on it. This was the real cause of "start all fails in the monorepo".
- **A task's own `env` replaces the `defaults` env; it does not merge.** Shared values have to be spread in every task: `env: !js '({...ctx.vars.shared, FOO: "bar"})'`.
- **YAML merge keys (`<<:`) are rejected.** Use `vars` and `!js` instead.
- **`env: { VAR: null }` unsets a variable.**
- **`dekit ls --json` states:**
  - stopped: `idle`, `done` (a job that finished), `exited`, `backoff`;
  - alive: `running`, `ready`, `starting`, `stopping`.

  A task can be `ready` while its port is not listening yet, so "really up" must also check the port.
- **Tasks only run while the runner is up.** After a reboot, nothing runs until `dekit up`. An app that lives *inside* dekit cannot start dekit, so Portplane must be its own process.
- **`dekit stop '**'` stops everything,** including any helper task: stop by project instead.

## Coding agents

- **Some tools change behaviour when they detect an AI agent.** Astro 7 moves `astro dev` to the background, so portless loses the process. Detection reads variables such as `AI_AGENT`, `CLAUDECODE`, `AGENT`, `CODEX_THREAD_ID` and `CURSOR_TRACE_ID`, and also the process ancestry. If an agent started the dekit runner, every task inherits those variables. Generated config should unset them for dev servers.

## Cross-service URLs

- **Put cross-service URLs in the task environment.** Values such as `API_URL`, `APP_URL` and `NEXT_PUBLIC_*` go in the task env. Process env overrides `.env` files in Next.js, Vite, Astro and Node's `--env-file`, so the repo's own files stay untouched.
- **Apps on sibling subdomains need a parent cookie domain.** `app.x.localhost` and `api.x.localhost` share a session only when the cookie domain is `x.localhost` (for example Better Auth's `crossSubDomainCookies`). Without it, login breaks silently.
- **External allowlists need the new origins.** CMS CORS settings and the CORS of cloud storage buckets are examples. The app cannot fix these, but it can warn when a project probably has them.

## Discovery and display

- **Mapping a listening port to a project:** take the process's working directory (`lsof -d cwd` on macOS, `/proc/<pid>/cwd` on Linux), then walk up to the nearest `.git`.
- **Worktrees** appear in `git worktree list --porcelain`. The first entry is the main checkout.
- **Order the view by activity:** projects with something running first, and within each group the config order. People want a stable layout, but they want to see what is on without scrolling.
- **Show "starting" separately from "on".** "Starting" means the process is alive but the port is not listening yet. During an install or build, show which step is running.
