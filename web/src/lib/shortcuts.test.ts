import { describe, expect, it } from "vitest";
import { createGlobalKeys, listAction, shortcutGroups, withShortcut } from "./shortcuts";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("listAction", () => {
  it("maps the list keys", () => {
    expect(listAction(key("j"))).toEqual({ kind: "move", delta: 1 });
    expect(listAction(key("ArrowUp"))).toEqual({ kind: "move", delta: -1 });
    expect(listAction(key("Enter"))).toEqual({ kind: "details" });
    expect(listAction(key("s"))).toEqual({ kind: "toggle" });
    expect(listAction(key("r"))).toEqual({ kind: "restart" });
    expect(listAction(key("o"))).toEqual({ kind: "open" });
    expect(listAction(key("c"))).toEqual({ kind: "copy" });
    expect(listAction(key("x"))).toEqual({ kind: "select", range: false });
    expect(listAction(key("X", { shiftKey: true }))).toEqual({ kind: "select", range: true });
    expect(listAction(key("/"))).toEqual({ kind: "search" });
    expect(listAction(key("Escape"))).toEqual({ kind: "clear" });
    expect(listAction(key("f"))).toEqual({ kind: "pin" });
  });

  it("leaves modified keys and others alone", () => {
    expect(listAction(key("c", { ctrlKey: true }))).toBeNull(); // copy text
    expect(listAction(key("r", { metaKey: true }))).toBeNull(); // reload
    expect(listAction(key("j", { altKey: true }))).toBeNull();
    expect(listAction(key("q"))).toBeNull();
  });
});

describe("createGlobalKeys", () => {
  it("goes to a view with g and a letter", () => {
    const keys = createGlobalKeys(1500);
    expect(keys(key("g"), 0)).toEqual({ kind: "pending" });
    expect(keys(key("h"), 400)).toEqual({ kind: "go", view: "health" });
    // the chord is over: s is not settings any more
    expect(keys(key("s"), 500)).toBeNull();
  });

  it("forgets a g after the timeout or another key", () => {
    const keys = createGlobalKeys(1500);
    keys(key("g"), 0);
    expect(keys(key("a"), 2000)).toBeNull();
    keys(key("g"), 3000);
    expect(keys(key("z"), 3100)).toBeNull();
    expect(keys(key("a"), 3200)).toBeNull();
    keys(key("g"), 4000);
    expect(keys(key("a", { ctrlKey: true }), 4100)).toBeNull();
    expect(keys(key("a"), 4200)).toBeNull();
  });

  it("opens help with ?", () => {
    expect(createGlobalKeys()(key("?", { shiftKey: true }), 0)).toEqual({ kind: "help" });
  });
});

describe("help", () => {
  it("lists every go key and the list keys, with the platform's modifier", () => {
    const groups = shortcutGroups(true);
    expect(groups.map((g) => g.title)).toEqual(["Anywhere", "Go to", "Apps list"]);
    expect(groups[0].items[0].keys).toEqual(["⌘", "K"]);
    expect(groups[1].items.map((i) => i.keys.join(" "))).toEqual(["g a", "g d", "g h", "g s", "g r", "g p", "g m"]);
    expect(shortcutGroups(false)[0].items[0].keys).toEqual(["Ctrl", "K"]);
    expect(withShortcut("Start web", "s")).toBe("Start web (S)");
    expect(withShortcut("Show details", "Enter")).toBe("Show details (Enter)");
  });
});
