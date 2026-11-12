import { useState } from "react";
import { useApp } from "../../components/AppContext";
import { Icon, Spinner } from "../../components/Icon";
import { useMachineScope } from "../../components/MachineScope";
import { isMac } from "../../lib/keyboard";
import { navigate } from "../../lib/router";
import { useShell } from "../../shell/ShellContext";
import { StartAtLogin } from "../settings/GeneralSection";
import { useOnboarding } from "./context";
import { StepFooter, StepLayout } from "./parts";

/** Step 9: three things worth knowing, then the apps. */
export function DoneStep() {
  const { info } = useApp();
  const { updatePreferences } = useShell();
  const { checks } = useOnboarding();
  const scope = useMachineScope();
  const [leaving, setLeaving] = useState(false);
  const mac = isMac(info?.os);
  const tray = checks.items.tray;
  const gnomeHint = tray?.problem?.includes("AppIndicator") ? tray : undefined;

  const finish = async () => {
    if (scope.remote) {
      navigate({ view: "apps" });
      return;
    }
    setLeaving(true);
    const ok = await updatePreferences((p) => ({ ...p, onboarding: { ...p.onboarding, completed: true, skipped: false, step: "done", done: [...new Set([...p.onboarding.done, "done"])] } }));
    setLeaving(false);
    if (ok) navigate({ view: "apps" });
  };

  if (scope.remote) {
    const name = scope.ms?.machine.name ?? scope.id;
    return (
      <StepLayout
        icon="checkCircle"
        title={`${name} is set up`}
        lead={`Portplane watches ${name}'s folders and shows its apps next to yours. They open here at https://<app>.${scope.id}.localhost, through SSH.`}
        footer={
          <StepFooter>
            <button type="button" className="btn btn-primary" onClick={() => void finish()} autoFocus>
              Go to the apps
              <Icon name="arrowRight" size={14} />
            </button>
          </StepFooter>
        }
      >
        <p className="muted">Its runners, its dekit config and its portless proxy are in Runners, Projects and Domains: pick {name} at the top of each.</p>
      </StepLayout>
    );
  }

  return (
    <StepLayout
      icon="checkCircle"
      title="You're all set"
      lead="Portplane is watching your folders. Three things that help from here:"
      footer={
        <StepFooter>
          <button type="button" className="btn btn-primary" onClick={() => void finish()} disabled={leaving} aria-busy={leaving || undefined} autoFocus>
            {leaving && <Spinner size={12} />}
            Go to my apps
            <Icon name="arrowRight" size={14} />
          </button>
        </StepFooter>
      }
    >
      <ol className="ob-tips">
        <li className="ob-tip">
          <span className="ob-tip-icon" aria-hidden="true">
            <Icon name="search" size={18} />
          </span>
          <div>
            <p className="ob-tip-title">
              Press <kbd>{mac ? "⌘" : "Ctrl"}</kbd> <kbd>K</kbd> for anything
            </p>
            <p className="muted">Go to an app, start or stop it, copy its address or open a setting, from the keyboard.</p>
          </div>
        </li>
        <li className="ob-tip">
          <span className="ob-tip-icon" aria-hidden="true">
            <Icon name="plug" size={18} />
          </span>
          <div className="ob-tip-wide">
            <StartAtLogin />
          </div>
        </li>
        <li className="ob-tip">
          <span className="ob-tip-icon" aria-hidden="true">
            <Icon name="monitor" size={18} />
          </span>
          <div>
            <p className="ob-tip-title">{mac ? "Find it in the menu bar" : "Find it in the tray"}</p>
            <p className="muted">Closing this window keeps Portplane running there, with your apps and their state one click away.</p>
            {gnomeHint && (
              <p className="ob-tip-extra">
                GNOME shows tray icons only with the AppIndicator extension.{" "}
                {gnomeHint.docs && (
                  <a href={gnomeHint.docs} target="_blank" rel="noopener noreferrer">
                    Get the extension
                    <Icon name="open" size={12} />
                  </a>
                )}{" "}
                On Ubuntu it's already there; on Fedora, <code>sudo dnf install gnome-shell-extension-appindicator</code>, then log out and in.
              </p>
            )}
          </div>
        </li>
      </ol>
    </StepLayout>
  );
}
