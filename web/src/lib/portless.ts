import type {
  DoctorReport,
  Finding,
  FixKind,
  InstallOrigin,
  NameInfo,
  NameSource,
  PortlessStatus,
  ProjectConfig,
  ProxyOptions,
  RouteView,
} from "../api/portless";

// The portless center's rules, kept here so they are tested once and the
// views stay about layout. They follow portless 0.16 (and the Go side in
// internal/portless, which checks the same things again).

/** portless's own subcommands: `portless proxy …` never wraps an app called "proxy". */
export const RESERVED_NAMES = ["run", "get", "alias", "compose", "hosts", "list", "doctor", "trust", "clean", "prune", "proxy", "service", "mcp"];

const MAX_LABEL = 63;
const MAX_HOSTNAME = 253;

/** Why a name can't be a portless name (with that top-level domain), or null. */
export function nameProblem(raw: string, tld = "localhost"): string | null {
  const base = raw.trim().replace(new RegExp(`\\.${escapeRe(tld)}$`), "");
  if (base === "") return "Type a name.";
  if (/^[-.]/.test(base)) return "Start the name with a letter or a digit.";
  if (/[-.]$/.test(base)) return "End the name with a letter or a digit.";
  if (base.includes("..")) return "Two dots in a row aren't allowed.";
  for (const ch of base) {
    if (!/[a-z0-9.-]/.test(ch)) return /[A-Z]/.test(ch) ? "Use lowercase letters." : `"${ch}" isn't allowed: use letters, digits, dashes and dots.`;
  }
  for (const label of base.split(".")) {
    if (label.length > MAX_LABEL) return `"${label}" is longer than ${MAX_LABEL} characters, the limit for one part of a name.`;
    if (/^-|-$/.test(label)) return "Each part between dots must start and end with a letter or a digit.";
  }
  if (base.length + 1 + tld.length > MAX_HOSTNAME) return `The address would be longer than ${MAX_HOSTNAME} characters.`;
  if (RESERVED_NAMES.includes(base)) return `"${base}" is one of portless's own commands; pick another name.`;
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "Api.Shop" and "test" → "api.shop.test"; a name that already ends in the domain keeps it. */
export function hostnameFor(name: string, tld = "localhost"): string {
  const n = name.trim().toLowerCase().replace(new RegExp(`\\.${escapeRe(tld)}$`), "");
  return n ? `${n}.${tld}` : "";
}

/** A hostname without its top-level domain (the longest that matches). */
export function baseName(hostname: string, tlds: string[] = []): string {
  const best = ["localhost", ...tlds].filter((t) => hostname.endsWith(`.${t}`)).sort((a, b) => b.length - a.length)[0];
  return best ? hostname.slice(0, -(best.length + 1)) : hostname;
}

/** The hostname a rename gives: `portless run` puts the worktree in front. */
export function previewHostname(info: Pick<NameInfo, "runMode" | "prefix" | "tld">, name: string): string {
  const n = name.trim().toLowerCase();
  if (!n) return "";
  return hostnameFor(info.runMode && info.prefix ? `${info.prefix}.${n}` : n, info.tld);
}

/** The URL of a hostname behind a proxy on that port, as portless prints it. */
export function proxyUrl(hostname: string, proxy: { port: number; https: boolean }): string {
  const scheme = proxy.https ? "https" : "http";
  const port = proxy.port || (proxy.https ? 443 : 80);
  const standard = proxy.https ? 443 : 80;
  return port === standard ? `${scheme}://${hostname}` : `${scheme}://${hostname}:${port}`;
}

/** What a name change checks as the user types: the rules, then clashes. */
export function renameProblem(info: NameInfo, name: string): string | null {
  const p = nameProblem(name.toLowerCase(), info.tld);
  if (p && p !== "Use lowercase letters.") return p;
  const n = name.trim().toLowerCase();
  if (n === info.name && !info.inferred) return "That's the name it has now.";
  const host = previewHostname(info, n);
  if (info.taken.includes(host)) return `${host} is already used by another app or route.`;
  return null;
}

/** Plain words for where a name lives. */
export const SOURCE_LABELS: Record<NameSource, string> = {
  fragment: "Portplane's task file",
  task: "your dekit file",
  config: "the project's portless config",
  "alias-task": "an alias job in dekit",
  alias: "a portless alias",
  compose: "a docker compose label",
  none: "nowhere: the app doesn't run through portless",
};

// ---- top-level domains and proxy options ----

/** portless's own warnings (getRiskyTldReason). */
const RISKY_TLDS: Record<string, string> = {
  local: "conflicts with mDNS (Bonjour) on macOS and on your network",
  dev: "is a public domain Google owns; browsers force HTTPS on it",
  app: "is a public domain Google owns; browsers force HTTPS on it",
  com: "is a public domain: lookups leak to the internet",
  org: "is a public domain: lookups leak to the internet",
  net: "is a public domain: lookups leak to the internet",
  io: "is a public domain: lookups leak to the internet",
  edu: "is a public domain: lookups leak to the internet",
  gov: "is a public domain: lookups leak to the internet",
  mil: "is a public domain: lookups leak to the internet",
  int: "is a public domain: lookups leak to the internet",
};

/** A warning for a domain that works but causes trouble, or null. */
export function tldWarning(tld: string): string | null {
  const t = tld.trim().replace(/^\./, "").toLowerCase();
  if (RISKY_TLDS[t]) return `.${t} ${RISKY_TLDS[t]}.`;
  for (const risky of ["local", "dev", "app"]) {
    if (t.endsWith(`.${risky}`)) return `.${t} ends in .${risky}, which ${RISKY_TLDS[risky]}.`;
  }
  return null;
}

/** Why a top-level domain can't be used, or null. */
export function tldProblem(tld: string): string | null {
  const t = tld.trim().replace(/^\./, "");
  if (t === "") return "Type a domain, such as test.";
  if (t !== t.toLowerCase()) return "Use lowercase letters.";
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(t)) return "Use one word of letters, digits and dashes, such as test.";
  return null;
}

