#!/usr/bin/env node
// Panel de ~/Repos: qué servidores están encendidos, en qué URL y en qué puerto.
// Lo arranca dekit (tarea `panel`) con portless: https://panel.localhost
//
// De dónde sale cada cosa:
//   - dekit.yaml (+ sus `load`): las tareas, su carpeta y su nombre en portless.
//   - `dekit ls --json`: si cada tarea está encendida.
//   - ~/.portless/routes.json: el puerto interno de cada URL.
//   - lsof: los puertos que escuchan de verdad y la carpeta de cada proceso, para
//     saber si una app ya responde y para enseñar los servidores fuera de dekit.
// Sin dependencias: solo Node.

import http from "node:http";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, "config.json");
const HOME = os.homedir();
const ROUTES = path.join(HOME, ".portless", "routes.json");
const PROXY_PID = path.join(HOME, ".portless", "proxy.pid");
const SELF = ".dekit/panel/server.mjs";

const BIN = {
  dekit: findBin("dekit", ["/opt/homebrew/bin/dekit", "/usr/local/bin/dekit"]),
  lsof: "/usr/sbin/lsof",
  open: "/usr/bin/open",
  osascript: "/usr/bin/osascript",
};

let root = loadRoot();

function findBin(name, fallbacks) {
  for (const dir of (process.env.PATH || "").split(":")) {
    const p = path.join(dir, name);
    if (dir && existsSync(p)) return p;
  }
  return fallbacks.find((p) => existsSync(p)) || name;
}

function loadRoot() {
  try {
    const r = JSON.parse(readFileSync(CONFIG, "utf8")).root;
    if (r && isDir(r)) return r;
  } catch {}
  return path.join(HOME, "Repos");
}

function saveRoot(r) {
  root = r;
  writeFileSync(CONFIG, JSON.stringify({ root: r }, null, 2) + "\n");
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function sh(bin, args, { timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || "", stderr: stderr || "", code: err?.code ?? 0 });
    });
  });
}

// ---------- dekit.yaml ----------

