import { useId, useState } from "react";
import { errorText } from "../api/errors";
import type { App, MachineSnapshot, Verb } from "../api/types";
import { appHref, bookmarkUrl, isAlive } from "../lib/apps";
import { copyText } from "../lib/clipboard";
import { appAddress, dekitCommand, displayHost, portLabel, stateLabel } from "../lib/format";
import { appsFingerprint } from "../lib/pending";
import { appTarget } from "../lib/targets";
import { useApp } from "./AppContext";
import { ExcerptPanel } from "./ExcerptPanel";
import { Icon } from "./Icon";
import { IconButton, IconSlot } from "./IconButton";
import { Menu, type MenuItem } from "./Menu";
import { StateDot } from "./StateDot";

export function AppRow({ app, ms }: { app: App; ms: MachineSnapshot }) {
  const { api, pending, toast } = useApp();
  const [expanded, setExpanded] = useState(false);
  const excerptId = useId();
  const machine = ms.machine.id;

  const alive = isAlive(app.state);
  const failed = app.state === "failed";
  const key = `app|${machine}|${app.id}|`;
  const busy = pending.hasPrefix(key);
  const href = app.state === "on" ? appHref(app, ms.machine) : undefined;
  // The live URL; or, while it runs without one, where it listens; or the
  // hostname portless keeps for it while it's off, greyed out.
  const address = app.url || !href ? appAddress(app) : displayHost(href);
  const copyUrl = bookmarkUrl(app, ms.tools);

  const act = (verb: Verb) =>
    pending.run(key + verb, appsFingerprint(machine, [app.id]), () => api.act(appTarget(machine, app), verb));

  const copy = (text: string, what: string) =>
    copyText(text).then(
      () => toast.info(`Copied ${what}`),
      (err: unknown) => toast.error(errorText(err)),
    );

  const menu: MenuItem[] = [];
  if (copyUrl) menu.push({ label: "Copy URL", icon: "copy", onSelect: () => copy(copyUrl, "the URL") });
  if (ms.machine.local && app.dir) {
    const dir = app.dir;
    menu.push({
      label: "Reveal folder",
      icon: "folder",
      onSelect: () => pending.run(key + "reveal", null, () => api.reveal(machine, dir)),
    });
  }
  menu.push({ label: "Copy dekit command", icon: "terminal", onSelect: () => copy(dekitCommand(app), "the command") });

  const toggleVerb: Verb = alive ? "stop" : "start";

  return (
    <li className={`row row-${app.state}${app.kind === "job" ? " row-job" : ""}`}>
      <div className="row-main">
        <StateDot state={app.state} />
        <div className="row-body">
          <div className="row-line">
            <span className="row-label" title={app.task}>
              {app.label}
            </span>
            {app.kind === "job" && <span className="tag">step</span>}
            <span className="row-state">{stateLabel(app.state)}</span>
            {(app.detail || failed) && (
              <span className="row-extra">
                {app.detail && <span className="row-detail">{app.detail}</span>}
                {failed && (
                  <button
                    type="button"
                    className="link-btn"
                    aria-expanded={expanded}
                    aria-controls={excerptId}
                    onClick={() => setExpanded((x) => !x)}
                  >
                    {expanded ? "Hide output" : "Show output"}
                    <Icon name={expanded ? "chevronDown" : "chevronRight"} size={13} />
                  </button>
                )}
              </span>
            )}
          </div>
          {address && (
            <div className="row-line row-addr">
              {href ? (
                <a className="addr" href={href} target="_blank" rel="noopener">
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
          )}
        </div>
        <div className="row-actions">
          {href ? (
            <a className="icon-btn" href={href} target="_blank" rel="noopener" aria-label={`Open ${app.label}`} title={`Open ${app.label}`}>
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
            pending={pending.has(key + toggleVerb)}
            busy={busy}
            onClick={() => act(toggleVerb)}
          />
          {alive ? (
            <IconButton
              icon="restart"
              label={`Restart ${app.label}`}
              pending={pending.has(key + "restart")}
              busy={busy}
              onClick={() => act("restart")}
            />
          ) : (
            <IconSlot />
          )}
          <Menu label={`More actions for ${app.label}`} items={menu} />
        </div>
      </div>
      {failed && expanded && <ExcerptPanel id={excerptId} machine={machine} app={app} />}
    </li>
  );
}
