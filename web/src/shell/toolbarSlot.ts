import { createContext, useContext } from "react";

// Where a view's title and actions go: the shell's toolbar, along the top
// of the window (ADR-0027). ViewHeader renders into it through a portal;
// without one (before the shell mounts it) the header renders in place.
export const ToolbarSlot = createContext<HTMLElement | null>(null);

export function useToolbarSlot(): HTMLElement | null {
  return useContext(ToolbarSlot);
}
