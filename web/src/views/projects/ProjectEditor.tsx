import { useEffect, useState, type ReactNode } from "react";
import type { Reload } from "../../api/dekit";
import { useApp } from "../../components/AppContext";
import { useScopedMachine } from "../../components/MachineScope";
import { Banner } from "../../components/Banner";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { Menu, type MenuItem } from "../../components/Menu";
import { ErrorState, LoadingState } from "../../components/States";
import { appRoute, navigate } from "../../lib/router";
import { DekitHelpHost } from "../runners/DekitHelp";
import { AddAppDialog } from "./AddAppDialog";
import { openProjectDialog, useProjectDialog } from "./dialogs";
import { ReloadStep } from "./SaveReview";
import { RunCommandDialog } from "./RunCommandDialog";
import { SettingsPanel } from "./SettingsPanel";
import { TasksPanel } from "./TasksPanel";
import { useProjectConfig, useReloadPlan } from "./useProjectConfig";
import { YamlPanel } from "./YamlPanel";
import "./ProjectEditor.css";

// A project's configuration (plan §4.5): one panel, not tabs (ADR-0032).
// The tree lists the file's Settings and its tasks; choosing one opens its
// form beside it. "View as YAML" swaps the panel for the raw files. A line
// says when dekit.yaml changed on disk, and the Add an app and Run a command
// dialogs open from here.

function ReloadDialog({ runner, reload, onClose }: { runner: string; reload: Reload; onClose(): void }) {
  return (
    <Dialog open onClose={onClose} title="Apply to the running project" size="md">
      <ReloadStep runner={runner} reload={reload} onDone={onClose} />
    </Dialog>
  );
}

export function ProjectEditor({ runner, up, os, only }: { runner: string; up: boolean; os?: string; only?: ReadonlySet<string> }) {
  const { load, reload } = useProjectConfig(runner);
  const { plan, refresh } = useReloadPlan(runner, up);
  const dialog = useProjectDialog();
  const { toast } = useApp();
  const [yaml, setYaml] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const pending = plan?.reload && (plan.reload.plan.changes.length > 0 || !!plan.reload.plan.order) ? plan.reload : null;
  const local = useScopedMachine();

  // A palette command asked for a reload review of this runner.
  useEffect(() => {
    if (dialog?.kind === "reload" && dialog.runner === runner) {
      openProjectDialog(null);
      if (pending) setReviewing(true);
      else toast.info(up ? "The runner already runs this config" : "The runner isn't running: it reads the config when it starts");
    }
  }, [dialog, runner, pending, up, toast]);

  const saved = () => {
    reload();
    refresh();
  };

  let panel: ReactNode;
  if (load.status === "loading") panel = <LoadingState label="Reading the config…" />;
  else if (load.status === "error") panel = <ErrorState title="Couldn't read the config" message={load.message} onRetry={reload} />;
  else if (yaml) panel = <YamlPanel runner={runner} config={load.value} onSaved={saved} />;
  else
    panel = (
      <TasksPanel
        runner={runner}
        config={load.value}
        os={os}
        selected={selected}
        onSelect={setSelected}
        onSaved={saved}
        only={only}
        settings={<SettingsPanel runner={runner} config={load.value} os={os} onSaved={saved} />}
      />
    );

  const config = load.status === "ok" ? load.value : null;
  const wantDialog = dialog && dialog.kind !== "reload" && (!dialog.runner || dialog.runner === runner) ? dialog : null;
  const changes = pending ? pending.plan.changes.length : 0;
  const more: MenuItem[] = [];
  if (up && runner !== "host") more.push({ label: "Run a command…", icon: "terminal", onSelect: () => openProjectDialog({ kind: "run-command", runner }) });
  return (
    <div className="project-editor">
      {pending && (
        <Banner
          tone="info"
          title={changes === 0 ? "The new order of tasks isn't running yet" : changes === 1 ? "1 saved change isn't running yet" : `${changes} saved changes aren't running yet`}
          action={
            <button type="button" className="btn btn-sm" onClick={() => setReviewing(true)}>
              Review and apply
            </button>
          }
        />
      )}
      {config && config.warnings.length > 0 && (
        <Banner tone="warn" title="dekit.yaml has problems">
          <ul className="editor-warnings">
            {config.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Banner>
      )}
      <div className="editor-bar">
        <button type="button" className="btn btn-sm btn-ghost" aria-pressed={yaml} onClick={() => setYaml((y) => !y)} disabled={!config}>
          <Icon name={yaml ? "rows" : "file"} size={13} />
          {yaml ? "Back to the form" : "View as YAML"}
        </button>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={() => openProjectDialog({ kind: "add-app", runner })} disabled={!config}>
          <Icon name="plus" size={13} />
          Add an app
        </button>
        {more.length > 0 && <Menu label="More configuration actions" items={more} />}
      </div>
      <div className="editor-panel">{panel}</div>
      {reviewing && pending && <ReloadDialog runner={runner} reload={pending} onClose={() => (setReviewing(false), refresh(), reload())} />}
      {wantDialog?.kind === "add-app" && config && (
        <AddAppDialog
          runner={runner}
          config={config}
          onClose={() => openProjectDialog(null)}
          onAdded={() => {
            saved();
            setYaml(false);
          }}
        />
      )}
      {wantDialog?.kind === "run-command" && (
        <RunCommandDialog
          runner={runner}
          initialCwd={wantDialog.cwd}
          tasks={(config?.tasks ?? []).filter((t) => !t.folder).map((t) => ({ path: t.path, label: typeof t.values.label === "string" ? (t.values.label as string) : (t.path.split("/").pop() ?? t.path) }))}
          onClose={() => openProjectDialog(null)}
          onStarted={(path) => {
            const app = local?.apps.find((a) => a.runner === runner && a.task === path);
            if (app && local) navigate(appRoute(local.machine.id, app.id));
          }}
        />
      )}
      <DekitHelpHost />
    </div>
  );
}
