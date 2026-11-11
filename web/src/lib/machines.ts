import type { MachineCandidate, MachineSettings } from "../api/types";

// Remote machines (M3): adding one from ~/.ssh/config or Tailscale peers.

export interface CandidateItem {
  candidate: MachineCandidate;
  /** Already added under this machine (matched on the ssh host). */
  added?: MachineSettings;
}

export interface CandidateGroup {
  source: MachineCandidate["source"];
  title: string;
  items: CandidateItem[];
}

const SOURCES: Array<{ source: MachineCandidate["source"]; title: string }> = [
  { source: "ssh-config", title: "From ~/.ssh/config" },
  { source: "tailscale", title: "Tailscale" },
];

/**
 * Candidates by source, ~/.ssh/config first. Tailscale peers that are online
 * come first; otherwise the server's order stays. A host listed twice in one
 * source shows once.
 */
export function groupCandidates(candidates: MachineCandidate[], saved: MachineSettings[]): CandidateGroup[] {
  const byHost = new Map(saved.map((m) => [m.host, m]));
  return SOURCES.flatMap(({ source, title }) => {
    const seen = new Set<string>();
    const items: CandidateItem[] = [];
    for (const c of candidates) {
      if (c.source !== source || seen.has(c.host)) continue;
      seen.add(c.host);
      items.push({ candidate: c, added: byHost.get(c.host) });
    }
    if (source === "tailscale") {
      // stable sort: online, then unknown, then offline
      const rank = (i: CandidateItem) => (i.candidate.online === true ? 0 : i.candidate.online === false ? 2 : 1);
      items.sort((a, b) => rank(a) - rank(b));
    }
    return items.length ? [{ source, title, items }] : [];
  });
}

/** The display name the server picks when none is given: "dev@box.example.com" -> "box". */
export function defaultMachineName(host: string): string {
  let name = host.trim();
  const at = name.indexOf("@");
  if (at >= 0) name = name.slice(at + 1);
  const dot = name.indexOf(".");
  if (dot > 0) name = name.slice(0, dot);
  return name;
}

/** Why a host can't be passed to ssh, or null. Mirrors the server's check. */
export function hostProblem(host: string): string | null {
  const h = host.trim();
  if (h === "") return "Enter an SSH host: an alias from ~/.ssh/config, or user@host.";
  if (h.startsWith("-") || /[\s'"`$;|&]/.test(h)) return "That isn't an SSH host. Use an alias from ~/.ssh/config, or user@host.";
  return null;
}

/** Why a folder on a remote machine (macOS or Linux, ADR-0015) can't be watched, or null. Empty is fine: it's ignored. */
export function remoteFolderProblem(path: string): string | null {
  const p = path.trim();
  if (p === "") return null;
  if (p.startsWith("~")) return "Write the full path: ~ isn't expanded on the other machine.";
  if (!p.startsWith("/")) return "Use an absolute path, such as /home/you/code.";
  return null;
}

/** Trimmed, without blanks or repeats, in order. */
export function cleanFolders(folders: string[]): string[] {
  const out: string[] = [];
  for (const f of folders) {
    const t = f.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function osLabel(os: string | undefined): string | undefined {
  if (!os) return undefined;
  const known: Record<string, string> = { linux: "Linux", darwin: "macOS", macos: "macOS", windows: "Windows" };
  return known[os.toLowerCase()] ?? os;
}
