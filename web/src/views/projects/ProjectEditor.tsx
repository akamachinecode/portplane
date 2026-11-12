import { useEffect, useState, type ReactNode } from "react";
import type { Reload } from "../../api/dekit";
import { useApp } from "../../components/AppContext";
import { Banner } from "../../components/Banner";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { ErrorState, LoadingState } from "../../components/States";
import { appRoute, navigate } from "../../lib/router";
import { useShell } from "../../shell/ShellContext";
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

// A project's configuration (plan §4.5), under its apps in Projects:
// tasks (tree and form), settings (defaults, kernel, hooks, log, vars,
// fragments) and the raw YAML, a banner when dekit.yaml changed on disk,
// and the Add an app and Run a command dialogs.

export type EditorTab = "apps" | "tasks" | "settings" | "yaml";
const TAB_LABEL: Record<EditorTab, string> = { apps: "Apps", tasks: "Tasks", settings: "Settings", yaml: "YAML" };

function ReloadDialog({ runner, reload, onClose }: { runner: string; reload: Reload; onClose(): void }) {
  return (
    <Dialog open onClose={onClose} title="Review and reload" size="md">
      <ReloadStep runner={runner} reload={reload} onDone={onClose} />
    </Dialog>
  );
}

export function ProjectEditor({ runner, up, apps, os }: { runner: string; up: boolean; apps?: ReactNode; os?: string }) {
  const { load, reload } = useProjectConfig(runner);
  const { plan, refresh } = useReloadPlan(runner, up);
  const dialog = useProjectDialog();
  const { snapshot } = useShell();
  const { toast } = useApp();
  const [tab, setTab] = useState<EditorTab>(apps ? "apps" : "tasks");
  const [selected, setSelected] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const tabs: EditorTab[] = apps ? ["apps", "tasks", "settings", "yaml"] : ["tasks", "settings", "yaml"];
  const pending = plan?.reload && (plan.reload.plan.changes.length > 0 || !!plan.reload.plan.order) ? plan.reload : null;
  const local = snapshot?.machines.find((m) => m.machine.local);

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
  if (tab === "apps") panel = apps;
  else if (load.status === "loading") panel = <LoadingState label="Reading the config…" />;
  else if (load.status === "error") panel = <ErrorState title="Couldn't read the config" message={load.message} onRetry={reload} />;
  else if (tab === "tasks") panel = <TasksPanel runner={runner} config={load.value} os={os} selected={selected} onSelect={setSelected} onSaved={saved} />;
  else if (tab === "settings") panel = <SettingsPanel runner={runner} config={load.value} os={os} onSaved={saved} />;
  else panel = <YamlPanel runner={runner} config={load.value} onSaved={saved} />;

  const config = load.status === "ok" ? load.value : null;
  const wantDialog = dialog && dialog.kind !== "reload" && (!dialog.runner || dialog.runner === runner) ? dialog : null;
  return (
    <div className="project-editor">
      {pending && (
        <Banner
          tone="info"
          title="Configuration changed: review and reload"
          action={
            <button type="button" className="btn btn-sm" onClick={() => setReviewing(true)}>
              Review and reload
            </button>
          }
        >
          The config files say something the runner doesn't run yet ({pending.plan.changes.length === 1 ? "1 task" : `${pending.plan.changes.length} tasks`}
          {pending.plan.order ? ", and the order" : ""}).
        </Banner>
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
      <div className="editor-tabs" role="tablist" aria-label="Project">
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={t === tab} data-tab={t} className="editor-tab" onClick={() => setTab(t)}>
            {TAB_LABEL[t]}
          </button>
        ))}
        <span className="spacer" />
        {up && runner !== "host" && (
          <button type="button" className="btn btn-sm" onClick={() => openProjectDialog({ kind: "run-command", runner })}>
            <Icon name="terminal" size={13} />
            Run a command…
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={() => openProjectDialog({ kind: "add-app", runner })} disabled={!config}>
          <Icon name="plus" size={13} />
          Add an app
        </button>
      </div>
      <div className="editor-panel" role="tabpanel" aria-label={TAB_LABEL[tab]}>
        {panel}
      </div>
      {reviewing && pending && <ReloadDialog runner={runner} reload={pending} onClose={() => (setReviewing(false), refresh(), reload())} />}
      {wantDialog?.kind === "add-app" && config && (
        <AddAppDialog
          runner={runner}
          config={config}
          onClose={() => openProjectDialog(null)}
          onAdded={() => {
            saved();
            setTab("tasks");
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
            if (app) navigate(appRoute("local", app.id));
          }}
        />
      )}
      <DekitHelpHost />
    </div>
  );
}
