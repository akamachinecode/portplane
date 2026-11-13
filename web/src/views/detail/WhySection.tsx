import { useEffect, useId, useState } from "react";
import type { Why } from "../../api/dekit";
import { errorText } from "../../api/errors";
import type { App, MachineSnapshot } from "../../api/types";
import { actOnApp, appKey } from "../../components/appActions";
import { useApp } from "../../components/AppContext";
import { Switch } from "../../components/Controls";
import { Spinner } from "../../components/Icon";
import { StateDot } from "../../components/StateDot";
import { neighbourhood } from "../../lib/dekit/graph";
import { depTone, rawStateText, whyMarks, whySentence } from "../../lib/dekit/why";
import { appRoute, href } from "../../lib/router";
import { HelpLink } from "../runners/DekitHelp";
import "./WhySection.css";

// "Why it is like this" (plan §4.3): dekit why, in sentences, with the
// marks (started by you, kept stopped, needed by), the dependencies and a
// small graph of what it needs and what needs it.

function useWhy(ms: MachineSnapshot, app: App) {
  const { api } = useApp();
  const [state, setState] = useState<{ why: Why | null; error: string | null; loading: boolean }>({ why: null, error: null, loading: true });
  const key = `${app.state}|${app.rawState ?? ""}|${app.detail ?? ""}|${app.pid ?? ""}`;
  const reachable = ms.machine.local || ms.machine.status === "online";
  const can = reachable && !!ms.tools.dekit && !!ms.runners.find((r) => r.root === app.runner)?.up;
  useEffect(() => {
    if (!can) {
      setState({ why: null, error: null, loading: false });
      return;
    }
    let live = true;
    api.dekitWhy(app.runner, app.task).then(
      (why) => live && setState({ why, error: null, loading: false }),
      (err: unknown) => live && setState({ why: null, error: errorText(err), loading: false }),
    );
    return () => {
      live = false;
    };
  }, [api, app.runner, app.task, key, can]);
  return { ...state, can };
}

/** What it needs (left) and what needs it (right). */
export function DepGraph({ ms, app }: { ms: MachineSnapshot; app: App }) {
  const titleId = useId();
  const apps = ms.apps.filter((a) => a.runner === app.runner);
  const byTask = new Map(apps.map((a) => [a.task, a]));
  const deps = new Map(apps.map((a) => [a.task, a.deps ?? []]));
  const g = neighbourhood(app.task, deps);
  if (g.nodes.length <= 1) return null;
  const W = 132;
  const H = 30;
  const GX = 44;
  const GY = 10;
  const minCol = Math.min(...g.cols);
  const x = (col: number) => (col - minCol) * (W + GX);
  const y = (row: number) => row * (H + GY);
  const width = (Math.max(...g.cols) - minCol) * (W + GX) + W;
  const height = g.rows * (H + GY) - GY;
  const pos = new Map(g.nodes.map((n) => [n.id, { x: x(n.col), y: y(n.row) }]));
  return (
    <figure className="dep-graph" aria-labelledby={titleId}>
      <figcaption id={titleId} className="sr-only">
        Dependency graph of {app.label}: it needs {app.deps?.join(", ") || "nothing"}.
      </figcaption>
      <div className="dep-graph-scroll">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="presentation">
          {g.edges.map((e) => {
            const a = pos.get(e.from)!;
            const b = pos.get(e.to)!;
            const x1 = a.x + W;
            const y1 = a.y + H / 2;
            const x2 = b.x;
            const y2 = b.y + H / 2;
            const mx = (x1 + x2) / 2;
            return <path key={`${e.from}>${e.to}`} className="dep-edge" d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} />;
          })}
        </svg>
        {g.nodes.map((n) => {
          const p = pos.get(n.id)!;
          const a = byTask.get(n.id);
          const center = n.id === app.task;
          const inner = (
            <>
              <StateDot state={a?.state ?? "unknown"} />
              <span>{a?.label ?? n.id}</span>
            </>
          );
          return center || !a ? (
            <span key={n.id} className={`dep-node${center ? " is-center" : ""}`} style={{ left: p.x, top: p.y, width: W, height: H }}>
              {inner}
            </span>
          ) : (
            <a key={n.id} className="dep-node" href={href(appRoute(ms.machine.id, a.id))} style={{ left: p.x, top: p.y, width: W, height: H }} title={`${a.task}: ${a.state}`}>
              {inner}
            </a>
          );
        })}
      </div>
    </figure>
  );
}

