import type { DekitHelp, HelpFieldItem, HelpTopic } from "../../api/dekit";

// dekit's own help (`dekit help --json`), so every form field explains
// itself in the words of the installed version (plan §4.4, §4.8).

/** The help for a config key, such as "tasks.*.cmd" or "defaults". */
export function fieldHelp(help: DekitHelp | null | undefined, key: string): HelpFieldItem | undefined {
  return help?.fields.find((f) => f.kind === "config" && f.key === key);
}

/** The help key of a task setting: "cmd" → "tasks.*.cmd", "ready.tcp" → "tasks.*.ready.tcp". */
export function taskKey(key: string): string {
  return `tasks.*.${key}`;
}

export type DescPart = { kind: "text"; text: string } | { kind: "code"; text: string } | { kind: "link"; tag: string };

/** A field description: `code`, and |topic#anchor| references to other topics. */
export function descParts(desc: string): DescPart[] {
  const out: DescPart[] = [];
  const re = /`([^`]+)`|\|([a-z0-9/_#.-]+)\|/g;
  let last = 0;
  for (let m = re.exec(desc); m; m = re.exec(desc)) {
    if (m.index > last) out.push({ kind: "text", text: desc.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else out.push({ kind: "link", tag: m[2] });
    last = re.lastIndex;
  }
  if (last < desc.length) out.push({ kind: "text", text: desc.slice(last) });
  return out;
}

/** Where a tag such as "config/tasks#ready" points: a topic and an anchor. */
export function resolveTag(help: DekitHelp | null | undefined, tag: string): { topic: string; anchor?: string } {
  const known = help?.tags?.[tag];
  if (known) return known.heading ? { topic: known.topic, anchor: known.heading } : { topic: known.topic };
  const [topic, anchor] = tag.split("#");
  return anchor ? { topic, anchor } : { topic };
}

export function topicById(help: DekitHelp | null | undefined, id: string): HelpTopic | undefined {
  return help?.topics.find((t) => t.id === id);
}

/** A topic's title for a link: "Tasks", "dekit reload". */
export function topicTitle(help: DekitHelp | null | undefined, tag: string): string {
  const { topic, anchor } = resolveTag(help, tag);
  const t = topicById(help, topic);
  if (!t) return tag;
  const h = anchor ? t.headings.find((x) => x.id === anchor) : undefined;
  return h ? `${t.title}: ${h.text}` : t.title;
}

/** Topics whose title, summary or text match a search, best first. */
export function searchTopics(help: DekitHelp, query: string): HelpTopic[] {
  const q = query.trim().toLowerCase();
  if (!q) return help.topics;
  const score = (t: HelpTopic) => {
    if (t.title.toLowerCase().includes(q)) return 3;
    if (t.summary.toLowerCase().includes(q)) return 2;
    if (JSON.stringify(t.blocks).toLowerCase().includes(q)) return 1;
    return 0;
  };
  return help.topics
    .map((t, i) => ({ t, i, s: score(t) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.t);
}
