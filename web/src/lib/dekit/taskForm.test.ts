import { describe, expect, it } from "vitest";
import type { YamlValue } from "../../api/dekit";
import { DEFAULTS_KEYS, draftOps, findCycle, fromDraft, fullDep, jsKeys, localDep, looksSecret, mountOf, relPath, toDraft, validateDraft, validDuration } from "./taskForm";

const web: Record<string, YamlValue> = {
  label: "Web",
  cwd: "apps/web",
  cmd: ["portless", "shop", "pnpm", "run", "dev"],
  deps: ["install"],
  env: { PORT: "4000", AI_AGENT: null },
  ready: { log: "ready in", timeout: "30s" },
  autorestart: "on-failure",
  stop: "SIGINT",
  mouse_scroll_speed: 3,
};

describe("toDraft and fromDraft", () => {
  it("round-trips without changes", () => {
    const d = toDraft(web);
    expect(d.env).toEqual([
      { key: "PORT", value: "4000" },
      { key: "AI_AGENT", value: null },
    ]);
    expect(d.ready).toEqual({ kind: "log", value: "ready in", interval: "", timeout: "30s" });
    expect(d.stop.mode).toBe("signal");
    expect(draftOps(["tasks", "web"], web, d)).toEqual([]);
  });

  it("turns only the changed keys into edits", () => {
    const d = toDraft(web);
    d.label = "Storefront";
    d.autorestart = "never";
    d.tags = ["frontend"];
    expect(draftOps(["tasks", "web"], web, d)).toEqual([
      { op: "set", path: ["tasks", "web"], key: "label", value: "Storefront" },
      { op: "set", path: ["tasks", "web"], key: "tags", value: ["frontend"] },
      { op: "unset", path: ["tasks", "web"], key: "autorestart" },
    ]);
  });

  it("keeps a cmd string that still splits the same, and the short stop form", () => {
    const v: Record<string, YamlValue> = { cmd: "npm run dev", stop: { signal: "SIGINT" } };
    const d = toDraft(v);
    expect(fromDraft(d, v).cmd).toBe("npm run dev");
    expect(fromDraft(d, v).stop).toEqual({ signal: "SIGINT" });
    d.cmd = ["npm", "run", "start"];
    expect(fromDraft(d, v).cmd).toEqual(["npm", "run", "start"]);
    expect(fromDraft(toDraft({ cmd: ["x"] }), {}).stop).toBeUndefined();
  });

  it("writes ready, stop and log", () => {
    const d = toDraft({ cmd: ["x"] });
    d.ready = { kind: "tcp", value: "3000", interval: "500ms", timeout: "" };
    d.stop = { mode: "keys", signal: "", keys: ["<C-c>"], cmd: [], timeout: "5s", group: true };
    d.log = { mode: "custom", dir: "logs", file: "", fileMode: "append" };
    d.scrollback = "5000";
    const v = fromDraft(d);
    expect(v.ready).toEqual({ tcp: 3000, interval: "500ms" });
    expect(v.stop).toEqual({ keys: ["<C-c>"], timeout: "5s" });
    expect(v.log).toEqual({ dir: "logs", mode: "append" });
    expect(v.scrollback_len).toBe(5000);
    d.type = "job";
    expect(fromDraft(d).ready).toBeUndefined();
  });

  it("never edits keys written with !js", () => {
    const v: Record<string, YamlValue> = { cmd: ["x"], env: { $js: "ctx.vars.env" } };
    expect(jsKeys(v)).toEqual(["env"]);
    const d = toDraft(v);
    d.env = [{ key: "A", value: "1" }];
    expect(draftOps(["tasks", "t"], v, d)).toEqual([]);
  });

  it("maps deps through a fragment's mount", () => {
    expect(mountOf({ path: "ops/db", key: "db" })).toBe("ops");
    expect(fullDep("db", "ops")).toBe("ops/db");
    expect(fullDep("/web", "ops")).toBe("web");
    expect(localDep("ops/db", "ops")).toBe("db");
    expect(localDep("web", "ops")).toBe("/web");
    const v: Record<string, YamlValue> = { cmd: ["x"], deps: ["db", "/web"] };
    expect(toDraft(v, "ops").deps).toEqual(["ops/db", "web"]);
    expect(draftOps(["tasks", "worker"], v, toDraft(v, "ops"), "ops")).toEqual([]);
  });

  it("limits defaults to the keys defaults: takes", () => {
    const d = toDraft({});
    d.label = "ignored";
    d.autorestart = "always";
    expect(draftOps(["defaults"], {}, d, "", DEFAULTS_KEYS)).toEqual([{ op: "set", path: ["defaults"], key: "autorestart", value: "always" }]);
  });
});

describe("validateDraft", () => {
  const all = new Map([
    ["install", []],
    ["api", ["install"]],
    ["web", ["api"]],
  ]);
  it("explains each problem", () => {
    const d = toDraft({ type: "job" });
    d.autorestart = "always";
    d.ready = { kind: "log", value: "", interval: "", timeout: "5 sec" };
    d.tags = ["autostart"];
    d.env = [
      { key: "A", value: "1" },
      { key: "A", value: "2" },
    ];
    d.stop = { mode: "signal", signal: "TERM", keys: [], cmd: [], timeout: "", group: true };
    d.scrollback = "lots";
    const e = validateDraft(d);
    expect(Object.keys(e).sort()).toEqual(["autorestart", "cmd", "env", "ready", "readyTimeout", "scrollback_len", "stop", "tags"]);
    expect(e.tags).toMatch(/dekit's own/);
  });
  it("finds dependency loops and unknown tasks", () => {
    const d = toDraft({ cmd: ["x"], deps: ["web"] });
    expect(validateDraft(d, { self: "install", allTasks: all }).deps).toBe("That makes a loop: install → web → api → install.");
    expect(validateDraft(toDraft({ cmd: ["x"], deps: ["nope"] }), { self: "web", allTasks: all }).deps).toMatch(/nope isn't a task/);
    expect(validateDraft(toDraft({ cmd: ["x"], deps: ["web"] }), { self: "web", allTasks: all }).deps).toMatch(/itself/);
    expect(validateDraft(toDraft({ cmd: ["x"], deps: ["api"] }), { self: "web", allTasks: all })).toEqual({});
    expect(findCycle("a", ["b"], new Map([["b", ["c"]]]))).toBeNull();
  });
  it("refuses sd_notify on Windows", () => {
    const d = toDraft({ cmd: ["x"], ready: { sd_notify: true } });
    expect(validateDraft(d, { os: "windows" }).ready).toMatch(/Windows/);
    expect(validateDraft(d, { os: "linux" })).toEqual({});
  });
});

describe("helpers", () => {
  it("validDuration", () => {
    expect(["500ms", "10s", "5m", "1h"].every(validDuration)).toBe(true);
    expect(["0s", "5", "1d", "5 s"].some(validDuration)).toBe(false);
  });
  it("relPath", () => {
    expect(relPath("/home/dev/code/.portplane", "/home/dev/code/apps/web")).toBe("../apps/web");
    expect(relPath("/home/dev/code", "/home/dev/code")).toBe(".");
    expect(relPath("C:\\code\\.portplane", "C:\\code\\api")).toBe("../api");
    expect(relPath("C:\\code", "D:\\api")).toBe("D:\\api");
  });
  it("looksSecret", () => {
    expect(looksSecret("STRIPE_SECRET_KEY")).toBe(true);
    expect(looksSecret("GITHUB_TOKEN")).toBe(true);
    expect(looksSecret("PORT")).toBe(false);
    expect(looksSecret("NEXTAUTH_URL")).toBe(false);
  });
});
