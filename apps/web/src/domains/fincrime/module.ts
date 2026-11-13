import {
  inStudio,
  StudioHome,
  MovedSurface,
  SetupMoved,
} from "../../studio/pages";
import { PROCESS_NAV, STUDIO_SANDBOX } from "../../studio/navigation";
import { createElement } from "react";
import type { DomainModule, SurfaceRoute, Template } from "@ehf/ui-shell";
import { lazyRouteComponent } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { placeholder } from "../../shell/surface-placeholder";
import { decisionOptions } from "./decision-options";

const lazy = (load: () => Promise<{ default: ComponentType }>): ComponentType =>
  lazyRouteComponent(load);

const r = (
  path: string,
  surfaceId: string,
  title: string,
  template: Template,
  requires: readonly string[],
  component: ComponentType,
): SurfaceRoute => ({
  path,
  surfaceId,
  title,
  template,
  requires,
  component,
});
const later = (
  path: string,
  surfaceId: string,
  title: string,
  template: Template,
  requires: readonly string[],
): SurfaceRoute =>
  r(
    path,
    surfaceId,
    title,
    template,
    requires,
    placeholder(surfaceId, title, "M8"),
  );

const WORK = ["human_work.read", "case.read"];
const caseRoom = lazy(() => import("./surfaces/work/case-room"));

