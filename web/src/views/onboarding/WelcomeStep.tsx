import { useState } from "react";
import { Icon, Spinner, type IconName } from "../../components/Icon";
import { useOnboarding } from "./context";
import { StepFooter, StepLayout } from "./parts";
import { flowOf } from "./steps";

const DIAGRAM: Array<{ icon: IconName; name: string; does: string }> = [
  { icon: "folder", name: "Your folders", does: "the projects you already have" },
  { icon: "layers", name: "dekit", does: "starts and watches each dev server" },
  { icon: "globe", name: "portless", does: "gives each one an address" },
  { icon: "monitor", name: "Your browser", does: "opens https://shop.localhost" },
];

/** Step 1: what Portplane does, and the way in. */
export function WelcomeStep() {
  const { go, checks } = useOnboarding();
  const [checking, setChecking] = useState(false);

  // "I already use dekit and portless": check, and go straight to the
  // folders when nothing else is needed.
  const already = async () => {
    setChecking(true);
    const flow = flowOf(await checks.run(["dekit", "node", "portless", "proxy", "ca"]));
    setChecking(false);
    go(flow.toolsReady && flow.proxyReady ? "folders" : "check");
  };

  return (
    <StepLayout
      title="Welcome to Portplane"
      lead="Portplane runs the dev servers in your project folders, each at its own https://name.localhost address."
      moreLabel="What to expect"
      more={
        <ul className="ob-promises">
          <li>About five minutes, and no terminal.</li>
          <li>Your password is asked once, by your system, for the HTTPS proxy. Portplane never sees it.</li>
          <li>Everything ends up as plain dekit and portless setup you can keep using from a terminal.</li>
        </ul>
      }
      footer={
        <StepFooter status={checking ? "Checking dekit, Node.js, portless and the proxy…" : undefined}>
          <button type="button" className="btn btn-ghost" onClick={() => void already()} disabled={checking} aria-busy={checking || undefined}>
            {checking && <Spinner size={12} />}I already use dekit and portless
          </button>
          <button type="button" className="btn btn-primary" onClick={() => go("check")} autoFocus>
            Start
            <Icon name="chevronRight" size={14} />
          </button>
        </StepFooter>
      }
    >
      <ol className="ob-diagram" aria-label="How Portplane works">
        {DIAGRAM.map((d, i) => (
          <li key={d.name} className="ob-diagram-node">
            <span className="ob-diagram-icon" aria-hidden="true">
              <Icon name={d.icon} size={20} />
            </span>
            <span className="ob-diagram-name">{d.name}</span>
            <span className="ob-diagram-does">{d.does}</span>
            {i < DIAGRAM.length - 1 && (
              <span className="ob-diagram-arrow" aria-hidden="true">
                <Icon name="arrowRight" size={16} />
              </span>
            )}
          </li>
        ))}
      </ol>
    </StepLayout>
  );
}
