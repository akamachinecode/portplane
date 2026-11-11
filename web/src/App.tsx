import { useCallback, useEffect, useMemo, useState } from "react";
import type { Api } from "./api/client";
import { errorText } from "./api/errors";
import { useSnapshot } from "./api/events";
import type { Info } from "./api/types";
import { AppContext, type AppCtx } from "./components/AppContext";
import { Banner } from "./components/Banner";
import { Spinner } from "./components/Icon";
import { MachineSection } from "./components/MachineSection";
import { SettingsDialog } from "./components/SettingsDialog";
import { Toasts } from "./components/Toasts";
import { TopBar } from "./components/TopBar";
import { usePending } from "./hooks/usePending";
import { useToasts } from "./hooks/useToasts";
import { documentTitle, summarize } from "./lib/summary";

export function App({ api }: { api: Api }) {
  const { snapshot, status } = useSnapshot(api);
  const { toasts, toast, dismiss } = useToasts();
  const pending = usePending(snapshot, toast);
  const [info, setInfo] = useState<Info | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    api.info().then(setInfo, (err: unknown) => toast.error(errorText(err)));
  }, [api, toast]);

  const summary = useMemo(() => (snapshot ? summarize(snapshot) : null), [snapshot]);
  useEffect(() => {
    document.title = documentTitle(summary);
  }, [summary]);

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const ctx = useMemo<AppCtx>(() => ({ api, info, toast, pending, openSettings }), [api, info, toast, pending, openSettings]);

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
          snapshot.machines.map((ms) => <MachineSection key={ms.machine.id} ms={ms} />)
        )}
      </main>
      <Toasts toasts={toasts} onDismiss={dismiss} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </AppContext>
  );
}
