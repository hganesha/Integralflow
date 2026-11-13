// The only file in apps/web allowed to import @ehf/ui-mock (BUILD-SPEC v2 §4.4). It is
// loaded with a dynamic import when VITE_API_MODE === "mock", so http builds exclude it.
import { startMockWorker } from "@ehf/ui-mock/browser";
import type { QueryClient } from "@tanstack/react-query";
import { setSignIn } from "./app/auth";

export async function bootMock(queryClient: QueryClient): Promise<void> {
  await startMockWorker();
  // Persona, scenario, clock and fault changes from the toolbar refetch everything with no
  // reload (Shell AC4).
  window.addEventListener("ehf-mock:change", () => void queryClient.invalidateQueries());
  // The mock signs the persona back in in place; http mode navigates to the BFF instead.
  setSignIn(async () => {
    await fetch("/auth/login?returnTo=%2F");
  });
}
