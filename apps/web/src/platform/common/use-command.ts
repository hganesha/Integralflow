import type { OperationId } from "@ehf/ui-contracts";
import { ApiError, type CallArgs, type ResultOf } from "@ehf/ui-client";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { api } from "../../app/api";
import { applyErrorPolicy } from "../../app/query-client";

export type CommandState = "idle" | "committing" | "confirmed" | "failed";

/**
 * Run a mutation the way N6 requires: show "committing" until the response arrives AND the
 * affected reads have been refetched; only then report "confirmed". Never optimistic.
 */
export function useCommand<K extends OperationId>(operationId: K, options: { invalidate?: readonly QueryKey[] } = {}) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<CommandState>("idle");
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<ResultOf<K> | null>(null);

  const run = useCallback(async (args?: CallArgs<K>): Promise<ResultOf<K> | null> => {
    setState("committing");
    setError(null);
    try {
      const response = await api.call(operationId, args);
      const data = response.data as ResultOf<K>;
      // Wait for the follow-up reads before saying "done" (EHF 03, N6).
      await Promise.all((options.invalidate ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      setResult(data);
      setState("confirmed");
      return data;
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : null;
      // A conflict means the current server basis changed. Reload affected reads before
      // presenting the conflict; local editor buffers remain owned by their components.
      if (apiError?.status === 409) {
        await Promise.all((options.invalidate ?? []).map(queryKey => queryClient.invalidateQueries({ queryKey })));
      }
      setError(apiError);
      setState("failed");
      applyErrorPolicy(queryClient, caught);
      if (!apiError) throw caught;
      return null;
    }
  }, [operationId, options.invalidate, queryClient]);

  const reset = useCallback(() => {
    setState("idle");
    setError(null);
    setResult(null);
  }, []);

  return { run, state, error, result, reset, busy: state === "committing" };
}
