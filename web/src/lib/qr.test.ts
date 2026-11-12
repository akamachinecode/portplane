import { describe, expect, it } from "vitest";
import { encodeQr, penalty, qrPath, type Ecc } from "./qr";
import fixtures from "./qr.fixtures.json";

// qr.fixtures.json holds codes made by the Python qrcode package 8.2 (a
// reference encoder that follows ISO/IEC 18004) for the same text, error
// correction and mask, in byte mode. Every module must match.

interface Fixture {
  text: string;
  ecc: Ecc;
  mask: number;
  forced: boolean;
  version: number;
  rows: string[];
}

const rows = (modules: boolean[][]) => modules.map((r) => r.map((d) => (d ? "1" : "0")).join(""));

describe("encodeQr", () => {
  it.each(fixtures as Fixture[])("matches the reference for $text ($ecc, mask $mask)", (f) => {
    const qr = encodeQr(f.text, { ecc: f.ecc, mask: f.mask });
    expect(qr.version).toBe(f.version);
    expect(qr.size).toBe(f.rows.length);
    expect(rows(qr.modules)).toEqual(f.rows);
  });

  it("picks the mask with the lowest penalty", () => {
    const qr = encodeQr("https://web.local");
    const scores = [0, 1, 2, 3, 4, 5, 6, 7].map((m) => penalty(encodeQr("https://web.local", { mask: m }).modules));
    expect(scores[qr.mask]).toBe(Math.min(...scores));
    // The reference picks the same one for this text.
    expect(qr.mask).toBe((fixtures as Fixture[])[0].mask);
  });

  it("grows the version with the text and refuses what doesn't fit", () => {
    expect(encodeQr("a").version).toBe(1);
    expect(encodeQr("a", { minVersion: 5 }).version).toBe(5);
    expect(encodeQr("x".repeat(2331), { ecc: "M" }).version).toBe(40);
    expect(() => encodeQr("x".repeat(2332), { ecc: "M" })).toThrow(/too long/);
  });
});

describe("qrPath", () => {
  it("draws one rectangle per run of dark modules, inside the quiet zone", () => {
    const path = qrPath({ size: 3, modules: [[true, true, false], [false, false, false], [true, false, true]] }, 2);
    expect(path).toBe("M2 2h2v1h-2zM2 4h1v1h-1zM4 4h1v1h-1z");
  });
});
