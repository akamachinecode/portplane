import { describe, expect, it } from "vitest";
import type { AppProposal, Proposal } from "../api/types";
import {
  applyMessage,
  cleanName,
  countsText,
  effectiveName,
  groupProposalApps,
  invalidNames,
  label,
  nameClashes,
  nameProblem,
  NO_EDITS,
  overridesFor,
  overridesKey,
  proposalCounts,
  relativePath,
  rescanDelay,
  TYPING_DELAY,
  urlForName,
  writeBlocker,
  type SetupEdits,
  type WriteState,
} from "./setup";

function ap(task: string, p: Partial<AppProposal> = {}): AppProposal {
  const [project] = task.split("/");
  return {
    task,
    project,
    name: task.split("/").reverse().join("."),
    hostname: "",
    dir: task,
    framework: "vite",
    packageManager: "pnpm",
    command: [],
    status: "new",
    skipped: false,
    ...p,
  };
}

function proposal(apps: AppProposal[], p: Partial<Proposal> = {}): Proposal {
  return {
    folder: "/home/dev/code",
    apps,
    warnings: [],
    change: { added: [], changed: [], removed: [] },
    files: [{ path: "/home/dev/code/.portplane/tasks.yaml", before: "", after: "tasks: {}\n", created: true, changed: true }],
    digest: "d1",
    ...p,
  };
}

describe("names", () => {
  it("cleans like the server does", () => {
    expect(label("@acme/Web App")).toBe("web-app");
    expect(label("--")).toBe("app");
    expect(label("x".repeat(70))).toHaveLength(63);
    expect(cleanName(" Web.Shop.localhost ")).toBe("web.shop");
    expect(cleanName("admin..shop")).toBe("admin.shop");
    expect(cleanName("My App.shop")).toBe("my-app.shop");
    expect(cleanName("...")).toBe("");
    expect(cleanName(".localhost")).toBe("");
  });

  it("says what is wrong with a typed name", () => {
    expect(nameProblem("")).toBe("Type a name.");
    expect(nameProblem("  ")).toBe("Type a name.");
    expect(nameProblem("..")).toMatch(/letters/);
    expect(nameProblem("web.shop")).toBeNull();
  });

  it("builds the URL", () => {
    expect(urlForName("web.shop")).toBe("https://web.shop.localhost");
  });
});

describe("overrides", () => {
  it("sends cleaned, valid names and only skipped tasks", () => {
    const edits: SetupEdits = {
      names: { "shop/web": " Store ", "shop/api": "..", "shop/admin": "Admin.Shop" },
      skip: { "shop/docs": true, "shop/web": false },
    };
    expect(overridesFor(edits)).toEqual({ names: { "shop/admin": "admin.shop", "shop/web": "store" }, skip: { "shop/docs": true } });
    expect(overridesFor(NO_EDITS)).toEqual({});
  });

  it("keys equal overrides equally, whatever the key order", () => {
    const a = overridesKey({ names: { b: "2", a: "1" }, skip: { x: true } });
    const b = overridesKey({ skip: { x: true }, names: { a: "1", b: "2" } });
    expect(a).toBe(b);
    expect(overridesKey({ skip: { x: false } })).toBe(overridesKey({}));
    expect(overridesKey({ names: { a: "1" } })).not.toBe(overridesKey({ names: { a: "2" } }));
  });

  it("does not re-scan for edits that clean to the same name", () => {
    const k1 = overridesKey(overridesFor({ names: { "shop/web": "Store" }, skip: {} }));
    const k2 = overridesKey(overridesFor({ names: { "shop/web": "store " }, skip: {} }));
    expect(k1).toBe(k2);
  });

  it("waits while typing and re-scans a checkbox at once", () => {
    expect(rescanDelay({}, { names: { a: "x" } })).toBe(TYPING_DELAY);
    expect(rescanDelay({ names: { a: "x" } }, { names: { a: "x" }, skip: { b: true } })).toBe(0);
    expect(rescanDelay({ skip: { b: true } }, {})).toBe(0);
  });
});

describe("effective state", () => {
  const apps = [ap("shop/web", { name: "shop" }), ap("shop/api", { name: "api.shop" }), ap("shop/docs", { name: "docs.shop", status: "manual", skipped: true })];

  it("shows a valid typed name ahead of the re-scan", () => {
    expect(effectiveName(apps[0], { names: { "shop/web": "Store" }, skip: {} })).toBe("store");
    expect(effectiveName(apps[0], { names: { "shop/web": ".." }, skip: {} })).toBe("shop");
    expect(effectiveName(apps[0], NO_EDITS)).toBe("shop");
  });

  it("finds two included apps that want the same URL", () => {
    expect(nameClashes(apps, NO_EDITS).size).toBe(0);
    const clash: SetupEdits = { names: { "shop/api": "shop" }, skip: {} };
    expect([...nameClashes(apps, clash)].sort()).toEqual(["shop/api", "shop/web"]);
    // skipping one of them resolves it; hand-written apps never count
    expect(nameClashes(apps, { ...clash, skip: { "shop/web": true } }).size).toBe(0);
    expect(nameClashes(apps, { names: { "shop/web": "docs.shop" }, skip: {} }).size).toBe(0);
  });

  it("lists typed names that can't be used", () => {
    expect(invalidNames({ names: { b: "", a: "..", c: "ok" }, skip: {} })).toEqual(["a", "b"]);
  });
});

