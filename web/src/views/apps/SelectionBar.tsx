import { errorText } from "../../api/errors";
import { useApp } from "../../components/AppContext";
import { Icon } from "../../components/Icon";
import { BULK_ACTIONS } from "./bulk";
import type { AppEntry } from "./model";

/** Actions on the selected apps (plan §6.2), at the bottom of the window while any is selected. */
export function SelectionBar({ selected, onClear }: { selected: AppEntry[]; onClear(): void }) {
  const ctx = useApp();
  const n = selected.length;
  return (
    <div className="selection-bar" role="toolbar" aria-label={`${n} selected ${n === 1 ? "app" : "apps"}`}>
      <span className="selection-count" aria-live="polite">
        {n} selected
      </span>
      <span className="selection-sep" aria-hidden="true" />
      {BULK_ACTIONS.map((a) => {
        const targets = a.applies(selected);
        const none = targets.length === 0;
        return (
          <button
            key={a.id}
            type="button"
            className={`btn btn-sm selection-btn${a.tone ? ` tone-${a.tone}` : ""}`}
            aria-disabled={none || undefined}
            title={none ? `None of the selected apps can ${a.label.toLowerCase()}` : `${a.label} ${targets.map((t) => t.app.label).join(", ")}`}
            onClick={() => {
              if (none) return;
              a.run(ctx, targets).catch((err: unknown) => ctx.toast.error(errorText(err)));
            }}
          >
            <Icon name={a.icon} size={14} />
            {a.label}
            {!none && targets.length !== n && <span className="selection-n">{targets.length}</span>}
          </button>
        );
      })}
      <span className="spacer" />
      <button type="button" className="btn btn-sm btn-ghost" onClick={onClear} title="Clear the selection (Esc)" aria-keyshortcuts="Escape">
        Clear
      </button>
    </div>
  );
}
