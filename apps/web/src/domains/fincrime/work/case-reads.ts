import type { OperationId, Schemas } from "@ehf/ui-contracts";
import type { CallArgs, ResultOf } from "@ehf/ui-client";
import { usePolled, type Polled } from "@ehf/ui-client/react";
import { useEffect, useRef } from "react";
import { api } from "../../../app/api";

export type CaseRoom = Schemas["CaseRoom"];

export function useCaseRoom(caseId: string): Polled<CaseRoom> {
  return usePolled(api, "getFincrimeCasesCaseIdRoom", { path: { caseId } });
}

/**
 * Case projections without their own poll (claims, ownership, screening, history) follow the
 * room: when its polled sequence advances, they refetch, so every region shows one case state.
 */
export function useCaseRead<K extends OperationId>(operationId: K, args: CallArgs<K>, caseSequence: number, options: { enabled?: boolean } = {}): Polled<ResultOf<K>> {
  const polled = usePolled(api, operationId, args, options);
  useFollowSequence(polled, caseSequence);
  return polled;
}

export function useFollowSequence(polled: { refresh: () => void; data: unknown }, caseSequence: number): void {
  const seen = useRef(caseSequence);
  useEffect(() => {
    if (seen.current === caseSequence) return;
    seen.current = caseSequence;
    if (polled.data !== undefined) polled.refresh();
  }, [caseSequence, polled]);
}