describe("groupProposalApps", () => {
  it("groups by project and checkout, main checkout first, in scan order", () => {
    const apps = [
      ap("shop/feature/web", { worktree: "feature" }),
      ap("shop/web"),
      ap("blog/site"),
      ap("shop/api"),
      ap("shop/feature/api", { worktree: "feature" }),
    ];
    const groups = groupProposalApps(apps);
    expect(groups.map((g) => g.project)).toEqual(["shop", "blog"]);
    expect(groups[0].worktrees.map((w) => [w.worktree, w.apps.map((a) => a.task)])).toEqual([
      ["", ["shop/web", "shop/api"]],
      ["feature", ["shop/feature/web", "shop/feature/api"]],
    ]);
    expect(groups[1].worktrees).toHaveLength(1);
    expect(groupProposalApps([])).toEqual([]);
  });
});

describe("counts", () => {
  it("counts statuses and removed tasks", () => {
    const p = proposal([ap("a/x"), ap("a/y", { status: "changed" }), ap("a/z", { status: "unchanged" }), ap("a/w", { status: "manual", skipped: true })], {
      change: { added: ["a/x"], changed: ["a/y"], removed: ["a/old", "a/older"] },
    });
    const c = proposalCounts(p);
    expect(c).toEqual({ new: 1, changed: 1, unchanged: 1, manual: 1, skipped: 0, removed: 2 });
    expect(countsText(c)).toBe("1 new · 1 changed · 2 removed · 1 unchanged");
    expect(countsText(proposalCounts(proposal([])))).toBe("no tasks");
  });
});

describe("relativePath", () => {
  it("shows files relative to the folder", () => {
    expect(relativePath("/home/dev/code/.portplane/tasks.yaml", "/home/dev/code")).toBe(".portplane/tasks.yaml");
    expect(relativePath("/home/dev/code/dekit.yaml", "/home/dev/code/")).toBe("dekit.yaml");
    expect(relativePath("/elsewhere/dekit.yaml", "/home/dev/code")).toBe("/elsewhere/dekit.yaml");
    expect(relativePath("C:\\code\\dekit.yaml", "C:\\code")).toBe("dekit.yaml");
  });
});

describe("writeBlocker", () => {
  const p = proposal([ap("shop/web", { name: "shop" }), ap("shop/api", { name: "api.shop" })]);
  const ready: WriteState = { proposal: p, scannedKey: overridesKey({}), edits: NO_EDITS, scanning: false };

  it("allows a write of exactly what was scanned", () => {
    expect(writeBlocker(ready)).toBeNull();
  });

  it("waits for the re-scan after an edit", () => {
    const edits: SetupEdits = { names: { "shop/api": "backend" }, skip: {} };
    expect(writeBlocker({ ...ready, edits })).toBe("Updating the preview…");
    const rescanned = { ...ready, edits, scannedKey: overridesKey(overridesFor(edits)) };
    expect(writeBlocker(rescanned)).toBeNull();
    expect(writeBlocker({ ...rescanned, scanning: true })).toBe("Updating the preview…");
  });

  it("blocks bad names, clashes, and an empty write", () => {
    expect(writeBlocker({ ...ready, proposal: null })).toMatch(/Scan/);
    expect(writeBlocker({ ...ready, edits: { names: { "shop/api": "" }, skip: {} } })).toBe("One name needs fixing.");
    expect(writeBlocker({ ...ready, edits: { names: { "shop/api": "shop" }, skip: {} } })).toMatch(/same URL/);
    const unchanged = proposal(p.apps, { files: p.files.map((f) => ({ ...f, changed: false })) });
    expect(writeBlocker({ ...ready, proposal: unchanged })).toMatch(/Nothing to write/);
  });
});

describe("applyMessage", () => {
  it("says what was written and whether dekit runs it", () => {
    expect(applyMessage({ written: ["a", "b"], reloaded: true })).toEqual({ kind: "info", text: "Wrote 2 files. dekit picked up the new tasks." });
    expect(applyMessage({ written: ["a"], reloaded: false })).toEqual({ kind: "info", text: "Wrote 1 file. Start the runner to run them." });
    expect(applyMessage({ written: ["a"], reloaded: false, reloadError: "boom" }).kind).toBe("error");
    expect(applyMessage({ written: [], reloaded: false }).text).toMatch(/Nothing to write/);
  });
});
