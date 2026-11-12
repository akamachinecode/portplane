import { useCallback, useMemo, useRef, useState } from "react";

export type ToastKind = "error" | "info";

/** A button on the toast, such as Undo after a destructive action. */
export interface ToastAction {
  label: string;
  run(): void;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  action?: ToastAction;
}

export interface Toaster {
  error(text: string): void;
  /** With an action (Undo), the toast stays long enough to use it. */
  info(text: string, opts?: { action?: ToastAction }): void;
}

const LIFETIME: Record<ToastKind, number> = { error: 8000, info: 2500 };
const LIFETIME_WITH_ACTION = 7000;
const MAX_TOASTS = 4;

export function useToasts(): { toasts: Toast[]; toast: Toaster; dismiss: (id: number) => void } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, text: string, action?: ToastAction) => {
      const id = nextId.current++;
      setToasts((list) => {
        // the same message twice in a row only resets its timer
        const rest = list.filter((t) => !(t.kind === kind && t.text === text));
        return [...rest, { id, kind, text, action }].slice(-MAX_TOASTS);
      });
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), action ? LIFETIME_WITH_ACTION : LIFETIME[kind]),
      );
    },
    [dismiss],
  );

  const toast = useMemo<Toaster>(
    () => ({ error: (text) => push("error", text), info: (text, opts) => push("info", text, opts?.action) }),
    [push],
  );
  return { toasts, toast, dismiss };
}
