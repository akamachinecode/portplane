import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Api } from "../api/client";
import { errorText } from "../api/errors";
import type { Proposal, SetupOverrides } from "../api/types";
import { overridesFor, overridesKey, rescanDelay, type SetupEdits } from "../lib/setup";

export interface SetupProposal {
  proposal: Proposal | null;
  /** The overrides that produced `proposal`: apply must send exactly these. */
  scannedWith: SetupOverrides | null;
  scannedKey: string | null;
  scanning: boolean;
  error: string | null;
  /** Scans again with the current edits, now (Rescan, or after a 409). */
  rescan(): Promise<Proposal | null>;
}

/**
 * Keeps a proposal in step with the user's edits. The first scan runs at
 * once; later edits re-scan after rescanDelay (typing waits, checkboxes
 * don't). Only the latest request's answer is kept.
 */
export function useSetupProposal(api: Api, folder: string, edits: SetupEdits): SetupProposal {
  const overrides = useMemo(() => overridesFor(edits), [edits]);
  const key = overridesKey(overrides);
  const [state, setState] = useState<Omit<SetupProposal, "rescan">>({
    proposal: null,
    scannedWith: null,
    scannedKey: null,
    scanning: false,
    error: null,
  });
  const seq = useRef(0);
  const requested = useRef<SetupOverrides | null>(null);
  const latest = useRef(overrides);
  latest.current = overrides;

  const scan = useCallback(
    async (ov: SetupOverrides): Promise<Proposal | null> => {
      const n = ++seq.current;
      requested.current = ov;
      setState((s) => ({ ...s, scanning: true, error: null }));
      try {
        const p = await api.setupScan(folder, ov);
        if (n !== seq.current) return null;
        setState({ proposal: p, scannedWith: ov, scannedKey: overridesKey(ov), scanning: false, error: null });
        return p;
      } catch (err) {
        if (n !== seq.current) return null;
        setState((s) => ({ ...s, scanning: false, error: errorText(err) }));
        return null;
      }
    },
    [api, folder],
  );

  useEffect(() => {
    const prev = requested.current;
    if (prev && overridesKey(prev) === key) return;
    const t = setTimeout(() => void scan(latest.current), prev ? rescanDelay(prev, latest.current) : 0);
    return () => clearTimeout(t);
  }, [key, scan]);

  const rescan = useCallback(() => scan(latest.current), [scan]);
  return { ...state, rescan };
}
