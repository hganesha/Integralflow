# Agent profiles

Status: implemented for `harness.factory/plan-v2` plans and `domain-package-v2` packages
(compiler compatibility version 4, or 5 with integrations), the only plan and package
contracts. The v1 pipeline, whose packages carried `skills` and `agents`, was removed.

An agent profile is the one contract for an agent in a v2 plan: who it is, what it is told,
which capabilities and business skills it may use, which context it may read and how long
its loop may run. It replaces the v2 pair of agent registrations (`agents`) and agent
playbooks (`skills`). From here on "skill" means only a business skill
([business-skills.md](business-skills.md)): `skillBindings`, node `config.skillId`,
`harness_control.business_skill_registry`.

## Contract

Plan key `agentProfiles` (schema `agentProfileSchema` in `packages/contracts`):

```
{
  id, version, name, description, role, prompt,
  instructions: [ { id, version, name, description, text, allowedCapabilityIds: [] } ],
  allowedCapabilities: [],          // computed by harnessc
  allowedSkills: [ { skillId, semver } ],
  modelProfileId, runtimeTarget, caseWrites, primaryCapabilityId?, inputSchema, outputSchema,
  purposes: [],
  limits: { maxSteps, maxObservationChars }
}
```

- `instructions` are the former playbooks, folded in and kept in authored order.
- `allowedCapabilities` is the sorted union of every instruction's `allowedCapabilityIds`
  and `primaryCapabilityId`. It is never authored.
- `allowedSkills` lists the business skills the profile may run, sorted by `skillId`.
- `purposes` lists the context purposes the profile may read, sorted and unique.
- `limits` bounds the node's agent loop. Defaults: `maxSteps` 8, `maxObservationChars`
  64000. Bounds are those of `config.loop`: `maxSteps` 1..20, `maxObservationChars`
  256..200000.

The authored form in a v2 `package.yaml` (`packageAgentProfileSchema`) has the same fields
except `allowedCapabilities`, which is refused. Instruction `text` is required; `limits`,
`allowedSkills`, `purposes`, `caseWrites` and an instruction's `allowedCapabilityIds` may be
omitted. Example: `packages/contracts/test-fixtures/agent-profiles/package.yaml` (the KYC v2
package before it moved onto library skills).

A node runs as a profile with `config.agentRef` (and optionally `config.agentVersion`).
Node `config.skillRefs` is retired in v2.

## Compiler rules (harnessc)

| Rule | Error codes |
| --- | --- |
| A package declares `agentProfiles`; `skills:` or `agents:` (even empty) refuses it. A `domain-package-v1` package is refused outright. | `package.agent_profiles_required:skills`, `package.agent_profiles_required:agents`, `package.v1_removed` |
| 1. Profile ids are unique; instruction ids are unique within a profile. | `package.agent_profile_duplicate`, `package.agent_profile_instruction_duplicate` |
| 2. Every instruction capability and `primaryCapabilityId` is a declared package capability. `allowedCapabilities` is not authored. | `package.agent_profile_capability_undeclared`, `package.agent_profile_allowed_capabilities_computed` |
| 3. `config.agentRef` resolves to a profile, and `agentVersion`, if set, equals its version. `config.skillRefs` is refused. | `workflow.agent_profile_missing`, `workflow.agent_profile_version_mismatch`, `workflow.skill_refs_retired` |
| 4. The node's `config.capabilityId` and every `config.loop.tools` entry are in `allowedCapabilities`. A profile without instructions allows only its primary capability. Replaces `workflow.loop_tool_not_allowed_by_skills`. | `workflow.capability_not_allowed_by_agent_profile`, `workflow.loop_tool_not_allowed_by_agent_profile` |
| 5. A node with both `agentRef` and `config.skillId` has that skill in `allowedSkills` at the binding's semver. Every `allowedSkills` entry exists in `skillBindings` at that semver. | `workflow.skill_not_allowed_by_agent_profile`, `package.agent_profile_skill_unbound`, `package.agent_profile_skill_semver_mismatch` |
| 6. Every purpose of a context selector the node reads is in `purposes`. | `workflow.context_purpose_not_allowed_by_agent_profile` |
| 7. `config.loop.maxSteps` and `maxObservationChars` may narrow the profile's limits but not exceed them. A limit the node omits is filled from the profile in the compiled node. | `workflow.loop_max_steps_exceeds_agent_profile`, `workflow.loop_observation_chars_exceeds_agent_profile`, `package.agent_profile_limits_invalid` |
| 8. Every agent loop skill (`config.loop.skills`) is bound in the package, read-only, in the profile's `allowedSkills` at the bound version with its candidates in `allowedCapabilities`, and reads only selectors the node reads ([agent-loop.md](agent-loop.md#loop-skills)). | `workflow.loop_skill_undeclared`, `workflow.loop_skill_not_read_only`, `workflow.loop_skill_not_allowed_by_agent_profile`, `workflow.loop_skill_capability_not_allowed_by_agent_profile`, `workflow.loop_skill_selector_not_on_node`, `workflow.loop_skills_require_agent_profile` |
| 9. Task completion (`config.completion`) is on an agent node with a loop and an agent profile, and every criterion targets an upstream skill node of the same profile. | `workflow.completion_node_kind_invalid`, `workflow.completion_requires_loop`, `workflow.completion_requires_agent_ref`, `workflow.completion_target_not_skill_node`, `workflow.completion_target_other_agent`, `workflow.completion_target_not_upstream` |

