import { navigate } from "../../lib/router";
import { registerCommandSource, type Command, type CommandContext } from "../../shell/commands";
import { suggestName } from "../../lib/portless";
import { requestIntent } from "./store";

// The portless center in the palette (plan §6.3): new alias, diagnostics,
// the proxy, and a URL for any listening port.

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
      id: "portless.alias.new",
      title: "New alias",
      group: "Actions",
      icon: "plug",
      keywords: ["portless", "url", "port", "route", "localhost"],
      run: () => {
        requestIntent({ kind: "new-alias" });
        navigate({ view: "domains", section: "aliases" });
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
        navigate({ view: "domains", section: "doctor" });
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
        navigate({ view: "domains", section: "proxy" });
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
        navigate({ view: "domains", section: "certificates" });
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
        navigate({ view: "domains", section: "aliases" });
      },
    });
  }
  return out;
}

registerCommandSource("portless", portlessCommands);
