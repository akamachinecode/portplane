import type { Api } from "./client";
import { ApiError } from "./errors";
import type { MockContext } from "./mockContext";
import type { App } from "./types";
import { shellQuote } from "../lib/format";

// The Output panel's mock: believable dev-server screens with colours that
// grow while the app runs, like `dekit screen` would show them. The text of
// each app is a pure function of how long it has run, so tests can pin it.

const ESC = "\x1b[";
const c = {
  reset: `${ESC}0m`,
  bold: (s: string) => `${ESC}1m${s}${ESC}22m`,
  dim: (s: string) => `${ESC}2m${s}${ESC}22m`,
  red: (s: string) => `${ESC}31m${s}${ESC}39m`,
  green: (s: string) => `${ESC}32m${s}${ESC}39m`,
  yellow: (s: string) => `${ESC}33m${s}${ESC}39m`,
  blue: (s: string) => `${ESC}34m${s}${ESC}39m`,
  magenta: (s: string) => `${ESC}35m${s}${ESC}39m`,
  cyan: (s: string) => `${ESC}36m${s}${ESC}39m`,
  gray: (s: string) => `${ESC}38;5;245m${s}${ESC}39m`,
  orange: (s: string) => `${ESC}38;5;208m${s}${ESC}39m`,
  inverse: (s: string) => `${ESC}7m${s}${ESC}27m`,
};

/** dekit's terminal is 80 columns wide; the mock keeps the last 48 rows, as a tall terminal would. */
export const MOCK_COLS = 80;
export const MOCK_ROWS = 48;

/** A small deterministic hash, so event i of an app always reads the same. */
function pick<T>(seed: number, list: readonly T[]): T {
  let h = (seed + 0x9e3779b9) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return list[Math.abs(h) % list.length];
}

function clock(ms: number, seconds = true): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const h = d.getHours();
  return `${(h + 11) % 12 + 1}:${p(d.getMinutes())}${seconds ? `:${p(d.getSeconds())}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

function clock24(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8);
}

function npmHeader(app: App, script: string): string[] {
  return ["", `> ${app.label}@0.0.0 dev ${app.dir ?? app.runner}`, `> ${script}`, ""];
}

const FILES = ["/src/App.tsx", "/src/routes/index.tsx", "/src/components/Header.tsx", "/src/styles/app.css", "/src/lib/api.ts", "/src/components/Table.tsx"];

/** A Vite dev server: the banner, then hot updates every few seconds. */
function viteScreen(app: App, url: string, startedAt: number, now: number): string[] {
  const rows = [
    ...npmHeader(app, `vite --port ${app.port ?? 5173} --strictPort --host 127.0.0.1`),
    "",
    `  ${c.green(c.bold("VITE"))} ${c.green("v6.3.5")}  ${c.dim("ready in")} ${c.bold("412")} ${c.dim("ms")}`,
    "",
    `  ${c.green("➜")}  ${c.bold("Local")}:   ${c.cyan(url)}`,
    `  ${c.dim(c.green("➜"))}  ${c.dim("Network")}${c.dim(": use ")}${c.bold("--host")}${c.dim(" to expose")}`,
    `  ${c.dim(c.green("➜"))}  ${c.dim("press ")}${c.bold("h + enter")}${c.dim(" to show help")}`,
  ];
  const every = 4000;
  const events = Math.floor((now - startedAt) / every);
  for (let i = Math.max(0, events - MOCK_ROWS); i < events; i++) {
    const at = startedAt + (i + 1) * every;
    const prefix = `${c.dim(clock(at))} ${c.cyan(c.bold("[vite]"))}`;
    const kind = pick(i, ["hmr", "hmr", "hmr", "css", "reload", "warn"] as const);
    const file = pick(i * 7 + 3, FILES);
    if (kind === "hmr") rows.push(`${prefix} ${c.green("hmr update ")}${c.dim(file)}`);
    else if (kind === "css") rows.push(`${prefix} ${c.green("hmr update ")}${c.dim("/src/styles/app.css")}`);
    else if (kind === "reload") rows.push(`${prefix} ${c.green("page reload ")}${c.dim(file)}`);
    else rows.push(`${prefix} ${c.yellow(`warning: ${pick(i, FILES.filter((f) => f.endsWith(".tsx"))).slice(1)} has an unused import: ${c.bold("useMemo")}`)}`);
  }
  return rows;
}

const ROUTES = ["/api/projects", "/api/projects/42", "/api/users/me", "/api/search?q=router", "/api/health", "/api/sessions", "/api/billing/invoices"];

