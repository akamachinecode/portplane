import type { ReactNode } from "react";
import { MachinePicker, MachineScope, RemoteStatusBanner, useMachineChoice, useMachineScope } from "../components/MachineScope";
import { ViewHeader } from "../components/ViewHeader";
import { DekitAbout } from "./runners/DekitAbout";
import { DekitHelpHost } from "./runners/DekitHelp";
import "./RunnersView.css";

/**
 * Settings › dekit › About dekit (ADR-0028): the dekit on a machine, its
 * version, how it was installed, the binary projects use, updating it and
 * its help. It used to sit on top of the runners.
 */
export function DekitView() {
  const { machine, options, choose } = useMachineChoice("dekit");
  return (
    <MachineScope machine={machine}>
      <DekitBody key={machine} picker={<MachinePicker machine={machine} options={options} onChange={choose} />} />
    </MachineScope>
  );
}

function DekitBody({ picker }: { picker: ReactNode }) {
  const scope = useMachineScope();
  const name = scope.remote ? (scope.ms?.machine.name ?? scope.id) : null;
  return (
    <>
      <ViewHeader
        section="dekit"
        title="About dekit"
        description={`dekit starts each dev server, restarts it when it crashes and keeps its output${name ? ` on ${name}` : ""}. Portplane drives it; your dekit.yaml files stay yours.`}
        actions={picker}
      />
      <RemoteStatusBanner />
      <DekitAbout />
      <DekitHelpHost />
    </>
  );
}