/** Normalised domains: no dots in front, lowercase, no repeats, localhost when empty. */
export function cleanTlds(tlds: string[] | undefined): string[] {
  const out: string[] = [];
  for (const t of tlds ?? []) {
    const c = t.trim().replace(/^\./, "").toLowerCase();
    if (c && !out.includes(c)) out.push(c);
  }
  return out.length ? out : ["localhost"];
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Problems with proxy options, by field, as portless would refuse them. */
export function optionsProblems(o: ProxyOptions): Partial<Record<keyof ProxyOptions, string>> {
  const out: Partial<Record<keyof ProxyOptions, string>> = {};
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) out.port = "Pick a port between 1 and 65535.";
  if (!o.lan) {
    for (const t of o.tlds ?? []) {
      const p = tldProblem(t);
      if (p) {
        out.tlds = `.${t}: ${p}`;
        break;
      }
    }
  }
  if (!!o.certPath !== !!o.keyPath) out[o.certPath ? "keyPath" : "certPath"] = "A custom certificate needs both the certificate and its key.";
  else if (o.certPath && !o.https) out.certPath = "A custom certificate needs HTTPS.";
  if (o.lanIp && !IPV4.test(o.lanIp)) out.lanIp = "Type an IPv4 address, such as 192.168.1.20.";
  return out;
}

/** The options as the server expects them: cleaned, without empty fields. */
export function normalizeOptions(o: ProxyOptions): ProxyOptions {
  const out: ProxyOptions = { port: o.port, https: o.https, tlds: o.lan ? ["local"] : cleanTlds(o.tlds), wildcard: o.wildcard, lan: o.lan, unprivileged: o.unprivileged };
  if (o.lan && o.lanIp?.trim()) out.lanIp = o.lanIp.trim();
  if (o.certPath?.trim()) out.certPath = o.certPath.trim();
  if (o.keyPath?.trim()) out.keyPath = o.keyPath.trim();
  return out;
}

export function sameOptions(a: ProxyOptions, b: ProxyOptions): boolean {
  return JSON.stringify(normalizeOptions(a)) === JSON.stringify(normalizeOptions(b));
}

/** "port 443 with HTTPS, for .localhost and .test" */
export function describeOptions(o: ProxyOptions): string {
  const parts = [`port ${o.port} with ${o.https ? "HTTPS" : "HTTP"}`];
  if (o.lan) parts.push("on your network as .local");
  else parts.push(`for ${cleanTlds(o.tlds).map((t) => `.${t}`).join(", ")}`);
  if (o.wildcard) parts.push("with wildcard subdomains");
  return parts.join(", ");
}

/** Ports below 1024 need an administrator on Linux unless the kernel allows them. */
export function lowPort(port: number): boolean {
  return port > 0 && port < 1024;
}

// ---- routes ----

