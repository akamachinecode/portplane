import type { PortlessAction, ProxyOptions } from "../api/portless";
import type { ComposeProject, ComposeState, LanView, Requirement, ShareInfo, ShareKind, ShareProvider, ShareView } from "../api/sharing";
import { cleanTlds } from "./portless";

// The rules of sharing, compose projects and LAN mode, kept here so they
// are tested once and the views stay about layout (M5.6).

export const SHARE_KINDS: ShareKind[] = ["tailscale", "funnel", "ngrok", "cloudflare"];

/** What each share is called on its switch. */
export const SHARE_TITLES: Record<ShareKind, string> = {
  tailscale: "Share on your tailnet",
  funnel: "Share publicly with Tailscale Funnel",
  ngrok: "Share publicly with ngrok",
  cloudflare: "Share publicly with Cloudflare",
};

/** Short names, for tags and lists. */
export const SHARE_NAMES: Record<ShareKind, string> = {
  tailscale: "Tailnet",
  funnel: "Funnel",
  ngrok: "ngrok",
  cloudflare: "Cloudflare",
};

/** Where a shared app opens, in a sentence. Who can open it is the dialog's title and its warning, said once. */
export const SHARE_BLURBS: Record<ShareKind, string> = {
  tailscale: "It opens at this computer's tailnet address.",
  funnel: "It opens at this computer's tailnet address, through Tailscale Funnel.",
  ngrok: "It opens at a random ngrok address.",
  cloudflare: "It opens at a random trycloudflare.com address that changes on every restart.",
};

export function isPublic(kind: ShareKind): boolean {
  return kind !== "tailscale";
}

export interface ShareState {
  kind: ShareKind;
  /** The app's command turns it on. */
  on: boolean;
  /** The task's environment turns it on (Portplane can't turn it off). */
  viaEnv: boolean;
  /** The address portless reports, once the share is up. */
  url?: string;
  provider?: ShareProvider;
  /** What's still missing to turn it on. */
  missing: Requirement[];
  /** It can be switched from here now. */
  canToggle: boolean;
  /** Why the switch is off-limits, when it is. */
  why?: string;
}

/** How one share stands for an app. */
export function shareState(info: ShareInfo, kind: ShareKind): ShareState {
  const on = info.on.includes(kind);
  const viaEnv = info.env.includes(kind);
  const provider = info.providers.find((p) => p.kind === kind);
  const missing = provider ? provider.requirements.filter((r) => !r.ok) : [];
  const url = info.shared.find((s) => s.kind === kind)?.url;
  const s: ShareState = { kind, on: on || viaEnv, viaEnv: viaEnv && !on, url, provider, missing, canToggle: false };
  if (!info.editable) s.why = info.reason;
  else if (s.viaEnv) s.why = `PORTLESS_${kind.toUpperCase()} in the task's environment turns this on; remove it there to stop.`;
  else if (!s.on && missing.length) s.why = missing.length === 1 ? (missing[0].problem ?? missing[0].label) : `${missing.length} things are missing first.`;
  else s.canToggle = true;
  return s;
}

/** The share a switch replaces: an app is on the tailnet or on Funnel, not both. */
export function replacedBy(info: ShareInfo, kind: ShareKind): ShareKind | undefined {
  if (kind === "tailscale" && info.on.includes("funnel")) return "funnel";
  if (kind === "funnel" && info.on.includes("tailscale")) return "tailscale";
  return undefined;
}

/** Public shares first, then by address: what the Sharing list shows. */
export function sortShares(shares: ShareView[]): ShareView[] {
  return [...shares].sort((a, b) => Number(b.public) - Number(a.public) || a.hostname.localeCompare(b.hostname) || a.kind.localeCompare(b.kind));
}

/** "Ready", "1 thing missing", "3 things missing". */
export function readiness(reqs: Requirement[]): string {
  const n = reqs.filter((r) => !r.ok).length;
  if (n === 0) return "Ready";
  return `${n} ${n === 1 ? "thing" : "things"} missing`;
}

// ---- LAN ----

/** The proxy options with LAN mode on (and a pinned address) or off. */
export function lanOptions(current: ProxyOptions, on: boolean, ip?: string): ProxyOptions {
  if (on) {
    const out: ProxyOptions = { ...current, lan: true, tlds: ["local"] };
    if (ip?.trim()) out.lanIp = ip.trim();
    else delete out.lanIp;
    return out;
  }
  const tlds = cleanTlds((current.tlds ?? []).filter((t) => t !== "local"));
  const out: ProxyOptions = { ...current, lan: false, tlds };
  delete out.lanIp;
  return out;
}

