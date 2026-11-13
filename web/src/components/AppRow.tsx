import { memo, useId, useState, type MouseEvent } from "react";
import type { App, MachineSnapshot, Verb } from "../api/types";
import { appHref, copyableUrl, isAlive, rowAddress } from "../lib/apps";
import { dekitCommand, portLabel, stateLabel } from "../lib/format";
import { appRoute, href as routeHref, navigate } from "../lib/router";
import { withShortcut } from "../lib/shortcuts";
import { useAppActionMenu } from "./AppActionMenu";
import { actOnApp, appKey, copyWithToast } from "./appActions";
import { useApp } from "./AppContext";
import { ExcerptPanel } from "./ExcerptPanel";
import { Icon } from "./Icon";
import { IconButton, IconSlot } from "./IconButton";
import { Menu, type MenuItem } from "./Menu";
import { AppIcon } from "./AppIcons";

/** What the Apps view adds to a row: pinning, selection and the keyboard cursor. */
export interface RowExtras {
  /** "<machine>|<appId>", on the row as data-app-key for the keyboard. */
  entryKey: string;
  favorite: boolean;
  onToggleFavorite(): void;
  selected: boolean;
  /** shiftKey: extend the selection from the last one picked. */
  onSelect(range: boolean): void;
  /** The keyboard cursor is on this row. */
  cursor: boolean;
}

export interface AppRowProps {
  app: App;
  ms: MachineSnapshot;
  extras?: RowExtras;
  /** A table row (the Apps view's table mode) instead of a list item. */
  variant?: "list" | "table";
  /** List: show the project (and worktree) after the state. */
  showProject?: boolean;
  /** Table: a column with the project and worktree, or the worktree alone (under a project's row). */
  placeCell?: "project" | "worktree";
  showMachine?: boolean;
}

/** Re-renders only when its app, machine or extras change (memo): long lists stay fast. */
export const AppRow = memo(AppRowImpl, (a, b) => {
  const x = a.extras;
  const y = b.extras;
  return (
    a.app === b.app &&
    a.ms.machine === b.ms.machine &&
    a.ms.tools === b.ms.tools &&
    a.variant === b.variant &&
    a.showProject === b.showProject &&
    a.placeCell === b.placeCell &&
    a.showMachine === b.showMachine &&
    (x === y || (!!x && !!y && x.entryKey === y.entryKey && x.favorite === y.favorite && x.selected === y.selected && x.cursor === y.cursor && x.onSelect === y.onSelect && x.onToggleFavorite === y.onToggleFavorite))
  );
});

