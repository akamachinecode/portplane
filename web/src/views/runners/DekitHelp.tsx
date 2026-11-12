import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { DekitHelp, HelpBlock, HelpInline } from "../../api/dekit";
import { errorText } from "../../api/errors";
import { useApp } from "../../components/AppContext";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { ErrorState, LoadingState } from "../../components/States";
import { descParts, fieldHelp, resolveTag, searchTopics, topicById, topicTitle } from "../../lib/dekit/help";
import "./DekitHelp.css";

// dekit's documentation inside Portplane (plan §4.8): the topics of the
// installed dekit's `help --json`, opened from the Runners view and from
// every form field's help link.

let cache: Promise<DekitHelp> | null = null;

/** The help of the installed dekit, fetched once per page. */
export function useDekitHelp(): { help: DekitHelp | null; error: string | null; retry(): void } {
  const { api } = useApp();
  const [state, setState] = useState<{ help: DekitHelp | null; error: string | null }>({ help: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    cache ??= api.dekitHelp();
    cache.then(
      (help) => live && setState({ help, error: null }),
      (err: unknown) => {
        cache = null;
        if (live) setState({ help: null, error: errorText(err) });
      },
    );
    return () => {
      live = false;
    };
  }, [api, attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

// ---- which topic is open, from anywhere ----

type Open = { tag: string } | null;
let open: Open = null;
const listeners = new Set<() => void>();
let hosts: string[] = [];

/** Opens the help viewer at a topic such as "config/tasks#ready". */
export function openDekitHelp(tag = "index"): void {
  open = { tag };
  for (const l of listeners) l();
}

function closeHelp() {
  open = null;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * Renders the help viewer while one is open. Views that offer help mount
 * one; when two are mounted (a view and the app drawer), the newest shows it.
 */
export function DekitHelpHost() {
  const id = useId();
  const current = useSyncExternalStore(subscribe, () => open);
  const [, force] = useState(0);
  useEffect(() => {
    hosts = [...hosts, id];
    force((n) => n + 1);
    return () => {
      hosts = hosts.filter((h) => h !== id);
    };
  }, [id]);
  if (!current || hosts[hosts.length - 1] !== id) return null;
  return <HelpDialog tag={current.tag} onClose={closeHelp} />;
}

/** A link that opens a topic. */
export function HelpLink({ tag, children, className }: { tag: string; children?: ReactNode; className?: string }) {
  return (
    <button type="button" className={className ?? "link-btn help-link"} onClick={() => openDekitHelp(tag)}>
      {children ?? (
        <>
          <Icon name="book" size={13} />
          dekit help
        </>
      )}
    </button>
  );
}

/** A field's help from dekit: its description, type and default, and a link to the topic. */
export function FieldHelp({ help, fieldKey, extra }: { help: DekitHelp | null; fieldKey: string; extra?: ReactNode }) {
  const f = fieldHelp(help, fieldKey);
  if (!f) return extra ? <span className="field-help">{extra}</span> : null;
  return (
    <span className="field-help">
      <Desc text={f.desc} help={help} />
      {f.default && <span className="field-help-default"> Default: {f.default}.</span>}
      {extra && <> {extra}</>}{" "}
      <HelpLink tag={f.topic}>More</HelpLink>
    </span>
  );
}

function Desc({ text, help }: { text: string; help: DekitHelp | null }) {
  return (
    <>
      {descParts(text).map((p, i) =>
        p.kind === "text" ? (
          <span key={i}>{p.text}</span>
        ) : p.kind === "code" ? (
          <code key={i}>{p.text}</code>
        ) : (
          <button key={i} type="button" className="link-btn help-ref" onClick={() => openDekitHelp(p.tag)}>
            {topicTitle(help, p.tag)}
          </button>
        ),
      )}
    </>
  );
}

// ---- the viewer ----

function Inlines({ items, help, go }: { items: HelpInline[]; help: DekitHelp; go(tag: string): void }): ReactNode {
  return items.map((it, i) => {
    switch (it.type) {
      case "text":
        return <span key={i}>{it.text}</span>;
      case "code":
        return <code key={i}>{it.text}</code>;
      case "strong":
        return (
          <strong key={i}>
            <Inlines items={it.children} help={help} go={go} />
          </strong>
        );
      case "em":
        return (
          <em key={i}>
            <Inlines items={it.children} help={help} go={go} />
          </em>
        );
      case "tag-link":
        return (
          <button key={i} type="button" className="link-btn help-ref" onClick={() => go(it.tag)}>
            {topicTitle(help, it.tag)}
          </button>
        );
      case "url-link":
        return (
          <a key={i} href={it.href} target="_blank" rel="noopener noreferrer">
            <Inlines items={it.children} help={help} go={go} />
          </a>
        );
      default:
        return null;
    }
  });
}

function Blocks({ blocks, help, go }: { blocks: HelpBlock[]; help: DekitHelp; go(tag: string): void }): ReactNode {
  return blocks.map((b, i) => {
    switch (b.type) {
      case "paragraph":
        return (
          <p key={i}>
            <Inlines items={b.inlines} help={help} go={go} />
          </p>
        );
      case "footnote":
        return (
          <p key={i} className="help-foot">
            <Inlines items={b.inlines} help={help} go={go} />
          </p>
        );
      case "heading": {
        const H = b.level <= 2 ? "h3" : "h4";
        return (
          <H key={i} id={`help-${b.id}`} className="help-h">
            <Inlines items={b.inlines} help={help} go={go} />
          </H>
        );
      }
      case "code":
        return (
          <pre key={i} className="help-code">
            <code>{b.text}</code>
          </pre>
        );
      case "list": {
        const L = b.ordered ? "ol" : "ul";
        return (
          <L key={i} className="help-list">
            {b.items.map((it, j) => (
              <li key={j}>
                <Inlines items={it} help={help} go={go} />
              </li>
            ))}
          </L>
        );
      }
      case "callout":
        return (
          <aside key={i} className={`help-callout help-callout-${b.variant}`}>
            {b.title && <p className="help-callout-title">{b.title}</p>}
            <Blocks blocks={b.blocks} help={help} go={go} />
          </aside>
        );
      case "fields":
        return (
          <dl key={i} className="help-fields">
            {b.items.map((f) => (
              <div key={f.key} className="help-field">
                <dt>
                  <code>{f.key}</code>
                  {f.type && <span className="help-type">{f.type}</span>}
                </dt>
                <dd>
                  <Desc text={f.desc} help={help} />
                  {f.default && <span className="muted"> Default: {f.default}.</span>}
                </dd>
              </div>
            ))}
          </dl>
        );
      case "commands":
        return (
          <dl key={i} className="help-fields">
            {b.items.map((c) => (
              <div key={c.cmd} className="help-field">
                <dt>
                  <code>{c.cmd}</code>
                </dt>
                <dd>
                  <Desc text={c.desc} help={help} />
                </dd>
              </div>
            ))}
          </dl>
        );
      default:
        return null;
    }
  });
}

function HelpDialog({ tag, onClose }: { tag: string; onClose(): void }) {
  const { help, error, retry } = useDekitHelp();
  const [current, setCurrent] = useState(tag);
  const [query, setQuery] = useState("");
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => setCurrent(tag), [tag]);
  const { topic: topicId, anchor } = resolveTag(help, current);
  const topic = topicById(help, topicId) ?? topicById(help, help?.home ?? "index");
  useEffect(() => {
    const el = anchor ? body.current?.querySelector(`#help-${CSS.escape(anchor)}`) : null;
    if (el) el.scrollIntoView({ block: "start" });
    else body.current?.scrollTo({ top: 0 });
  }, [topic?.id, anchor]);
  const results = useMemo(() => (help && query.trim() ? searchTopics(help, query) : null), [help, query]);

  return (
    <Dialog open onClose={onClose} size="full" title={help ? `dekit ${help.dekit} help` : "dekit help"}>
      {error ? (
        <ErrorState title="Couldn't load dekit's help" message={error} onRetry={retry} />
      ) : !help || !topic ? (
        <LoadingState label="Loading dekit's help…" />
      ) : (
        <div className="help-layout">
          <nav className="help-nav" aria-label="Help topics">
            <input className="input" type="search" placeholder="Search the help" aria-label="Search the help" value={query} onChange={(e) => setQuery(e.target.value)} />
            {results ? (
              <ul>
                {results.length === 0 && <li className="muted help-none">No topic mentions that.</li>}
                {results.map((t) => (
                  <li key={t.id}>
                    <button type="button" className="help-nav-item" aria-current={t.id === topic.id ? "page" : undefined} onClick={() => setCurrent(t.id)}>
                      {t.title}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              help.nav.map((section) => (
                <div key={section.id} className="help-nav-section">
                  <p className="help-nav-title">{section.title}</p>
                  <ul>
                    {section.topics.map((id) => {
                      const t = topicById(help, id);
                      return t ? (
                        <li key={id}>
                          <button type="button" className="help-nav-item" aria-current={id === topic.id ? "page" : undefined} onClick={() => setCurrent(id)}>
                            {t.title}
                          </button>
                        </li>
                      ) : null;
                    })}
                  </ul>
                </div>
              ))
            )}
          </nav>
          <article className="help-body" ref={body} tabIndex={0} aria-labelledby="help-topic-title">
            <h3 id="help-topic-title" className="help-title">
              {topic.title}
            </h3>
            <p className="help-summary">{topic.summary}</p>
            <Blocks blocks={topic.blocks} help={help} go={setCurrent} />
            {topic.related.length > 0 && (
              <footer className="help-related">
                <p className="help-nav-title">Related</p>
                <ul>
                  {topic.related.map((r) => (
                    <li key={r}>
                      <button type="button" className="link-btn" onClick={() => setCurrent(r)}>
                        {topicTitle(help, r)}
                      </button>
                    </li>
                  ))}
                </ul>
              </footer>
            )}
          </article>
        </div>
      )}
    </Dialog>
  );
}
