export const SKILL_SECTIONS = [
  { value: "overview", label: "Overview" },
  { value: "contract", label: "Contract & schemas" },
  { value: "requirements", label: "Context requirements" },
  { value: "guardrails", label: "Guardrails" },
  { value: "usage", label: "Agents & tasks" },
] as const;
export const SOURCE_SECTIONS = [
  { value: "source", label: "Source files" },
  { value: "evaluate", label: "Dataset evaluations" },
  { value: "history", label: "Revisions & publication" },
] as const;
export type StudioTab =
  | (typeof SKILL_SECTIONS)[number]["value"]
  | (typeof SOURCE_SECTIONS)[number]["value"];
