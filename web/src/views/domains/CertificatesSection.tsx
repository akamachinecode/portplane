import { useEffect, useState } from "react";
import { errorText } from "../../api/errors";
import type { Certificates } from "../../api/portless";
import { copyWithToast } from "../../components/appActions";
import { useApp } from "../../components/AppContext";
import { Banner } from "../../components/Banner";
import { Icon, Spinner } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { ErrorState, LoadingState } from "../../components/States";
import { StateDot } from "../../components/StateDot";
import { expiry } from "../../lib/portless";
import { SettingRow, SettingsGroup } from "../settings/SettingsGroup";
import { StatusGate, usePlan } from "./ProxySection";
import { useRefreshOnJobs } from "./store";

const date = (iso: string | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "unknown");

function CA({ certs, reload }: { certs: Certificates; reload(): void }) {
  const ctx = useApp();
  const { show, dialog } = usePlan();
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const ca = certs.ca;
  const now = Date.now();
  const exp = expiry(ca.notAfter, now);

  const exportCA = async () => {
    setExporting(true);
    try {
      const res = await ctx.api.portlessExportCA();
      setExported(res.path);
      ctx.toast.info(res.revealed ? `Saved ${res.path} and opened its folder` : `Saved ${res.path}`);
    } catch (err) {
      ctx.toast.error(errorText(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      {ca.systemCopyNotRoot && (
        <Banner
          tone="warn"
          title="The trusted copy of the certificate belongs to your user"
          action={
            <button type="button" className="btn btn-sm" onClick={() => show("ca-fix-ownership")}>
              <Icon name="shield" size={13} />
              Fix ownership
            </button>
          }
        >
          <span className="mono">{ca.systemCopy}</span> should belong to the administrator. While it's yours, any program you run could replace it with another certificate that your system would then trust.
        </Banner>
      )}
      <SettingsGroup title="Local certificate authority" description="portless signs a certificate for every address with its own authority. Your system and browsers need to trust it once for the padlock to show.">
        {!ca.exists ? (
          <p className="muted">portless hasn't created it yet. Trusting it creates it, or starting the proxy with HTTPS.</p>
        ) : (
          <>
            <SettingRow label="Trusted by the system">
              <span className="inline-state">
                <StateDot state={ca.trusted ? "on" : "failed"} />
                {ca.trusted ? "Yes" : "No: browsers warn on every .localhost address"}
              </span>
            </SettingRow>
            <SettingRow label="Browsers" description="Firefox and some Linux browsers keep their own list of trusted certificates.">
              {certs.browsers ? (
                <ul className="browser-list">
                  {certs.browsers.map((b) => (
                    <li key={`${b.browser}-${b.profile ?? ""}`} className="inline-state">
                      <StateDot state={b.trusted ? "on" : "failed"} />
                      {b.browser}
                      {b.profile && <span className="muted"> · {b.profile}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="muted">Not checked here yet: the welcome screen's browser step checks them</span>
              )}
            </SettingRow>
            <SettingRow label="Fingerprint (SHA-256)">
              <span className="fingerprint">
                <code className="mono">{ca.fingerprint}</code>
                {ca.fingerprint && <IconButton icon="copy" label="Copy the fingerprint" onClick={() => void copyWithToast(ctx, ca.fingerprint!, "the fingerprint")} />}
              </span>
            </SettingRow>
            <SettingRow label="Expires">
              <span className={exp === "expired" || exp === "soon" ? "warn-text" : undefined}>
                {date(ca.notAfter)}
                {exp === "expired" && " · expired: regenerate it"}
                {exp === "soon" && " · soon"}
              </span>
            </SettingRow>
            <SettingRow label="File">
              <span className="mono path-value">{ca.path}</span>
            </SettingRow>
          </>
        )}
        <div className="sgroup-foot">
          {ca.exists && (
            <button type="button" className="btn btn-ghost" onClick={() => show("ca-regenerate")}>
              <Icon name="restart" size={13} />
              Regenerate…
            </button>
          )}
          {ca.exists && (
            <button type="button" className="btn" onClick={() => void exportCA()} disabled={exporting} aria-busy={exporting || undefined}>
              {exporting ? <Spinner /> : <Icon name="file" size={13} />}
              Export ca.pem
            </button>
          )}
          <button type="button" className={`btn${ca.trusted ? "" : " btn-primary"}`} onClick={() => show("trust")}>
            {certs.trustNeedsAdmin && <Icon name="shield" size={13} />}
            {ca.trusted ? "Trust again" : "Trust the certificate"}
          </button>
        </div>
        {exported && (
          <div className="ca-devices">
            <p>
              Saved to <span className="mono">{exported}</span>. To open your apps from a phone on the same network (LAN mode), install it there:
            </p>
            <ul>
              <li>
                <strong>iPhone, iPad:</strong> AirDrop or mail the file, open it, install the profile in Settings → Profile Downloaded, then turn it on in Settings → General → About → Certificate Trust Settings.
              </li>
              <li>
                <strong>Android:</strong> copy the file over, then Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate.
              </li>
            </ul>
          </div>
        )}
      </SettingsGroup>
      {dialog}
      <HostCerts certs={certs} reload={reload} />
    </>
  );
}

function HostCerts({ certs }: { certs: Certificates; reload(): void }) {
  const now = Date.now();
  return (
    <SettingsGroup title="Address certificates" description="The certificates portless signed for each address, in host-certs/. portless renews them on its own.">
      {certs.hostCerts.length === 0 ? (
        <p className="muted">None yet: portless signs one the first time an address is opened.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Names</th>
                <th scope="col">Expires</th>
                <th scope="col">Signed by</th>
              </tr>
            </thead>
            <tbody>
              {certs.hostCerts.map((c) => {
                const exp = expiry(c.notAfter, now);
                return (
                  <tr key={c.file}>
                    <td className="mono" title={c.file}>
                      {c.names.join(", ")}
                    </td>
                    <td className={exp === "expired" || exp === "soon" ? "warn-text" : undefined}>{date(c.notAfter)}</td>
                    <td className="wrap">{c.signedByCa ? "This authority" : <span className="warn-text">An older authority: browsers may warn until it renews</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SettingsGroup>
  );
}

/** The local CA, who trusts it, and the certificates it signed (plan §5.6). */
export function CertificatesSection() {
  const { api } = useApp();
  const [certs, setCerts] = useState<Certificates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    api.portlessCertificates().then(setCerts, (err: unknown) => setError(errorText(err)));
  };
  useEffect(load, [api]);
  useRefreshOnJobs(load);
  return (
    <StatusGate>
      {() => (certs ? <CA certs={certs} reload={load} /> : error ? <ErrorState title="Couldn't read the certificates" message={error} onRetry={load} /> : <LoadingState label="Reading certificates…" />)}
    </StatusGate>
  );
}
