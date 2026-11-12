import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "../api/client";
import { errorText } from "../api/errors";
import type { Preferences } from "../api/types";
import { DEFAULT_PREFERENCES, normalizePreferences } from "../lib/preferences";
import type { PreferencesLoad } from "../shell/ShellContext";
import type { Toaster } from "./useToasts";

/**
 * Loads the preferences once and saves changes optimistically: the UI
 * changes at once, the whole object is PUT, and a failed save rolls back
 * with a toast. Only the newest save's answer is applied.
 */
export function usePreferences(api: Api, toast: Toaster) {
  const [state, setState] = useState<PreferencesLoad>({ status: "loading" });
  const latest = useRef<Preferences | null>(null);
  const seq = useRef(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setState((s) => (s.status === "ok" ? s : { status: "loading" }));
    api.preferences().then(
      (raw) => {
        if (!live) return;
        const p = normalizePreferences(raw);
        latest.current = p;
        setState({ status: "ok", value: p });
      },
      (err: unknown) => live && setState({ status: "error", message: errorText(err) }),
    );
    return () => {
      live = false;
    };
  }, [api, attempt]);

  const update = useCallback(
    async (change: (p: Preferences) => Preferences): Promise<boolean> => {
      const loaded = latest.current;
      const before = loaded ?? DEFAULT_PREFERENCES;
      const next = change(before);
      latest.current = next;
      setState({ status: "ok", value: next });
      const n = ++seq.current;
      try {
        const saved = normalizePreferences(await api.savePreferences(next));
        if (n === seq.current) {
          latest.current = saved;
          setState({ status: "ok", value: saved });
        }
        return true;
      } catch (err) {
        if (n === seq.current) {
          latest.current = loaded;
          setState(loaded ? { status: "ok", value: loaded } : { status: "error", message: errorText(err) });
        }
        toast.error(`Couldn't save the change: ${errorText(err)}`);
        return false;
      }
    },
    [api, toast],
  );

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { preferences: state, updatePreferences: update, reloadPreferences: reload };
}
