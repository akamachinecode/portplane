import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import type { Job } from "../api/jobs";
import { LOCAL_MACHINE } from "../api/machine";
import { useApp } from "../components/AppContext";
import { Icon, Spinner } from "../components/Icon";
import { MachineScope, RemoteStatusBanner, useMachineScope } from "../components/MachineScope";
import { useSetupProposal } from "../hooks/useSetupProposal";
import { NO_EDITS, type SetupEdits } from "../lib/setup";
import { navigate } from "../lib/router";
import { useShell } from "../shell/ShellContext";
import { AppsStep } from "./onboarding/AppsStep";
import { BrowsersStep } from "./onboarding/BrowsersStep";
import { CheckStep } from "./onboarding/CheckStep";
import { OnboardingContext, useChecks, type FolderScan, type OnboardingCtx } from "./onboarding/context";
import { DoneStep } from "./onboarding/DoneStep";
import { FoldersStep } from "./onboarding/FoldersStep";
import { InstallStep } from "./onboarding/InstallStep";
import { ProxyStep } from "./onboarding/ProxyStep";
import { ReviewStep } from "./onboarding/ReviewStep";
import { StartStep } from "./onboarding/StartStep";
import { flowOf, nextStep, parseStep, reached, resumeStep, STEPS, stepIndex, type StepId } from "./onboarding/steps";
import { stepRecord, stepStatuses, type TimelineFacts } from "./onboarding/timeline";
import { ViewHeader } from "../components/ViewHeader";
import { inferHome } from "../lib/format";
import { WelcomeStep } from "./onboarding/WelcomeStep";
import "./OnboardingView.css";

const STEP_VIEWS: Record<StepId, ComponentType> = {
  welcome: WelcomeStep,
  check: CheckStep,
  install: InstallStep,
  proxy: ProxyStep,
  browsers: BrowsersStep,
  folders: FoldersStep,
  apps: AppsStep,
  review: ReviewStep,
  start: StartStep,
  done: DoneStep,
};

/** Keeps one folder's scan in step with its edits while the apps and the review are open. */
function ScanDriver({ folder, edits, onState }: { folder: string; edits: SetupEdits; onState(folder: string, s: FolderScan): void }) {
  const { api } = useApp();
  const scan = useSetupProposal(api, folder, edits);
  useEffect(() => {
    onState(folder, scan);
  }, [folder, scan.proposal, scan.scannedKey, scan.scanning, scan.error, onState]);
  return null;
}

/**
 * Setup (plan §3, ADR-0028): a page of the app, with the sidebar, that
 * shows every step from a computer without dekit, portless or Node.js to
 * the first app at https://<name>.localhost as a timeline. Each step says
 * what it found; the open one does its work in place. The step is in the
 * URL (#/onboarding/<step>) and the progress in the preferences, so it
 * resumes where it was left. On a machine over SSH
 * (#/setup/<machine>/<step>, ADR-0026) the same steps act on that machine:
 * its tools, its folders, its apps; its progress is not saved.
 */
export function OnboardingView() {
  const { route } = useShell();
  const machine = (route.view === "onboarding" && route.machine) || LOCAL_MACHINE;
  return (
    <MachineScope machine={machine}>
      <OnboardingFlow key={machine} />
    </MachineScope>
  );
}

// A remote machine's setup is not saved in the preferences (they are this
// computer's): how far it got is kept for this session only.
const remoteFurthest = new Map<string, number>();

/** A step's label in the rail and the header, naming a remote machine. */
function labelOf(step: StepId, remote: string | null): string {
  if (remote && step === "check") return `Check ${remote}`;
  return STEPS[stepIndex(step)].label;
}