const unq = (s) => s.trim().replace(/^(["'])(.*)\1$/, "$2");

// Lector mínimo del dekit.yaml de ~/Repos: claves de tarea a dos espacios y sus
// cmd/cwd/label/type/deps a cuatro. Lo que no entiende, lo ignora.
function parseYaml(text) {
  const tasks = {};
  const loads = [];
  let section = null;
  let cur = null;
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    let m;
    if ((m = raw.match(/^([A-Za-z_]\w*):/))) { section = m[1]; cur = null; continue; }
    if (section === "load") {
      if ((m = raw.match(/^\s*-\s*(.+?)\s*$/))) loads.push(unq(m[1]));
      continue;
    }
    if (section !== "tasks") continue;
    if ((m = raw.match(/^ {2}(["']?)([^"'\s][^"']*?)\1:\s*$/))) {
      cur = m[2].endsWith("/") ? null : (tasks[m[2]] = {});
      continue;
    }
    if (!cur || !(m = raw.match(/^ {4}(cmd|cwd|label|type|deps):\s*(.*)$/))) continue;
    const [, key, val] = m;
    if (key === "deps") {
      cur.deps = val.replace(/^\[|\]\s*$/g, "").split(",").map(unq).filter(Boolean);
    } else {
      cur[key] = unq(val);
    }
  }
  return { tasks, loads };
}

function readFragment(file) {
  const text = readFileSync(file, "utf8");
  const json = text.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  try {
    const data = JSON.parse(json);
    for (const t of Object.values(data.tasks || {})) {
      if (Array.isArray(t.cmd)) t.cmd = t.cmd.join(" ");
    }
    for (const k of Object.keys(data.tasks || {})) if (k.endsWith("/")) delete data.tasks[k];
    return data.tasks || {};
  } catch {
    return parseYaml(text).tasks;
  }
}

function readConfig(dir) {
  const file = path.join(dir, "dekit.yaml");
  if (!existsSync(file)) return null;
  const { tasks, loads } = parseYaml(readFileSync(file, "utf8"));
  for (const l of loads) {
    try { Object.assign(tasks, readFragment(path.resolve(dir, l))); } catch {}
  }
  for (const [p, t] of Object.entries(tasks)) {
    t.path = p;
    t.cmd = t.cmd || "";
    t.cwd = t.cwd ? path.resolve(dir, t.cwd) : dir;
    t.job = t.type === "job";
    t.deps = (t.deps || []).map((d) => d.replace(/^\//, ""));
    t.portless = portlessOf(t.cmd);
    t.self = t.cmd.includes(SELF);
  }
  return tasks;
}

const PORTLESS_VERBS = new Set(["run", "proxy", "alias", "get", "list", "service", "mcp",
  "compose", "trust", "clean", "prune", "hosts", "doctor"]);

function portlessOf(cmd) {
  let m = cmd.match(/^portless\s+alias\s+(\S+)\s+(\d+)/);
  if (m) return { host: fqdn(m[1]), alias: true, port: +m[2] };
  m = cmd.match(/^portless\s+(?:--?\S+\s+)*([A-Za-z0-9][\w.-]*)\s+\S/);
  if (m && !PORTLESS_VERBS.has(m[1])) return { host: fqdn(m[1]) };
  return null;
}

const fqdn = (h) => (h.endsWith(".localhost") ? h : `${h}.localhost`);

// ---------- estado en vivo ----------

async function dekitTasks(dir) {
  const r = await sh(BIN.dekit, ["ls", "--json", "-C", dir], { timeout: 5000 });
  if (!r.ok) return null;
  try {
    return new Map(JSON.parse(r.stdout).tasks.map((t) => [t.path, t]));
  } catch { return null; }
}

function portlessRoutes() {
  try { return JSON.parse(readFileSync(ROUTES, "utf8")); } catch { return []; }
}

function proxyAlive() {
  try {
    process.kill(+readFileSync(PROXY_PID, "utf8").trim(), 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // es de root: existe pero no podemos tocarlo
  }
}

async function listeners() {
  const r = await sh("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], { timeout: 8000 });
  const out = [];
  const seen = new Set();
  let pid = 0;
  let command = "";
  for (const line of r.stdout.split("\n")) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") pid = +val;
    else if (tag === "c") command = val;
    else if (tag === "n") {
      const port = +val.slice(val.lastIndexOf(":") + 1);
      const local = /^(127\.|\[::1\]|localhost)/.test(val);
      const key = `${pid}:${port}`;
      if (!port || seen.has(key)) continue;
      seen.add(key);
      out.push({ pid, command: command.replace(/\\x20/g, " "), port, local });
    }
  }
  const pids = [...new Set(out.map((l) => l.pid))];
  const cwd = new Map();
  if (pids.length) {
    const c = await sh(BIN.lsof, ["-a", "-d", "cwd", "-p", pids.join(","), "-Fn"], { timeout: 8000 });
    let p = 0;
    for (const line of c.stdout.split("\n")) {
      if (line[0] === "p") p = +line.slice(1);
      else if (line[0] === "n") cwd.set(p, line.slice(1));
    }
  }
  for (const l of out) l.cwd = cwd.get(l.pid) || "";
  return out;
}

const gitRootCache = new Map();
function gitRoot(dir) {
  if (gitRootCache.has(dir)) return gitRootCache.get(dir);
  let d = dir;
  let found = null;
  while (d && d !== path.dirname(d)) {
    if (existsSync(path.join(d, ".git"))) { found = d; break; }
    d = path.dirname(d);
  }
  gitRootCache.set(dir, found);
  return found;
}

const inside = (p, dir) => p === dir || p.startsWith(dir + "/");

// ---------- lo que ve la página ----------

let cache = { at: 0, data: null, pending: null };

async function state() {
  if (Date.now() - cache.at < 900 && cache.data) return cache.data;
  if (!cache.pending) {
    cache.pending = build().then((data) => {
      cache = { at: Date.now(), data, pending: null };
      return data;
    }, (e) => { cache.pending = null; throw e; });
  }
  return cache.pending;
}

async function build() {
  const dir = root;
  const config = readConfig(dir);
  const [live, ports] = await Promise.all([config ? dekitTasks(dir) : null, listeners()]);
  const routes = portlessRoutes();
  const routeByHost = new Map(routes.map((r) => [r.hostname, r]));
  const routeByPort = new Map(routes.map((r) => [r.port, r]));
  const listening = new Map();
  for (const l of ports) if (!listening.has(l.port)) listening.set(l.port, l);
  const claimed = new Set();

  const tasks = config ? Object.values(config) : [];
  // carpeta más concreta primero, para repartir los puertos sin dueño por cwd
  const byCwd = tasks.filter((t) => !t.job).sort((a, b) => b.cwd.length - a.cwd.length);
  const ownerOf = (l) => byCwd.find((t) => l.cwd && inside(l.cwd, t.cwd));

  // URL de los servicios envueltos por un alias (php -S + portless alias)
  for (const t of tasks) {
    if (t.portless || t.job) continue;
    const alias = t.deps.map((d) => config[d]?.portless).find((p) => p?.alias);
    if (alias) t.portless = { host: alias.host, port: alias.port, viaAlias: true };
  }

  const groups = new Map();
  const order = live ? [...live.keys()] : Object.keys(config || {});
  for (const p of order) {
    const t = config?.[p];
    if (!t || t.self) continue;
    const key = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : p;
    if (!groups.has(key)) groups.set(key, { key, tasks: [] });
    groups.get(key).tasks.push(t);
  }

  const out = [];
  for (const g of groups.values()) {
    const items = [];
    const jobs = [];
    for (const t of g.tasks) {
      const lt = live?.get(t.path);
      const dstate = lt?.state || "idle";
      if (t.job) { jobs.push({ name: lastSeg(t.path), state: dstate, code: lt?.exit_code }); continue; }

      const route = t.portless ? routeByHost.get(t.portless.host) : null;
      let port = route?.port ?? t.portless?.port ?? null;
      let listener = port ? listening.get(port) : null;
      if (!t.portless) {
        listener = ports.find((l) => !claimed.has(l.port) && ownerOf(l) === t);
        port = listener?.port ?? null;
      }
      if (listener) claimed.add(listener.port);
      for (const l of ports) if (ownerOf(l) === t) claimed.add(l.port);

      const url = t.portless ? `https://${t.portless.host}` : port ? `http://localhost:${port}` : null;
      // idle, done, exited y backoff están parados; el resto (running, ready,
      // starting, stopping...) tiene un proceso vivo o a punto de tenerlo.
      const running = !["idle", "done", "exited", "backoff"].includes(dstate);
      let status;
      if (dstate === "stopping") status = "stopping";
      else if (running && listener) status = "on";
      else if (running) status = "starting";
      else if (listener) status = "outside";
      else if (dstate === "backoff" || (dstate === "exited" && lt?.exit_code !== 0)) status = "error";
      else status = "off";

      items.push({
        path: t.path,
        name: g.tasks.length > 1 || p_has_parent(t.path) ? lastSeg(t.path) : "",
        url,
        port,
        status,
        dstate,
        code: lt?.exit_code ?? null,
        signal: lt?.signal ?? null,
        waitingFor: status === "starting" && !listener
          ? jobs.find((j) => j.state === "running")?.name || null : null,
        label: lt?.label || t.label || null,
      });
    }
    if (!items.length) continue;
    const isTree = g.key.startsWith("worktrees/");
    const segs = g.key.split("/");
    const branch = items.map((i) => i.label?.match(/\(([^)]+)\)\s*$/)?.[1]).find(Boolean) || null;
    const cwds = g.tasks.map((t) => t.cwd);
    out.push({
      key: g.key,
      target: g.tasks.length > 1 || p_has_parent(g.tasks[0].path) ? `${g.key}/**` : g.key,
      title: isTree ? segs.slice(1, -1).join("/") : segs[0],
      tree: isTree ? segs[segs.length - 1] : null,
      branch,
      folder: gitRoot(commonDir(cwds)) || commonDir(cwds),
      jobs,
      items,
    });
  }

  // puertos abiertos que no son de ninguna tarea
  const others = new Map();
  const system = [];
  for (const l of ports) {
    if (claimed.has(l.port) || l.port === +process.env.PORT) continue;
    const route = routeByPort.get(l.port);
    const entry = { port: l.port, command: l.command, pid: l.pid, cwd: l.cwd, local: l.local,
      url: route ? `https://${route.hostname}` : `http://localhost:${l.port}` };
    if (l.cwd && inside(l.cwd, dir)) {
      const repo = gitRoot(l.cwd) || l.cwd;
      if (!others.has(repo)) others.set(repo, { folder: repo, title: path.relative(dir, repo) || path.basename(repo), items: [] });
      others.get(repo).items.push(entry);
    } else {
      system.push(entry);
    }
  }
  system.sort((a, b) => a.port - b.port);

  return {
    root: dir,
    rootLabel: dir.startsWith(HOME) ? "~" + dir.slice(HOME.length) : dir,
    hasConfig: !!config,
    runner: !!live,
    proxy: proxyAlive(),
    groups: out,
    others: [...others.values()],
    system,
    at: Date.now(),
  };
}

function p_has_parent(p) { return p.includes("/"); }
function lastSeg(p) { return p.slice(p.lastIndexOf("/") + 1); }
function commonDir(dirs) {
  if (!dirs.length) return root;
  let c = dirs[0];
  for (const d of dirs) while (!inside(d, c)) c = path.dirname(c);
  return c;
}

// ---------- acciones ----------

async function act(body) {
  const data = await state();
  const targets = new Set();
  for (const g of data.groups) {
    targets.add(g.target);
    for (const i of g.items) targets.add(i.path);
  }

  switch (body.action) {
    case "start":
    case "stop":
    case "restart": {
      if (!targets.has(body.target)) throw new Error("No conozco esa tarea");
      const r = await sh(BIN.dekit, [body.action, body.target, "-C", data.root]);
      if (!r.ok) throw new Error((r.stderr || r.stdout).trim() || `dekit ${body.action} falló`);
      break;
    }
    case "stop-all": {
      // tarea a tarea: `dekit stop '**'` apagaría también este panel
      for (const g of data.groups) {
        if (g.items.some((i) => i.status !== "off" && i.status !== "error")) {
          await sh(BIN.dekit, ["stop", g.target, "-C", data.root]);
        }
      }
      break;
    }
    case "runner": {
      const r = await sh(BIN.dekit, ["runner", "start", "-C", data.root]);
      if (!r.ok) throw new Error((r.stderr || r.stdout).trim());
      break;
    }
    case "open": {
      const urls = (body.urls || []).filter((u) => /^https?:\/\/[\w.-]+(:\d+)?\/?$/.test(u));
      if (urls.length) await sh(BIN.open, urls);
      break;
    }
    case "reveal": {
      const p = String(body.path || "");
      if (!inside(p, data.root) || !isDir(p)) throw new Error("Carpeta fuera de la raíz");
      await sh(BIN.open, [p]);
      break;
    }
    case "pick": {
      const script = [
        "activate",
        `POSIX path of (choose folder with prompt "Carpeta con tus proyectos" default location (POSIX file ${JSON.stringify(data.root)}))`,
      ];
      const r = await sh(BIN.osascript, script.flatMap((s) => ["-e", s]), { timeout: 300000 });
      if (!r.ok) return { cancelled: true };
      setRoot(r.stdout.trim());
      break;
    }
    case "root": {
      setRoot(String(body.root || ""));
      break;
    }
    default:
      throw new Error("Acción desconocida");
  }
  cache.at = 0;
  return { ok: true };
}

function setRoot(r) {
  r = r.replace(/^~(?=\/|$)/, HOME).replace(/\/+$/, "") || "/";
  if (!path.isAbsolute(r) || !isDir(r)) throw new Error(`No existe la carpeta ${r}`);
  saveRoot(r);
}

// ---------- servidor ----------

const PAGE = readFileSync(path.join(HERE, "index.html"), "utf8");
const ICON = readFileSync(path.join(HERE, "icon.svg"), "utf8");
const MANIFEST = JSON.stringify({
  name: "Repos",
  short_name: "Repos",
  start_url: "/",
  display: "standalone",
  background_color: "#0f1115",
  theme_color: "#0f1115",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
});

const server = http.createServer(async (req, res) => {
  const send = (code, type, body) => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  try {
    if (req.method === "GET" && req.url === "/") return send(200, "text/html; charset=utf-8", PAGE);
    if (req.method === "GET" && req.url === "/icon.svg") return send(200, "image/svg+xml", ICON);
    if (req.method === "GET" && req.url === "/manifest.json") return send(200, "application/manifest+json", MANIFEST);
    if (req.method === "GET" && req.url === "/api/state") return send(200, "application/json", JSON.stringify(await state()));
    if (req.method === "POST" && req.url === "/api/act") {
      // Solo la propia página: otra web no puede mandar esta cabecera sin preflight.
      if (req.headers["x-panel"] !== "1") return send(403, "text/plain", "no");
      let raw = "";
      for await (const chunk of req) raw += chunk;
      try {
        return send(200, "application/json", JSON.stringify(await act(JSON.parse(raw || "{}"))));
      } catch (e) {
        return send(400, "application/json", JSON.stringify({ error: e.message }));
      }
    }
    send(404, "text/plain", "not found");
  } catch (e) {
    send(500, "application/json", JSON.stringify({ error: e.message }));
  }
});

const port = +process.env.PORT || 4999;
server.listen(port, process.env.HOST || "127.0.0.1", () => {
  console.log(`Panel en ${process.env.PORTLESS_URL || `http://127.0.0.1:${port}`} (raíz: ${root})`);
});
