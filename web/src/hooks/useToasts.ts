import { useCallback, useMemo, useRef, useState } from "react";

export type ToastKind = "error" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

export interface Toaster {
  error(text: string): void;
  info(text: string): void;
}

const LIFETIME: Record<ToastKind, number> = { error: 8000, info: 2500 };
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
    (kind: ToastKind, text: string) => {
      const id = nextId.current++;
      setToasts((list) => {
        // the same message twice in a row only resets its timer
        const rest = list.filter((t) => !(t.kind === kind && t.text === text));
        return [...rest, { id, kind, text }].slice(-MAX_TOASTS);
      });
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), LIFETIME[kind]),
      );
    },
    [dismiss],
  );

  const toast = useMemo<Toaster>(
    () => ({ error: (text) => push("error", text), info: (text) => push("info", text) }),
    [push],
  );
  return { toasts, toast, dismiss };
}
