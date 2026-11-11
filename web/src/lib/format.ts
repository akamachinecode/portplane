import type { App, Port, State } from "../api/types";

const STATE_LABELS: Record<State, string> = {
  on: "Running",
  starting: "Starting",
  stopping: "Stopping",
  failed: "Failed",
  off: "Off",
  done: "Done",
  unknown: "Unknown",
};

export function stateLabel(state: State): string {
  return STATE_LABELS[state] ?? state;
}

/** "https://web.app.localhost/" -> "web.app.localhost". Keeps the path, drops a lone trailing slash. */
export function displayHost(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/$/, "");
}

/** What to show where the URL goes: the live URL, or the hostname portless keeps while the app is off. */
export function appAddress(app: App): string | undefined {
  if (app.url) return displayHost(app.url);
  return app.hostname || undefined;
}

export function portLabel(port: number): string {
  return `:${port}`;
}

/** POSIX shell quoting, only when needed, so copied commands paste as is. */
export function shellQuote(arg: string): string {
  if (arg !== "" && /^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The dekit command that starts this app by hand. */
export function dekitCommand(app: Pick<App, "runner" | "task">): string {
  return `dekit -C ${shellQuote(app.runner)} start ${shellQuote(app.task)}`;
}

const HOME_PATTERNS = [
  /^\/(?:var\/)?home\/[^/]+(?=\/|$)/, // Linux, including image-based distros
  /^\/Users\/[^/]+(?=\/|$)/, // macOS
  /^\/root(?=\/|$)/,
  /^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, // Windows
];

/**
 * Guesses the home directory from paths the machine reported (watched
 * folders first). Returns undefined when no path looks like one.
 */
export function inferHome(paths: Array<string | undefined>): string | undefined {
  for (const p of paths) {
    if (!p) continue;
    for (const re of HOME_PATTERNS) {
      const m = re.exec(p);
      if (m) return m[0];
    }
  }
  return undefined;
}

/** "/home/dev/code/web" -> "~/code/web" when home is "/home/dev". */
export function shortenPath(path: string, home: string | undefined): string {
  if (!home) return path;
  if (path === home) return "~";
  const sep = home.includes("\\") ? "\\" : "/";
  if (path.startsWith(home + sep)) return "~" + sep + path.slice(home.length + 1);
  return path;
}

/** Other ports: those inside the watched folders first, then by port number. */
export function sortOtherPorts(ports: Port[]): Port[] {
  return [...ports].sort((a, b) => Number(b.inFolder) - Number(a.inFolder) || a.port - b.port);
}
