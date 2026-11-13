import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { MachineSnapshot, Requirement, RequirementId } from "../../api/types";
import { useApp } from "../../components/AppContext";
import { Icon, Spinner, type IconName } from "../../components/Icon";
import { ErrorState } from "../../components/States";
import { serviceCounts } from "../../lib/apps";
import { href, type Route } from "../../lib/router";
import { statusOf } from "../onboarding/steps";
import { resource, valueOf } from "../domains/store";

// Health's board (ADR-0028): every check of this computer, grouped the way
// people think about them, green when fine. The guided setup's own check
// answers most of them (GET /api/setup/check); the snapshot answers the
// runners, the apps and the machines.

/** The setup check, run when Health opens and on "Check again". */
export const checkResource = resource((api) => api.setupCheck());

export function useSystemCheck(autorun: boolean) {
  const { api } = useApp();
  const state = useSyncExternalStore(checkResource.subscribe, checkResource.get);
  useEffect(() => {
    if (autorun && checkResource.get().status === "idle") void checkResource.load(api);
  }, [api, autorun]);
  return { state, reload: () => checkResource.load(api) };
}

export type CheckTone = "ok" | "warn" | "fail" | "info" | "idle";

export interface CheckRow {
  id: string;
  tone: CheckTone;
  title: string;
  /** What was found: a version, a port, a folder. */
  detail?: ReactNode;
  /** Where to act on it. */
  link?: { label: string; route: Route };
}

const TONE_ICON: Record<CheckTone, IconName> = { ok: "checkCircle", warn: "warning", fail: "xCircle", info: "info", idle: "circle" };
const TONE_LABEL: Record<CheckTone, string> = { ok: "Fine", warn: "Needs a look", fail: "Problem", info: "Note", idle: "Not set up" };

/** The groups of the board, by the setup check's ids. */
export const CHECK_GROUPS: Array<{ title: string; ids: RequirementId[] }> = [
  { title: "Tools", ids: ["dekit", "node", "portless", "git", "packages", "path"] },
  { title: "HTTPS and addresses", ids: ["proxy", "port", "ca", "hosts", "lan"] },
  { title: "Portplane", ids: ["portplane", "tray"] },
];

/** Where a check is acted on: its settings page, or the setup step that fixes it. */
export function checkLink(r: Requirement): CheckRow["link"] {
  const bad = statusOf(r) !== "ok" && statusOf(r) !== "info" && statusOf(r) !== "skipped";
  switch (r.id) {
    case "dekit":
      return bad ? { label: "Install", route: { view: "onboarding", step: "install" } } : { label: "About dekit", route: { view: "dekit" } };
    case "portless":
      return bad ? { label: "Install", route: { view: "onboarding", step: "install" } } : { label: "About portless", route: { view: "domains", section: "maintenance" } };
    case "node":
    case "path":
      return bad ? { label: "Fix in Setup", route: { view: "onboarding", step: "install" } } : undefined;
    case "proxy":
    case "port":
      return { label: "Proxy", route: { view: "domains", section: "proxy" } };
    case "ca":
      return bad && r.fix === "trust-browsers" ? { label: "Fix in Setup", route: { view: "onboarding", step: "browsers" } } : { label: "Certificates", route: { view: "domains", section: "certificates" } };
    case "hosts":
      return { label: "Hosts file", route: { view: "domains", section: "hosts" } };
    case "lan":
      return { label: "Sharing", route: { view: "domains", section: "lan" } };
    default:
      return undefined;
  }
}

export function requirementRow(r: Requirement): CheckRow {
  const s = statusOf(r);
  const tone: CheckTone = s === "ok" ? "ok" : s === "info" ? "info" : s === "skipped" ? "idle" : s === "warning" || r.optional ? "warn" : "fail";
  const found = [r.version, r.detail].filter(Boolean).join(" · ");
  return { id: r.id, tone, title: r.name, detail: tone === "ok" || tone === "idle" || tone === "info" ? found || r.why : r.problem || found || r.why, link: checkLink(r) };
}

/** The runners and the apps of a machine, from the snapshot. */
export function snapshotRows(ms: MachineSnapshot): CheckRow[] {
  const rows: CheckRow[] = ms.runners.map((r) => ({
    id: `runner|${r.root}`,
    tone: !r.up ? "idle" : r.error ? "warn" : "ok",
    title: `Runner for ${r.name}`,
    detail: !r.up ? "Stopped: it starts with the first app you start." : r.error ? r.error : "Running",
    link: { label: "Runners", route: { view: "runners" } },
  }));
  const { running, total } = serviceCounts(ms.apps);
  const failed = ms.apps.filter((a) => a.state === "failed").length;
  rows.push({
    id: "apps",
    tone: failed ? "fail" : "ok",
    title: "Apps",
    detail: `${running} of ${total} running${failed ? ` · ${failed} failed` : ""}`,
    link: { label: "Apps", route: { view: "apps" } },
  });
  return rows;
}

export function CheckList({ rows, label }: { rows: CheckRow[]; label: string }) {
  return (
    <ul className="board" aria-label={label}>
      {rows.map((row) => (
        <li key={row.id} className={`board-row tone-${row.tone}`}>
          <span className="board-icon">
            <Icon name={TONE_ICON[row.tone]} size={16} />
            <span className="sr-only">{TONE_LABEL[row.tone]}:</span>
          </span>
          <span className="board-title">{row.title}</span>
          <span className="board-detail">{row.detail}</span>
          {row.link ? (
            <a className="board-link" href={href(row.link.route)}>
              {row.link.label}
              <Icon name="chevronRight" size={13} />
            </a>
          ) : (
            <span />
          )}
        </li>
      ))}
    </ul>
  );
}

/** This computer's board: the setup check's groups, then the runners and the apps. */
export function SystemChecks({ ms }: { ms: MachineSnapshot }) {
  const { state, reload } = useSystemCheck(true);
  const check = valueOf(state);
  const byId = new Map((check?.requirements ?? []).map((r) => [r.id, r]));
  return (
    <>
      {state.status === "error" && !check && <ErrorState title="Couldn't check this computer" message={state.error} onRetry={() => void reload()} />}
      {CHECK_GROUPS.map((g) => {
        const rows = g.ids.flatMap((id) => (byId.has(id) ? [requirementRow(byId.get(id)!)] : []));
        return (
          <section key={g.title} className="board-group" aria-label={g.title}>
            <h3 className="board-group-title">{g.title}</h3>
            {rows.length ? (
              <CheckList rows={rows} label={g.title} />
            ) : (
              <p className="board-loading">
                <Spinner size={13} /> Checking…
              </p>
            )}
          </section>
        );
      })}
      <section className="board-group" aria-label="dekit">
        <h3 className="board-group-title">Runners and apps</h3>
        <CheckList rows={snapshotRows(ms)} label="Runners and apps" />
      </section>
    </>
  );
}
