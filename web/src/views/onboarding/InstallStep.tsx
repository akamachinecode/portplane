import { useEffect, useId, useState } from "react";
import { errorText } from "../../api/errors";
import { useJob, type Job } from "../../api/jobs";
import type { InstallPlan, ToolId } from "../../api/tools";
import type { Requirement, RequirementId } from "../../api/types";
import { useApp } from "../../components/AppContext";
import { copyWithToast } from "../../components/appActions";
import { Icon, Spinner } from "../../components/Icon";
import { JobCard } from "../../components/JobCard";
import { useJobEnd, useOnboarding } from "./context";
import { Mark, NextButton, StepFooter, StepLayout } from "./parts";
import { statusOf } from "./steps";

const NAMES: Record<ToolId, string> = { dekit: "dekit", node: "Node.js 24", portless: "portless" };
const WHAT: Record<ToolId, string> = {
  dekit: "Starts, stops and watches your dev servers.",
  node: "portless runs on it. Your own Node.js, if you have one, stays as it is.",
  portless: "Gives each dev server its https://name.localhost address.",
};
/** What to check again after an install. */
const RECHECK: Record<ToolId, RequirementId[]> = {
  dekit: ["dekit", "path"],
  node: ["node", "portless"],
  portless: ["portless", "proxy", "ca", "path"],
};

interface Install {
  tool: ToolId;
  req?: Requirement;
  job?: Job;
  ok: boolean;
  running: boolean;
  failed: boolean;
  /** Why it can't start yet ("Needs Node.js 24 first"), or null. */
  blocked: string | null;
  start(method?: string): Promise<void>;
  starting: boolean;
  startError: string | null;
}

function useInstall(tool: ToolId, blocked: string | null): Install {
  const { api, toast } = useApp();
  const { checks, jobs, trackJob } = useOnboarding();
  const job = useJob(jobs[`install:${tool}`]);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const req = checks.items[tool];
  useJobEnd(job, (j) => {
    void checks.run(RECHECK[tool]);
    if (j.state === "succeeded") toast.info(`${NAMES[tool]} is installed`);
  });
  const start = async (method?: string) => {
    setStarting(true);
    setStartError(null);
    try {
      trackJob(`install:${tool}`, await api.installTool(tool, method));
    } catch (err) {
      setStartError(errorText(err));
    } finally {
      setStarting(false);
    }
  };
  const ok = !!req && statusOf(req) === "ok";
  return {
    tool,
    req,
    job,
    ok,
    running: job?.state === "running",
    failed: job?.state === "failed" || job?.state === "cancelled",
    blocked,
    start,
    starting,
    startError,
  };
}

function PlanDetails({ plan }: { plan: InstallPlan }) {
  return (
    <dl className="ob-plan">
      <div>
        <dt>From</dt>
        <dd>{plan.source}</dd>
      </div>
      <div>
        <dt>Checked</dt>
        <dd>{plan.checksum}</dd>
      </div>
      <div>
        <dt>Goes to</dt>
        <dd className="mono">{plan.destination}</dd>
      </div>
      <div>
        <dt>Password</dt>
        <dd>No password needed: it installs for you only.</dd>
      </div>
    </dl>
  );
}

