import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { App, MachineSnapshot } from "../api/types";
import { appsFingerprint } from "../lib/pending";
import { appTarget } from "../lib/targets";
import { appActionList, appKey, type AppAction } from "./appActions";
import { useApp, type AppCtx } from "./AppContext";
import { ConfirmDialog } from "./Dialog";
import type { MenuItem } from "./Menu";
import "./AppActionMenu.css";

// The extra app actions (kill, keep stopped, force restart, remove) as menu
// items, with their confirmation dialog, and "Remove" that waits a few
// seconds with Undo before it happens.

/** How long "Remove" waits for Undo. */
export const UNDO_MS = 6000;

interface Removal {
  key: string;
  label: string;
  at: number;
  timer: ReturnType<typeof setTimeout>;
}

const removals = new Map<string, Removal>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => {
  version++;
  for (const l of listeners) l();
};

/** Schedules a removal; it runs after UNDO_MS unless undone. */
export function scheduleRemoval(ctx: Pick<AppCtx, "api" | "pending">, machine: string, app: App, ms = UNDO_MS): void {
  const key = appKey(machine, app);
  if (removals.has(key)) return;
  const timer = setTimeout(() => {
    removals.delete(key);
    notify();
    void ctx.pending.run(key + "rm", appsFingerprint(machine, [app.id]), () => ctx.api.act(appTarget(machine, app), "rm"));
  }, ms);
  removals.set(key, { key, label: app.label, at: Date.now(), timer });
  notify();
}

export function undoRemoval(machine: string, app: Pick<App, "id">): void {
  const r = removals.get(appKey(machine, app));
  if (!r) return;
  clearTimeout(r.timer);
  removals.delete(r.key);
  notify();
}

function useRemoval(machine: string, app: Pick<App, "id">): Removal | undefined {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  return removals.get(appKey(machine, app));
}

function UndoStrip({ machine, app, removal }: { machine: string; app: App; removal: Removal }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((removal.at + UNDO_MS - now) / 1000));
  return (
    <div className="undo-strip" role="status">
      <span>
        Removing <strong>{app.label}</strong>
        {left > 0 ? ` in ${left}s` : "…"}
      </span>
      <button type="button" className="btn btn-sm" onClick={() => undoRemoval(machine, app)}>
        Undo
      </button>
    </div>
  );
}

/**
 * The actions of appActionList that apply now, as menu items, plus what to
 * render next to the menu (the confirmation dialog, the Undo strip).
 */
export function useAppActionMenu(ms: MachineSnapshot, app: App): { items: MenuItem[]; element: ReactNode; removing: boolean } {
  const ctx = useApp();
  const machine = ms.machine.id;
  const [asking, setAsking] = useState<AppAction | null>(null);
  const [busy, setBusy] = useState(false);
  const removal = useRemoval(machine, app);
  const run = async (a: AppAction) => {
    if (a.undoable) {
      scheduleRemoval(ctx, machine, app);
      return;
    }
    await ctx.pending.run(appKey(machine, app) + a.verb, appsFingerprint(machine, [app.id]), () => ctx.api.act(appTarget(machine, app), a.verb));
  };
  const items: MenuItem[] = appActionList(app, ms)
    .filter((a) => a.applies && !(a.undoable && removal))
    .map((a) => ({ label: a.label, icon: a.icon, onSelect: () => (a.confirm ? setAsking(a) : void run(a)) }));
  const element = (
    <>
      {asking?.confirm && (
        <ConfirmDialog
          open
          title={asking.confirm.title}
          confirmLabel={asking.confirm.confirmLabel}
          busy={busy}
          error={null}
          onClose={() => setAsking(null)}
          onConfirm={() => {
            setBusy(true);
            void run(asking).finally(() => {
              setBusy(false);
              setAsking(null);
            });
          }}
        >
          <p className="dialog-text">{asking.confirm.body}</p>
        </ConfirmDialog>
      )}
      {removal && <UndoStrip machine={machine} app={app} removal={removal} />}
    </>
  );
  return { items, element, removing: !!removal };
}
