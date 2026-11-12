import type { MachineSnapshot } from "../api/types";
import { shortenPath } from "../lib/format";
import { href } from "../lib/router";
import { runnerFingerprint } from "../lib/pending";
import { useApp } from "./AppContext";
import { Banner } from "./Banner";
import { Spinner } from "./Icon";

/** A link into the guided setup, for this computer's own tools (F3). */
function SetupLink({ step, children }: { step: "install" | "proxy"; children: string }) {
  return (
    <a className="btn" href={href({ view: "onboarding", step })}>
      {children}
    </a>
  );
}

/** What is missing on this machine, and why it matters, in one sentence each. */
export function ToolBanners({ ms }: { ms: MachineSnapshot }) {
  const { tools } = ms;
  const local = ms.machine.local;
  return (
    <>
      {!tools.dekit && (
        <Banner tone="warn" title="dekit isn't installed" action={local ? <SetupLink step="install">Install dekit</SetupLink> : undefined}>
          Portplane uses{" "}
          <a href="https://dekit.run" target="_blank" rel="noopener noreferrer">
            dekit
          </a>{" "}
          to start, stop and supervise your dev servers. Until it's installed, you get a read-only view of the ports open on
          this machine.
        </Banner>
      )}
      {!tools.portless && (
        <Banner tone="info" title="portless isn't installed" action={local ? <SetupLink step="install">Install portless</SetupLink> : undefined}>
          <a href="https://github.com/vercel-labs/portless" target="_blank" rel="noopener noreferrer">
            portless
          </a>{" "}
          gives each dev server a stable <code>https://name.localhost</code> URL, so bookmarks keep working when ports move.
          Without it, apps show their port only.
        </Banner>
      )}
      {tools.portless && !tools.proxyRunning && (
        <Banner tone="warn" title="The portless proxy isn't running" action={local ? <SetupLink step="proxy">Set up the proxy</SetupLink> : undefined}>
          Apps keep their <code>.localhost</code> names, but the URLs won't load until the proxy runs.{" "}
          {local ? (
            <>Installing it as a service asks for your password once, and it then starts with your computer.</>
          ) : (
            <>
              Install it there once with <code>sudo portless service install</code>.
            </>
          )}
        </Banner>
      )}
    </>
  );
}

/** A dekit project whose runner is down: its apps can't start until it's up. */
export function RunnerBanners({ ms, home }: { ms: MachineSnapshot; home: string | undefined }) {
  const { api, pending } = useApp();
  const machine = ms.machine.id;
  return (
    <>
      {ms.runners
        // Without dekit, the tool banner already explains; nothing can start.
        .filter((r) => ms.tools.dekit && (!r.up || r.error))
        .map((r) => {
          const key = `runner|${machine}|${r.root}`;
          const busy = pending.has(key);
          return (
            <Banner
              key={r.root}
              tone="warn"
              title={
                r.up ? (
                  <>
                    Problem reading <strong>{r.name}</strong>
                  </>
                ) : (
                  <>
                    dekit isn't running for <strong>{r.name}</strong>
                  </>
                )
              }
              action={
                r.up ? undefined : (
                <button
                  type="button"
                  className="btn"
                  aria-busy={busy || undefined}
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    if (!busy) void pending.run(key, runnerFingerprint(machine, r.root), () => api.runnerUp(machine, r.root));
                  }}
                >
                  {busy && <Spinner />}
                  Start runner
                </button>
                )
              }
            >
              <span className="banner-meta">
                <span className="mono">{shortenPath(r.root, home)}</span>
                {r.error && <span className="banner-detail-error">{r.error}</span>}
              </span>
            </Banner>
          );
        })}
    </>
  );
}
