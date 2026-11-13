import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";

export type OntologySelection = { kind: "object"; id: string; field?: string } | { kind: "relation"; id: string } | null;
export function useOntologySelection() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const selection: OntologySelection = typeof search.relation === "string" ? { kind: "relation", id: search.relation }
    : typeof search.object === "string" ? { kind: "object", id: search.object, ...(typeof search.field === "string" ? { field: search.field } : {}) } : null;
  const select = useCallback((next: OntologySelection) => {
    void navigate({ to: ".", replace: true, search: (previous: Record<string, unknown>) => {
      const { object: _o, field: _f, relation: _r, ...rest } = previous;
      return { ...rest, ...(next?.kind === "relation" ? { relation: next.id } : next ? { object: next.id, ...(next.field ? { field: next.field } : {}) } : {}) };
    } } as never);
  }, [navigate]);
  return { selection, select };
}
