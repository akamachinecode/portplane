import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Api } from "../../api/client";
import { errorText } from "../../api/errors";
import type { Job } from "../../api/jobs";
import type { Proposal, Requirement, RequirementId, SetupOverrides } from "../../api/types";
import type { SetupEdits } from "../../lib/setup";
import { CHECK_ORDER, type Flow, type StepId } from "./steps";

/** The system check, one request per check so each shows as it comes. */
export interface Checks {
  items: Partial<Record<RequirementId, Requirement>>;
  pending: ReadonlySet<RequirementId>;
  errors: Partial<Record<RequirementId, string>>;
  /** How this computer asks for the admin password ("" when it can't). */
  admin: string | undefined;
  /** Runs these checks (all by default) in parallel; resolves with every answer known then. */
  run(ids?: readonly RequirementId[]): Promise<Partial<Record<RequirementId, Requirement>>>;
}

export function useChecks(api: Api): Checks {
  const [items, setItems] = useState<Checks["items"]>({});
  const [pending, setPending] = useState<ReadonlySet<RequirementId>>(new Set());
  const [errors, setErrors] = useState<Checks["errors"]>({});
  const [admin, setAdmin] = useState<string | undefined>(undefined);
  const latest = useRef<Checks["items"]>({});
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const run = useCallback(
    async (ids: readonly RequirementId[] = CHECK_ORDER) => {
      setPending((p) => new Set([...p, ...ids]));
      await Promise.all(
        ids.map(async (id) => {
          try {
            const c = await api.checkSome([id]);
            if (!live.current) return;
            const r = c.requirements.find((x) => x.id === id);
            const next = { ...latest.current };
            if (r) next[id] = r;
            else delete next[id]; // an older binary without this check
            latest.current = next;
            setItems(next);
            setErrors((cur) => {
              const { [id]: _drop, ...rest } = cur;
              return rest;
            });
            if (c.admin !== undefined) setAdmin(c.admin);
          } catch (err) {
            if (live.current) setErrors((cur) => ({ ...cur, [id]: errorText(err) }));
          } finally {
            if (live.current)
              setPending((p) => {
                const n = new Set(p);
                n.delete(id);
                return n;
              });
          }
        }),
      );
      return latest.current;
    },
    [api],
  );

  return { items, pending, errors, admin, run };
}

/** A folder's scan, as the review needs it to write. */
export interface FolderScan {
  proposal: Proposal | null;
  scannedWith: SetupOverrides | null;
  scannedKey: string | null;
  scanning: boolean;
  error: string | null;
  rescan(): Promise<Proposal | null>;
}

export interface OnboardingCtx {
  step: StepId;
  go(step: StepId): void;
  next(): void;
  back(): void;
  flow: Flow;
  checks: Checks;
  /** Some browser does not trust the CA yet (null until the browsers were read). */
  setBrowsersNeeded(v: boolean | null): void;
  choices: Record<string, string>;
  choose(key: string, value: string): void;
  /** The folders chosen for this setup (saved in Settings). */
  folders: string[];
  setFolders(f: string[]): void;
  edits: Record<string, SetupEdits>;
  setEdits(folder: string, change: (e: SetupEdits) => SetupEdits): void;
  scans: Record<string, FolderScan>;
  /** The dekit projects written by the review, for the first start. */
  roots: string[];
  setRoots(r: string[]): void;
  /** Jobs started from a step, by a key such as "install:dekit", so they survive moving between steps. */
  jobs: Record<string, string>;
  trackJob(key: string, job: Job): void;
}

export const OnboardingContext = createContext<OnboardingCtx | null>(null);

export function useOnboarding(): OnboardingCtx {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error("useOnboarding outside OnboardingView");
  return ctx;
}

/** Runs fn once when a job leaves "running". */
export function useJobEnd(job: Job | undefined, fn: (job: Job) => void): void {
  const seen = useRef<string | null>(null);
  const cb = useRef(fn);
  cb.current = fn;
  useEffect(() => {
    if (!job || job.state === "running") return;
    const key = `${job.id}:${job.state}`;
    if (seen.current === key) return;
    const first = seen.current === null && job.endedAt !== undefined;
    seen.current = key;
    // A job that had already ended when the step opened is not news.
    if (first && Date.now() - Date.parse(job.endedAt!) > 5000) return;
    cb.current(job);
  }, [job]);
}
