import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.WEB_E2E_PORT ?? 5199);
const contextHttpUrl = process.env.CONTEXT_HTTP_URL;

/**
 * UI journeys and acceptance tests (BUILD-SPEC v2 §11.3) against the mock: apps/web's Vite
 * dev server in mock mode.
 */
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  use: { baseURL: contextHttpUrl ?? `http://127.0.0.1:${port}`, trace: "off", ...(process.env.WEB_BROWSER_CHANNEL?{channel:process.env.WEB_BROWSER_CHANNEL}:{} ) },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  ...(contextHttpUrl ? {} : { webServer: {
    command: `node ../../scripts/ui-sync.mjs --if-stale && pnpm --dir ../../apps/web exec vite --mode mock --port ${port} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  } }),
});
