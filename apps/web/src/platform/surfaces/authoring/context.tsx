import type { ApiError } from "@ehf/ui-client";
import type { QueryKey } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import type { Draft, TabId } from "./model";

/** Reads every draft mutation refetches before it reports "confirmed" (N6). */
export const DRAFT_READS: readonly QueryKey[] = [["getAuthoringDraftsDraftId"], ["getAuthoringDrafts"], ["getAuthoringDraftsDraftIdTestSamples"], ["getAuthoringDraftsDraftIdScope"]];
export const AGENT_READS: readonly QueryKey[] = [["getAuthoringAgents"], ["getAuthoringSkills"]];
export const REGISTRY_READS: readonly QueryKey[] = [["getGatewayRegistry"]];

export type Feedback = { tone: "ok" | "warn" | "error"; text: string } | null;

export type SourceBuffers = { package: string | null; workflow: string | null; baseRevision: number | null; sourceFiles?:Record<string,string>|null; baseSourceFiles?:Record<string,string> };

/** A 409 on a draft mutation: the revision the edit was based on and what was being saved. */
export type Conflict = { mine: number; label: string; error: ApiError };

export type Workspace = {
  draft: Draft;
  subjectId: string;
  actions: readonly string[];
  /** draft.write held and the draft is not PUBLISHED. */
  canWrite: boolean;
  readOnly: boolean;
  buffers: SourceBuffers;
  setBuffer: (kind: "package" | "workflow", value: string) => void;
  setSourceFiles: (files:Record<string,string>)=>void;
  /** Keep the local edits but base the next save on the server's current revision. */
  rebaseBuffers: () => void;
  clearBuffers: () => void;
  sourcesDirty: boolean;
  feedback: Feedback;
  say: (feedback: Feedback) => void;
  conflict: Conflict | null;
  setConflict: (conflict: Conflict | null) => void;
  selectedNodeId: string | null;
  selectNode: (id: string | null) => void;
  goTo: (tab: TabId, extra?: Record<string, string | undefined>) => void;
};

export const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace outside the draft workspace");
  return value;
}
