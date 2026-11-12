import { useState, type ComponentType, type ReactNode } from "react";
import type { PortlessAction } from "../api/portless";
import type { IconName } from "../components/Icon";
import { MachinePicker, MachineScope, RemoteStatusBanner, useMachineChoice, useMachineScope } from "../components/MachineScope";
import { StateDot } from "../components/StateDot";
import { SubNav } from "../components/SubNav";
import { ViewHeader } from "../components/ViewHeader";
import { hostsSectionVisible } from "../lib/portless";
import { DOMAIN_SECTIONS, type DomainSection } from "../lib/router";
import { DOMAIN_LABELS } from "../shell/nav";
import { useShell } from "../shell/ShellContext";
import { AliasesSection } from "./domains/AliasesSection";
import { CertificatesSection } from "./domains/CertificatesSection";
import "./domains/commands";
import { ConfigSection } from "./domains/ConfigSection";
import { DoctorSection } from "./domains/DoctorSection";
import { HostsSection } from "./domains/HostsSection";
import { MaintenanceSection } from "./domains/MaintenanceSection";
import { PlanDialog } from "./domains/PlanDialog";
import "./domains/problems";
import { ProxySection } from "./domains/ProxySection";
import { RoutesSection } from "./domains/RoutesSection";
import { useIntent, usePortlessDoctor, usePortlessStatus, useRefreshOnJobs, valueOf } from "./domains/store";
import "./DomainsView.css";

/** One component per section, each in domains/, so the portless center can grow them apart. */
const SECTIONS: Record<DomainSection, { icon: IconName; Section: ComponentType }> = {
  proxy: { icon: "shield", Section: ProxySection },
  routes: { icon: "link", Section: RoutesSection },
  aliases: { icon: "plug", Section: AliasesSection },
  config: { icon: "file", Section: ConfigSection },
  certificates: { icon: "check", Section: CertificatesSection },
  hosts: { icon: "terminal", Section: HostsSection },
  doctor: { icon: "pulse", Section: DoctorSection },
  maintenance: { icon: "gear", Section: MaintenanceSection },
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
  const sections = DOMAIN_SECTIONS.filter((s) => s !== "hosts" || showHosts);
  return (
    <>
      <ViewHeader
        title="Domains"
        description={
          scope.remote ? (
            <>
              The <code>.localhost</code> addresses portless gives the apps on {scope.ms?.machine.name ?? scope.id}, and the proxy behind them. You open them here through Portplane.
            </>
          ) : (
            <>
              The stable <code>.localhost</code> addresses portless gives your apps, and the proxy behind them.
            </>
          )
        }
        actions={
          <>
            {picker}
            <ProxyPill />
          </>
        }
      />
      <RemoteStatusBanner />
      <div className="with-subnav">
        <SubNav label="Domain sections" items={sections.map((s) => ({ route: { view: "domains", section: s, machine: inUrl }, label: DOMAIN_LABELS[s], icon: SECTIONS[s].icon, current: s === section }))} />
        <div className="with-subnav-main">
          <Section />
        </div>
      </div>
      {action && <PlanDialog action={action} onClose={() => setAction(null)} />}
    </>
  );
}
