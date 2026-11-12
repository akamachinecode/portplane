// The base styles first, so each component's and view's own CSS comes after.
import "./fonts.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createHttpApi, type Api } from "./api/client";
import { applyAppearance, cachedAppearance } from "./lib/preferences";
import { safeLocalStorage } from "./lib/storage";
import { readToken } from "./lib/token";

// Paint in the last theme and density right away; the saved preferences
// arrive a moment later and win.
const appearance = cachedAppearance(safeLocalStorage());
if (appearance) applyAppearance(document.documentElement, appearance);

async function loadApi(): Promise<Api> {
  // `?mock` (dev builds only) runs the UI on an in-memory snapshot; the
  // branch and the mock module are dropped from production builds.
  if (import.meta.env.DEV) {
    const params = new URLSearchParams(location.search);
    if (params.has("mock")) {
      const { createMockApi } = await import("./api/mock");
      const { registerCommandSource } = await import("./shell/commands");
      const mock = createMockApi((params.get("mock") || "default") as Parameters<typeof createMockApi>[0]);
      // for poking at the mock from the console, e.g. portplaneMock.touchSetupFolder()
      (window as unknown as { portplaneMock: typeof mock }).portplaneMock = mock;
      registerCommandSource("mock", () => [
        { id: "mock.job", title: "Run a demo job", group: "Developer", icon: "jobs", hint: "mock", run: () => mock.startDemoJob() },
        { id: "mock.job.fail", title: "Run a failing demo job", group: "Developer", icon: "jobs", hint: "mock", run: () => mock.startDemoJob(true) },
      ]);
      return mock;
    }
  }
  return createHttpApi(readToken(document));
}

void loadApi().then((api) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App api={api} />
    </StrictMode>,
  );
});
