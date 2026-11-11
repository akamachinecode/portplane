import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createHttpApi, type Api } from "./api/client";
import { readToken } from "./lib/token";
import "./styles.css";

async function loadApi(): Promise<Api> {
  // `?mock` (dev builds only) runs the UI on an in-memory snapshot; the
  // branch and the mock module are dropped from production builds.
  if (import.meta.env.DEV) {
    const params = new URLSearchParams(location.search);
    if (params.has("mock")) {
      const { createMockApi } = await import("./api/mock");
      const mock = createMockApi((params.get("mock") || "default") as Parameters<typeof createMockApi>[0]);
      // for poking at the mock from the console, e.g. portplaneMock.touchSetupFolder()
      (window as unknown as { portplaneMock: typeof mock }).portplaneMock = mock;
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
