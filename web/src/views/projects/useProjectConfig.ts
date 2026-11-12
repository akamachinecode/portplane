import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectConfig, ReloadResponse } from "../../api/dekit";
import { errorText } from "../../api/errors";
import { useApp } from "../../components/AppContext";

export type ConfigLoad = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; value: ProjectConfig; refreshing: boolean };

/** A project's config for the editor. A refresh keeps showing the last one, so open forms stay put. */
export function useProjectConfig(runner: string | null): { load: ConfigLoad; reload(): void } {
  const { api } = useApp();
  const [load, setLoad] = useState<ConfigLoad>({ status: "loading" });
  const seq = useRef(0);
  const reload = useCallback(() => {
    if (!runner) return;
    const n = ++seq.current;
    setLoad((l) => (l.status === "ok" ? { ...l, refreshing: true } : { status: "loading" }));
    api.dekitConfig(runner).then(
      (value) => n === seq.current && setLoad({ status: "ok", value, refreshing: false }),
      (err: unknown) => n === seq.current && setLoad({ status: "error", message: errorText(err) }),
    );
  }, [api, runner]);
  useEffect(() => {
    setLoad({ status: "loading" });
    reload();
  }, [reload]);
  return { load, reload };
}

/**
 * The runner's reload plan, checked every few seconds while shown: a
 * dekit.yaml edited on disk shows as "Configuration changed".
 */
export function useReloadPlan(runner: string | null, enabled: boolean, every = 5000): { plan: ReloadResponse | null; refresh(): void } {
  const { api } = useApp();
  const [plan, setPlan] = useState<ReloadResponse | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!runner || !enabled) {
      setPlan(null);
      return;
    }
    let live = true;
    const check = () =>
      api.dekitReloadPlan(runner).then(
        (p) => live && setPlan(p),
        () => live && setPlan(null),
      );
    void check();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, every);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [api, runner, enabled, every, tick]);
  return { plan, refresh };
}
