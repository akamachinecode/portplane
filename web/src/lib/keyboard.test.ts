import { describe, expect, it } from "vitest";
import { isPaletteShortcut, isTypingTarget } from "./keyboard";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("isPaletteShortcut", () => {
  it("takes Ctrl+K off macOS and ⌘K on it", () => {
    expect(isPaletteShortcut(key("k", { ctrlKey: true }), false)).toBe(true);
    expect(isPaletteShortcut(key("K", { ctrlKey: true }), false)).toBe(true);
    expect(isPaletteShortcut(key("k", { metaKey: true }), false)).toBe(false);
    expect(isPaletteShortcut(key("k", { metaKey: true }), true)).toBe(true);
    expect(isPaletteShortcut(key("k", { ctrlKey: true }), true)).toBe(false);
    expect(isPaletteShortcut(key("k", { ctrlKey: true, shiftKey: true }), false)).toBe(false);
  });

  it("takes a bare slash", () => {
    expect(isPaletteShortcut(key("/"), false)).toBe(true);
    expect(isPaletteShortcut(key("/", { ctrlKey: true }), false)).toBe(false);
    expect(isPaletteShortcut(key("k"), false)).toBe(false);
  });
});

describe("isTypingTarget", () => {
  it("knows text fields from other controls", () => {
    expect(isTypingTarget({ tagName: "INPUT", type: "text" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "input", type: "search" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