/** A Node API: it listens, then logs requests, now and then a slow or failing one. */
function apiScreen(app: App, startedAt: number, now: number): string[] {
  const port = app.port ?? 3000;
  const rows = [
    ...npmHeader(app, "tsx watch src/server.ts"),
    `${c.gray(clock24(startedAt + 600))} ${c.green("INFO")}  Connected to ${c.bold("postgres")} ${c.dim("(pool of 10)")}`,
    `${c.gray(clock24(startedAt + 700))} ${c.green("INFO")}  Server listening on ${c.cyan(`http://127.0.0.1:${port}`)}`,
  ];
  const every = 1500;
  const events = Math.floor((now - startedAt) / every);
  for (let i = Math.max(0, events - MOCK_ROWS); i < events; i++) {
    const at = startedAt + 1000 + i * every;
    const time = c.gray(clock24(at));
    const route = pick(i, ROUTES);
    const method = pick(i * 3 + 1, ["GET", "GET", "GET", "POST", "PATCH"] as const);
    const outcome = pick(i * 5 + 2, ["ok", "ok", "ok", "ok", "ok", "ok", "slow", "missing", "fail"] as const);
    const ms = 4 + ((i * 37) % 60);
    if (outcome === "ok") rows.push(`${time} ${c.green("INFO")}  ${c.bold(method)} ${route} ${c.green(method === "POST" ? "201" : "200")} ${c.dim(`${ms} ms`)}`);
    else if (outcome === "slow") rows.push(`${time} ${c.yellow("WARN")}  ${c.bold(method)} ${route} ${c.green("200")} ${c.orange(`${640 + ms * 9} ms`)} ${c.dim("slow query")}`);
    else if (outcome === "missing") rows.push(`${time} ${c.green("INFO")}  ${c.bold(method)} /api/projects/9999 ${c.yellow("404")} ${c.dim(`${ms} ms`)}`);
    else {
      rows.push(`${time} ${c.red("ERROR")} ${c.bold(method)} ${route} ${c.red("500")} ${c.dim(`${ms} ms`)}`);
      rows.push(`    ${c.red("TypeError: Cannot read properties of undefined (reading 'id')")}`);
      rows.push(c.dim("        at handler (src/routes/projects.ts:48:27)"));
    }
  }
  return rows;
}

/** A docs site that is still starting: it syncs content and has not opened its port. */
function startingScreen(app: App, startedAt: number, now: number): string[] {
  const secs = Math.floor((now - startedAt) / 1000);
  const rows = [
    ...npmHeader(app, "astro dev --port 4517 --host 127.0.0.1"),
    `${c.dim(clock24(startedAt + 300))} ${c.blue("[types]")} Generated ${c.dim("318ms")}`,
    `${c.dim(clock24(startedAt + 500))} ${c.blue("[content]")} Syncing content`,
  ];
  const synced = Math.min(240, 12 + secs * 3);
  rows.push(`${c.dim(clock24(now))} ${c.blue("[content]")} Synced ${c.bold(String(synced))} of 240 entries ${c.dim("…")}`);
  return rows;
}

/** pnpm install while it runs: the progress line moves, as dekit's screen shows it. */
function installingScreen(startedAt: number, now: number): string[] {
  const secs = (now - startedAt) / 1000;
  const resolved = Math.min(1204, Math.floor(180 + secs * 41));
  return [
    "Scope: all 6 workspace projects",
    "Lockfile is up to date, resolution step is skipped",
    `Progress: resolved ${c.bold(String(resolved))}, reused ${c.bold(String(resolved - 3))}, downloaded ${c.bold("3")}, added ${c.bold(String(Math.floor(resolved * 0.8)))}`,
    `${c.green("+".repeat(Math.min(58, Math.floor(resolved / 21))))}`,
  ];
}

/** pnpm install, finished. */
function installedScreen(): string[] {
  return [
    "Scope: all 6 workspace projects",
    "Lockfile is up to date, resolution step is skipped",
    `Progress: resolved ${c.bold("1204")}, reused ${c.bold("1201")}, downloaded ${c.bold("3")}, added ${c.bold("1204")}, done`,
    `.../esbuild@0.25.4/node_modules/esbuild ${c.dim("postinstall$")} node install.js`,
    `.../esbuild@0.25.4/node_modules/esbuild ${c.dim("postinstall:")} Done`,
    "",
    `${c.bold("dependencies:")}`,
    `${c.green("+")} react ${c.dim("19.3.1")}`,
    `${c.green("+")} react-dom ${c.dim("19.3.1")}`,
    "",
    `${c.bold("devDependencies:")}`,
    `${c.green("+")} typescript ${c.dim("7.0.2")}`,
    `${c.green("+")} vite ${c.dim("6.3.5")}`,
    "",
    `Done in 4.2s using pnpm ${c.dim("v10.12.1")}`,
  ];
}