function ToolCard({ install, main }: { install: Install; main: boolean }) {
  const app = useApp();
  const { tool, req, job, ok, running, failed, blocked } = install;
  const plan = req?.install;
  const [picked, setMethod] = useState<string>("");
  const method = picked || plan?.method || "";
  const [showJob, setShowJob] = useState(false);
  const name = NAMES[tool];
  const groupId = useId();
  const outdated = req && statusOf(req) === "outdated";

  const head = (
    <header className="ob-tool-head">
      {ok ? <Mark tone="ok" label="Installed" /> : running ? <Mark tone="busy" label="Installing" /> : failed ? <Mark tone="bad" label="Failed" /> : req ? <Mark tone="idle" label="Not installed" /> : <Mark tone="busy" label="Checking" />}
      <h2 className="ob-tool-name">{name}</h2>
      {ok && req?.version && <span className="ob-check-version mono">{req.version}</span>}
      <span className="ob-tool-state">
        {ok ? (req?.detail ?? "Installed") : running ? "Installing…" : failed ? "Didn't install" : outdated ? `${req?.version} is too old` : req ? "Not installed" : "Checking…"}
      </span>
    </header>
  );

  if (ok) {
    return (
      <article className="ob-tool is-ok">
        {head}
        {job?.state === "succeeded" && (
          <>
            <button type="button" className="link-btn ob-tool-more" aria-expanded={showJob} onClick={() => setShowJob((v) => !v)}>
              {showJob ? "Hide what was done" : "Show what was done"}
            </button>
            {showJob && <JobCard job={job} lines={10} headingLevel={3} />}
          </>
        )}
      </article>
    );
  }

  const copyManual = () => plan && void copyWithToast(app, plan.manual.join("\n"), plan.manual.length > 1 ? "the commands" : "the command");

  return (
    <article className={`ob-tool${failed ? " is-failed" : ""}`} aria-busy={running || undefined}>
      {head}
      <p className="ob-tool-what">{WHAT[tool]}</p>
      {req?.problem && outdated && !failed && !running && <p className="ob-check-problem">{req.problem}</p>}
      {job && (running || failed) ? (
        <JobCard job={job} lines={8} headingLevel={3} />
      ) : (
        plan && (
          <>
            {plan.alternatives && plan.alternatives.length > 0 && (
              <fieldset className="ob-choice" aria-describedby={`${groupId}-hint`}>
                <legend className="sr-only">How to install {name}</legend>
                <label className="ob-choice-item">
                  <input type="radio" name={groupId} value={plan.method} checked={method === plan.method} onChange={() => setMethod(plan.method)} />
                  <span>
                    <span className="ob-choice-title">For Portplane only (recommended)</span>
                    <span className="ob-choice-desc">Only portless uses it; nothing else on your computer changes.</span>
                  </span>
                </label>
                {plan.alternatives.map((a) => (
                  <label key={a.method} className="ob-choice-item">
                    <input type="radio" name={groupId} value={a.method} checked={method === a.method} onChange={() => setMethod(a.method)} />
                    <span>
                      <span className="ob-choice-title">{a.label}</span>
                      <span className="ob-choice-desc">
                        Runs <code>{a.commands.join(" && ")}</code>: Node.js 24 becomes your default everywhere.
                      </span>
                    </span>
                  </label>
                ))}
                <p id={`${groupId}-hint`} className="sr-only">
                  Choose how to install Node.js 24
                </p>
              </fieldset>
            )}
            {method === plan.method && (
              <details className="ob-more">
                <summary>Where it comes from</summary>
                <div className="ob-more-body">
                  <PlanDetails plan={plan} />
                </div>
              </details>
            )}
          </>
        )
      )}
      {install.startError && (
        <p className="field-error" role="alert">
          {install.startError}
        </p>
      )}
      {!running && (
        <div className="ob-tool-actions">
          {blocked ? (
            <span className="ob-blocked muted">{blocked}</span>
          ) : (
            <button type="button" className={main ? "btn btn-primary" : "btn"} onClick={() => void install.start(method || undefined)} disabled={install.starting || !req} aria-busy={install.starting || undefined}>
              {install.starting ? <Spinner size={12} /> : <Icon name={failed ? "restart" : "box"} size={14} />}
              {failed ? "Retry" : outdated && tool !== "node" ? `Update ${name}` : `Install ${name}`}
            </button>
          )}
          {plan && plan.manual.length > 0 && (
            <button type="button" className="btn btn-ghost" onClick={copyManual}>
              <Icon name="copy" size={14} />
              Copy the command to do it by hand
            </button>
          )}
        </div>
      )}
    </article>
  );
}

