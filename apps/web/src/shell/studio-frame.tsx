import { WorkspaceLayout } from "@ehf/ui-shell";
import { createContext, useContext, type ReactNode } from "react";

type StudioDefaults = { orient: ReactNode; orientLabel: string };

export const StudioContext = createContext<StudioDefaults | null>(null);

/**
 * The domain studio frame (WorkspaceLayout, §8.2) as a surface sees it. The shell provides the
 * studio's default orientation (its navigation); a surface may replace it (the case room's
 * "My Work" panel) and add an inspector and a bottom rail. Region positions never move.
 */
export function StudioFrame({ children, orient, inspector, rail, labels, focusMain }: {
  children: ReactNode;
  /** Replaces the studio navigation. Pass `studioNav` from `useStudioNav()` to keep it inside your own panel. */
  orient?: ReactNode;
  inspector?: ReactNode;
  rail?: ReactNode;
  focusMain?: boolean;
  labels?: { orient?: string; inspector?: string; rail?: string };
}) {
  const defaults = useContext(StudioContext);
  return (
    <WorkspaceLayout
      orient={orient ?? defaults?.orient}
      main={children}
      inspector={inspector}
      rail={rail}
      focusMain={focusMain}
      labels={{ orient: labels?.orient ?? defaults?.orientLabel, inspector: labels?.inspector, rail: labels?.rail }}
    />
  );
}

/** The studio navigation the shell would show, for surfaces that compose their own orientation. */
export function useStudioNav(): ReactNode {
  return useContext(StudioContext)?.orient ?? null;
}
