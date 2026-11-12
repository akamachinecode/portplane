import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import type { DetailTabProps } from "../AppDetail";
import { DekitHelpHost } from "../runners/DekitHelp";
import { TaskForm } from "../projects/TaskForm";
import { useProjectConfig } from "../projects/useProjectConfig";
import "../projects/ProjectEditor.css";

/** The task's settings as a form (plan §4.4), saved with a diff and a reload review. */
export function ConfigTab({ ms, app }: DetailTabProps) {
  const local = ms.machine.local;
  const { load, reload } = useProjectConfig(local && ms.tools.dekit ? app.runner : null);
  if (!local) {
    return (
      <EmptyState icon="machine" title="Only on this computer for now">
        Editing a task on {ms.machine.name} comes later. Edit its <code>dekit.yaml</code> there; Portplane picks up the change.
      </EmptyState>
    );
  }
  if (!ms.tools.dekit) return <EmptyState icon="pencil" title="dekit isn't installed">Install dekit to edit its tasks.</EmptyState>;
  if (app.dynamic) {
    return (
      <EmptyState icon="terminal" title="Added with Run a command">
        <code>{app.task}</code> isn't in any config file: it runs until you remove it. To keep it, add it as an app from Projects.
      </EmptyState>
    );
  }
  if (load.status === "loading") return <LoadingState label="Reading the project's config…" />;
  if (load.status === "error") return <ErrorState title="Couldn't read the config" message={load.message} onRetry={reload} />;
  const entry = load.value.tasks.find((t) => t.path === app.task && !t.folder);
  if (!entry) {
    return (
      <EmptyState icon="file" title="Not in the config files">
        Portplane found no entry for <code>{app.task}</code>. It may come from a fragment it can't read, or from <code>!js</code>.
      </EmptyState>
    );
  }
  return (
    <div className="config-tab">
      <TaskForm runner={app.runner} config={load.value} entry={entry} os={ms.machine.os} onSaved={reload} />
      <DekitHelpHost />
    </div>
  );
}
