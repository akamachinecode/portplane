import { useState } from "react";
import { Icon, Spinner } from "../components/Icon";
import { navigate } from "../lib/router";
import { useShell } from "../shell/ShellContext";
import "./OnboardingView.css";

/**
 * The guided setup (plan §3), full window, without the sidebar. A
 * placeholder until M5.1 builds the steps (route #/onboarding/<step>).
 */
export function OnboardingView() {
  const { updatePreferences } = useShell();
  const [busy, setBusy] = useState(false);

  const skip = async () => {
    setBusy(true);
    await updatePreferences((p) => ({ ...p, onboarding: { ...p.onboarding, skipped: true } }));
    setBusy(false);
    navigate({ view: "apps" });
  };

  return (
    <main className="onboarding" id="main">
      <div className="onboarding-card">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={48} height={48} className="onboarding-mark" />
        <h1 className="onboarding-title" tabIndex={-1}>
          Welcome to Portplane
        </h1>
        <p className="onboarding-text">
          Every dev server, on every machine, in one window. Portplane uses dekit to run your apps and portless to give each one a stable{" "}
          <code>https://name.localhost</code> address.
        </p>
        <p className="onboarding-text muted">
          A guided setup that installs the tools and finds your apps is on its way. For now, add a folder in Settings and Portplane walks
          you through the rest.
        </p>
        <div className="onboarding-actions">
          <button type="button" className="btn btn-primary" onClick={() => navigate({ view: "settings", section: "folders" })}>
            <Icon name="folder" size={14} />
            Choose folders
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void skip()} disabled={busy} aria-busy={busy || undefined}>
            {busy && <Spinner />}
            Skip for now
          </button>
        </div>
      </div>
    </main>
  );
}
