import { useEffect, useId, useState } from "react";
import { errorText } from "../../api/errors";
import { useJob } from "../../api/jobs";
import type { CommandPreview, ProxyOptions, ProxyResult } from "../../api/tools";
import { useApp } from "../../components/AppContext";
import { Banner } from "../../components/Banner";
import { Icon, Spinner } from "../../components/Icon";
import { JobCard } from "../../components/JobCard";
import { useMachineScope, useRemoteCommand } from "../../components/MachineScope";
import { EmptyState } from "../../components/States";
import { useJobEnd, useOnboarding } from "./context";
import { CopyCommand, Mark, NextButton, PrivilegedPreview, StepFooter, StepLayout } from "./parts";
import { proxyOptionsFor, type Advanced, type ProxyMode as Mode } from "./helpers";
import { statusOf } from "./steps";


const NO_ADVANCED: Advanced = { tld: "localhost", wildcard: false, httpOnly: false, cert: "", key: "" };

/** Where no password dialog can open: on this computer, or on a machine over SSH (ADR-0026). */
function useNoDialog(): string {
  const scope = useMachineScope();
  const name = scope.ms?.machine.name ?? scope.id;
  return scope.remote
    ? `Nobody at ${name}'s screen can answer a password dialog. Run this in a terminal here: it opens SSH to ${name}, where sudo asks for your password.`
    : "This computer can't show a password dialog here. Run this in a terminal instead:";
}

/** What a proxy job found, as a short checklist. */
function Results({ result, onOpen }: { result: ProxyResult; onOpen?: () => void }) {
  const rows: Array<[boolean, string, string]> = [
    [result.answers, "The proxy answers", "The proxy didn't answer."],
    [result.caTrusted, "Your system trusts the local certificate", "Your system doesn't trust the local certificate yet."],
    [result.loads, `${result.url} loads`, `${result.url} doesn't load with a trusted certificate yet.`],
  ];
  return (
    <div className="ob-results">
      <ul className="ob-checks">
        {rows.map(([ok, yes, no]) => (
          <li key={yes} className={`ob-check ob-check-${ok ? "ok" : "warn"}`}>
            <Mark tone={ok ? "ok" : "warn"} label={ok ? "Done" : "Not yet"} />
            <div className="ob-check-body">
              <p className="ob-check-name">{ok ? yes : no}</p>
            </div>
          </li>
        ))}
      </ul>
      {result.answers && onOpen && (
        <button type="button" className="btn" onClick={onOpen}>
          <Icon name="open" size={14} />
          Open {result.url}
        </button>
      )}
    </div>
  );
}

