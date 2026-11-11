import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The Go binary embeds the build from internal/webui/dist.
// In development, `pnpm dev` proxies /api to a running `portplane serve`
// (PORTPLANE_API, default http://127.0.0.1:4799).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../internal/webui/dist",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: process.env.PORTPLANE_API ?? "http://127.0.0.1:4799",
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: "node",
  },
});
