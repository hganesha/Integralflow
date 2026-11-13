import { ApiError } from "@ehf/ui-client";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { markSessionEnded } from "./session-events";

/**
 * Global error policy (§9.1, Shell AC5/AC6):
 * - 401 anywhere ends the session and opens the sign-in dialog;
 * - 403 role_missing means roles changed under us, so the session is refetched and
 *   navigation and controls re-filter; csrf.invalid also refetches the session.
 */
export function applyErrorPolicy(client: QueryClient, error: unknown): void {
  if (!(error instanceof ApiError)) return;
  if (error.status === 401) markSessionEnded(true);
  if ((error.status === 403 && error.reason === "authorization.role_missing") || error.reason === "csrf.invalid") {
    void client.invalidateQueries({ queryKey: ["session"] });
  }
}

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: (error) => applyErrorPolicy(client, error) }),
    mutationCache: new MutationCache({ onError: (error) => applyErrorPolicy(client, error) }),
    defaultOptions: { queries: { retry: false, staleTime: 2_000, refetchOnWindowFocus: true }, mutations: { retry: false } },
  });
  return client;
}
