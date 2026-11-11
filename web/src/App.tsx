import { useCallback, useEffect, useMemo, useState } from "react";
import type { Api } from "./api/client";
import { errorText } from "./api/errors";
import { useSnapshot } from "./api/events";
import type { Info, Machine } from "./api/types";
import { AppContext, type AppCtx } from "./components/AppContext";
import { Banner } from "./components/Banner";
import { Icon, Spinner } from "./components/Icon";
import { AddMachineDialog, EditMachineDialog, RemoveMachineDialog } from "./components/MachineDialogs";
import { MachineSection } from "./components/MachineSection";
import { SettingsDialog } from "./components/SettingsDialog";
import { SetupDialog } from "./components/SetupDialog";
import { Toasts } from "./components/Toasts";
import { TopBar } from "./components/TopBar";
import { usePending } from "./hooks/usePending";
import { useToasts } from "./hooks/useToasts";
import { documentTitle, summarize } from "./lib/summary";

type MachineDialog = { kind: "add" } | { kind: "edit"; id: string } | { kind: "remove"; id: string; name: string } | null;

export function App({ api }: { api: Api }) {
  const { snapshot, status } = useSnapshot(api);
  const { toasts, toast, dismiss } = useToasts();
  const pending = usePending(snapshot, toast);
  const [info, setInfo] = useState<Info | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [setupFolder, setSetupFolder] = useState<string | null>(null);
  const [machineDialog, setMachineDialog] = useState<MachineDialog>(null);

  useEffect(() => {
    api.info().then(setInfo, (err: unknown) => toast.error(errorText(err)));
  }, [api, toast]);

  const summary = useMemo(() => (snapshot ? summarize(snapshot) : null), [snapshot]);
  useEffect(() => {
    document.title = documentTitle(summary);
  }, [summary]);

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const openSetup = useCallback((folder: string) => setSetupFolder(folder), []);
  const openAddMachine = useCallback(() => setMachineDialog({ kind: "add" }), []);
  const openEditMachine = useCallback((id: string) => setMachineDialog({ kind: "edit", id }), []);
  const openRemoveMachine = useCallback((m: Machine) => setMachineDialog({ kind: "remove", id: m.id, name: m.name }), []);
  const closeMachineDialog = useCallback(() => setMachineDialog(null), []);

  const ctx = useMemo<AppCtx>(
    () => ({ api, info, toast, pending, openSettings, openSetup, openAddMachine, openEditMachine, openRemoveMachine }),
    [api, info, toast, pending, openSettings, openSetup, openAddMachine, openEditMachine, openRemoveMachine],
  );

  return (
    <AppContext value={ctx}>
      <TopBar summary={summary} status={status} onSettings={openSettings} />
      <main className="main">
        {status === "expired" && (
          <Banner
            tone="error"
            title="Portplane restarted"
            action={
              <button type="button" className="btn" onClick={() => location.reload()}>
                Reload
              </button>
            }
          >
            This page lost its connection. Reload it to see live state again.
          </Banner>
        )}
        {snapshot === null ? (
          status !== "expired" && (
            <p className="loading">
              <Spinner /> Connecting to Portplane…
            </p>
          )
        ) : snapshot.machines.length === 0 ? (
          <p className="loading">No machines to show.</p>
        ) : (
          <>
            {snapshot.machines.map((ms) => (
              <MachineSection key={ms.machine.id} ms={ms} />
            ))}
            <button type="button" className="add-machine" onClick={openAddMachine}>
              <span className="add-machine-icon">
                <Icon name="plus" size={15} />
              </span>
              <span className="add-machine-text">
                <span className="add-machine-title">Add a machine</span>
                <span className="add-machine-hint">See the dev servers of another computer over SSH, Tailscale included.</span>
              </span>
            </button>
          </>
        )}
      </main>
      <Toasts toasts={toasts} onDismiss={dismiss} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {setupFolder !== null && <SetupDialog folder={setupFolder} onClose={() => setSetupFolder(null)} />}
      {machineDialog?.kind === "add" && <AddMachineDialog onClose={closeMachineDialog} />}
      {machineDialog?.kind === "edit" && <EditMachineDialog id={machineDialog.id} onClose={closeMachineDialog} />}
      {machineDialog?.kind === "remove" && <RemoveMachineDialog id={machineDialog.id} name={machineDialog.name} onClose={closeMachineDialog} />}
    </AppContext>
  );
}