/** The ~/.local/bin line for the terminal, only after the user agrees. */
function PathCard() {
  const { api, toast } = useApp();
  const { checks, choices, choose } = useOnboarding();
  const req = checks.items.path;
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!req || !req.path) return null;
  const st = req.path;
  const windows = st.shell === "windows";
  if (statusOf(req) === "ok") {
    return (
      <article className="ob-tool is-ok">
        <header className="ob-tool-head">
          <Mark tone="ok" label="Done" />
          <h2 className="ob-tool-name">Your terminal finds the tools</h2>
          <span className="ob-tool-state mono">{st.dir}</span>
        </header>
      </article>
    );
  }
  if (choices.path === "skip") {
    return (
      <p className="muted ob-note">
        Your terminal won't find dekit and portless by name; Portplane doesn't need it.{" "}
        <button type="button" className="link-btn" onClick={() => choose("path", "")}>
          Show the line again
        </button>
      </p>
    );
  }
  const add = async () => {
    setAdding(true);
    setError(null);
    try {
      await api.addPathToProfile();
      await checks.run(["path"]);
      toast.info(windows ? "Added to your user Path. New terminals find the tools." : `Added to ${st.file}. New terminals find the tools.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setAdding(false);
    }
  };
  return (
    <article className="ob-tool">
      <header className="ob-tool-head">
        <Mark tone="info" label="Optional" />
        <h2 className="ob-tool-name">Let your terminal find dekit and portless</h2>
        <span className="tag">Optional</span>
      </header>
      <p className="ob-tool-what">
        {st.dir} isn't on your terminal's PATH. Portplane works without it; this is only so <code>dekit</code> and <code>portless</code> work in a
        terminal too.
      </p>
      <p className="ob-tool-what">{windows ? "Portplane would add this folder to your user Path:" : <>Portplane would add these two lines to <span className="mono">{st.file}</span>:</>}</p>
      <pre className="ob-line mono">{windows ? st.line : `# Added by Portplane: dekit and portless live here.\n${st.line}`}</pre>
      {error && (
        <p className="field-error" role="alert">
          Couldn't change it: {error}
        </p>
      )}
      <div className="ob-tool-actions">
        <button type="button" className="btn" onClick={() => void add()} disabled={adding} aria-busy={adding || undefined}>
          {adding ? <Spinner size={12} /> : <Icon name="plus" size={14} />}
          {windows ? "Add it to my Path" : `Add the line to ${st.file?.split(/[\\/]/).pop()}`}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => choose("path", "skip")}>
          Not now
        </button>
      </div>
    </article>
  );
}

/** Step 3: a card per tool that says what will happen, then live progress. */
export function InstallStep() {
  const { checks } = useOnboarding();
  const nodeOK = !!checks.items.node && statusOf(checks.items.node) === "ok";
  const dekit = useInstall("dekit", null);
  const node = useInstall("node", null);
  const portless = useInstall("portless", nodeOK ? null : "Needs Node.js 24 first.");
  const all = [dekit, node, portless];
  const [queue, setQueue] = useState(false);

  // "Install everything": dekit and Node at once, portless once Node is in.
  useEffect(() => {
    if (!queue) return;
    for (const i of all) {
      if (!i.ok && !i.running && !i.failed && !i.blocked && !i.starting && i.req && !i.job) void i.start();
    }
    if (all.every((i) => i.ok || i.failed)) setQueue(false);
  });

  const missing = all.filter((i) => i.req && !i.ok);
  const busy = all.some((i) => i.running || i.starting);
  const ready = all.every((i) => i.ok);
  const status = busy ? "Installing… you can keep this window open." : ready ? "All three are installed." : missing.length ? `${missing.length === 1 ? "One tool" : `${missing.length} tools`} to install.` : "";

  return (
    <StepLayout
      title="Install tools"
      lead="Portplane downloads and checks each tool for you, without asking for your password."
      busy={busy}
      footer={
        <StepFooter status={status}>
          {missing.length > 1 && !busy && (
            <button type="button" className="btn btn-primary" onClick={() => setQueue(true)}>
              <Icon name="box" size={14} />
              Install all {missing.length}
            </button>
          )}
          {ready ? <NextButton /> : <NextButton label="Continue anyway" primary={false} disabled={busy} />}
        </StepFooter>
      }
    >
      <div className="ob-tools">
        {all.map((i) => (
          <ToolCard key={i.tool} install={i} main={missing.length === 1} />
        ))}
        <PathCard />
      </div>
    </StepLayout>
  );
}
