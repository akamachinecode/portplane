import { LOCAL_MACHINE } from "../api/machine";
import type { Snapshot } from "../api/types";

// The rules behind the machine picker (ADR-0026), apart from React.

export interface MachineOption {
  id: string;
  label: string;
  online: boolean;
}

/** The machines a view can act on: this computer first, then the others; offline ones can't be picked. */
export function pickableMachines(snapshot: Snapshot | null): MachineOption[] {
  const out: MachineOption[] = [{ id: LOCAL_MACHINE, label: "This computer", online: true }];
  for (const ms of snapshot?.machines ?? []) {
    const m = ms.machine;
    if (m.local) {
      out[0] = { id: m.id, label: "This computer", online: true };
      continue;
    }
    const online = m.status === "online";
    out.push({ id: m.id, label: online ? m.name : `${m.name} (${m.status === "connecting" ? "connecting" : "offline"})`, online });
  }
  return out;
}

/**
 * The machine a view shows: the one in the URL (while the snapshot can't
 * say it's gone), else the one last picked if it's still there, else this
 * computer. `urlMachine` is the URL's when it counts.
 */
export function chosenMachine(
  inUrl: string | undefined,
  picked: string,
  options: MachineOption[],
  haveSnapshot: boolean,
): { machine: string; urlMachine?: string } {
  const known = (id: string) => options.some((o) => o.id === id);
  const urlMachine = inUrl && (!haveSnapshot || known(inUrl)) ? inUrl : undefined;
  return { machine: urlMachine ?? (known(picked) ? picked : LOCAL_MACHINE), urlMachine };
}

const key = (view: string) => `portplane.machine.${view}`;

/** The machine last picked in a view; this computer when none was. */
export function rememberedMachine(storage: Storage | undefined, view: string): string {
  try {
    return storage?.getItem(key(view)) || LOCAL_MACHINE;
  } catch {
    return LOCAL_MACHINE;
  }
}

export function rememberMachine(storage: Storage | undefined, view: string, id: string): void {
  try {
    if (id === LOCAL_MACHINE) storage?.removeItem(key(view));
    else storage?.setItem(key(view), id);
  } catch {
    // blocked storage: the choice lasts until the page reloads
  }
}

/** A word is safe for a POSIX shell without quotes. */
function plain(s: string): boolean {
  return /^[A-Za-z0-9_\-./:=@%+,]+$/.test(s);
}

function quote(s: string): string {
  if (s === "") return "''";
  return plain(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * A command to paste in a terminal on this computer that runs `command` on
 * a machine over SSH, with a terminal for sudo's password prompt:
 * `ssh -t box 'sudo portless trust'`. The command is passed as one quoted
 * argument, so the remote shell sees it exactly as written.
 */
export function sshCommand(host: string | undefined, command: string): string {
  const dest = host && host.trim() ? host.trim() : "<machine>";
  return `ssh -t ${quote(dest)} ${quote(command)}`;
}
