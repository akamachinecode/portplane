import { useEffect } from "react";
import type { Api } from "../api/client";
import type { Theme } from "../api/types";

/**
 * Tells the binary which theme the page shows, so the native window's title
 * bar matches (ADR-0024). In a browser tab it changes nothing; an older
 * binary without the route is fine too.
 */
export function useWindowTheme(api: Api, theme: Theme | null): void {
  useEffect(() => {
    if (!theme) return;
    api.setWindowTheme(theme).catch(() => {
      // no native window, or an older binary: nothing to sync
    });
  }, [api, theme]);
}
