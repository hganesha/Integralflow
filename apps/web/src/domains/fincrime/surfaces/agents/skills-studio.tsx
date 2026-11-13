import { SkillWorkbench } from "../../../../platform/surfaces/workbench";
import { SkillInformation } from "../../agents/skill-information";

/** Domain metadata plugs into the platform's source, revision and evaluation workspace. */
export default function SkillsStudio() {
  return (
    <SkillWorkbench
      renderSkillInformation={(skillId, section) => (
        <SkillInformation skillId={skillId} section={section} />
      )}
    />
  );
}
