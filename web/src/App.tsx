import { useCallback, useEffect, useMemo, useState } from "react";
import type { Api } from "./api/client";
import { errorText } from "./api/errors";
import { useSnapshot } from "./api/events";
import { createJobsStore, JobsContext } from "./api/jobs";
import type { Info, Machine } from "./api/types";
import { AppContext, type AppCtx } from "./components/AppContext";
import { AddMachineDialog, EditMachineDialog, RemoveMachineDialog } from "./components/MachineDialogs";
import { SetupDialog } from "./components/SetupDialog";
import { Toasts } from "./components/Toasts";
import { usePending } from "./hooks/usePending";
import { usePreferences } from "./hooks/usePreferences";
import { useToasts } from "./hooks/useToasts";
import { applyAppearance, cacheAppearance } from "./lib/preferences";
import { navigate, useRoute } from "./lib/router";
import { safeLocalStorage } from "./lib/storage";
import { documentTitle, summarize } from "./lib/summary";
import { collectProblems, useProblemSourcesVersion } from "./shell/health";
import { Shell } from "./shell/Shell";
import { ShellContext, type ShellData } from "./shell/ShellContext";

type MachineDialog = { kind: "add" } | { kind: "edit"; id: string } | { kind: "remove"; id: string; name: string } | null;

export function App({ api }: { api: Api }) {
  const [jobs] = useState(createJobsStore);
  const { snapshot, status } = useSnapshot(api, jobs.upsert);
  const { toasts, toast, dismiss } = useToasts();
  const pending = usePending(snapshot, toast);
  const route = useRoute();
  const { preferences, updatePreferences, reloadPreferences } = usePreferences(api, toast);
  const [info, setInfo] = useState<Info | null>(null);
  const [setupFolder, setSetupFolder] = useState<string | null>(null);
  const [machineDialog, setMachineDialog] = useState<MachineDialog>(null);

  useEffect(() => {
    api.info().then(setInfo, (err: unknown) => toast.error(errorText(err)));
  }, [api, toast]);

  // The recent jobs on every (re)connection; events keep them current after.
  useEffect(() => {
    if (status !== "live") return;
    api.jobs().then(jobs.merge, () => {
      // an older binary without jobs: the indicator just stays hidden
    });
  }, [api, status, jobs]);

  // Theme and density on <html>, remembered for the next start.
  const theme = preferences.status === "ok" ? preferences.value.theme : null;
  const density = preferences.status === "ok" ? preferences.value.density : null;
  useEffect(() => {
    if (!theme || !density) return;
    applyAppearance(document.documentElement, { theme, density });
    cacheAppearance(safeLocalStorage(), { theme, density });
  }, [theme, density]);

  const summary = useMemo(() => (snapshot ? summarize(snapshot) : null), [snapshot]);
  useEffect(() => {
    document.title = documentTitle(summary);
  }, [summary]);

  const problemSources = useProblemSourcesVersion();
  const problems = useMemo(() => (snapshot ? collectProblems(snapshot) : []), [snapshot, problemSources]);

  const openSettings = useCallback(() => navigate({ view: "settings", section: "folders" }), []);
  const openSetup = useCallback((folder: string) => setSetupFolder(folder), []);
  const openAddMachine = useCallback(() => setMachineDialog({ kind: "add" }), []);
  const openEditMachine = useCallback((id: string) => setMachineDialog({ kind: "edit", id }), []);
  const openRemoveMachine = useCallback((m: Machine) => setMachineDialog({ kind: "remove", id: m.id, name: m.name }), []);
  const closeMachineDialog = useCallback(() => setMachineDialog(null), []);

  const ctx = useMemo<AppCtx>(
    () => ({ api, info, toast, pending, openSettings, openSetup, openAddMachine, openEditMachine, openRemoveMachine }),
    [api, info, toast, pending, openSettings, openSetup, openAddMachine, openEditMachine, openRemoveMachine],
  );
  const shell = useMemo<ShellData>(
    () => ({ snapshot, status, route, summary, problems, preferences, updatePreferences, reloadPreferences }),
    [snapshot, status, route, summary, problems, preferences, updatePreferences, reloadPreferences],
  );
  const jobsCtx = useMemo(() => ({ store: jobs, api }), [jobs, api]);

  return (
    <AppContext value={ctx}>
      <ShellContext value={shell}>
        <JobsContext value={jobsCtx}>
          <Shell />
          <Toasts toasts={toasts} onDismiss={dismiss} />
          {setupFolder !== null && <SetupDialog folder={setupFolder} onClose={() => setSetupFolder(null)} />}
          {machineDialog?.kind === "add" && <AddMachineDialog onClose={closeMachineDialog} />}
          {machineDialog?.kind === "edit" && <EditMachineDialog id={machineDialog.id} onClose={closeMachineDialog} />}
          {machineDialog?.kind === "remove" && <RemoveMachineDialog id={machineDialog.id} name={machineDialog.name} onClose={closeMachineDialog} />}
        </JobsContext>
      </ShellContext>
    </AppContext>
  );
}
