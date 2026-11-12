import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseAnsi, plainLines } from "../../lib/ansi";
import { findMatches } from "../../lib/outputSearch";
import { OutputLines } from "./OutputLines";

const render = (screen: string, query = "", current = 0) => {
  const lines = parseAnsi(screen);
  return renderToStaticMarkup(<OutputLines lines={lines} matches={findMatches(plainLines(lines), query)} current={current} />);
};

describe("OutputLines", () => {
  it("renders colours as classes and other colours as custom properties", () => {
    expect(render("\x1b[1;32mready\x1b[0m in \x1b[38;5;208m412\x1b[0m ms")).toBe(
      '<pre class="out-pre"><span class="out-line"><span class="ansi-fg-2 ansi-bold">ready</span> in <span class="ansi-fg-x" style="--ansi-fg:rgb(255 135 0)">412</span> ms\n</span></pre>',
    );
  });

  it("never turns output into markup (injection attempts)", () => {
    const html = render(
      '<img src=x onerror=alert(1)>\n\x1b[31m</span><script>alert(1)</script>\x1b[0m\n\x1b]8;;javascript:alert(1)\x1b\\link\x1b]8;;\x1b\\\n\x1b[38;2;0;0;0;background:url(x)mx',
    );
    expect(html).not.toMatch(/<(img|script|a)\b/);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;/span&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    // The only inline styles are the custom properties built from numbers.
    for (const m of html.matchAll(/style="([^"]*)"/g)) expect(m[1]).toMatch(/^(--ansi-(fg|bg):rgb\(\d+ \d+ \d+\);?)+$/);
  });

  it("marks the matches and the current one, across colour changes", () => {
    const html = render("\x1b[31mer\x1b[32mror\x1b[0m and error", "error", 1);
    expect(html).toBe(
      '<pre class="out-pre"><span class="out-line">' +
        '<mark class="out-match" data-match="0"><span class="ansi-fg-1">er</span></mark>' +
        '<mark class="out-match" data-match="0"><span class="ansi-fg-2">ror</span></mark>' +
        ' and <mark class="out-match out-match-current" data-match="1">error</mark>\n</span></pre>',
    );
  });
});
