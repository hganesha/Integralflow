export const STUDIO_PATH = "/studio";
export const STUDIO_DRAFTS = "/studio/drafts";
export const STUDIO_SANDBOX = "/studio/sandbox-runs";
export const STUDIO_PUBLISHED = "/studio/published";
export const STUDIO_AGENTS = "/studio/agents";
export const STUDIO_SKILLS = "/studio/skills";
export const DATA_SOURCES = "/platform/data-sources";
export const PROCESS_NAV = [
  {
    label: "Draft processes",
    route: STUDIO_DRAFTS,
    requires: ["draft.read"],
    authoring: true,
  },
  {
    label: "Sandbox Runs",
    route: STUDIO_SANDBOX,
    requires: ["run.read"],
    authoring: true,
  },
  {
    label: "Published processes",
    route: STUDIO_PUBLISHED,
    requires: ["release.read"],
  },
  {
    label: "Agents",
    route: STUDIO_AGENTS,
    requires: ["draft.read"],
    authoring: true,
  },
  {
    label: "Skills",
    route: STUDIO_SKILLS,
    requires: ["draft.read"],
    authoring: true,
  },
  {
    label: "Policy Studio",
    route: "/studio/policies",
    requires: ["draft.read"],
    authoring: true,
  },
] as const;