/** The FinCrime domain module (ALIGNMENT §5). Registered with the shell; never imported by it. */
export const fincrimeModule: DomainModule = {
  id: "fincrime",
  label: "Financial crime",
  studios: [
    {
      id: "work",
      label: "Workspace",
      icon: "inbox",
      route: "/work",
      requires: WORK,
    },
    {
      id: "processes",
      label: "Process Studio",
      icon: "workflow",
      route: "/studio",
      requires: ["draft.read", "release.read"],
      navigation: PROCESS_NAV,
    },
    {
      id: "context",
      label: "Context",
      icon: "layers",
      route: "/context",
      requires: ["draft.read"],
      catalogLinks: [
        {
          label: "Context catalog",
          route: "/catalogs/context",
          requires: ["draft.read"],
        },
      ],
    },
    {
      id: "assurance",
      label: "Assurance",
      icon: "flight",
      route: "/assurance",
      requires: ["run.read", "human_work.read"],
    },
  ],
  routes: [
    r(
      "/context/cases",
      "CXT-07",
      "Case relationships",
      "Instrument",
      ["draft.read", "case.read"],
      lazy(() => import("./surfaces/context/case-traversal")),
    ),
    r(
      "/work",
      "BIZ-01",
      "My Workspace",
      "Queue",
      WORK,
      lazy(() => import("./surfaces/work/my-workspace")),
    ),
    r(
      "/work/cases/$caseId",
      "BIZ-02",
      "Case room",
      "CaseRoom",
      ["case.read"],
      caseRoom,
    ),
    r(
      "/work/cases/$caseId/$section",
      "BIZ-02",
      "Case room",
      "CaseRoom",
      ["case.read"],
      caseRoom,
    ),
    r(
      "/work/cases/$caseId/lens/ownership",
      "BIZ-03",
      "Ownership workbench",
      "CaseRoom",
      ["case.read"],
      lazy(() => import("./surfaces/work/ownership")),
    ),
    r(
      "/work/cases/$caseId/lens/documents",
      "BIZ-02",
      "Documents",
      "CaseRoom",
      ["case.read"],
      lazy(() => import("./surfaces/work/documents")),
    ),
    later("/work/cases/$caseId/lens/edd", "BIZ-04", "EDD", "CaseRoom", [
      "case.read",
    ]),
    later("/work/cases/$caseId/lens/aml", "BIZ-05", "AML", "CaseRoom", [
      "case.read",
    ]),
    r(
      "/work/cases/$caseId/lens/screening",
      "BIZ-06",
      "Screening",
      "CaseRoom",
      ["case.read"],
      lazy(() => import("./surfaces/work/screening")),
    ),
    r(
      "/work/cases/$caseId/lens/risk",
      "BIZ-07",
      "Risk",
      "CaseRoom",
      ["case.read"],
      lazy(() => import("./surfaces/work/risk")),
    ),
    later("/work/cases/$caseId/lens/qa", "BIZ-08", "QA lens", "CaseRoom", [
      "case.read",
    ]),
    r(
      "/work/decisions/$caseId",
      "BIZ-07",
      "Decision desk",
      "DecisionDesk",
      ["case.read"],
      lazy(() => import("./surfaces/work/decision-desk")),
    ),
    later("/work/ops", "BIZ-09", "Operations", "Queue", ["human_work.read"]),
    r(
      "/studio",
      "STU-01",
      "Process Studio",
      "Instrument",
      ["draft.read", "release.read"],
      StudioHome,
    ),
    {
      ...r(
        "/studio/drafts",
        "PLT-02",
        "Draft processes",
        "Instrument",
        ["draft.read"],
        inStudio(lazy(() => import("../../platform/surfaces/drafts"))),
      ),
      authoring: true,
    },
    {
      ...r(
        "/studio/drafts/$draftId",
        "PLT-03",
        "Draft process",
        "Instrument",
        ["draft.read"],
        inStudio(lazy(() => import("../../platform/surfaces/draft-workspace"))),
      ),
      authoring: true,
    },
    {
      ...r(
        "/studio/drafts/$draftId/policies",
        "PLT-04",
        "Policy Studio",
        "Instrument",
        ["draft.read"],
        inStudio(lazy(() => import("../../platform/surfaces/policy-studio"))),
      ),
      authoring: true,
    },
    ...[STUDIO_SANDBOX, `${STUDIO_SANDBOX}/$runId`].map(path => ({
      ...r(path, "STU-SANDBOX", "Sandbox Runs", "Instrument", ["run.read"],
        inStudio(lazy(() => import("../../studio/sandbox/SandboxRuns")))),
      authoring: true,
    })),
    r(
      "/studio/published",
      "PLT-11",
      "Published processes",
      "Instrument",
      ["release.read"],
      inStudio(lazy(() => import("../../platform/surfaces/releases"))),
    ),
    {
      ...r(
        "/studio/agents",
        "STU-02",
        "Agents",
        "Instrument",
        ["draft.read"],
        inStudio(
          lazy(async () => ({
            default: (await import("../../platform/surfaces/workbench"))
              .AgentWorkbench,
          })),
        ),
      ),
      authoring: true,
    },
    {
      ...r(
        "/studio/skills",
        "STU-03",
        "Skills",
        "Instrument",
        ["draft.read"],
        inStudio(
          lazy(() => import("./surfaces/agents/skills-studio")),
        ),
      ),
      authoring: true,
    },
    {
      ...r(
        "/studio/policies",
        "PLT-04",
        "Policy Studio",
        "Instrument",
        ["draft.read"],
        inStudio(lazy(() => import("../../platform/surfaces/policy-studio"))),
      ),
      authoring: true,
    },
    r(
      "/platform/data-sources",
      "DAT-01",
      "Data sources",
      "Console",
      ["draft.read", "capability.read"],
      lazy(() => import("./surfaces/context/data-sources")),
    ),
    r(
      "/studio/agents/mandates",
      "AGT-01",
      "Workforce Atlas",
      "Atlas",
      ["draft.read"],
      lazy(() => import("./surfaces/agents/atlas")),
    ),
    r(
      "/studio/skills/definitions/$skillId",
      "AGT-04",
      "Skill",
      "Instrument",
      ["draft.read"],
      lazy(() => import("./surfaces/agents/skill")),
    ),
    r(
      "/studio/agents/mandates/$agentId",
      "AGT-02",
      "Agent profile",
      "Instrument",
      ["draft.read"],
      lazy(() => import("./surfaces/agents/agent-profile")),
    ),
    r(
      "/studio/agents/mandates/$agentId/tasks/$taskId",
      "AGT-03",
      "Taskboard and Skillboard",
      "Instrument",
      ["draft.read"],
      lazy(() => import("./surfaces/agents/taskboard")),
    ),
    later(
      "/studio/agents/mandates/$agentId/rehearsal/$runId",
      "AGT-06",
      "Rehearsal",
      "Preview",
      ["run.read"],
    ),
    later(
      "/studio/agents/mandates/$agentId/publish",
      "AGT-07",
      "Publish and diff",
      "Instrument",
      ["release.read"],
    ),
    r("/agents", "AGT-01", "Agent mandates", "Atlas", ["draft.read"], () =>
      createElement(MovedSurface, { to: "/studio/agents/mandates" }),
    ),
    r(
      "/agents/skills/$skillId",
      "AGT-04",
      "Skill",
      "Instrument",
      ["draft.read"],
      () =>
        createElement(MovedSurface, {
          to: "/studio/skills/definitions/$skillId",
        }),
    ),
    r(
      "/agents/$agentId",
      "AGT-02",
      "Agent profile",
      "Instrument",
      ["draft.read"],
      () =>
        createElement(MovedSurface, { to: "/studio/agents/mandates/$agentId" }),
    ),
    r(
      "/agents/$agentId/tasks/$taskId",
      "AGT-03",
      "Taskboard",
      "Instrument",
      ["draft.read"],
      () =>
        createElement(MovedSurface, {
          to: "/studio/agents/mandates/$agentId/tasks/$taskId",
        }),
    ),
    r(
      "/agents/$agentId/rehearsal/$runId",
      "AGT-06",
      "Rehearsal",
      "Preview",
      ["run.read"],
      () =>
        createElement(MovedSurface, {
          to: "/studio/agents/mandates/$agentId/rehearsal/$runId",
        }),
    ),
    r(
      "/agents/$agentId/publish",
      "AGT-07",
      "Publish",
      "Instrument",
      ["release.read"],
      () =>
        createElement(MovedSurface, {
          to: "/studio/agents/mandates/$agentId/publish",
        }),
    ),
    r(
      "/context",
      "CXT-01",
      "Contextboard",
      "Instrument",
      ["draft.read"],
      lazy(() => import("./surfaces/context/contextboard")),
    ),
    r(
      "/context/connections",
      "CXT-05",
      "Edit context",
      "Instrument",
      ["draft.read"],
      SetupMoved,
    ),
    r(
      "/context/sources/$sourceId",
      "CXT-05",
      "Context source setup",
      "Instrument",
      ["draft.read"],
      SetupMoved,
    ),
    r(
      "/context/mappings/$mappingId",
      "CXT-05",
      "Context source setup",
      "Instrument",
      ["draft.read"],
      SetupMoved,
    ),
    r(
      "/context/documents",
      "CXT-06",
      "Document search",
      "Instrument",
      ["case.read", "evidence.read"],
      lazy(() => import("./surfaces/context/context-documents")),
    ),
    r(
      "/context/preview",
      "CXT-04",
      "Context preview",
      "Preview",
      ["draft.read"],
      lazy(() => import("./surfaces/context/context-preview")),
    ),
    r(
      "/assurance",
      "ASR-01",
      "Mission Control",
      "Queue",
      ["run.read", "human_work.read"],
      lazy(() => import("./surfaces/assurance/mission-control")),
    ),
    r(
      "/assurance/recorder/$caseId",
      "ASR-02",
      "Flight Recorder",
      "Recorder",
      ["event.read"],
      lazy(() => import("./surfaces/assurance/recorder")),
    ),
    r(
      "/assurance/lineage/$caseId",
      "ASR-03",
      "Decision lineage",
      "Lineage",
      ["case.read"],
      lazy(() => import("./surfaces/assurance/lineage")),
    ),
    later("/assurance/lab", "ASR-04", "Assurance Lab", "Queue", ["run.read"]),
    r(
      "/assurance/packages",
      "ASR-05",
      "Assurance packages",
      "Queue",
      ["case.read"],
      lazy(() => import("./surfaces/assurance/packages")),
    ),
  ],
  decisionOptions,
  commandLabel: (type) => type.replace(/([a-z])([A-Z])/g, "$1 $2"),
  reasonLabel: () => undefined,
};
