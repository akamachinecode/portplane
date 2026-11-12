import { useState } from "react";
import { errorText } from "../../api/errors";
import { useApp } from "../../components/AppContext";
import { Icon, Spinner } from "../../components/Icon";

/** What the report holds, said before it is made. */
export const DIAGNOSTICS_DESCRIPTION =
  "A zip with the versions of Portplane, dekit and portless, portless doctor, the proxy service's status, your runners and what Portplane shows. Secrets, environment values and your home folder are left out, and nothing is sent anywhere: you choose whether to share it.";

/** "Export diagnostics": builds the report and saves it where the user picks (plan §6.4). */
export function ExportDiagnosticsButton({ variant = "btn" }: { variant?: "btn" | "ghost" }) {
  const { api, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const saved = await api.exportDiagnostics();
      if (!saved) return; // the user closed the save dialog
      toast.info(saved.dialog ? `Saved the report to ${saved.path}` : `Saved the report in your Downloads folder${saved.revealed ? ", now open" : ""}: ${saved.path}`);
    } catch (err) {
      toast.error(`Couldn't export the diagnostic report: ${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className={variant === "ghost" ? "btn btn-ghost" : "btn"}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      title={DIAGNOSTICS_DESCRIPTION}
      onClick={() => !busy && void run()}
    >
      {busy ? <Spinner /> : <Icon name="download" size={14} />}
      {busy ? "Preparing the report…" : "Export diagnostics"}
    </button>
  );
}
