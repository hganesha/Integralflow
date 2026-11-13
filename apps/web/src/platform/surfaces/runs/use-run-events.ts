import { operationMeta } from "@ehf/ui-client";
import type { ApiError } from "@ehf/ui-client";
import type { Schemas } from "@ehf/ui-contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../app/api";

export type RuntimeEvent = Schemas["runtimeEvent"];

const PAGE = 200;
const MAX_PAGES = 10;
const MAX_BACKOFF_MS = 60_000;

/**
 * Merge a page of events into what we already hold: keyed by sequence (no duplicates) and
 * ordered by sequence (PLT-07 AC1). A replayed sequence keeps the first copy we saw.
 */
export function mergeEvents(held: readonly RuntimeEvent[], incoming: readonly RuntimeEvent[]): RuntimeEvent[] {
  const bySequence = new Map(held.map((event) => [event.sequence, event]));
  for (const event of incoming) if (!bySequence.has(event.sequence)) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

export function lastSequence(events: readonly RuntimeEvent[]): number {
  return events.length ? events[events.length - 1]!.sequence : 0;
}

/**
 * Incremental run events: each poll asks only for `after = last sequence` and follows
 * `nextCursor`, then appends. Polls at the contract interval, pauses while hidden, backs off
 * on failure and keeps what it already holds (§4.3).
 */
export function useRunEvents(runId: string, options: { enabled?: boolean; poll?: boolean } = {}) {
  const held = useRef<{ runId: string; events: RuntimeEvent[] }>({ runId, events: [] });
  if (held.current.runId !== runId) held.current = { runId, events: [] };
  const [failures, setFailures] = useState(0);
  const previouslyPolling = useRef(options.poll);
  const interval = (operationMeta("getRunsRunIdEvents")?.xPoll?.intervalMs as number | undefined) ?? 3000;

  const query = useQuery<RuntimeEvent[], ApiError>({
    queryKey: ["getRunsRunIdEvents", { path: { runId } }, "incremental"],
    enabled: options.enabled ?? true,
    queryFn: async ({ signal }) => {
      let events = held.current.events;
      let after = lastSequence(events);
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await api.getRunsRunIdEvents({ path: { runId }, query: { after, limit: PAGE }, signal });
        events = mergeEvents(events, result.events);
        const next = lastSequence(events);
        if (!result.nextCursor || next === after) break;
        after = next;
      }
      if (held.current.runId === runId) held.current.events = events;
      return events;
    },
    refetchInterval: options.poll === false ? false : () => Math.min(interval * 2 ** failures, MAX_BACKOFF_MS),
    refetchIntervalInBackground: false,
    retry: false,
  });

  useEffect(() => {
    if (query.isError) setFailures((count) => count + 1);
    else if (query.isSuccess) setFailures(0);
  }, [query.isError, query.isSuccess, query.dataUpdatedAt, query.errorUpdatedAt]);

  const { refetch } = query;
  useEffect(() => {
    if (options.enabled !== false && previouslyPolling.current === true && options.poll === false) void refetch();
    previouslyPolling.current = options.poll;
  }, [options.enabled, options.poll, refetch]);

  return {
    events: query.data ?? held.current.events,
    loading: query.isPending,
    error: query.error ?? null,
    updatedAt: query.dataUpdatedAt || null,
    refresh: () => void query.refetch(),
  };
}
