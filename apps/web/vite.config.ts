import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// MSW belongs to ui-mock; resolve through its declared dependency boundary.
const require = createRequire(new URL('../../packages/ui-mock/package.json', import.meta.url));

/** Keep the article's repository source canonical and include it in every web build. */
function visualStory(): Plugin {
  const source = new URL('../../docs/visual-story.html', import.meta.url);
  return {
    name: "ehf-visual-story",
    configureServer(server) {
      server.middlewares.use("/visual-story.html", (_request, response) => {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(readFileSync(source, "utf8"));
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "visual-story.html", source: readFileSync(source, "utf8") });
    },
  };
}

/**
 * Serve MSW's service worker in mock-mode dev only. It is never written to `public/`, so an
 * http build cannot ship it (BUILD-SPEC v2 §4.4).
 */
function mockServiceWorker(): Plugin {
  return {
    name: "ehf-mock-service-worker",
    apply: "serve",
    configureServer(server) {
      if (server.config.mode !== "mock") return;
      const source = readFileSync(require.resolve("msw/mockServiceWorker.js"), "utf8");
      server.middlewares.use("/mockServiceWorker.js", (_request, response) => {
        response.setHeader("content-type", "text/javascript");
        response.end(source);
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), mockServiceWorker(), visualStory()],
  define: {
    "import.meta.env.VITE_API_MODE": JSON.stringify(mode === "mock" ? "mock" : "http"),
  },
  server: {
    port: 5173,
    // In http mode the BFF serves /api and /auth; Vite only proxies them.
    proxy: mode === "http" ? {
      "/api": { target: process.env.BFF_URL ?? "http://127.0.0.1:4200", changeOrigin: false },
      "/auth": { target: process.env.BFF_URL ?? "http://127.0.0.1:4200", changeOrigin: false },
    } : undefined,
  },
  build: { outDir: "dist", sourcemap: true },
}));