/** Trusting the CA in the system, when the 1355 route left it untrusted. */
function TrustSystem() {
  const { api } = useApp();
  const { checks, jobs, trackJob, go } = useOnboarding();
  const scope = useMachineScope();
  const command = useRemoteCommand();
  const noDialog = useNoDialog();
  const job = useJob(jobs.trust);
  const [preview, setPreview] = useState<CommandPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.systemTrustPreview().then(setPreview, (err: unknown) => setError(errorText(err)));
  }, [api]);
  useJobEnd(job, () => void checks.run(["ca"]));
  const start = async () => {
    try {
      trackJob("trust", await api.trustSystem());
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <article className="ob-tool">
      <header className="ob-tool-head">
        <Mark tone="warn" label="Not trusted yet" />
        <h2 className="ob-tool-name">Trust the local certificate</h2>
      </header>
      <p className="ob-tool-what">
        {scope.remote ? (
          <>
            {scope.ms?.machine.name ?? scope.id}'s apps open here with this computer's certificate. Trusting {scope.ms?.machine.name ?? scope.id}'s own matters to programs there that call
            https://….localhost addresses{preview?.needsAdmin ? " (needs your password there)" : ""}.
          </>
        ) : (
          <>
            Browsers warn about https://….localhost until they trust portless's certificate. Trust it in your system{preview?.needsAdmin ? " (asks for your password)" : ""}, or add it to each
            browser on the next step without a password.
          </>
        )}
      </p>
      {preview && !job && <PrivilegedPreview preview={preview} />}
      {job && <JobCard job={job} lines={6} headingLevel={3} />}
      {preview && preview.needsAdmin && preview.admin === "" && (
        <>
          <p className="ob-tool-what">{noDialog}</p>
          <CopyCommand command={command(preview.terminal)} />
        </>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="ob-tool-actions">
        {preview && (preview.admin !== "" || !preview.needsAdmin) && job?.state !== "running" && (
          <button type="button" className="btn" onClick={() => void start()}>
            <Icon name="shield" size={14} />
            {preview.needsAdmin ? "Trust it (asks for your password)" : "Trust it"}
          </button>
        )}
        {preview && preview.needsAdmin && preview.admin === "" && (
          <button type="button" className="btn" onClick={() => void checks.run(["ca"])} disabled={checks.pending.has("ca")}>
            {checks.pending.has("ca") ? <Spinner size={12} /> : <Icon name="restart" size={14} />}I ran it: check again
          </button>
        )}
        {!scope.remote && (
          <button type="button" className="btn btn-ghost" onClick={() => go("browsers")}>
            Add it to my browsers instead
          </button>
        )}
      </div>
    </article>
  );
}

/** Step 4: the proxy, with one password (the service) or none (port 1355). */
export function ProxyStep() {
  const { api, toast } = useApp();
  const scope = useMachineScope();
  const remoteName = scope.remote ? (scope.ms?.machine.name ?? scope.id) : null;
  const command = useRemoteCommand();
  const noDialog = useNoDialog();
  const { checks, jobs, trackJob, choose, choices, go, setBrowsersNeeded } = useOnboarding();
  const proxy = checks.items.proxy;
  const port = checks.items.port;
  const portBusy = !!port && statusOf(port) === "warning";
  const [mode, setMode] = useState<Mode>(choices.proxy === "unprivileged" || portBusy ? "unprivileged" : "service");
  const [adv, setAdv] = useState<Advanced>(NO_ADVANCED);
  const [preview, setPreview] = useState<CommandPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [redo, setRedo] = useState(false);
  const job = useJob(jobs.proxy);
  const groupId = useId();
  const options = proxyOptionsFor(mode, adv);
  const optionsKey = JSON.stringify(options);
  const portlessReady = !!checks.items.portless && statusOf(checks.items.portless) === "ok";

  // The exact command, again whenever the options change.
  useEffect(() => {
    if (mode !== "service" || !portlessReady) return;
    let live = true;
    const t = setTimeout(() => {
      api.proxyServicePreview(JSON.parse(optionsKey) as ProxyOptions).then(
        (p) => {
          if (!live) return;
          setPreview(p);
          setPreviewError(null);
        },
        (err: unknown) => live && setPreviewError(errorText(err)),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [api, mode, optionsKey, portlessReady]);

  useJobEnd(job, (j) => {
    void checks.run(["proxy", "ca", "port"]);
    setBrowsersNeeded(null);
    if (j.state === "succeeded") {
      choose("proxy", j.kind === "proxy-start" ? "unprivileged" : "service");
      toast.info("The proxy is running");
    }
  });

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      trackJob("proxy", mode === "service" ? await api.installProxyService(options) : await api.startProxy(options));
      setRedo(false);
    } catch (err) {
      setStartError(errorText(err));
    } finally {
      setStarting(false);
    }
  };

  const result = job?.state === "succeeded" ? (job.result as ProxyResult | undefined) : undefined;
  const running = job?.state === "running";
  const failed = job?.state === "failed" || job?.state === "cancelled";
  const proxyOK = !!proxy && statusOf(proxy) === "ok";
  const ca = checks.items.ca;
  const caUntrusted = !!ca && ca.fix === "trust-system";
  const open = (url: string) => void api.open(scope.id, [url]).catch((err: unknown) => toast.error(errorText(err)));

  if (!portlessReady) {
    return (
      <StepLayout icon="shield" title="HTTPS and the proxy" footer={<StepFooter><NextButton label="Skip this step" primary={false} /></StepFooter>}>
        <EmptyState
          icon="box"
          title="portless isn't installed yet"
          action={
            <button type="button" className="btn btn-primary" onClick={() => go("install")}>
              Install it first
            </button>
          }
        >
          The proxy is part of portless. Install it on the previous step, then come back here.
        </EmptyState>
      </StepLayout>
    );
  }

  const showForm = (!proxyOK || redo) && !running && !result;

  return (
    <StepLayout
      icon="shield"
      title="HTTPS and the proxy"
      lead={
        remoteName
          ? `Apps on ${remoteName} get addresses like https://shop.localhost from the portless proxy there; you open them here through Portplane, at https://shop.${scope.id}.localhost. Installing the proxy as a service on ${remoteName} needs your password there once: Portplane shows the command to run over SSH.`
          : "Your apps get addresses like https://shop.localhost from the portless proxy, which listens on port 443 with a certificate your computer creates and trusts. Installing it as a service needs your password once, so it can use port 443 and start with your computer."
      }
      busy={running}
      footer={
        <StepFooter status={running ? "Working…" : proxyOK ? "The proxy is running." : ""}>
          {proxyOK && !running ? <NextButton /> : <NextButton label="Skip for now" primary={false} disabled={running} />}
        </StepFooter>
      }
    >
      {proxyOK && !job && !redo && (
        <div className="ob-done-panel">
          <Mark tone="ok" label="Ready" />
          <div>
            <p className="ob-done-title">The proxy is already running.</p>
            {proxy?.detail && <p className="muted">{proxy.detail}</p>}
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRedo(true)}>
            Set it up again
          </button>
        </div>
      )}

      {job && (running || failed || result) && <JobCard job={job} lines={8} headingLevel={2} />}
      {failed && job?.kind === "proxy-service" && preview && (
        <div className="ob-manual">
          <p className="muted">You can also do it by hand in a terminal, then check again:</p>
          <CopyCommand command={command(preview.terminal)} />
        </div>
      )}

      {showForm && (
        <>
          {portBusy && port?.problem && (
            <Banner tone="warn" title="Port 443 is taken">
              {port.problem}
            </Banner>
          )}
          <fieldset className="ob-choice ob-choice-big">
            <legend className="sr-only">How to run the proxy</legend>
            <label className={`ob-choice-item${mode === "service" ? " is-on" : ""}`}>
              <input type="radio" name={groupId} checked={mode === "service"} onChange={() => setMode("service")} />
              <span>
                <span className="ob-choice-title">
                  Install the proxy <span className="tag">Recommended</span>
                </span>
                <span className="ob-choice-desc">Asks for your password once. Addresses have no port number, and the proxy starts with your computer.</span>
              </span>
            </label>
            <label className={`ob-choice-item${mode === "unprivileged" ? " is-on" : ""}`}>
              <input type="radio" name={groupId} checked={mode === "unprivileged"} onChange={() => setMode("unprivileged")} />
              <span>
                <span className="ob-choice-title">Without a password (port 1355)</span>
                <span className="ob-choice-desc">
                  Runs as you on port 1355, so addresses carry it: <span className="mono">https://shop.localhost:1355</span>. It doesn't start with your
                  computer; Portplane starts it when it opens.
                </span>
              </span>
            </label>
          </fieldset>

          <details className="ob-advanced">
            <summary>Advanced options</summary>
            <div className="ob-advanced-grid">
              <label className="field">
                <span className="field-label">Top-level domain</span>
                <input className="input mono" value={adv.tld} onChange={(e) => setAdv({ ...adv, tld: e.target.value })} spellCheck={false} autoCapitalize="off" />
                <span className="field-hint">localhost needs nothing else. Others (test, dev) need entries in /etc/hosts, which portless keeps.</span>
              </label>
              <label className="ob-check-option">
                <input type="checkbox" checked={adv.wildcard} onChange={(e) => setAdv({ ...adv, wildcard: e.target.checked })} />
                Wildcard: any subdomain of an app's name reaches that app
              </label>
              <label className="ob-check-option">
                <input type="checkbox" checked={adv.httpOnly} onChange={(e) => setAdv({ ...adv, httpOnly: e.target.checked })} />
                HTTP only, no certificate (http:// addresses)
              </label>
              {!adv.httpOnly && (
                <>
                  <label className="field">
                    <span className="field-label">Your own certificate (optional)</span>
                    <input className="input mono" value={adv.cert} placeholder="/path/to/cert.pem" onChange={(e) => setAdv({ ...adv, cert: e.target.value })} spellCheck={false} />
                  </label>
                  <label className="field">
                    <span className="field-label">Its private key</span>
                    <input className="input mono" value={adv.key} placeholder="/path/to/key.pem" onChange={(e) => setAdv({ ...adv, key: e.target.value })} spellCheck={false} />
                  </label>
                </>
              )}
            </div>
          </details>

          {mode === "service" && (
            <div className="ob-proxy-command">
              {preview && <PrivilegedPreview preview={preview} />}
              {previewError && (
                <p className="field-error" role="alert">
                  {previewError}
                </p>
              )}
              {preview && preview.admin === "" && (
                <Banner tone="info" title={remoteName ? `Run this on ${remoteName} over SSH` : "This computer can't show a password dialog here"}>
                  {remoteName ? `${noDialog} Then check again, or use the option without a password above.` : "Run this in a terminal, then check again. Or use the option without a password above."}
                  <CopyCommand command={command(preview.terminal)} />
                </Banner>
              )}
            </div>
          )}

          {startError && (
            <p className="field-error" role="alert">
              {startError}
            </p>
          )}
          <div className="ob-tool-actions">
            {mode === "service" && preview?.admin === "" ? (
              <button type="button" className="btn btn-primary" onClick={() => void checks.run(["proxy", "ca", "port"])} disabled={checks.pending.has("proxy")}>
                {checks.pending.has("proxy") ? <Spinner size={12} /> : <Icon name="restart" size={14} />}I ran it: check again
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => void start()} disabled={starting || (mode === "service" && (!preview || !!previewError))} aria-busy={starting || undefined}>
                {starting ? <Spinner size={12} /> : <Icon name={failed ? "restart" : mode === "service" ? "shield" : "play"} size={14} />}
                {mode === "service"
                  ? failed
                    ? "Try again (asks for your password)"
                    : "Install the proxy (asks for your password)"
                  : failed
                    ? "Try again on port 1355"
                    : "Start the proxy on port 1355"}
              </button>
            )}
          </div>
        </>
      )}

      {result && <Results result={result} onOpen={scope.remote ? undefined : () => open(result.url)} />}
      {(result || proxyOK) && caUntrusted && <TrustSystem />}
    </StepLayout>
  );
}
