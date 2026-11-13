import type { Schemas } from "@ehf/ui-contracts";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { HumanDecisionSheet } from "../../../shell/trusted/HumanDecisionSheet";

type QueueItem = Schemas["HumanQueueItem"];
type DecisionOption = Schemas["DecisionOption"];
export type DecisionRequest = { mode: "decide" | "resolve"; item: QueueItem; options: DecisionOption[] | null };

const DecisionContext = createContext<((request: DecisionRequest) => void) | null>(null);

/**
 * Holds the one open TrustedDecisionSheet for a surface, above the lists that show the work
 * item. The sheet stays open while the item completes and leaves the case (it then shows
 * "Recorded. This item is complete."), and it closes only when the person closes it (N6).
 */
export function DecisionHost({ liveItems, children }: { liveItems: readonly QueueItem[]; children: ReactNode }) {
  const [request, setRequest] = useState<DecisionRequest | null>(null);
  const open = useCallback((next: DecisionRequest) => setRequest(next), []);
  const live = request ? liveItems.find((entry) => entry.workItem.workItemId === request.item.workItem.workItemId) : undefined;
  return (
    <DecisionContext.Provider value={open}>
      {children}
      {request ? (
        <HumanDecisionSheet
          open
          onClose={() => setRequest(null)}
          item={request.item}
          liveItem={live}
          mode={request.mode}
          options={request.options}
        />
      ) : null}
    </DecisionContext.Provider>
  );
}

export function useDecisionSheet(): (request: DecisionRequest) => void {
  const open = useContext(DecisionContext);
  if (!open) throw new Error("useDecisionSheet needs a DecisionHost");
  return open;
}
