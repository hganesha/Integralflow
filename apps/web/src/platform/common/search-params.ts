import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";

/**
 * One URL search parameter as state (filters, tabs, selection live in the URL, ui-specs §1.5).
 * Setting a value replaces history so filters don't fill the back stack.
 */
export function useSearchParam(name: string): [string | undefined, (value: string | undefined) => void] {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const raw = search[name];
  const value = raw === undefined || raw === null || raw === "" ? undefined : String(raw);
  const set = useCallback((next: string | undefined) => {
    void navigate({
      to: ".",
      replace: true,
      search: (previous: Record<string, unknown>) => {
        const copy = { ...previous };
        if (next === undefined || next === "") delete copy[name];
        else copy[name] = next;
        return copy;
      },
    } as never);
  }, [name, navigate]);
  return [value, set];
}
