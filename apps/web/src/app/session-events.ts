import { useSyncExternalStore } from "react";

/** App-wide "session ended" flag, set by any 401 (§9.1). Unsaved input stays in memory. */
let ended = false;
const listeners = new Set<() => void>();

export function markSessionEnded(value: boolean): void {
  if (ended === value) return;
  ended = value;
  for (const listener of listeners) listener();
}

export function useSessionEnded(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => ended,
  );
}
