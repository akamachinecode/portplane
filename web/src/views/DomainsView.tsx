import { useState, type ComponentType, type ReactNode } from "react";
import type { PortlessAction } from "../api/portless";
import type { IconName } from "../components/Icon";
import { MachinePicker, MachineScope, RemoteStatusBanner, useMachineChoice, useMachineScope } from "../components/MachineScope";
import { StateDot } from "../components/StateDot";
import { SubNav } from "../components/SubNav";
import { ViewHeader } from "../components/ViewHeader";
import { hostsSectionVisible, proxyAnswers } from "../lib/portless";
import type { DomainSection } from "../lib/router";
import { DOMAIN_LABELS, domainGroupOf } from "../shell/nav";
import { useShell } from "../shell/ShellContext";
import { CertificatesSection } from "./domains/CertificatesSection";
import "./domains/commands";
import { ConfigSection } from "./domains/ConfigSection";
import { HostsSection } from "./domains/HostsSection";
import { LanSection } from "./domains/LanSection";
import { MaintenanceSection } from "./domains/MaintenanceSection";
import { PlanDialog } from "./domains/PlanDialog";
import "./domains/problems";
import { ProxySection } from "./domains/ProxySection";
import { SharingSection } from "./domains/SharingSection";
import { useIntent, usePortlessDoctor, usePortlessStatus, useRefreshOnJobs, valueOf } from "./domains/store";
import "./DomainsView.css";

/** One component per section, each in domains/, so portless's pages can grow apart. */
const SECTIONS: Record<DomainSection, { icon: IconName; Section: ComponentType }> = {
  proxy: { icon: "shield", Section: ProxySection },
  hosts: { icon: "terminal", Section: HostsSection },
  certificates: { icon: "lock", Section: CertificatesSection },
  sharing: { icon: "share", Section: SharingSection },
  lan: { icon: "wifi", Section: LanSection },
  config: { icon: "file", Section: ConfigSection },
  maintenance: { icon: "info", Section: MaintenanceSection },
};

function ProxyPill() {
  const status = valueOf(usePortlessStatus().state);
  if (!status?.installed) return null;
  const { up, port } = proxyAnswers(status);
  return (
    <span className="pill" title={up ? `The proxy answers on port ${port}` : "The proxy isn't running"}>
      <StateDot state={up ? "on" : "failed"} />
      {up ? `Proxy on :${port}` : "Proxy stopped"}
    </span>
  );
}

/**
 * portless: the proxy, the .localhost routes and what keeps them working
 * (plan §5), on this computer or a machine over SSH (ADR-0026).
 */
export function DomainsView() {
  const { machine, options, choose } = useMachineChoice("domains");
  return (
    <MachineScope machine={machine}>
      <DomainsBody key={machine} picker={<MachinePicker machine={machine} options={options} onChange={choose} />} />
    </MachineScope>
  );
}

function DomainsBody({ picker }: { picker: ReactNode }) {
  const { route } = useShell();
  const scope = useMachineScope();
  const section = route.view === "domains" ? route.section : "proxy";
  const inUrl = route.view === "domains" ? route.machine : undefined;
  const { Section } = SECTIONS[section];
  const status = valueOf(usePortlessStatus().state);
  const doctor = valueOf(usePortlessDoctor().state);
  const [action, setAction] = useState<PortlessAction | null>(null);
  useRefreshOnJobs();
  // A fix from Health or the palette opens its plan here.
  useIntent("action", (i) => setAction(i.action));
  const showHosts = section === "hosts" || hostsSectionVisible(status ?? null, doctor ?? null);
  const group = domainGroupOf(section);
  const sections = group.sections.filter((s) => s !== "hosts" || showHosts);
  const machineName = scope.ms?.machine.name ?? scope.id;
  return (
    <>
      <ViewHeader
        section="portless"
        title={group.label}
        description={group.id === "proxy" ? (scope.remote ? <>On {machineName}; you open its addresses here through Portplane.</> : undefined) : scope.remote ? <>{group.text} On {machineName}; you open its addresses here through Portplane.</> : group.text}
        actions={
          <>
            {picker}
            {/* the Proxy page says it in its State row */}
            {group.id !== "proxy" && <ProxyPill />}
          </>
        }
      />
      <RemoteStatusBanner />
      {sections.length > 1 && (
        <SubNav
          variant="tabs"
          label={`${group.label} sections`}
          items={sections.map((s) => ({ route: { view: "domains", section: s, machine: inUrl }, label: DOMAIN_LABELS[s], icon: SECTIONS[s].icon, current: s === section }))}
        />
      )}
      <div className="with-subnav-main">
        <Section />
      </div>
      {action && <PlanDialog action={action} onClose={() => setAction(null)} />}
    </>
  );
}
