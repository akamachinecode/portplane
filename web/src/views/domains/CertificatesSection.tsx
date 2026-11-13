import { useEffect, useState } from "react";
import { errorText } from "../../api/errors";
import type { Certificates } from "../../api/portless";
import { copyWithToast } from "../../components/appActions";
import { useApp } from "../../components/AppContext";
import { Banner } from "../../components/Banner";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { useMachineScope } from "../../components/MachineScope";
import { Menu, type MenuItem } from "../../components/Menu";
import { ErrorState, LoadingState } from "../../components/States";
import { StateDot } from "../../components/StateDot";
import { expiry } from "../../lib/portless";
import { href } from "../../lib/router";
import { SettingRow } from "../settings/SettingsGroup";
import { Fact, Fold, Group, ShortPath, StatusLine } from "./Fold";
import { StatusGate, usePlan } from "./ProxySection";
import { useRefreshOnJobs } from "./store";

const date = (iso: string | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "unknown");

function CA({ certs, reload }: { certs: Certificates; reload(): void }) {
  const ctx = useApp();
  const { show, dialog } = usePlan();
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const ca = certs.ca;
  // A remote machine's apps open here with this computer's certificate
  // (ADR-0016): its own matters to programs on that machine only.
  const scope = useMachineScope();
  const remote = scope.remote ? (scope.ms?.machine.name ?? scope.id) : null;
  const now = Date.now();
  const exp = expiry(ca.notAfter, now);

  const exportCA = async () => {
    if (exporting) return;
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

  const items: MenuItem[] = [];
  if (ca.exists && ca.trusted) items.push({ label: "Trust it again", icon: "shield", onSelect: () => show("trust") });
  if (ca.exists) items.push({ label: "Export ca.pem", icon: "download", onSelect: () => void exportCA() });
  if (ca.exists) items.push({ label: "Regenerate…", icon: "restart", onSelect: () => show("ca-regenerate") });
  const trustButton = (!ca.exists || !ca.trusted) && (
    <button type="button" className="btn btn-primary" onClick={() => show("trust")}>
      {certs.trustNeedsAdmin && <Icon name="shield" size={13} />}
      Trust the certificate
    </button>
  );

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
      <Group
        title="Local certificate authority"
        description={remote ? `It signs the addresses on ${remote}. Its apps open here with this computer's certificate; ${remote}'s own matters to programs there.` : undefined}
      >
        {!ca.exists ? (
          <StatusLine state="off" sub="Trusting it creates it, as does starting the proxy with HTTPS." actions={trustButton}>
            Not created yet
          </StatusLine>
        ) : (
          <>
            <StatusLine
              state={ca.trusted ? "on" : "failed"}
              actions={
                <>
                  {trustButton}
                  <Menu label="More certificate actions" items={items} />
                </>
              }
            >
              {ca.trusted ? (remote ? `Trusted on ${remote}` : "Trusted by this computer") : remote ? `Not trusted: programs on ${remote} refuse its addresses` : "Not trusted: browsers warn on every .localhost address"}
            </StatusLine>
            {!remote && (
              <SettingRow label="Browsers with their own list">
                {certs.browsers ? (
                  <ul className="browser-list">
                    {certs.browsers.map((b) => (
                      <li key={`${b.browser}-${b.profile ?? ""}`} className="inline-state">
                        <StateDot state={b.trusted ? "on" : "failed"} />
                        {b.browser}
                        {b.profile && <span className="muted"> · {b.profile}</span>}
                        <span className="muted">: {b.trusted ? "trusted" : "not trusted"}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="muted">
                    Not checked · <a href={href({ view: "onboarding", step: "browsers" })}>Check them in Setup</a>
                  </span>
                )}
              </SettingRow>
            )}
            {(exp === "expired" || exp === "soon") && (
              <SettingRow label="Expires">
                <span className="warn-text">
                  {date(ca.notAfter)}
                  {exp === "expired" ? " · expired: regenerate it" : " · soon"}
                </span>
              </SettingRow>
            )}
            {exported && (
              <p className="sgroup-text">
                Saved to <span className="mono">{exported}</span>. To install it on a phone, see{" "}
                <a href={href({ view: "domains", section: "lan" })}>Local network</a>.
              </p>
            )}
            <Fold summary="Details">
              <dl className="dfacts">
                <Fact label="Fingerprint (SHA-256)">
                  <span className="fingerprint">
                    <code className="mono">{ca.fingerprint}</code>
                    {ca.fingerprint && <IconButton icon="copy" label="Copy the fingerprint" onClick={() => void copyWithToast(ctx, ca.fingerprint!, "the fingerprint")} />}
                  </span>
                </Fact>
                <Fact label="Expires">{date(ca.notAfter)}</Fact>
                <Fact label="File">
                  <ShortPath path={ca.path} />
                </Fact>
              </dl>
            </Fold>
          </>
        )}
      </Group>
      {dialog}
      <HostCerts certs={certs} reload={reload} />
    </>
  );
}

function HostCerts({ certs }: { certs: Certificates; reload(): void }) {
  const now = Date.now();
  const trouble = certs.hostCerts.some((c) => !c.signedByCa || ["expired", "soon"].includes(expiry(c.notAfter, now)));
  return (
    <Fold className="dfold-section" summary={`Address certificates (${certs.hostCerts.length})`} hint="portless renews them on its own" open={trouble || undefined}>
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
    </Fold>
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
