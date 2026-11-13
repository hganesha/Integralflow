import "@ehf/ui-tokens/tokens.css";
import "@ehf/ui-kit/base.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createQueryClient } from "./app/query-client";
import { router } from "./router";
import { probeOnboarding } from "@ehf/ui-client/onboarding";

async function start() {
  const queryClient = createQueryClient();
  if (import.meta.env.VITE_API_MODE === "mock") {
    const { bootMock } = await import("./mock-bootstrap");
    await bootMock(queryClient);
  }
  if (import.meta.env.VITE_API_MODE === "http") {
    if (await probeOnboarding()) {
      const { default: Onboarding } = await import("./onboarding/Onboarding");
      createRoot(document.getElementById("root")!).render(<StrictMode><Onboarding /></StrictMode>);
      return;
    }
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void start();
