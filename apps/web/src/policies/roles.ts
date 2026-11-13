/**
 * The roles a diligence rule may require approval from, and how a human requirement reads. No
 * dependencies, so the trusted decision sheet can use it without loading the policy studio.
 */
export const APPROVAL_ROLES: ReadonlyArray<readonly [string, string]> = [
  ["Case.Reviewer", "Case reviewer"], ["KYC.SeniorReviewer", "Senior reviewer"], ["Harness.Approver", "Process flow approver"], ["Case.Analyst", "Case analyst"], ["Legal.HoldOfficer", "Legal hold officer"],
];
export const roleName = (role: string) => APPROVAL_ROLES.find(([id]) => id === role)?.[1] ?? role;

/**
 * Who must decide, in words: "2 case reviewers and 1 senior reviewer (3 people)" when each role has
 * its own quorum, else "2 of Case reviewer or Senior reviewer".
 */
export function requirementText(requirement: { roles: readonly string[]; quorum: number; roleQuorums?: Readonly<Record<string, number>> | undefined }): string {
  const plural = (count: number, role: string) => `${count} ${roleName(role).toLowerCase()}${count === 1 ? "" : "s"}`;
  const quorums = Object.entries(requirement.roleQuorums ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (!quorums.length) return `${requirement.quorum} of ${requirement.roles.map(roleName).join(" or ")}`;
  const listed = quorums.map(([role, count]) => plural(count, role));
  const words = listed.length > 1 ? `${listed.slice(0, -1).join(", ")} and ${listed.at(-1)}` : listed[0]!;
  const total = quorums.reduce((sum, [, count]) => sum + count, 0);
  return `${words}${requirement.quorum > total ? `, ${requirement.quorum} people in all` : quorums.length > 1 || total > 1 ? ` (${requirement.quorum} people)` : ""}`;
}
