import { useCallback, useSyncExternalStore } from "react";

/**
 * Screen-level draft store for the Administration tabs (BUILD-SPEC §10 PLT-14 delta 1).
 * Only the active tab is mounted, so drafts live here rather than in component state and
 * survive a tab switch. Memory only: nothing is written to storage and a reload discards.
 */
const drafts = new Map<string, unknown>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readDraft<T>(key: string): T | undefined {
  return drafts.get(key) as T | undefined;
}

export function writeDraft<T>(key: string, value: T | undefined): void {
  if (value === undefined) drafts.delete(key);
  else drafts.set(key, value);
  emit();
}

/** Drop every draft whose key starts with `prefix` (e.g. after a confirmed save). */
export function discardDrafts(prefix: string): void {
  for (const key of [...drafts.keys()]) if (key.startsWith(prefix)) drafts.delete(key);
  emit();
}

export function hasDrafts(prefix: string): boolean {
  return [...drafts.keys()].some((key) => key.startsWith(prefix));
}

/**
 * A draft value seeded from `initial` until edited. Returns the current value, a setter and
 * whether an edit is held.
 */
export function useDraft<T>(key: string, initial: T): [T, (next: T) => void, boolean, () => void] {
  const stored = useSyncExternalStore(subscribe, () => drafts.get(key), () => undefined) as T | undefined;
  const set = useCallback((next: T) => writeDraft(key, next), [key]);
  const discard = useCallback(() => writeDraft(key, undefined), [key]);
  return [stored === undefined ? initial : stored, set, stored !== undefined, discard];
}

/** Re-render when any draft under `prefix` changes (for "unsaved" markers on tabs). */
export function useHasDrafts(prefix: string): boolean {
  return useSyncExternalStore(subscribe, () => hasDrafts(prefix), () => false);
}