function OnboardingFlow() {
  const { api, toast } = useApp();
  const { route, preferences, updatePreferences: savePreferences } = useShell();
  const scope = useMachineScope();
  const remote = scope.remote ? (scope.ms?.machine.name ?? scope.id) : null;
  const machineId = scope.remote ? scope.id : undefined;
  // Progress is this computer's: a remote machine's setup is not saved.
  const updatePreferences = useCallback<typeof savePreferences>((fn) => (scope.remote ? Promise.resolve(true) : savePreferences(fn)), [scope.remote, savePreferences]);
  const prefs = preferences.status === "ok" ? preferences.value : null;
  const routeStep = route.view === "onboarding" ? route.step : undefined;
  const step = parseStep(routeStep);
  const checks = useChecks(api);
  // A remote machine's apps open in this computer's browsers.
  const [browsersNeeded, setBrowsersNeeded] = useState<boolean | null>(scope.remote ? false : null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [folders, setFolders] = useState<string[] | null>(null);
  const [edits, setAllEdits] = useState<Record<string, SetupEdits>>({});
  const [scans, setScans] = useState<Record<string, FolderScan>>({});
  const [roots, setRoots] = useState<string[]>([]);
  const [jobs, setJobs] = useState<Record<string, string>>({});
  const [leaving, setLeaving] = useState(false);

  // Resume where the user left off.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return;
    if (machineId) {
      resumed.current = true;
      if (!routeStep) navigate({ view: "onboarding", machine: machineId, step: "check" }, { replace: true });
      return;
    }
    if (!prefs) return;
    resumed.current = true;
    setChoices(prefs.onboarding.choices ?? {});
    if (!routeStep) navigate({ view: "onboarding", step: resumeStep(prefs.onboarding) }, { replace: true });
  }, [prefs, routeStep, machineId]);

  // The check runs once, in the background, from the start: by the time
  // the user clicks Start, most answers are in.
  useEffect(() => {
    void checks.run();
  }, []);

  // The folders already watched are the starting choice.
  useEffect(() => {
    let live = true;
    api.settings().then(
      (s) => live && setFolders((cur) => cur ?? s.folders),
      () => live && setFolders((cur) => cur ?? []),
    );
    return () => {
      live = false;
    };
  }, [api]);

  const flow = useMemo(() => flowOf(checks.items, scope.remote ? false : browsersNeeded), [checks.items, browsersNeeded, scope.remote]);

  // A remote machine's apps open in this computer's browsers, which this
  // computer's own setup covers: its setup has no Browser trust step.
  const steps = useMemo(() => (scope.remote ? STEPS.filter((s) => s.id !== "browsers") : STEPS), [scope.remote]);
  const index = Math.max(0, steps.findIndex((s) => s.id === step));

  const go = useCallback(
    (to: StepId) => {
      if (machineId) remoteFurthest.set(machineId, Math.max(remoteFurthest.get(machineId) ?? 0, stepIndex(to)));
      navigate({ view: "onboarding", step: to, machine: machineId });
      void updatePreferences((p) => ({ ...p, onboarding: reached(p.onboarding, to) }));
    },
    [updatePreferences, machineId],
  );

  const choose = useCallback(
    (key: string, value: string) => {
      setChoices((c) => ({ ...c, [key]: value }));
      void updatePreferences((p) => ({ ...p, onboarding: { ...p.onboarding, choices: { ...p.onboarding.choices, [key]: value } } }));
    },
    [updatePreferences],
  );

  const setEdits = useCallback((folder: string, change: (e: SetupEdits) => SetupEdits) => {
    setAllEdits((all) => ({ ...all, [folder]: change(all[folder] ?? NO_EDITS) }));
  }, []);
  const onScan = useCallback((folder: string, s: FolderScan) => setScans((all) => ({ ...all, [folder]: s })), []);
  const trackJob = useCallback((key: string, job: Job) => setJobs((j) => ({ ...j, [key]: job.id })), []);

  const ctx = useMemo<OnboardingCtx>(
    () => ({
      step,
      go,
      next: () => go(nextStep(step, flow)),
      back: () => go(steps[Math.max(0, index - 1)].id),
      flow,
      checks,
      setBrowsersNeeded,
      choices,
      choose,
      folders: folders ?? [],
      setFolders,
      edits,
      setEdits,
      scans,
      roots,
      setRoots,
      jobs,
      trackJob,
    }),
    [step, steps, index, go, flow, checks, choices, choose, folders, edits, setEdits, scans, roots, jobs, trackJob],
  );

  const skip = async () => {
    if (scope.remote) {
      navigate({ view: "machines" });
      return;
    }
    setLeaving(true);
    const ok = await updatePreferences((p) => ({ ...p, onboarding: { ...p.onboarding, skipped: true, step } }));
    setLeaving(false);
    if (ok) {
      toast.info("Setup, in the sidebar, picks up where you left off.");
      navigate({ view: "apps" });
    }
  };

  const View = STEP_VIEWS[step];
  const done = new Set<string>(machineId ? STEPS.filter((_, i) => i < (remoteFurthest.get(machineId) ?? 0)).map((s) => s.id) : (prefs?.onboarding.done ?? []));
  const scanning = step === "apps" || step === "review";
  const facts: TimelineFacts = {
    checks: checks.items,
    flow,
    folders: folders ?? [],
    ms: scope.ms,
    done,
    home: inferHome([...(folders ?? []), ...(scope.ms?.folders ?? [])]),
  };
  const statuses = stepStatuses(
    steps.map((s) => s.id),
    step,
    facts,
  );
  // One count of progress (ADR-0032): what is done, whichever step is open.
  const record = stepStatuses(
    steps.map((s) => s.id),
    "welcome",
    facts,
  );
  const doneSteps = steps.filter((s) => s.id !== "welcome" && s.id !== "done" && record[s.id] === "done").length;
  const countable = steps.length - 2;

  return (
    <OnboardingContext value={ctx}>
      <ViewHeader
        title={remote ? `Set up ${remote}` : "Setup"}
        summary={doneSteps === countable ? "All set" : `${doneSteps} of ${countable} done`}
        description={
          remote
            ? `Everything Portplane sets up on ${remote}, step by step, acting on that machine over SSH.`
            : "Everything Portplane checked, installed and set up on this computer, step by step. Each step reads how things are now, so work done in a terminal counts too; open any step to see it or do it again."
        }
        actions={
          <>
            <button type="button" className="btn" onClick={() => void checks.run()} title="Check this computer again">
              <Icon name="restart" size={14} />
              Check again
            </button>
            {remote && (
              <button type="button" className="btn btn-ghost" onClick={() => void skip()} disabled={leaving} aria-busy={leaving || undefined}>
                {leaving && <Spinner size={12} />}
                Back to machines
              </button>
            )}
          </>
        }
      />
      <RemoteStatusBanner className="ob-remote-banner" />
      <ol className="timeline" aria-label="Setup steps">
        {steps.map((s, i) => {
          const status = statuses[s.id];
          const current = s.id === step;
          const reachable = i <= index || status === "done" || done.has(s.id);
          return (
            <li key={s.id} className={`tl-item is-${status}`} aria-current={current ? "step" : undefined}>
              <span className="tl-marker" aria-hidden="true">
                {status === "done" ? <Icon name="check" size={12} /> : current ? <span className="tl-pulse" /> : <span className="tl-num">{i + 1}</span>}
              </span>
              <div className="tl-content">
                <button type="button" className="tl-head" disabled={current || !reachable} onClick={() => go(s.id)} aria-expanded={current}>
                  <span className="tl-title">{labelOf(s.id, remote)}</span>
                  <span className="tl-record">{stepRecord(s.id, facts)}</span>
                  {!current && reachable && (
                    <span className="tl-open">
                      {status === "done" ? "Open" : "Go"}
                      <Icon name="chevronRight" size={13} />
                    </span>
                  )}
                  <span className="sr-only">{status === "done" ? " (done)" : current ? " (open)" : " (to do)"}</span>
                </button>
                {current && (
                  <div className="tl-panel">
                    <View key={step} />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {scanning && ctx.folders.map((f) => <ScanDriver key={f} folder={f} edits={edits[f] ?? NO_EDITS} onState={onScan} />)}
    </OnboardingContext>
  );
}
