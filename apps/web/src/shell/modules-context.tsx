import type { Schemas } from "@ehf/ui-contracts";
import type { DomainModule } from "@ehf/ui-shell";
import { createContext, useCallback, useContext } from "react";

const ModulesContext = createContext<readonly DomainModule[]>([]);

/** The registered domain modules, provided by the app root (never imported by shell or platform, N13). */
export const ModulesProvider = ModulesContext.Provider;

/**
 * Decision labels for a human-work item from the first module that recognises it (§8.5).
 * Null means no domain claims the item, and the platform shows Approve · Reject · Return.
 */
export function useDecisionOptions(): (item: Schemas["HumanQueueItem"]) => Schemas["DecisionOption"][] | null {
  const modules = useContext(ModulesContext);
  return useCallback((item) => {
    for (const module of modules) {
      const options = module.decisionOptions(item);
      if (options) return options;
    }
    return null;
  }, [modules]);
}
