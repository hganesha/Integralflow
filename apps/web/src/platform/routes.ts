import {
  MovedSurface,
  WorkbenchMoved,
  SourcesMoved,
  ConnectorOperationsMoved,
} from "../studio/pages";
import { createElement } from "react";
import type { IconName } from "@ehf/ui-kit";
import type { SurfaceRoute } from "@ehf/ui-shell";
import { lazyRouteComponent } from "@tanstack/react-router";
import type { ComponentType } from "react";

/** Any read action reaches the platform overview (§8.3). */
export const ANY_READ = [
  "plan.read",
  "run.read",
  "draft.read",
  "capability.read",
  "case.read",
  "evidence.read",
  "receipt.read",
  "event.read",
  "release.read",
  "human_work.read",
  "integration.read",
  "admin.read",
  "telemetry.read",
] as const;

/** Each surface lives in its own file under ./surfaces and loads with its route (code splitting). */
const COMPONENTS: Record<string, ComponentType> = {
  "/platform/workbench": WorkbenchMoved,
  "/platform/context-sources": SourcesMoved,
  "/platform": lazyRouteComponent(() => import("./surfaces/overview")),
  "/platform/drafts": () =>
    createElement(MovedSurface, { to: "/studio/drafts" }),
  "/platform/drafts/$draftId": () =>
    createElement(MovedSurface, { to: "/studio/drafts/$draftId" }),
  "/platform/drafts/$draftId/policies": () =>
    createElement(MovedSurface, { to: "/studio/drafts/$draftId/policies" }),
  "/platform/policies": () =>
    createElement(MovedSurface, { to: "/studio/policies" }),
  "/platform/plans": lazyRouteComponent(() => import("./surfaces/plans")),
  "/platform/plans/$planDigest": lazyRouteComponent(
    () => import("./surfaces/plan-detail"),
  ),
  "/platform/runs": lazyRouteComponent(() => import("./surfaces/runs")),
  "/platform/runs/$runId": lazyRouteComponent(
    () => import("./surfaces/run-detail"),
  ),
  "/platform/traces/$traceId": lazyRouteComponent(
    () => import("./surfaces/trace"),
  ),
  "/platform/cases": lazyRouteComponent(() => import("./surfaces/cases")),
  "/platform/cases/$caseId": lazyRouteComponent(
    () => import("./surfaces/case-detail"),
  ),
  "/platform/human-work": lazyRouteComponent(
    () => import("./surfaces/human-work"),
  ),
  "/platform/releases": () =>
    createElement(MovedSurface, { to: "/studio/published" }),
  "/platform/system": lazyRouteComponent(() => import("./surfaces/system")),
  "/platform/users": lazyRouteComponent(() => import("./surfaces/users")),
  "/platform/admin": lazyRouteComponent(() => import("./surfaces/admin")),
  "/platform/integrations": lazyRouteComponent(
    () => import("./surfaces/integrations"),
  ),
  "/platform/data-connectors": ConnectorOperationsMoved,
  "/platform/document-studio": lazyRouteComponent(() => import("../documents/document-studio")),
  "/platform/document-factory": lazyRouteComponent(() => import("./surfaces/document-factory")),
  "/platform/intelligence": lazyRouteComponent(
    () => import("./surfaces/intelligence"),
  ),
};

const p = (
  path: string,
  surfaceId: string,
  title: string,
  requires: readonly string[],
  authoring = false,
): SurfaceRoute => ({
  path,
  surfaceId,
  title,
  template: "Console",
  requires,
  ...(authoring ? { authoring } : {}),
  component: COMPONENTS[path]!,
});

/** Platform console routes (BUILD-SPEC v2 §8.3). Domain-neutral: never imports a domain (N13). */
export const PLATFORM_ROUTES: readonly SurfaceRoute[] = [
  p("/platform/workbench", "PLT-18", "Skills & agents", ["draft.read"], true),
  p("/platform/context-sources", "PLT-17", "Context sources", [
    "capability.read",
  ]),
  p("/platform", "PLT-01", "Overview", ANY_READ),
  p("/platform/drafts", "PLT-02", "Drafts", ["draft.read"], true),
  p(
    "/platform/drafts/$draftId",
    "PLT-03",
    "Draft workspace",
    ["draft.read"],
    true,
  ),
  p(
    "/platform/drafts/$draftId/policies",
    "PLT-04",
    "Policy Studio",
    ["draft.read"],
    true,
  ),
  p("/platform/policies", "PLT-04", "Policy Studio", ["draft.read"], true),
  p("/platform/plans", "PLT-05", "Plans", ["plan.read"]),
  p("/platform/plans/$planDigest", "PLT-05", "Plan", ["plan.read"]),
  p("/platform/runs", "PLT-06", "Runs", ["run.read"]),
  p("/platform/runs/$runId", "PLT-07", "Run detail", ["run.read"]),
  p("/platform/traces/$traceId", "PLT-08", "Trace", [
    "telemetry.read",
    "run.read",
  ]),
  p("/platform/cases", "PLT-09", "Cases", ["case.read"]),
  p("/platform/cases/$caseId", "PLT-09", "Case", ["case.read"]),
  p("/platform/human-work", "PLT-10", "Human work", ["human_work.read"]),
  p("/platform/releases", "PLT-11", "Releases", ["release.read"]),
  p("/platform/system", "PLT-12", "Health", [
    "capability.read",
    "telemetry.read",
  ]),
  p("/platform/users", "PLT-19", "Users & roles", ["admin.read"]),
  p("/platform/admin", "PLT-14", "Administration", ["admin.read"]),
  p("/platform/integrations", "PLT-15", "Integrations", ["integration.read"]),
  p("/platform/data-connectors", "PLT-18", "Data connectors", ["draft.read"]),
  p("/platform/intelligence", "PLT-16", "Intelligence", ["admin.read"]),
  p("/platform/document-studio", "PLT-22", "Document Studio", ["draft.read"], true),
  p("/platform/document-factory", "PLT-23", "Document Factory", ["dataset.read"]),
];

/** Console navigation: one entry per top-level surface. */
export const PLATFORM_NAV: ReadonlyArray<{
  id: string;
  label: string;
  icon: IconName;
  path: string;
}> = [
  { id: "overview", label: "Overview", icon: "gauge", path: "/platform" },
  { id: "document-studio", label: "Document Studio", icon: "file", path: "/platform/document-studio" },
  { id: "document-factory", label: "Document Factory", icon: "package", path: "/platform/document-factory" },
  { id: "plans", label: "Plans", icon: "package", path: "/platform/plans" },
  { id: "runs", label: "Runs", icon: "activity", path: "/platform/runs" },
  { id: "cases", label: "Cases", icon: "inbox", path: "/platform/cases" },
  {
    id: "human-work",
    label: "Human work",
    icon: "hand",
    path: "/platform/human-work",
  },
  {
    id: "data-sources",
    label: "Data sources",
    icon: "database",
    path: "/platform/data-sources",
  },
  { id: "system", label: "Health", icon: "signal", path: "/platform/system" },
  {
    id: "admin",
    label: "Administration",
    icon: "sliders",
    path: "/platform/admin",
  },
  {
    id: "intelligence",
    label: "Intelligence",
    icon: "cpu",
    path: "/platform/intelligence",
  },
  {
    id: "users", label: "Users & roles", icon: "users", path: "/platform/users",
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: "link",
    path: "/platform/integrations",
  },
];
