import type { Http } from "./http";
import type { Job } from "./jobs";
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

/** How this Portplane was installed, and so how it updates (internal/selfupdate, ADR-0031). */
export type SelfUpdateMethod = "archive" | "app" | "deb" | "rpm" | "homebrew" | "manual";

/** GET /api/updates/self: whether "Update and restart" can update this Portplane. */
export interface SelfUpdatePlan {
  method: SelfUpdateMethod;
  /** "Update and restart" can do it. */
  auto: boolean;
  /** It asks for the administrator password (a .deb or .rpm). */
  password?: boolean;
  /** What gets replaced: a folder, the app or the package. */
  where?: string;
  /** Why Portplane can't update itself; absent when auto. */
  reason?: string;
  /** The command that updates it from a terminal, when there is one. */
  command?: string;
  /** The version running now. */
  running: string;
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
  /** How this Portplane updates. */
  selfUpdatePlan(): Promise<SelfUpdatePlan>;
  /** Installs `version` (the latest the last check found), then restarts Portplane; a job. */
  installUpdate(version: string): Promise<Job>;
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
    selfUpdatePlan: () => h.json<SelfUpdatePlan>("GET", "/api/updates/self"),
    installUpdate: (version) => h.json<Job>("POST", "/api/updates/self/install", { version }),
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
