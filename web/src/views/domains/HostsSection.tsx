import { useEffect, useState } from "react";
import { errorText } from "../../api/errors";
import type { HostsView } from "../../api/portless";
import { useApp } from "../../components/AppContext";
import { Icon } from "../../components/Icon";
import { ErrorState, LoadingState } from "../../components/States";
import { Menu, type MenuItem } from "../../components/Menu";
import { SettingRow } from "../settings/SettingsGroup";
import { Fact, Fold, Group, StatusLine } from "./Fold";
import { StatusGate, usePlan } from "./ProxySection";
import { useRefreshOnJobs } from "./store";

function Hosts({ hosts }: { hosts: HostsView }) {
  const { show, dialog } = usePlan();
  const names = hosts.entries.flatMap((e) => e.names.map((n) => ({ address: e.address, name: n })));
  const extra = hosts.tlds.filter((t) => t !== "localhost").map((t) => `.${t}`);
  const items: MenuItem[] = [];
  if (hosts.inSync) items.push({ label: "Sync again", icon: "shield", onSelect: () => show("hosts-sync") });
  if (hosts.block) items.push({ label: "Remove portless's block", icon: "trash", onSelect: () => show("hosts-clean") });
  return (
    <>
      <Group
        title="The hosts file"
        description={hosts.needed ? `The system finds ${extra.join(", ") || "your addresses"} only through portless's block in this file.` : "Not needed for .localhost. portless keeps a block for browsers, such as Safari, that ask the system."}
      >
        {!hosts.readable ? (
          <p className="warn-text">Portplane can't read {hosts.path}.</p>
        ) : (
          <>
            <StatusLine
              state={hosts.inSync ? "on" : hosts.block ? "starting" : "off"}
              sub={!hosts.inSync && hosts.needed ? "Addresses outside .localhost may not load until it's synced." : undefined}
              actions={
                <>
                  {!hosts.inSync && (
                    <button type="button" className="btn btn-primary" onClick={() => show("hosts-sync")}>
                      <Icon name="shield" size={13} />
                      Sync
                    </button>
                  )}
                  {items.length > 0 && <Menu label="More hosts file actions" items={items} />}
                </>
              }
            >
              {hosts.inSync ? (hosts.block ? "In sync with your routes" : "Nothing to write") : hosts.block ? "Out of date" : "Missing"}
            </StatusLine>
            {hosts.missing.length > 0 && (
              <SettingRow label="Missing" description="Routes the block doesn't list yet.">
                <span className="chips">
                  {hosts.missing.map((n) => (
                    <span key={n} className="dchip mono">
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
                    <span key={n} className="dchip mono">
                      {n}
                    </span>
                  ))}
                </span>
              </SettingRow>
            )}
            <Fold summary="Details">
              <dl className="dfacts">
                <Fact label="File">
                  <span className="mono">{hosts.path}</span>
                </Fact>
              </dl>
              {names.length > 0 && <pre className="hosts-block mono">{["# portless-start", ...names.map((n) => `${n.address} ${n.name}`), "# portless-end"].join("\n")}</pre>}
            </Fold>
          </>
        )}
      </Group>
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