/** Which address LAN mode publishes: followed as the network changes, pinned to one of this computer's, or typed in. */
export type LanChoice = { mode: "follow" } | { mode: "pin"; ip: string } | { mode: "custom"; ip: string };

/** The choice the proxy's options make now. */
export function lanChoice(view: Pick<LanView, "options" | "addresses">): LanChoice {
  const ip = view.options.lanIp?.trim();
  if (!ip) return { mode: "follow" };
  return view.addresses.some((a) => a.ip === ip) ? { mode: "pin", ip } : { mode: "custom", ip };
}

/** Why a typed address can't be pinned, or null. portless takes an IPv4 address here. */
export function lanAddressProblem(raw: string): string | null {
  const ip = raw.trim();
  if (!ip) return "Type the address, such as 192.168.1.20.";
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255 || (p.length > 1 && p.startsWith("0")))) {
    return "Type an IPv4 address: four numbers from 0 to 255 with dots, such as 192.168.1.20.";
  }
  const [a, b] = parts.map(Number);
  if (a === 127) return "That address is this computer only; a phone can't reach it.";
  if (a === 0 || a >= 224) return "That isn't an address a device on your network can have.";
  if (a === 169 && b === 254) return "That's a link-local address, which changes and doesn't reach other devices reliably.";
  return null;
}

/** The proxy action that applies new options: the service keeps them, else a restart or a start. */
export function applyAction(serviceInstalled: boolean, responding: boolean): PortlessAction {
  if (serviceInstalled) return "service-install";
  return responding ? "proxy-restart" : "proxy-start";
}

export interface TrustStep {
  title: string;
  steps: string[];
}

/** How a phone trusts portless's certificate, so .local pages show the padlock. */
export const PHONE_TRUST: Record<"ios" | "android", TrustStep> = {
  ios: {
    title: "iPhone and iPad",
    steps: [
      "Send ca.pem to the phone with AirDrop, Mail or Files, and open it.",
      "Open Settings → Profile Downloaded, tap Install and enter the phone's passcode.",
      "Open Settings → General → About → Certificate Trust Settings and turn on portless Local CA.",
    ],
  },
  android: {
    title: "Android",
    steps: [
      "Copy ca.pem to the phone (USB, Quick Share or a cloud folder).",
      "Open Settings → Security & privacy → More security settings → Encryption & credentials → Install a certificate → CA certificate, and pick the file.",
      "Chrome trusts it at once. Firefox needs Settings → About Firefox → tap the logo 5 times, then Settings → Secret Settings → Use third party CA certificates.",
    ],
  },
};

// ---- compose ----

export const COMPOSE_STATE_LABELS: Record<ComposeState, string> = {
  running: "Running",
  stopped: "Stopped",
  down: "Down",
};

/** Where Portplane found a project's compose file, in words. */
export function composeFileFrom(p: Pick<ComposeProject, "file" | "fileFrom">): string {
  switch (p.fileFrom) {
    case "remembered":
      return "the file Portplane last started it with";
    case "task":
      return "a dekit task that runs portless compose";
    case "containers":
      return "the folder Docker recorded on its containers";
    case "guess":
      return "the folders its services build from";
  }
  return "not found";
}

/** A service's addresses on one domain: <label>.<project>.<tld>, and <port>.<label>.<project> when it routes several ports. */
export function composeHostnames(project: Pick<ComposeProject, "label">, svc: ComposeProject["services"][number], tld: string): string[] {
  const routed = svc.ports.filter((p) => p.routed).map((p) => p.target);
  if (!routed.length) return [];
  const suffix = `.${project.label}.${tld}`;
  return [`${svc.label}${suffix}`, ...(routed.length > 1 ? routed.map((t) => `${t}.${svc.label}${suffix}`) : [])];
}

/** A one-line summary of a project: "3 services · 2 addresses". */
export function composeSummary(p: ComposeProject): string {
  const parts: string[] = [];
  if (p.services.length) parts.push(`${p.services.length} ${p.services.length === 1 ? "service" : "services"}`);
  if (p.routes.length) parts.push(`${p.routes.length} ${p.routes.length === 1 ? "address" : "addresses"}`);
  return parts.join(" · ") || "No services known yet";
}
