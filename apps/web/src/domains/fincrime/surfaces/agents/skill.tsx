import { Navigate, useParams } from "@tanstack/react-router";

/** Preserve old deep links while keeping every skill section in Skill Studio. */
export default function SkillDetail() {
  const { skillId = "" } = useParams({ strict: false }) as { skillId?: string };
  return <Navigate to={"/studio/skills" as string} search={{ source: skillId } as never} replace />;
}
