import { useEffect, useState } from "react";
import { errorText } from "../../api/errors";
import type { HostsView } from "../../api/portless";
import { useApp } from "../../components/AppContext";
import { Icon } from "../../components/Icon";
import { ErrorState, LoadingState } from "../../components/States";
import { StateDot } from "../../components/StateDot";
import { SettingRow, SettingsGroup } from "../settings/SettingsGroup";
import { StatusGate, usePlan } from "./ProxySection";
import { useRefreshOnJobs } from "./store";

function Hosts({ hosts }: { hosts: HostsView }) {
  const { show, dialog } = usePlan();
  const names = hosts.entries.flatMap((e) => e.names.map((n) => ({ address: e.address, name: n })));
  return (
    <>
      <SettingsGroup
        title="The hosts file"
        description={
          hosts.needed ? (
            <>
              Your proxy serves {hosts.tlds.filter((t) => t !== "localhost").map((t) => `.${t}`).join(", ")}, which the system only finds through portless's block in <span className="mono">{hosts.path}</span>. Changing the file asks for your password.
            </>
          ) : (
            <>
              Names under .localhost need no hosts file: every system sends them to this computer. portless still keeps a block in <span className="mono">{hosts.path}</span> for browsers, such as Safari, that ask the system instead.
            </>
          )
        }
      >
        {!hosts.readable ? (
          <p className="warn-text">Portplane can't read {hosts.path}.</p>
        ) : (
          <>
            <SettingRow label="portless's block">
              <span className="inline-state">
                <StateDot state={hosts.inSync ? "on" : hosts.block ? "starting" : "off"} />
                {hosts.inSync ? (hosts.block ? "In sync with your routes" : "Not needed: nothing to write") : hosts.block ? "Out of date" : "Missing"}
              </span>
            </SettingRow>
            {hosts.missing.length > 0 && (
              <SettingRow label="Missing" description="Routes the block doesn't list yet.">
                <span className="chips">
                  {hosts.missing.map((n) => (
                    <span key={n} className="chip mono">
                      {n}
                    </span>
                  ))}
                </span>
              </SettingRow>
            )}
            {hosts.extra.length > 0 && (
              <SettingRow label="Left over" description="Names in the block that no route has any more.">
                <span className="chips">
                  {hosts.extra.map((n) => (
                    <span key={n} className="chip mono">
                      {n}
                    </span>
                  ))}
                </span>
              </SettingRow>
            )}
            {names.length > 0 && (
              <details className="hosts-block">
                <summary>The block as it is now ({names.length})</summary>
                <pre className="mono">{["# portless-start", ...names.map((n) => `${n.address} ${n.name}`), "# portless-end"].join("\n")}</pre>
              </details>
            )}
          </>
        )}
        <div className="sgroup-foot">
          {hosts.block && (
            <button type="button" className="btn btn-ghost" onClick={() => show("hosts-clean")}>
              <Icon name="trash" size={13} />
              Clean
            </button>
          )}
          <button type="button" className={`btn${hosts.inSync ? "" : " btn-primary"}`} onClick={() => show("hosts-sync")}>
            <Icon name="shield" size={13} />
            Sync
          </button>
        </div>
      </SettingsGroup>
      {dialog}
    </>
  );
}

/** portless's block in the hosts file (plan §5.7). */
export function HostsSection() {
  const { api } = useApp();
  const [hosts, setHosts] = useState<HostsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    api.portlessHosts().then(setHosts, (err: unknown) => setError(errorText(err)));
  };
  useEffect(load, [api]);
  useRefreshOnJobs(load);
  return (
    <StatusGate>
      {() => (hosts ? <Hosts hosts={hosts} /> : error ? <ErrorState title="Couldn't read the hosts file" message={error} onRetry={load} /> : <LoadingState label="Reading the hosts file…" />)}
    </StatusGate>
  );
}
