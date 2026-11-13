import { Navigate, useParams, useRouterState } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { canUse } from "@ehf/ui-shell";
import { useSession } from "../app/session";
import { StudioFrame } from "../shell/studio-frame";
import {
  STUDIO_DRAFTS,
  STUDIO_PUBLISHED,
  STUDIO_AGENTS,
  STUDIO_SKILLS,
  DATA_SOURCES,
} from "./navigation";
import { usePolled } from "@ehf/ui-client/react";
import { api } from "../app/api";
import { Region } from "../platform/common";

export function StudioHome() {
  const session = useSession();
  const home = canUse(session, ["draft.read"], true)
    ? STUDIO_DRAFTS
    : canUse(session, ["release.read"])
      ? STUDIO_PUBLISHED
      : "/studio/agents/mandates";
  return <Navigate to={home as string} replace />;
}
export function MovedSurface({ to, tab }: { to: string; tab?: string }) {
  const params = useParams({ strict: false }) as Record<string, string>;
  const search = useRouterState({
    select: (state) => state.location.search,
  }) as Record<string, unknown>;
  const destination = to.replace(/\$([a-zA-Z]+)/g, (_match, key) =>
    encodeURIComponent(params[key] ?? ""),
  );
  return (
    <Navigate
      to={destination}
      search={{ ...search, ...(tab ? { tab } : {}) } as never}
      replace
    />
  );
}
export function SourcesMoved() {
  return <MovedSurface to={DATA_SOURCES} tab="bindings" />;
}
export function ConnectorOperationsMoved() {
  const search = useRouterState({
    select: (state) => state.location.search,
  }) as Record<string, unknown>;
  return (
    <MovedSurface
      to={DATA_SOURCES}
      tab={typeof search.tab === "string" ? search.tab : "status"}
    />
  );
}
export function SetupMoved() {
  const params = useParams({ strict: false }) as {
    mappingId?: string;
    sourceId?: string;
  };
  const search = useRouterState({
    select: (state) => state.location.search,
  }) as Record<string, unknown>;
  return (
    <Navigate
      to={DATA_SOURCES as string}
      search={
        {
          ...search,
          tab: params.mappingId ? "mappings" : "connections",
          ...(params.mappingId ? { mapping: params.mappingId } : {}),
          ...(params.sourceId ? { source: params.sourceId } : {}),
        } as never
      }
      replace
    />
  );
}
export function WorkbenchMoved() {
  const search = useRouterState({
    select: (state) => state.location.search,
  }) as Record<string, unknown>;
  const id = typeof search.workspace === "string" ? search.workspace : "";
  const workspace = usePolled(
    api,
    "getWorkbenchWorkspace",
    { path: { workspaceId: id }, query: {} },
    { enabled: Boolean(id) },
  );
  const redirect = (kind: string) => (
    <Navigate
      to={(kind === "agent" ? STUDIO_AGENTS : STUDIO_SKILLS) as string}
      search={search as never}
      replace
    />
  );
  return id ? (
    <Region polled={workspace} label="source workspace">
      {(view) => redirect(view.workspace.kind)}
    </Region>
  ) : (
    redirect(
      typeof search.source === "string" && search.source.startsWith("agent.")
        ? "agent"
        : "skill",
    )
  );
}
export function inStudio(Component: ComponentType) {
  return function StudioSurface() {
    return (
      <StudioFrame>
        <Component />
      </StudioFrame>
    );
  };
}
