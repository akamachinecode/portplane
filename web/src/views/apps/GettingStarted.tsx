import { useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import { checklist, checklistVisible, doneCount, type ChecklistId } from "../../lib/gettingStarted";
import { href } from "../../lib/router";
import { ProgressRing } from "../../shell/Sidebar";
import { useShell } from "../../shell/ShellContext";

/**
 * "Get started" (ADR-0027): the four steps from nothing to the first app at
 * https://<name>.localhost, on top of the Apps view until they are done or
 * hidden. One step is open at a time, the first one left by default; each
 * leads into the guided setup at the right step.
 */
export function GettingStarted() {
  const { snapshot, preferences, updatePreferences } = useShell();
  const local = snapshot?.machines.find((m) => m.machine.local);
  const items = useMemo(() => checklist(local), [local]);
  const prefs = preferences.status === "ok" ? preferences.value : null;
  const firstLeft = items.find((i) => !i.done)?.id ?? null;
  const [open, setOpen] = useState<ChecklistId | null | undefined>(undefined);
  if (!snapshot || !checklistVisible(prefs, items)) return null;
  const current = open === undefined ? firstLeft : open;
  const done = doneCount(items);
  const fresh = done === 0;

  const hide = () => void updatePreferences((p) => ({ ...p, onboarding: { ...p.onboarding, choices: { ...p.onboarding.choices, checklist: "hidden" } } }));

  return (
    <section className="getting-started" aria-labelledby="gs-title">
      <header className="gs-head">
        <div className="gs-head-text">
          <h2 className="gs-title" id="gs-title">
            {fresh ? "Welcome to Portplane" : "Finish setting up"}
          </h2>
          <p className="gs-sub">
            {done} of {items.length} done · every dev server at a stable https://….localhost address, from one window
          </p>
        </div>
        <ProgressRing value={done} max={items.length} size={28} />
        <button type="button" className="icon-btn" aria-label="Hide these steps" title="Hide these steps (Settings › General brings them back)" onClick={hide}>
          <Icon name="close" size={15} />
        </button>
      </header>
      <ol className="gs-list">
        {items.map((item) => {
          const isOpen = current === item.id;
          const bodyId = `gs-${item.id}`;
          return (
            <li key={item.id} className={`gs-item${item.done ? " is-done" : ""}${isOpen ? " is-open" : ""}`}>
              <button type="button" className="gs-item-head" aria-expanded={isOpen} aria-controls={bodyId} onClick={() => setOpen(isOpen ? null : item.id)}>
                <span className="gs-check" aria-hidden="true">
                  {item.done ? <Icon name="check" size={13} /> : <Icon name={item.icon} size={14} />}
                </span>
                <span className="gs-item-text">
                  <span className="gs-item-title">
                    {item.title}
                    {item.done && <span className="sr-only"> (done)</span>}
                  </span>
                  <span className="gs-item-summary">{item.summary}</span>
                </span>
                <Icon name="chevronDown" size={14} className="gs-chevron" />
              </button>
              {isOpen && (
                <div className="gs-item-body" id={bodyId}>
                  <p>{item.body}</p>
                  <div className="gs-actions">
                    <a className={`btn btn-sm${item.done ? "" : " btn-primary"}`} href={href({ view: "onboarding", step: item.step })}>
                      {item.done ? "Review" : item.action}
                      <Icon name="arrowRight" size={13} />
                    </a>
                    {item.id === "projects" && (
                      <a className="btn btn-sm btn-ghost" href={href({ view: "settings", section: "folders" })}>
                        Add a folder by hand
                      </a>
                    )}
                    {item.id === "tools" && !item.done && (
                      <span className="gs-hint">Already use them from a terminal? They show here as soon as they're on your PATH.</span>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