/** The marks whose news isn't in the sentence already ("You started it", "kept stopped", "because web needs it"). */
function extraMarks(why: Why, app: App) {
  const sentence = whySentence(why);
  return whyMarks(why, app).filter(
    (m) => !(m.id === "pinned" && sentence.includes("You started it")) && !(m.id === "vetoed" && sentence.includes("kept stopped")) && !(m.id === "needed" && /needs? it|starts when/.test(sentence)),
  );
}

export function WhySection({ ms, app }: { ms: MachineSnapshot; app: App }) {
  const ctx = useApp();
  const titleId = useId();
  const { why, error, loading, can } = useWhy(ms, app);
  const key = appKey(ms.machine.id, app);
  const vetoBusy = ctx.pending.has(key + "veto") || ctx.pending.has(key + "start");
  const byTask = new Map(ms.apps.filter((a) => a.runner === app.runner).map((a) => [a.task, a]));
  return (
    <section className="detail-section why" aria-labelledby={titleId}>
      <h3 className="detail-section-title" id={titleId}>
        Why it is like this
        <span className="spacer" />
        <HelpLink tag="cli/why" />
      </h3>
      {!can ? (
        <p className="muted">
          {!ms.machine.local && ms.machine.status !== "online" ? `${ms.machine.name} is offline.` : !ms.tools.dekit ? "dekit isn't installed." : "The runner isn't running: dekit explains a task once its runner is up."}
        </p>
      ) : loading && !why ? (
        <p className="muted why-loading">
          <Spinner size={12} /> Asking dekit…
        </p>
      ) : error ? (
        <p className="field-error">{error}</p>
      ) : why ? (
        <>
          <p className="why-sentence">{whySentence(why)}</p>
          {/* Only what the sentence doesn't already say (ADR-0032): the raw
              state lives in Technical details, and the dependencies show
              here only while one holds it back. */}
          {extraMarks(why, app).length > 0 && (
            <ul className="why-marks">
              {extraMarks(why, app).map((m) => (
                <li key={m.id} className={`why-mark why-${m.id}`} title={m.detail}>
                  {m.label}
                </li>
              ))}
            </ul>
          )}
          {why.deps.some((d) => !d.satisfied) && (
            <ul className="why-deps" aria-label="What it waits for">
              {why.deps
                .filter((d) => !d.satisfied)
                .map((d) => {
                  const a = byTask.get(d.path);
                  return (
                    <li key={d.path} className={`why-dep tone-${depTone(d)}`}>
                      <StateDot state={depTone(d)} />
                      {a ? <a href={href(appRoute(ms.machine.id, a.id))}>{a.label}</a> : <span className="mono">{d.path}</span>}
                      <span className="muted">{rawStateText(d)}</span>
                      <span className="why-wait">waiting</span>
                    </li>
                  );
                })}
            </ul>
          )}
          <div className="why-veto">
            <Switch
              checked={why.vetoed}
              busy={vetoBusy}
              onChange={(on) => void actOnApp(ctx, ms.machine.id, app, on ? "veto" : "start")}
              label="Keep it stopped"
              description={why.vetoed ? "dekit won't start it, even when another app needs it. Turning this off starts it." : "Don't start it even if another app needs it. Turning this on stops it."}
            />
          </div>
        </>
      ) : null}
    </section>
  );
}
