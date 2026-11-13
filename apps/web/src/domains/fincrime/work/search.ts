import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";

/** Several search parameters changed in one navigation, so state never passes through a half-set URL. */
export function usePatchSearch(): (patch: Record<string, string | undefined>) => void {
  const navigate = useNavigate();
  return useCallback((patch) => {
    void navigate({ to: ".", replace: true, search: (previous: Record<string, unknown>) => {
      const next = { ...previous };
      for (const [key, value] of Object.entries(patch)) { if (value === undefined || value === "") delete next[key]; else next[key] = value; }
      return next;
    } } as never);
  }, [navigate]);
}

/** A search parameter as text. The router parses "1" as a number, so the parsed type is ignored. */
export function useSearchText(): (key: string) => string | undefined {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  return (key) => (search[key] === undefined || search[key] === null || search[key] === "" ? undefined : String(search[key]));
}
