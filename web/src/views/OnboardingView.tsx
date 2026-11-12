import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import type { Job } from "../api/jobs";
import { useApp } from "../components/AppContext";
import { Icon, Spinner } from "../components/Icon";
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
import { flowOf, nextStep, parseStep, progressOf, reached, resumeStep, STEPS, stepIndex, type StepId } from "./onboarding/steps";
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
 * The guided setup (plan §3), full window: from a computer without dekit,
 * portless or Node.js to the first app at https://<name>.localhost. The
 * step is in the URL (#/onboarding/<step>) and the progress in the
 * preferences, so it resumes where it was left.
 */
export function OnboardingView() {
  const { api, toast } = useApp();
  const { route, preferences, updatePreferences } = useShell();
  const prefs = preferences.status === "ok" ? preferences.value : null;
  const routeStep = route.view === "onboarding" ? route.step : undefined;
  const step = parseStep(routeStep);
  const checks = useChecks(api);
  const [browsersNeeded, setBrowsersNeeded] = useState<boolean | null>(null);
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
    if (resumed.current || !prefs) return;
    resumed.current = true;
    setChoices(prefs.onboarding.choices ?? {});
    if (!routeStep) navigate({ view: "onboarding", step: resumeStep(prefs.onboarding) }, { replace: true });
  }, [prefs, routeStep]);

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

  const flow = useMemo(() => flowOf(checks.items, browsersNeeded), [checks.items, browsersNeeded]);

  const go = useCallback(
    (to: StepId) => {
      navigate({ view: "onboarding", step: to });
      void updatePreferences((p) => ({ ...p, onboarding: reached(p.onboarding, to) }));
    },
    [updatePreferences],
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
      back: () => go(STEPS[Math.max(0, stepIndex(step) - 1)].id),
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
    [step, go, flow, checks, choices, choose, folders, edits, setEdits, scans, roots, jobs, trackJob],
  );

  const skip = async () => {
    setLeaving(true);
    const ok = await updatePreferences((p) => ({ ...p, onboarding: { ...p.onboarding, skipped: true, step } }));
    setLeaving(false);
    if (ok) {
      toast.info("You can finish setting up any time from the notice on top, or from Settings.");
      navigate({ view: "apps" });
    }
  };

  const View = STEP_VIEWS[step];
  const index = stepIndex(step);
  const done = new Set(prefs?.onboarding.done ?? []);
  const scanning = step === "apps" || step === "review";

  return (
    <OnboardingContext value={ctx}>
      <main className="onboarding" id="main">
        <header className="ob-top">
          <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={24} height={24} className="ob-top-mark" />
          <span className="ob-top-name">Set up Portplane</span>
          <span className="ob-top-step">
            Step {index + 1} of {STEPS.length}
            <span className="ob-top-step-label"> · {STEPS[index].label}</span>
          </span>
          {step !== "done" && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void skip()} disabled={leaving} aria-busy={leaving || undefined}>
              {leaving && <Spinner size={12} />}
              Skip for now
            </button>
          )}
        </header>
        <div
          className="ob-progress"
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={0}
          aria-valuemax={STEPS.length}
          aria-valuenow={index + 1}
          aria-valuetext={`Step ${index + 1} of ${STEPS.length}: ${STEPS[index].label}`}
        >
          <span className="ob-progress-bar" style={{ width: `${Math.max(4, progressOf(step) * 100)}%` }} />
        </div>
        <div className="ob-body">
          <nav className="ob-rail" aria-label="Setup steps">
            <ol>
              {STEPS.map((s, i) => {
                const current = s.id === step;
                const reachable = i <= index || done.has(s.id);
                const finished = done.has(s.id) && !current;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={`ob-rail-item${current ? " is-current" : ""}${finished ? " is-done" : ""}`}
                      aria-current={current ? "step" : undefined}
                      disabled={!reachable}
                      onClick={() => go(s.id)}
                    >
                      <span className="ob-rail-dot" aria-hidden="true">
                        {finished ? <Icon name="check" size={11} /> : i + 1}
                      </span>
                      <span className="ob-rail-label">{s.label}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
          <View key={step} />
        </div>
        {scanning && ctx.folders.map((f) => <ScanDriver key={f} folder={f} edits={edits[f] ?? NO_EDITS} onState={onScan} />)}
      </main>
    </OnboardingContext>
  );
}
