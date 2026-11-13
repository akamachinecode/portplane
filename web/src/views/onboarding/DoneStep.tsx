import { useState } from "react";
import { useApp } from "../../components/AppContext";
import { Icon, Spinner } from "../../components/Icon";
import { useMachineScope } from "../../components/MachineScope";
import { isMac } from "../../lib/keyboard";
import { navigate } from "../../lib/router";
import { useShell } from "../../shell/ShellContext";
import { StartAtLogin } from "../settings/GeneralSection";
import { useOnboarding } from "./context";
import { More, StepFooter, StepLayout } from "./parts";

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
        title={`${name} is set up`}
        lead={`Its apps show next to yours and open here at https://<app>.${scope.id}.localhost, through SSH.`}
        footer={
          <StepFooter>
            <button type="button" className="btn btn-primary" onClick={() => void finish()} autoFocus>
              Go to the apps
              <Icon name="arrowRight" size={14} />
            </button>
          </StepFooter>
        }
        moreLabel="Where to find the rest"
        more={<p>Its runners, its dekit config and its portless proxy are in Runners, Projects and Domains: pick {name} at the top of each.</p>}
      />
    );
  }

  return (
    <StepLayout
      title="Done"
      lead="Portplane watches your folders now. Three things that help from here:"
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
      <ul className="ob-tips">
        <li className="ob-tip">
          <Icon name="search" size={16} />
          <div>
            <p className="ob-tip-title">
              Press <kbd>{mac ? "⌘" : "Ctrl"}</kbd> <kbd>K</kbd> for anything
            </p>
            <p className="ob-tip-text">Go to an app, start or stop it, copy its address or open a setting.</p>
          </div>
        </li>
        <li className="ob-tip">
          <Icon name="plug" size={16} />
          <div className="ob-tip-wide">
            <StartAtLogin />
          </div>
        </li>
        <li className="ob-tip">
          <Icon name="monitor" size={16} />
          <div>
            <p className="ob-tip-title">{mac ? "Find it in the menu bar" : "Find it in the tray"}</p>
            <p className="ob-tip-text">Closing this window keeps Portplane running there.</p>
            {gnomeHint && (
              <More label="Don't see it on GNOME?">
                <p>
                  GNOME shows tray icons only with the AppIndicator extension.{" "}
                  {gnomeHint.docs && (
                    <a href={gnomeHint.docs} target="_blank" rel="noopener noreferrer">
                      Get the extension
                      <Icon name="open" size={12} />
                    </a>
                  )}{" "}
                  On Ubuntu it's already there; on Fedora, <code>sudo dnf install gnome-shell-extension-appindicator</code>, then log out and in.
                </p>
              </More>
            )}
          </div>
        </li>
      </ul>
    </StepLayout>
  );
}
