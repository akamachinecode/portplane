import { memo, type CSSProperties, type ReactNode } from "react";
import { spanLook, type AnsiLine, type AnsiStyle } from "../../lib/ansi";
import { segmentLine, type Match } from "../../lib/outputSearch";

function styled(text: string, style: AnsiStyle, key: number): ReactNode {
  const look = spanLook(style);
  if (!look.className) return text;
  return (
    <span key={key} className={look.className} style={look.vars as CSSProperties | undefined}>
      {text}
    </span>
  );
}

/**
 * A screen's lines with their colours and the search matches marked. Text is
 * only ever a React text node, so nothing in the output can become markup.
 */
export const OutputLines = memo(function OutputLines({ lines, matches, current }: { lines: AnsiLine[]; matches: Match[]; current: number }) {
  const byLine = new Map<number, { start: number; end: number; index: number }[]>();
  matches.forEach((m, index) => {
    const list = byLine.get(m.line) ?? [];
    list.push({ start: m.start, end: m.end, index });
    byLine.set(m.line, list);
  });
  return (
    <pre className="out-pre">
      {lines.map((spans, i) => (
        <span className="out-line" key={i}>
          {segmentLine(spans, byLine.get(i) ?? []).map((seg, j) => {
            const node = styled(seg.text, seg.style, j);
            if (seg.match === undefined) return node;
            const isCurrent = seg.match === current;
            return (
              <mark key={j} className={isCurrent ? "out-match out-match-current" : "out-match"} data-match={seg.match}>
                {node}
              </mark>
            );
          })}
          {"\n"}
        </span>
      ))}
    </pre>
  );
});
