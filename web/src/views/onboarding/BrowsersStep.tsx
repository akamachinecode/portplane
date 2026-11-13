import { useCallback, useEffect, useState } from "react";
import { errorText } from "../../api/errors";
import type { BrowserProfile, BrowserReport } from "../../api/tools";
import { useApp } from "../../components/AppContext";
import { Icon, Spinner } from "../../components/Icon";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { useOnboarding } from "./context";
import { browsersNeedAction } from "./helpers";
import { CopyCommand, Mark, NextButton, StepFooter, StepLayout } from "./parts";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; report: BrowserReport };

const NEEDS = new Set(["missing", "outdated", "unknown"]);
function ProfileRow({ browser, browserName, profile, onAdded }: { browser: string; browserName: string; profile: BrowserProfile; onAdded(p: BrowserProfile): void }) {
  const { api, toast } = useApp();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tone = profile.status === "trusted" || profile.status === "system" ? "ok" : profile.status === "no-ca" ? "idle" : NEEDS.has(profile.status) ? "warn" : "info";
  const label = profile.name === "All profiles" ? browserName : `${browserName} (profile ${profile.name})`;
  const add = async () => {
    setAdding(true);
    setError(null);
    try {
      const p = await api.trustBrowser(browser, profile.id);
      onAdded(p);
      toast.info(`${label} trusts the certificate now. Restart it if it was open.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setAdding(false);
    }
  };
  if (tone === "ok") {
    // A profile that trusts it takes one line; what that means is the mark (ADR-0032).
    return (
      <li className="ob-check ob-check-ok is-compact">
        <Mark tone="ok" label={profile.status} />
        <p className="ob-check-name" title={profile.detail}>
          {profile.name === "All profiles" ? "All profiles" : profile.name}
          {profile.default && profile.name !== "All profiles" && <span className="tag">default</span>}
        </p>
      </li>
    );
  }
  return (
    <li className={`ob-check ob-check-${tone}`}>
      <Mark tone={tone === "idle" ? "idle" : tone} label={profile.status} />
      <div className="ob-check-body">
        <p className="ob-check-name">
          {profile.name === "All profiles" ? "All profiles" : profile.name}
          {profile.default && profile.name !== "All profiles" && <span className="tag">default</span>}
        </p>
        {profile.detail && <p className="ob-check-detail">{profile.detail}</p>}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {(profile.status === "missing" || profile.status === "outdated") && profile.canAdd && (
        <button type="button" className="btn btn-sm" onClick={() => void add()} disabled={adding} aria-busy={adding || undefined}>
          {adding ? <Spinner size={12} /> : <Icon name="plus" size={13} />}
          {profile.status === "outdated" ? `Replace the old certificate in ${label}` : `Add Portplane's certificate to ${label}`}
        </button>
      )}
    </li>
  );
}

/** Step 4b: browsers that keep their own certificates get the CA too. */
export function BrowsersStep() {
  const { api, toast } = useApp();
  const { setBrowsersNeeded, choices, choose, go, checks } = useOnboarding();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [opened, setOpened] = useState(false);

  const fetchReport = useCallback(() => {
    setLoad({ status: "loading" });
    api.browserTrust().then(
      (report) => setLoad({ status: "ok", report }),
      (err: unknown) => setLoad({ status: "error", message: errorText(err) }),
    );
  }, [api]);

  useEffect(fetchReport, [fetchReport]);

  // Functional: several profiles can be added at once.
  const replace = (browser: string, p: BrowserProfile) => {
    setLoad((cur) => {
      if (cur.status !== "ok") return cur;
      const report = { ...cur.report, browsers: cur.report.browsers.map((b) => (b.id !== browser ? b : { ...b, profiles: b.profiles.map((x) => (x.id === p.id ? p : x)) })) };
      return { status: "ok", report };
    });
    void checks.run(["ca"]);
  };

  // Whether the flow still needs this step follows the report.
  useEffect(() => {
    if (load.status === "ok") setBrowsersNeeded(browsersNeedAction(load.report));
  }, [load, setBrowsersNeeded]);

  const proxy = checks.items.proxy?.service;
  const url = `https://portplane.localhost${proxy?.port && proxy.port !== 443 ? `:${proxy.port}` : ""}`;
  const verified = choices.browserVerified === "yes";
  const report = load.status === "ok" ? load.report : null;
  const pending = report ? browsersNeedAction(report) : false;

  return (
    <StepLayout
      title="Browser trust"
      lead="Portplane adds the local certificate to each browser that keeps its own list, without a password."
      busy={load.status === "loading"}
      footer={
        <StepFooter status={report ? (pending ? "Some browsers don't trust it yet." : "Your browsers trust the certificate.") : ""}>
          {pending && (
            <button type="button" className="btn" onClick={fetchReport} disabled={load.status === "loading"}>
              <Icon name="restart" size={14} />
              Check the browsers again
            </button>
          )}
          <NextButton label={pending ? "Continue anyway" : "Next"} primary={!pending} />
        </StepFooter>
      }
    >
      {load.status === "loading" && <LoadingState label="Looking for browsers and their certificates…" />}
      {load.status === "error" && <ErrorState title="Couldn't read the browsers" message={load.message} onRetry={fetchReport} />}
      {report && !report.caExists && (
        <EmptyState
          icon="shield"
          title="There's no certificate yet"
          action={
            <button type="button" className="btn btn-primary" onClick={() => go("proxy")}>
              Set up the proxy
            </button>
          }
        >
          portless creates it with the proxy. Set the proxy up first.
        </EmptyState>
      )}
      {report && report.caExists && report.browsers.length === 0 && (
        <EmptyState icon="globe" title="No browsers found">
          Portplane looks for Firefox, Chrome, Chromium, Brave and Edge. Others usually use your system's certificates.
        </EmptyState>
      )}
      {report && report.caExists && report.browsers.length > 0 && (
        <>
          {report.certutilHint && report.browsers.some((b) => b.profiles.some((p) => p.status === "unknown")) && (
            <div className="ob-manual">
              <p>
                To read and change browsers' own certificates, Portplane needs <code>certutil</code> from NSS's tools. Install it, then check again:
              </p>
              <CopyCommand command={report.certutilHint} />
            </div>
          )}
          {report.browsers.map((b) => (
            <section key={`${b.id}-${b.variant ?? ""}`} className="ob-browser" aria-label={b.name}>
              <h2 className="ob-browser-name">
                {b.name}
                <span className="ob-browser-store muted">{b.store === "system" ? "uses your system's certificates" : "keeps its own certificates"}</span>
              </h2>
              <ul className="ob-checks">
                {b.profiles.map((p) => (
                  <ProfileRow key={p.id} browser={b.id} browserName={b.name} profile={p} onAdded={(np) => replace(b.id, np)} />
                ))}
              </ul>
            </section>
          ))}
          <div className="ob-verify">
            <p className="ob-verify-title">Check it in your browser</p>
            <p className="muted">Open Portplane's own address. If the page loads with no certificate warning, your browser trusts it.</p>
            <div className="ob-tool-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setOpened(true);
                  void api.open("local", [url]).catch((err: unknown) => toast.error(errorText(err)));
                }}
              >
                <Icon name="open" size={14} />
                Open {url}
              </button>
              {verified ? (
                <span className="ob-verified">
                  <Icon name="checkCircle" size={15} />
                  It loads without a warning
                </span>
              ) : (
                <button type="button" className={opened ? "btn btn-primary" : "btn btn-ghost"} onClick={() => choose("browserVerified", "yes")}>
                  <Icon name="check" size={14} />
                  It loads without a warning
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </StepLayout>
  );
}
