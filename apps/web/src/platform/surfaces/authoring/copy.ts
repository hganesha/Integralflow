import type { ApiError } from "@ehf/ui-client";
import { reasonCopy } from "../../common";

/**
 * Authoring-specific copy for reason codes (ui-specs §4, §7.7). Shared codes live in
 * platform/common; unknown codes fall back to the server's message.
 */
const AUTHORING_COPY: Record<string, string> = {
  "authoring.compile_failed": "Compilation failed. Fix the diagnostics below, then compile again.",
  "authoring.evaluation_failed": "Evaluation gates failed. Review the report, fix the sources, then compile again.",
  "authoring.orchestration_node_invalid": "The group or subgraph is invalid. Review the diagnostics below.",
  "authoring.node_id_invalid": "Use a lowercase ID with letters, digits, and hyphens.",
  "authoring.node_duplicate": "A node with that ID already exists.",
  "authoring.node_not_found": "That node no longer exists in the draft. The canvas has been refreshed.",
  "authoring.edge_endpoint_invalid": "Connect two different nodes that exist in the workflow.",
  "authoring.edge_not_found": "That connection no longer exists. Close the insertion form and choose a current connection.",
  "authoring.node_name_required": "Give this step a name before saving.",
  "authoring.graph_mutation_invalid": "This graph change is incomplete or invalid. Review the fields and try again.",
  "authoring.delete_boundary_node_forbidden": "Input and output nodes cannot be deleted.",
  "authoring.agent_not_found": "That agent is no longer registered. Refresh the agent registry.",
  "authoring.draft_not_found": "This draft no longer exists.",
  "authoring.lifecycle_conflict": "Someone else moved this draft to another stage. The draft has been refreshed.",
  "authoring.compile_requires_draft": "Only a DRAFT can be compiled. Edit the sources to start a new revision.",
  "authoring.evaluate_requires_compiled": "Compile the draft before running evaluation gates.",
  "policy.production_blocked": "Production release is blocked. Close these release blockers first.",
  "policy.signature_invalid": "The bundle signature could not be verified. Nothing was approved.",
  "policy.revision_conflict": "Someone saved a newer policy revision. Reload the history, then save again.",
};

export function authoringCopy(error: ApiError): string {
  return reasonCopy(error, (code) => AUTHORING_COPY[code]);
}
