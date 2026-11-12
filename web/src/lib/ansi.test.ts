import { describe, expect, it } from "vitest";
import { applySgr, cssColor, hasText, parseAnsi, plainLines, spanLook } from "./ansi";

const E = "\x1b[";

describe("parseAnsi", () => {
  it("reads colours and styles into spans", () => {
    expect(parseAnsi(`${E}32mgreen${E}0m ${E}1;31mbold red${E}0m plain`)).toEqual([
      [
        { text: "green", style: { fg: 2 } },
        { text: " ", style: {} },
        { text: "bold red", style: { bold: true, fg: 1 } },
        { text: " plain", style: {} },
      ],
    ]);
  });

  it("reads bright, 256-colour and 24-bit colours, with ; and : separators", () => {
    const style = (seq: string) => parseAnsi(`${E}${seq}mx`)[0][0].style;
    expect(style("91")).toEqual({ fg: 9 });
    expect(style("104")).toEqual({ bg: 12 });
    expect(style("38;5;208")).toEqual({ fg: 208 });
    expect(style("48;5;17")).toEqual({ bg: 17 });
    expect(style("38;2;10;20;30")).toEqual({ fg: [10, 20, 30] });
    expect(style("38:5:208")).toEqual({ fg: 208 });
    expect(style("38:2::10:20:30")).toEqual({ fg: [10, 20, 30] });
    expect(style("38:2:10:20:30")).toEqual({ fg: [10, 20, 30] });
    expect(style("1;4;3;9;2;7")).toEqual({ bold: true, underline: true, italic: true, strike: true, dim: true, inverse: true });
    expect(style("4:3")).toEqual({ underline: true });
  });

  it("turns styles off one by one and all at once", () => {
    let s = applySgr({}, "1;2;3;4;7;9;31;42");
    s = applySgr(s, "22;23");
    expect(s).toEqual({ underline: true, inverse: true, strike: true, fg: 1, bg: 2 });
    s = applySgr(s, "24;27;29;39");
    expect(s).toEqual({ bg: 2 });
    expect(applySgr(s, "49")).toEqual({});
    expect(applySgr({ bold: true, fg: 3 }, "")).toEqual({}); // ESC[m is a reset
    expect(applySgr({ bold: true }, "0;32")).toEqual({ fg: 2 });
    expect(applySgr({ underline: true }, "4:0")).toEqual({});
  });

  it("carries a style over line breaks, like a terminal", () => {
    expect(parseAnsi(`${E}33mone\ntwo${E}0m\nthree`)).toEqual([[{ text: "one", style: { fg: 3 } }], [{ text: "two", style: { fg: 3 } }], [{ text: "three", style: {} }]]);
  });

  it("ignores colours out of range and unknown colour forms", () => {
    const style = (seq: string) => parseAnsi(`${E}${seq}mx`)[0][0].style;
    expect(style("38;5;256")).toEqual({});
    expect(style("38;2;300;20;30")).toEqual({ fg: [255, 20, 30] });
    expect(style("38;9;1;31")).toEqual({}); // the rest of the sequence is ignored
    expect(style("58;5;1")).toEqual({}); // underline colour: not shown
    expect(style("1234567")).toEqual({});
  });

  it("drops every other escape sequence and control character", () => {
    const text = (s: string) => plainLines(parseAnsi(s)).join("\n");
    expect(text(`${E}2J${E}1;1H${E}?25lready${E}K`)).toBe("ready");
    expect(text("\x1b]0;title\x07a \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ b")).toBe("a link b");
    expect(text("\x1bPq#0\x1b\\x\x1b_apc\x1b\\y\x1b(B\x1b=z")).toBe("xyz");
    expect(text(`${E}?1mA${E}>4;2mB${E}1 mC`)).toBe("ABC");
    expect(text("a\x07b\x08c\x00d\re\x7ff\u009bg\th")).toBe("abcdefg\th");
    expect(text("\x1b]0;open\nnext")).toBe("\nnext");
    expect(text("cut\x1b[3")).toBe("cut");
    expect(text("lone\x1b")).toBe("lone");
  });

  it("keeps markup as text and builds styles from numbers only (injection attempts)", () => {
    const lines = parseAnsi(`<script>alert(1)</script>${E}31m<img src=x onerror=alert(1)>${E}0m`);
    expect(plainLines(lines)).toEqual(["<script>alert(1)</script><img src=x onerror=alert(1)>"]);
    // Parameters that are not digits make the sequence something else: dropped, no style.
    const sneaky = parseAnsi(`${E}38;2;0;0;0;url(javascript:alert(1))mtext${E}31;"onmouseover=alert(1)mtext`);
    // ESC[38;2;0;0;0;u and ESC[31;"o end where a terminal would end them; the rest is text.
    expect(plainLines(sneaky)).toEqual(["rl(javascript:alert(1))mtextnmouseover=alert(1)mtext"]);
    for (const span of sneaky.flat()) expect(span.style).toEqual({});
    const look = spanLook(parseAnsi(`${E}38;2;1;2;3;48;5;200mx`)[0][0].style);
    expect(look).toEqual({ className: "ansi-fg-x ansi-bg-x", vars: { "--ansi-fg": "rgb(1 2 3)", "--ansi-bg": "rgb(255 0 215)" } });
  });
});

describe("spanLook", () => {
  it("uses themed classes for the 16 colours and swaps for inverse", () => {
    expect(spanLook({})).toEqual({ className: undefined, vars: undefined });
    expect(spanLook({ fg: 1, bg: 12, bold: true, underline: true })).toEqual({ className: "ansi-fg-1 ansi-bg-12 ansi-bold ansi-underline", vars: undefined });
    expect(spanLook({ inverse: true }).className).toBe("ansi-fg-rev ansi-bg-rev");
    expect(spanLook({ inverse: true, fg: 2 }).className).toBe("ansi-fg-rev ansi-bg-2");
    expect(spanLook({ inverse: true, fg: 2, bg: 4 }).className).toBe("ansi-fg-4 ansi-bg-2");
  });
});

describe("cssColor", () => {
  it("maps the 256-colour palette", () => {
    expect(cssColor(16)).toBe("rgb(0 0 0)");
    expect(cssColor(208)).toBe("rgb(255 135 0)");
    expect(cssColor(231)).toBe("rgb(255 255 255)");
    expect(cssColor(232)).toBe("rgb(8 8 8)");
    expect(cssColor(255)).toBe("rgb(238 238 238)");
    expect(cssColor([1, 2, 3])).toBe("rgb(1 2 3)");
  });
});

describe("hasText", () => {
  it("is false for a screen of blank rows", () => {
    expect(hasText(["", "  ", "\t"])).toBe(false);
    expect(hasText(["", "x"])).toBe(true);
  });
});
