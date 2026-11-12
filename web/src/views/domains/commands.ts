import { navigate } from "../../lib/router";
import { registerCommandSource, type Command, type CommandContext } from "../../shell/commands";
import { suggestName } from "../../lib/portless";
import { requestIntent } from "./store";

// The portless center in the palette (plan §6.3): new alias, diagnostics,
// the proxy, a URL for any listening port, and sharing, compose projects
// and LAN mode (M5.6). The actions are this computer's; another machine's
// are in Domains with that machine picked.

export function portlessCommands(ctx: CommandContext): Command[] {
  const local = ctx.snapshot?.machines.find((m) => m.machine.local);
  const out: Command[] = [
    {
      id: "portless.open",
      title: "Open domains",
      group: "Go to",
      icon: "globe",
      keywords: ["portless", "proxy", "routes", "localhost"],
      searchOnly: true,
      run: () => navigate({ view: "domains", section: "proxy" }),
    },
  ];
  if (!local?.tools.portless) return out;
  out.push(
    {
      id: "portless.sharing.open",
      title: "Open sharing",
      group: "Go to",
      icon: "share",
      keywords: ["share", "tailscale", "tailnet", "funnel", "ngrok", "cloudflare", "tunnel", "public"],
      searchOnly: true,
      run: () => navigate({ view: "domains", section: "sharing" }),
    },
    {
      id: "portless.compose.open",
      title: "Open compose projects",
      group: "Go to",
      icon: "box",
      keywords: ["docker", "compose", "containers", "portless"],
      searchOnly: true,
      run: () => navigate({ view: "domains", section: "compose" }),
    },
    {
      id: "portless.compose.start",
      title: "Start a compose project",
      group: "Actions",
      icon: "box",
      keywords: ["docker", "compose", "up", "containers", "portless"],
      searchOnly: true,
      run: () => {
        requestIntent({ kind: "compose-start" });
        navigate({ view: "domains", section: "compose" });
      },
    },
    {
      id: "portless.lan.open",
      title: "Open LAN mode",
      group: "Go to",
      icon: "wifi",
      keywords: ["lan", "network", "wifi", "mdns", "local", "phone", "mobile"],
      searchOnly: true,
      run: () => navigate({ view: "domains", section: "lan" }),
    },
    {
      id: "portless.lan.phone",
      title: "Open an app on a phone",
      group: "Actions",
      icon: "qr",
      keywords: ["phone", "mobile", "qr", "certificate", "lan", "ios", "android", "iphone"],
      searchOnly: true,
      run: () => {
        requestIntent({ kind: "lan-phone" });
        navigate({ view: "domains", section: "lan" });
      },
    },
  );
  out.push(
    {
      id: "portless.alias.new",
      title: "New alias",
      group: "Actions",
      icon: "plug",
      keywords: ["portless", "url", "port", "route", "localhost"],
      run: () => {
        requestIntent({ kind: "new-alias" });
        navigate({ view: "domains", section: "aliases", machine: local.machine.id });
      },
    },
    {
      id: "portless.doctor",
      title: "Run diagnostics",
      group: "Actions",
      icon: "pulse",
      keywords: ["portless", "doctor", "check", "health", "diagnose"],
      run: () => {
        requestIntent({ kind: "run-doctor" });
        navigate({ view: "domains", section: "doctor", machine: local.machine.id });
      },
    },
    {
      id: "portless.proxy.toggle",
      title: local.tools.proxyRunning ? "Stop the proxy" : "Start the proxy",
      group: "Actions",
      icon: local.tools.proxyRunning ? "stop" : "play",
      keywords: ["portless", "proxy"],
      searchOnly: true,
      run: () => {
        requestIntent({ kind: "action", action: local.tools.proxyRunning ? "proxy-stop" : "proxy-start" });
        navigate({ view: "domains", section: "proxy", machine: local.machine.id });
      },
    },
    {
      id: "portless.trust",
      title: "Trust the local certificate",
      group: "Actions",
      icon: "shield",
      keywords: ["portless", "https", "ca", "padlock", "certificate"],
      searchOnly: true,
      run: () => {
        requestIntent({ kind: "action", action: "trust" });
        navigate({ view: "domains", section: "certificates", machine: local.machine.id });
      },
    },
  );
  for (const p of local.otherPorts) {
    if (p.route) continue;
    out.push({
      id: `portless.alias.port.${p.port}`,
      title: `Give port ${p.port} a URL`,
      group: "Actions",
      icon: "link",
      hint: p.process,
      keywords: ["alias", "portless", String(p.port)],
      searchOnly: true,
      run: () => {
        requestIntent({ kind: "new-alias", port: p.port, name: suggestName(p.process) });
        navigate({ view: "domains", section: "aliases", machine: local.machine.id });
      },
    });
  }
  return out;
}

registerCommandSource("portless", portlessCommands);
