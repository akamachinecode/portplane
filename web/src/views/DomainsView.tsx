import type { ComponentType } from "react";
import type { IconName } from "../components/Icon";
import { SubNav } from "../components/SubNav";
import { ViewHeader } from "../components/ViewHeader";
import { DOMAIN_SECTIONS, type DomainSection } from "../lib/router";
import { DOMAIN_LABELS } from "../shell/nav";
import { useShell } from "../shell/ShellContext";
import { AliasesSection } from "./domains/AliasesSection";
import { CertificatesSection } from "./domains/CertificatesSection";
import { DoctorSection } from "./domains/DoctorSection";
import { HostsSection } from "./domains/HostsSection";
import { ProxySection } from "./domains/ProxySection";
import { RoutesSection } from "./domains/RoutesSection";
import "./DomainsView.css";

/** One component per section, each in domains/, so the portless center (M5.2) can grow them apart. */
const SECTIONS: Record<DomainSection, { icon: IconName; Section: ComponentType }> = {
  proxy: { icon: "shield", Section: ProxySection },
  routes: { icon: "link", Section: RoutesSection },
  aliases: { icon: "plug", Section: AliasesSection },
  certificates: { icon: "file", Section: CertificatesSection },
  hosts: { icon: "terminal", Section: HostsSection },
  doctor: { icon: "pulse", Section: DoctorSection },
};

/** portless: the proxy, the .localhost routes and what keeps them working (plan §5). */
export function DomainsView() {
  const { route } = useShell();
  const section = route.view === "domains" ? route.section : "proxy";
  const { Section } = SECTIONS[section];
  return (
    <>
      <ViewHeader title="Domains" description={<>The stable <code>.localhost</code> addresses portless gives your apps, and the proxy behind them.</>} />
      <div className="with-subnav">
        <SubNav
          label="Domain sections"
          items={DOMAIN_SECTIONS.map((s) => ({ route: { view: "domains", section: s }, label: DOMAIN_LABELS[s], icon: SECTIONS[s].icon, current: s === section }))}
        />
        <div className="with-subnav-main">
          <Section />
        </div>
      </div>
    </>
  );
}
