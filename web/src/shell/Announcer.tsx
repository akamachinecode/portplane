import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../api/types";
import { announceChanges } from "../lib/announce";
import { useShell } from "./ShellContext";

/**
 * A polite live region: screen readers hear apps change state ("admin
 * failed") without moving focus. The text clears after a while, so the same
 * change later is read again.
 */
export function Announcer() {
  const { snapshot } = useShell();
  const prev = useRef<Snapshot | null>(null);
  const [text, setText] = useState("");

  useEffect(() => {
    if (!snapshot) return;
    const said = announceChanges(prev.current, snapshot);
    prev.current = snapshot;
    if (!said) return;
    setText(said);
    const t = setTimeout(() => setText(""), 6000);
    return () => clearTimeout(t);
  }, [snapshot]);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}