/** How long ago a route was registered, as portless list shows it: 45s, 12m, 3h, 2d. */
export function routeAge(registeredAt: number | undefined, now: number): string | null {
  if (!registeredAt || !Number.isFinite(registeredAt) || registeredAt <= 0) return null;
  const elapsed = now - registeredAt;
  if (elapsed < -60_000) return null;
  const s = Math.floor(Math.max(elapsed, 0) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export const KIND_LABELS: Record<RouteView["kind"], string> = { app: "app", alias: "alias", compose: "compose", remote: "remote" };

/** Aliases the user added: not Portplane's own, not a remote machine's, not compose's. */
export function isUserAlias(r: RouteView): boolean {
  return r.kind === "alias" && r.owner?.kind !== "portplane";
}

/** Stale routes first is not what people want: live first, then by hostname. */
export function sortRoutes(routes: RouteView[]): RouteView[] {
  return [...routes].sort((a, b) => Number(b.alive) - Number(a.alive) || a.hostname.localeCompare(b.hostname));
}

/** A first guess at an alias name from a process name: "postgres", "redis-server" → "redis". */
export function suggestName(process: string | undefined): string | undefined {
  if (!process) return undefined;
  const base = process.toLowerCase().replace(/\.(exe|js)$/, "").replace(/-server$/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!base || ["node", "python", "python3", "ruby", "php", "java", "bun", "deno"].includes(base)) return undefined;
  return base;
}

// ---- doctor ----

export const CHECK_LABELS: Record<string, string> = {
  node: "Node.js",
  state: "State folder",
  proxy: "Proxy",
  pid: "Proxy process",
  openssl: "OpenSSL",
  ca: "Certificate",
  routes: "Routes",
  ports: "App ports",
  lan: "Network (LAN)",
  dns: "Name lookup",
  service: "Proxy service",
  other: "Other",
};

export const FIX_LABELS: Record<FixKind, string> = {
  "proxy-start": "Start the proxy",
  "proxy-restart": "Restart the proxy",
  trust: "Trust the certificate",
  prune: "Clean stale routes",
  "hosts-sync": "Sync the hosts file",
  "service-install": "Reinstall the service",
};

export interface CheckGroup {
  check: string;
  label: string;
  /** The worst status in the group. */
  status: Finding["status"];
  findings: Finding[];
  /** The fixes the group offers, each once. */
  fixes: FixKind[];
}

const RANK: Record<Finding["status"], number> = { fail: 0, warn: 1, info: 2, ok: 3 };

/** Findings grouped by what they check, worst first; groups keep doctor's order otherwise. */
export function groupFindings(findings: Finding[]): CheckGroup[] {
  const groups: CheckGroup[] = [];
  const by = new Map<string, CheckGroup>();
  for (const f of findings) {
    let g = by.get(f.check);
    if (!g) {
      g = { check: f.check, label: CHECK_LABELS[f.check] ?? f.check, status: f.status, findings: [], fixes: [] };
      by.set(f.check, g);
      groups.push(g);
    }
    g.findings.push(f);
    if (RANK[f.status] < RANK[g.status]) g.status = f.status;
    if (f.fix && !g.fixes.includes(f.fix)) g.fixes.push(f.fix);
  }
  return groups.map((g, i) => ({ g, i })).sort((a, b) => RANK[a.g.status] - RANK[b.g.status] || a.i - b.i).map((x) => x.g);
}

/** One line about a report: "2 problems, 1 warning" or "Everything checks out". */
export function doctorSummary(r: Pick<DoctorReport, "failures" | "warnings">): string {
  if (!r.failures && !r.warnings) return "Everything checks out.";
  const parts: string[] = [];
  if (r.failures) parts.push(`${r.failures} ${r.failures === 1 ? "problem" : "problems"}`);
  if (r.warnings) parts.push(`${r.warnings} ${r.warnings === 1 ? "warning" : "warnings"}`);
  return parts.join(", ") + ".";
}

/** The hosts file only matters for other domains, or when doctor says names don't resolve. */
export function hostsSectionVisible(status: Pick<PortlessStatus, "hostsNeeded"> | null, doctor: Pick<DoctorReport, "findings"> | null): boolean {
  if (status?.hostsNeeded) return true;
  return !!doctor?.findings.some((f) => f.check === "dns" && (f.status === "warn" || f.status === "fail"));
}

// ---- certificates ----

export type Expiry = "expired" | "soon" | "ok" | "unknown";

/** Expired, within 30 days, fine, or unknown. */
export function expiry(notAfter: string | undefined, now: number): Expiry {
  if (!notAfter) return "unknown";
  const t = Date.parse(notAfter);
  if (!Number.isFinite(t) || t <= 0) return "unknown";
  if (t <= now) return "expired";
  if (t - now < 30 * 24 * 3600 * 1000) return "soon";
  return "ok";
}

// ---- maintenance ----

export const ORIGIN_LABELS: Record<InstallOrigin, string> = {
  npm: "npm (installed globally)",
  homebrew: "Homebrew",
  portplane: "Portplane's own copy",
  pnpm: "pnpm (installed globally)",
  bun: "Bun (installed globally)",
  volta: "Volta",
  unknown: "unknown",
};

// ---- portless.json ----

const TOP_KEYS = ["name", "script", "appPort", "proxy", "turbo", "apps"];
const APP_KEYS = ["name", "script", "appPort", "proxy"];

export interface ConfigCheck {
  config: ProjectConfig | null;
  problems: string[];
  warnings: string[];
}

function checkApp(obj: Record<string, unknown>, prefix: string, problems: string[]) {
  const a: ProjectConfig = {};
  if ("name" in obj) {
    if (typeof obj.name !== "string" || !obj.name.trim()) problems.push(`"${prefix}name" must be a non-empty string.`);
    else {
      a.name = obj.name;
      const p = nameProblem(obj.name);
      if (p) problems.push(`"${prefix}name": ${p}`);
    }
  }
  if ("script" in obj) {
    if (typeof obj.script !== "string" || !obj.script.trim()) problems.push(`"${prefix}script" must be a non-empty string.`);
    else a.script = obj.script;
  }
  if ("appPort" in obj) {
    const p = obj.appPort;
    if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535) problems.push(`"${prefix}appPort" must be a whole number between 1 and 65535.`);
    else a.appPort = p;
  }
  if ("proxy" in obj) {
    if (typeof obj.proxy !== "boolean") problems.push(`"${prefix}proxy" must be true or false.`);
    else a.proxy = obj.proxy;
  }
  return a;
}

function unknownKeys(obj: Record<string, unknown>, known: string[], prefix: string): string[] {
  return Object.keys(obj)
    .filter((k) => !known.includes(k))
    .sort()
    .map((k) => `portless ignores "${prefix}${k}"; it knows ${known.join(", ")}.`);
}

/** Checks portless.json text the way portless does (validateConfig); a string is a name. */
export function checkConfigText(text: string): ConfigCheck {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    return { config: null, problems: [`This isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`], warnings: [] };
  }
  if (typeof v === "string") return { config: v.trim() ? { name: v.trim() } : null, problems: [], warnings: [] };
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return { config: null, problems: ['The config must be a JSON object, like {"name": "web"}.'], warnings: [] };
  }
  const obj = v as Record<string, unknown>;
  const problems: string[] = [];
  const warnings: string[] = [];
  const config = checkApp(obj, "", problems);
  if ("turbo" in obj) {
    if (typeof obj.turbo !== "boolean") problems.push('"turbo" must be true or false.');
    else config.turbo = obj.turbo;
  }
  if ("apps" in obj) {
    const apps = obj.apps;
    if (typeof apps !== "object" || apps === null || Array.isArray(apps)) problems.push('"apps" must be an object of folder → settings.');
    else {
      config.apps = {};
      for (const k of Object.keys(apps).sort()) {
        const app = (apps as Record<string, unknown>)[k];
        if (typeof app !== "object" || app === null || Array.isArray(app)) {
          problems.push(`"apps.${k}" must be an object.`);
          continue;
        }
        config.apps[k] = checkApp(app as Record<string, unknown>, `apps.${k}.`, problems);
        warnings.push(...unknownKeys(app as Record<string, unknown>, APP_KEYS, `apps.${k}.`));
      }
    }
  }
  warnings.push(...unknownKeys(obj, TOP_KEYS, ""));
  return { config, problems, warnings };
}

/** The form's config as JSON, keys in portless's order, empty fields left out. */
export function configText(config: ProjectConfig, extra: Record<string, unknown> = {}): string {
  const app = (a: ProjectConfig) => {
    const o: Record<string, unknown> = {};
    if (a.name?.trim()) o.name = a.name.trim();
    if (a.script?.trim()) o.script = a.script.trim();
    if (a.appPort !== undefined && Number.isFinite(a.appPort)) o.appPort = a.appPort;
    if (a.proxy !== undefined) o.proxy = a.proxy;
    return o;
  };
  const out = app(config);
  if (config.turbo !== undefined) out.turbo = config.turbo;
  const apps = Object.entries(config.apps ?? {}).filter(([path]) => path.trim());
  if (apps.length) out.apps = Object.fromEntries(apps.map(([path, a]) => [path.trim(), app(a)]));
  for (const [k, v] of Object.entries(extra)) if (!TOP_KEYS.includes(k)) out[k] = v;
  return JSON.stringify(out, null, 2) + "\n";
}

/** Keys the form doesn't edit, kept as they are when the form saves. */
export function extraKeys(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !TOP_KEYS.includes(k)));
  } catch {
    return {};
  }
}
