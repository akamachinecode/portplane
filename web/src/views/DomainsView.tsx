import { useState, type ComponentType, type ReactNode } from "react";
import type { PortlessAction } from "../api/portless";
import type { IconName } from "../components/Icon";
import { MachinePicker, MachineScope, RemoteStatusBanner, useMachineChoice, useMachineScope } from "../components/MachineScope";
import { StateDot } from "../components/StateDot";
import { SubNav } from "../components/SubNav";
import { ViewHeader } from "../components/ViewHeader";
import { hostsSectionVisible } from "../lib/portless";
import type { DomainSection } from "../lib/router";
import { DOMAIN_LABELS, domainGroupOf } from "../shell/nav";
import { useShell } from "../shell/ShellContext";
import { AliasesSection } from "./domains/AliasesSection";
import { CertificatesSection } from "./domains/CertificatesSection";
import "./domains/commands";
import { ComposeSection } from "./domains/ComposeSection";
import { ConfigSection } from "./domains/ConfigSection";
import { DoctorSection } from "./domains/DoctorSection";
import { HostsSection } from "./domains/HostsSection";
import { LanSection } from "./domains/LanSection";
import { MaintenanceSection } from "./domains/MaintenanceSection";
import { PlanDialog } from "./domains/PlanDialog";
import "./domains/problems";
import { ProxySection } from "./domains/ProxySection";
import { RoutesSection } from "./domains/RoutesSection";
import { SharingSection } from "./domains/SharingSection";
import { useIntent, usePortlessDoctor, usePortlessStatus, useRefreshOnJobs, valueOf } from "./domains/store";
import "./DomainsView.css";

/** One component per section, each in domains/, so the portless center can grow them apart. */
const SECTIONS: Record<DomainSection, { icon: IconName; Section: ComponentType }> = {
  proxy: { icon: "shield", Section: ProxySection },
  routes: { icon: "link", Section: RoutesSection },
  aliases: { icon: "plug", Section: AliasesSection },
  sharing: { icon: "share", Section: SharingSection },
  compose: { icon: "box", Section: ComposeSection },
  lan: { icon: "wifi", Section: LanSection },
  config: { icon: "file", Section: ConfigSection },
  certificates: { icon: "check", Section: CertificatesSection },
  hosts: { icon: "terminal", Section: HostsSection },
  doctor: { icon: "pulse", Section: DoctorSection },
  maintenance: { icon: "gear", Section: MaintenanceSection },
};

/** What each of portless's pages is for, in a sentence. */
const GROUP_TEXT: Record<string, ReactNode> = {
  routes: (
    <>
      Every <code>.localhost</code> address portless answers, and the aliases you added for servers it doesn't start.
    </>
  ),
  proxy: (
    <>
      The local server behind every <code>.localhost</code> address, its HTTPS certificate, and how your system finds it.
    </>
  ),
  sharing: <>Open an app to someone else: a public link, every device on your network, or a Docker Compose project at its own address.</>,
  doctor: <>portless checks its own setup and fixes what it can; maintenance keeps its state tidy.</>,
};

function ProxyPill() {
  const status = valueOf(usePortlessStatus().state);
  if (!status?.installed) return null;
  const p = status.proxy;
  return (
    <span className="pill" title={p.responding ? `The proxy answers on port ${p.port}` : "The proxy isn't running"}>
      <StateDot state={p.responding ? "on" : "failed"} />
      {p.responding ? `Proxy on :${p.port}` : "Proxy stopped"}
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
        description={scope.remote ? <>{GROUP_TEXT[group.id]} On {machineName}; you open its addresses here through Portplane.</> : GROUP_TEXT[group.id]}
        actions={
          <>
            {picker}
            <ProxyPill />
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