/** The admin app's failure: the same story as its excerpt, with colours. */
function failedScreen(app: App): string[] {
  return [
    ...npmHeader(app, "vite --port 4516 --host 127.0.0.1"),
    `${c.red("failed to load config from apps/admin/vite.config.ts")}`,
    `${c.red("error when starting dev server:")}`,
    `${c.red(c.bold("Error"))}${c.red(": Cannot find module '@my-monorepo/ui/vite'")}`,
    "Require stack:",
    "- apps/admin/vite.config.ts",
    c.dim("    at Module._resolveFilename (node:internal/modules/cjs/loader:1405:15)"),
    c.dim("    at defaultResolveImpl (node:internal/modules/cjs/loader:1061:19)"),
    c.dim("    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1066:22)"),
    `${c.inverse(c.red(" ELIFECYCLE "))} ${c.red("Command failed with exit code 3.")}`,
  ];
}

/** Cuts rows at the terminal's width, counting only visible characters. */
export function wrapRows(rows: string[], cols = MOCK_COLS): string[] {
  const out: string[] = [];
  const sgr = /\x1b\[[0-9;]*m/y;
  for (const row of rows) {
    let cur = "";
    let width = 0;
    for (let i = 0; i < row.length; ) {
      sgr.lastIndex = i;
      const m = sgr.exec(row);
      if (m) {
        cur += m[0];
        i += m[0].length;
        continue;
      }
      const ch = String.fromCodePoint(row.codePointAt(i)!);
      if (width === cols) {
        out.push(cur);
        cur = "";
        width = 0;
      }
      cur += ch;
      width++;
      i += ch.length;
    }
    out.push(cur);
  }
  return out;
}

function screenFor(app: App, url: string, startedAt: number, now: number): string[] {
  const label = app.task.split("/").pop() ?? app.task;
  if (app.state === "failed") return failedScreen(app);
  if (app.kind === "job") return app.state === "done" ? installedScreen() : app.state === "starting" ? installingScreen(startedAt, now) : [];
  if (app.state === "starting") return app.rawState === "waiting" ? [] : startingScreen(app, startedAt, now);
  if (app.state === "on" || app.state === "stopping") {
    if (label === "api" || label === "worker") return apiScreen(app, startedAt, now);
    return viteScreen(app, url || `http://localhost:${app.port ?? 5173}/`, startedAt, now);
  }
  return [];
}

/**
 * The mock's `output`: the app must exist and its machine be online; a down
 * runner answers runnerDown, like the agent.
 */
export function createMockOutput(ctx: MockContext, clockNow: () => number = Date.now): Pick<Api, "output"> {
  // When each app's current run started; a new pid (a restart) starts over.
  const runs = new Map<string, { key: string; startedAt: number; stoppedAt?: number }>();
  const firstSeen = clockNow();

  return {
    async output(machine, runner, task) {
      await ctx.delay(undefined, 60);
      const ms = ctx.snapshot().machines.find((m) => m.machine.id === machine);
      if (!ms) throw new ApiError(`unknown machine "${machine}"`, 404);
      if (!ms.machine.local && ms.machine.status !== "online") throw new ApiError("machine is offline", 400);
      const app = ms.apps.find((a) => a.runner === runner && a.task === task);
      if (!app) throw new ApiError(`unknown app ${task}`, 400);
      const command = `dekit -C ${shellQuote(runner)} attach ${shellQuote(task)}`;
      if (ms.runners.find((r) => r.root === runner)?.up === false) return { screen: "", runnerDown: true, command };

      const now = clockNow();
      const key = app.pid ? `pid ${app.pid}` : app.state;
      let run = runs.get(app.id);
      if (!run || (run.key !== key && app.state !== "off" && app.state !== "done")) {
        // Apps that were already up when the mock started have run for a while.
        const head = !run && app.state === "on" ? 6 * 60_000 : 0;
        run = { key, startedAt: (run ? now : firstSeen) - head };
        runs.set(app.id, run);
      }
      let shown = app;
      if (app.state === "off") {
        // A stopped app keeps the screen of its last run, as dekit does.
        if (run.key === "off") return { screen: "", command };
        run.stoppedAt ??= now;
        shown = { ...app, state: "on" };
      } else {
        run.stoppedAt = undefined;
      }
      const rows = screenFor(shown, app.remoteUrl ?? app.url ?? "", run.startedAt, run.stoppedAt ?? now);
      if (app.state === "off") rows.push("", c.dim("^C"), `${c.yellow("Stopped")} ${c.dim("(SIGTERM)")}`);
      return { screen: wrapRows(rows).slice(-MOCK_ROWS).join("\n"), command };
    },
  };
}
