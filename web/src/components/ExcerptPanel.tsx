import { useEffect, useState } from "react";
import { errorText } from "../api/errors";
import type { App, Excerpt } from "../api/types";
import { copyText } from "../lib/clipboard";
import { appRoute, href } from "../lib/router";
import { useApp } from "./AppContext";
import { Icon, Spinner } from "./Icon";

/** ADR-0011: the last lines of a failed app, never a log view. */
export const EXCERPT_LINES = 15;

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; excerpt: Excerpt };

export function ExcerptPanel({ id, machine, app }: { id: string; machine: string; app: App }) {
  const { api, toast } = useApp();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // Fetch again when the app fails anew (its detail or dekit state changes).
  useEffect(() => {
    let live = true;
    setLoad({ status: "loading" });
    api.excerpt(machine, app.runner, app.task).then(
      (excerpt) => live && setLoad({ status: "ok", excerpt }),
      (err: unknown) => live && setLoad({ status: "error", message: errorText(err) }),
    );
    return () => {
      live = false;
    };
  }, [api, machine, app.runner, app.task, app.detail, app.rawState, attempt]);

  if (load.status === "loading") {
    return (
      <div className="excerpt" id={id}>
        <p className="excerpt-note">
          <Spinner /> Loading the last lines…
        </p>
      </div>
    );
  }
  if (load.status === "error") {
    return (
      <div className="excerpt" id={id}>
        <p className="excerpt-note excerpt-error" role="alert">
          Couldn't load the output: {load.message}
          <button type="button" className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </button>
        </p>
      </div>
    );
  }

  const lines = load.excerpt.lines.slice(-EXCERPT_LINES);
  const copy = () =>
    copyText(lines.join("\n")).then(
      () => toast.info("Copied the last lines"),
      (err: unknown) => toast.error(errorText(err)),
    );

  return (
    <div className="excerpt" id={id}>
      {lines.length > 0 ? (
        <pre className="excerpt-lines" tabIndex={0} aria-label={`Last lines of ${app.label}`}>
          {lines.join("\n")}
        </pre>
      ) : (
        <p className="excerpt-note">The task printed nothing before it stopped.</p>
      )}
      <div className="excerpt-foot">
        <span className="excerpt-hint">
          In a terminal: <code>{load.excerpt.command}</code>
        </span>
        <a className="btn btn-sm" href={href(appRoute(machine, app.id, "output"))}>
          <Icon name="terminal" size={14} />
          Show full output
        </a>
        {lines.length > 0 && (
          <button type="button" className="btn btn-sm" onClick={copy}>
            <Icon name="copy" size={14} />
            Copy
          </button>
        )}
      </div>
    </div>
  );
}
