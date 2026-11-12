import { Banner } from "../../components/Banner";
import { Icon } from "../../components/Icon";
import { href } from "../../lib/router";
import { useShell } from "../../shell/ShellContext";
import { resumeStep, stepLabel } from "./steps";

/** After "Skip for now": a notice that stays until the setup is finished (plan §3.1). */
export function FinishSetupNotice() {
  const { preferences } = useShell();
  if (preferences.status !== "ok") return null;
  const o = preferences.value.onboarding;
  if (!o.skipped || o.completed) return null;
  const step = resumeStep(o);
  return (
    <Banner
      tone="info"
      title="Finish setting up Portplane"
      action={
        <a className="btn btn-sm btn-primary" href={href({ view: "onboarding", step })}>
          <Icon name="wand" size={13} />
          Continue setup
        </a>
      }
    >
      You skipped the guided setup at "{stepLabel(step)}". It installs what's missing and finds your apps; it picks up where you left off.
    </Banner>
  );
}
