import type { Requirement, ShareProvider } from "../../api/sharing";

// One word for how a way to share stands (ADR-0032): "Ready" or what it
// needs, named by the tool, so a row says it in two words and the details
// wait behind it.

const TOOLS: Array<[RegExp, string]> = [
  [/^tailscale-funnel$/, "Funnel allowed"],
  [/^tailscale-operator$/, "your user allowed"],
  [/^tailscale/, "Tailscale"],
  [/^ngrok/, "ngrok"],
  [/^cloudflared/, "cloudflared"],
  [/^docker/, "Docker"],
];

function toolOf(r: Requirement): string | undefined {
  return TOOLS.find(([re]) => re.test(r.id))?.[1];
}

/** "Ready", "Needs Tailscale", "Needs ngrok", or "2 things missing" when a need has no name here. */
export function needsWord(reqs: Requirement[]): string {
  const missing = reqs.filter((r) => !r.ok);
  if (!missing.length) return "Ready";
  const tools = missing.map(toolOf);
  if (tools.some((t) => !t)) return `${missing.length} ${missing.length === 1 ? "thing" : "things"} missing`;
  const names = [...new Set(tools as string[])];
  return `Needs ${names.join(" and ")}`;
}

/**
 * Each provider's missing requirements, without those an earlier one
 * already listed (Funnel needs everything the tailnet does): a fact such
 * as "Tailscale is turned off" is said once on the page.
 */
export function ownNeeds(providers: ShareProvider[]): Map<ShareProvider["kind"], { own: Requirement[]; sharedWith?: string }> {
  const seen = new Map<string, string>();
  const out = new Map<ShareProvider["kind"], { own: Requirement[]; sharedWith?: string }>();
  for (const p of providers) {
    const missing = p.requirements.filter((r) => !r.ok);
    const own = missing.filter((r) => !seen.has(r.id));
    const shared = missing.find((r) => seen.has(r.id));
    out.set(p.kind, { own, sharedWith: shared ? seen.get(shared.id) : undefined });
    for (const r of missing) if (!seen.has(r.id)) seen.set(r.id, p.label);
  }
  return out;
}