function AppRowImpl({ app, ms, extras, variant = "list", showProject, placeCell, showMachine }: AppRowProps) {
  const ctx = useApp();
  const { api, pending } = ctx;
  const [expanded, setExpanded] = useState(false);
  const excerptId = useId();
  const machine = ms.machine.id;

  const alive = isAlive(app.state);
  const failed = app.state === "failed";
  const key = appKey(machine, app);
  const busy = pending.hasPrefix(key);
  const href = app.state === "on" ? appHref(app, ms.machine) : undefined;
  // The live URL (tunnelled, for another machine); or, while it runs without
  // one, where it listens; or the hostname portless keeps while it's off.
  const address = rowAddress(app, ms.machine, href);
  const copyUrl = copyableUrl(app, ms.machine, ms.tools);

  const act = (verb: Verb) => actOnApp(ctx, machine, app, verb);
  const copy = (text: string, what: string) => copyWithToast(ctx, text, what);
  const detail = appRoute(machine, app.id);

  const menu: MenuItem[] = [{ label: "Show details", icon: "panelRight", shortcut: "Enter", onSelect: () => navigate(detail) }];
  if (copyUrl) menu.push({ label: "Copy URL", icon: "copy", shortcut: "C", onSelect: () => copy(copyUrl, "the URL") });
  if (ms.machine.local && app.dir) {
    const dir = app.dir;
    menu.push({
      label: "Reveal folder",
      icon: "folder",
      onSelect: () => pending.run(key + "reveal", null, () => api.reveal(machine, dir)),
    });
  }
  menu.push({ label: "Copy dekit command", icon: "terminal", onSelect: () => copy(dekitCommand(app), "the command") });
  const more = useAppActionMenu(ms, app);
  menu.push(...more.items);

  const toggleVerb: Verb = alive ? "stop" : "start";
  const rowClass = `row row-${app.state}${app.kind === "job" ? " row-job" : ""}${extras?.cursor ? " is-cursor" : ""}${extras?.selected ? " is-selected" : ""}`;

  const select = extras && (
    <input
      type="checkbox"
      className="row-check"
      checked={extras.selected}
      aria-label={`Select ${app.label}`}
      title={withShortcut(`Select ${app.label}`, "x")}
      aria-keyshortcuts="X"
      onClick={(e: MouseEvent<HTMLInputElement>) => {
        e.preventDefault(); // the selection is the view's state, not the box's
        extras.onSelect(e.shiftKey);
      }}
      onChange={() => {
        // handled on click, where Shift is known
      }}
    />
  );

  const name = (
    <div className="row-line">
      <a className="row-label" href={routeHref(detail)} title={withShortcut(`${app.task}: show details`, "Enter")}>
        {app.label}
      </a>
      {app.kind === "job" && <span className="tag">step</span>}
      {/* Running shows as the green dot and a live address, off as neither:
          the word is written only when something needs a look (ADR-0032). */}
      <span className={app.state === "on" || app.state === "off" ? "sr-only" : "row-state"}>{stateLabel(app.state)}</span>
      {variant === "list" && (showProject || showMachine) && (
        <span className="row-where">{[showProject ? [app.project, app.worktree].filter(Boolean).join(" · ") : "", showMachine ? ms.machine.name : ""].filter(Boolean).join(" · ")}</span>
      )}
      {(app.detail || failed) && (
        <span className="row-extra">
          {app.detail && <span className="row-detail">{app.detail}</span>}
          {failed && variant === "list" && (
            <button type="button" className="link-btn" aria-expanded={expanded} aria-controls={excerptId} onClick={() => setExpanded((x) => !x)}>
              {expanded ? "Hide output" : "Show output"}
              <Icon name={expanded ? "chevronDown" : "chevronRight"} size={13} />
            </button>
          )}
        </span>
      )}
    </div>
  );

  const addressLine = address && (
    <div className="row-line row-addr">
      {href ? (
        <a className="addr" href={href} target="_blank" rel="noopener" title={withShortcut(`Open ${app.label}`, "o")}>
          {address}
        </a>
      ) : (
        <span className="addr addr-idle" title={app.url ? undefined : "Its URL once it runs"}>
          {address}
        </span>
      )}
      {app.port && app.url ? (
        <span className="port" title="Internal port">
          <span aria-hidden="true">→ </span>
          {portLabel(app.port)}
        </span>
      ) : null}
    </div>
  );

  const actions = (
    <div className="row-actions">
      {extras && (
        <button
          type="button"
          className={`icon-btn row-pin${extras.favorite ? " is-pinned" : ""}`}
          aria-pressed={extras.favorite}
          aria-label={`Pin ${app.label}`}
          title={withShortcut(extras.favorite ? `Unpin ${app.label}` : `Pin ${app.label} to the top and the tray`, "f")}
          aria-keyshortcuts="F"
          onClick={extras.onToggleFavorite}
        >
          <Icon name={extras.favorite ? "starFilled" : "star"} size={15} />
        </button>
      )}
      {href ? (
        <a className="icon-btn" href={href} target="_blank" rel="noopener" aria-label={`Open ${app.label}`} title={withShortcut(`Open ${app.label}`, "o")} aria-keyshortcuts="O">
          <Icon name="open" />
        </a>
      ) : (
        <IconSlot />
      )}
      <IconButton
        key="toggle"
        icon={alive ? "stop" : "play"}
        tone={alive ? "halt" : "go"}
        label={`${alive ? "Stop" : "Start"} ${app.label}`}
        shortcut="s"
        pending={pending.has(key + toggleVerb)}
        busy={busy}
        onClick={() => act(toggleVerb)}
      />
      {alive ? (
        <IconButton icon="restart" className="row-restart" label={`Restart ${app.label}`} shortcut="r" pending={pending.has(key + "restart")} busy={busy} onClick={() => act("restart")} />
      ) : (
        <IconSlot />
      )}
      <Menu label={`More actions for ${app.label}`} items={menu} />
    </div>
  );

  if (variant === "table") {
    const place = placeCell === "worktree" ? app.worktree || "main" : [app.project, app.worktree].filter(Boolean).join(" · ");
    return (
      <tr className={rowClass} data-app-key={extras?.entryKey}>
        {extras && <td className="cell-check">{select}</td>}
        <td className="cell-name">
          <span className="cell-name-inner">
            <AppIcon ms={ms} app={app} size={22} state={app.state} />
            <span className="row-body">{name}</span>
          </span>
        </td>
        {placeCell && (
          <td className="cell-project">
            <span className="cell-clip" title={place}>
              {place}
            </span>
          </td>
        )}
        {showMachine && (
          <td className="cell-machine">
            <span className="cell-clip">{ms.machine.name}</span>
          </td>
        )}
        <td className="cell-addr">{addressLine}</td>
        <td className="cell-actions">{actions}</td>
      </tr>
    );
  }

  return (
    <li className={rowClass} data-app-key={extras?.entryKey}>
      <div className={extras ? "row-main has-check" : "row-main"}>
        {select}
        <AppIcon ms={ms} app={app} size={28} state={app.state} />
        <div className="row-body">
          {name}
          {addressLine}
        </div>
        {actions}
      </div>
      {failed && expanded && <ExcerptPanel id={excerptId} machine={machine} app={app} />}
      {more.element}
    </li>
  );
}