Other checks: required fields (`package.agent_profile_field_required`), unknown fields
(`package.agent_profile_field_unknown`, `package.agent_profile_instruction_field_unknown`),
`modelProfileId` must be listed in the package's `modelProfiles`
(`package.agent_profile_model_profile_undeclared`), and the runtime target must be a hosted
adapter (`package.agent_profile_runtime_target_invalid`,
`package.production_agent_profile_requires_hosted_runtime`).

The plan's `compiler.compatibilityVersion` is `4` (`5` with integrations); `2`/`3` were the
`skills`/`agents` shape. Implementation: `packages/compiler/src/agent-profiles.ts`; the refusals are pinned in `packages/compiler/src/test-support.ts`.

## Runtime

- Admission (`harnessPlanV2Schema`): a v2 plan with `skills` or `agents` is refused with
  `plan.v2_agent_profiles_required`; a node with `skillRefs` is refused, and an `agentRef`
  that names no embedded profile fails with `plan.agent_profile_missing`.
- Context plane (`resolveInstructions`): reads the node's profile through
  `agentProfileForNode`; the prompt renders the profile's prompt and an `# Instructions`
  section. A bound capability outside `allowedCapabilities` fails the node with
  `context.capability_not_allowed_by_agent_profile`. `ContextInstructions.instructions`
  replaced `ContextInstructions.skills`.
- Agent loop (`loopConfigFor`): clamps `maxSteps` and `maxObservationChars` to the
  profile's limits at run time as well, so a plan that bypassed the compiler still cannot
  exceed them.
- Authoring: v2 drafts are validated and compiled with `agentProfiles`. Registered agents
  and their registered instructions (still stored in `harness_control.agent_registry` and
  `harness_control.skill_registry`) are folded into one profile when an agent is attached
  to, or materialized for, a v2 node; the profile's `purposes` and `allowedSkills` are
  taken from the nodes that run as it. The registry API presents playbooks as agent
  instructions at `/v1/authoring/agent-instructions`. The evaluation check
  `agent-profiles.embedded` replaces `agents.embedded` for v2 plans.

## Qualification

`agent.qualification.v1` (`agentQualificationSchema` in `packages/contracts`) is the evidence
record for one agent as a plan embeds it. `agentQualificationTarget(plan, profileId)` gives what it
must match: the profile's `stableDigest`, its version, its model profile and the revision digest the
plan pinned, the sorted tools of every loop node that runs as the profile, and the plan digest;
`agentQualificationMismatches` lists the differences. Authority counts (protected writes, cleared
alerts, final dispositions) are literal zeros and every injection case must be resisted, whatever
the other metrics. Production enforcement at the gateway is open
([production-slice-1.md](production-slice-1.md) §9).

## Mapping to the skill library's `AgentProfile`

| Library (`AgentProfile`) | Platform (`agentProfiles[]`) |
| --- | --- |
| `id`, `version` | `id`, `version` |
| `instructions` | `prompt` + `instructions[]` |
| `allowed_skills {skill_id: version}` | `allowedSkills [{skillId, semver}]` |
| `capabilities` | `allowedCapabilities` |
| `purposes` | `purposes` |
| `max_agent_steps` | `limits.maxSteps` |
| `model_char_budget` | `limits.maxObservationChars` |
| `model_config_ref` | `modelProfileId` |
| `permissions` | `caseWrites` |
| `timeout_seconds` | not represented yet |
| `max_objects` | not represented yet |

## Migration

- Recompile every v2 package with the current harnessc. A v2 package that still has
  `skills:`/`agents:` must move each agent into `agentProfiles`, with its playbooks as
  `instructions` (`allowedCapabilityIds` stay on each instruction) and `text` in place of
  the playbook's `instructions` string. Remove node `skillRefs`.
- v2 plans compiled before this change are refused at admission
  (`plan.v2_agent_profiles_required`). Plans already admitted in a database fail to parse
  when read; recompile and admit the new plan, then cut a new release.
- v1 plans and packages are no longer supported (`package.v1_removed`, `plan.v1_removed`).
