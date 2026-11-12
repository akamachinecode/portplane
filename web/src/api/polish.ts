import type { Http } from "./http";
import type { Theme } from "./types";

// M5.5: update checks (ADR-0025), the diagnostic report, a test
// notification and the native window's theme. The mock is mockPolish.ts.

export type UpdateTool = "portplane" | "dekit" | "portless";

/** One tool's answer to "Check for updates" (internal/updates). */
export interface UpdateItem {
  id: UpdateTool;
  name: string;
  installed?: string;
  latest?: string;
  /** latest is newer than installed. */
  update: boolean;
  /** The release notes. */
  notes?: string;
  /** Why the check failed, for the user. */
  error?: string;
}

export interface UpdateCheck {
  checkedAt: string;
  items: UpdateItem[];
}

/** Where the diagnostic report went (internal/server/diagnostics.go). */
export interface SavedReport {
  path: string;
  /** The user picked the place; otherwise it is in Downloads, shown in the file manager. */
  dialog: boolean;
  revealed: boolean;
}

export interface PolishApi {
  /** The last update check, or null before the first one. */
  updates(): Promise<UpdateCheck | null>;
  /** Asks the official sources now; only reads. */
  checkUpdates(): Promise<UpdateCheck>;
  /** Builds the report and saves it; null when the user cancels the save dialog. */
  exportDiagnostics(): Promise<SavedReport | null>;
  /** Shows a sample system notification; fails when the desktop has none. */
  testNotification(): Promise<void>;
  /** The native window's title bar follows the theme the page shows. */
  setWindowTheme(theme: Theme): Promise<void>;
}

export function createPolishHttp(h: Http): PolishApi {
  return {
    updates: () => h.json<UpdateCheck | null>("GET", "/api/updates"),
    checkUpdates: () => h.json<UpdateCheck>("POST", "/api/updates/check", {}),
    async exportDiagnostics() {
      const res = await h.send("POST", "/api/diagnostics", {});
      if (res.status === 204) return null;
      if (!res.ok) throw await h.fail(res);
      return (await res.json()) as SavedReport;
    },
    testNotification: () => h.none("POST", "/api/notifications/test", {}),
    setWindowTheme: (theme) => h.none("PUT", "/api/window/theme", { theme }),
  };
}
