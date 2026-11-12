import { describe, expect, it } from "vitest";
import type { UpdateCheck } from "../api/polish";
import { DEFAULT_PREFERENCES } from "./preferences";
import { portplaneUpdate, shouldAskAboutUpdates } from "./updateCheck";

const check = (items: UpdateCheck["items"]): UpdateCheck => ({ checkedAt: "2026-11-12T10:00:00Z", items });

describe("portplaneUpdate", () => {
  it("finds a newer Portplane, and nothing else", () => {
    const newer = { id: "portplane" as const, name: "Portplane", installed: "0.5.0", latest: "0.6.0", update: true };
    expect(portplaneUpdate(check([newer]))).toEqual(newer);
    expect(portplaneUpdate(check([{ ...newer, update: false }]))).toBeUndefined();
    expect(portplaneUpdate(check([{ ...newer, id: "dekit", name: "dekit" }]))).toBeUndefined();
    expect(portplaneUpdate(check([{ ...newer, error: "offline" }]))).toBeUndefined();
    expect(portplaneUpdate(null)).toBeUndefined();
    expect(portplaneUpdate(undefined)).toBeUndefined();
  });
});

describe("shouldAskAboutUpdates", () => {
  it("asks once, after setup, while checks are manual", () => {
    const p = DEFAULT_PREFERENCES;
    expect(shouldAskAboutUpdates(p, false)).toBe(true);
    expect(shouldAskAboutUpdates(p, true)).toBe(false);
    expect(shouldAskAboutUpdates({ ...p, updateAsked: true }, false)).toBe(false);
    expect(shouldAskAboutUpdates({ ...p, updateCheck: "auto" }, false)).toBe(false);
    expect(shouldAskAboutUpdates(null, false)).toBe(false);
  });
});
