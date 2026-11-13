# Bounded agent loop

An `agent` or `evaluate` node with `config.loop` runs a bounded plan → act → observe
loop instead of a single model call. Implementation: `packages/runtime-langgraph/src/agent-loop.ts`.

```yaml
- id: investigation
  kind: agent
  config:
    agentRef: agent.kyc.investigation.v1
    loop:
      maxSteps: 8                 # 1..20 and <= the profile's limits.maxSteps; exhausting it fails the node
      tools: [business.registry.lookup.v1, screening.pep.v1]   # connectors; may be empty when skills are listed
      skills:                       # business skills the model may choose to run (optional)
        - skillId: screening.pep.relationship.resolve
          contextSelectorIds: [recPEPRelationship-investigation-screening-pep-relationship-resolve]
          skillPolicy: {...}        # the pinned policy projection, as on a skill node
      maxObservationChars: 12000  # <= the profile's limits.maxObservationChars; larger results become a digest stub + preview
      repairAttempts: 1           # re-asks once when the final output fails the schema
```

## Authority

- **Compiler** (`harnessc`): every tool must be a declared, non-model capability. On a v2
  node with an agent profile ([agent-profiles.md](agent-profiles.md)) every tool must be in
  the profile's `allowedCapabilities` (`workflow.loop_tool_not_allowed_by_agent_profile`);
  `maxSteps` and `maxObservationChars` may narrow the profile's `limits` but not exceed
  them, and a limit the node omits is filled from the profile. The node must bind a model
  capability. Tools are added to the node's permission envelope and to the plan.
- **Runtime limits**: `loopConfigFor` clamps `maxSteps` and `maxObservationChars` to the
  node's profile limits, so the profile bounds the loop even for a plan that did not come
  from harnessc.
- **Runtime**: a model step or tool call is an ordinary `invokeCapability` with its own
  execution envelope; `invokeCapability` refuses any capability outside the node's
  envelope before calling the gateway.
- **Gateway**: unchanged. It already authorizes any capability in the node's envelope,
  re-checks the fence, reserves budget and records a receipt per invocation, so
  `budgets.maxModelCalls` / `maxCapabilityCalls` bound the loop as well as `maxSteps`.

## Protocol

The model sees the context-plane prompt (the profile's prompt and instructions, task,
trust-labelled context), the tool catalog (`id`, `kind`, `effect`, `inputSchema`) and the rules, and
must return exactly one of:

```json
{"action": "call_tool", "tool": "<id>", "input": {...}, "rationale": "..."}
{"action": "call_skill", "skill": "<skill id>", "parameters": {...}, "rationale": "..."}
{"action": "final", "output": {...}, "rationale": "..."}
```

The runtime, not the model, enforces: unknown tools, schema-invalid input and repeats of
an already-observed call are refused without reaching the gateway and returned as
observations; a non-protocol reply costs a step; a final answer must validate against the
agent's `outputSchema` (one repair, then `runtime.agent_output_invalid`).

## Observations

Tool results re-enter through the context plane (`withObservations`) as
`UNTRUSTED_EXTERNAL` sections with the gateway receipt as provenance, run through the
injection tripwire (quarantined if instruction-like) and are stubbed to a digest when
large; oldest observations are stubbed first when the budget is tight.

## Replay and audit

Invocation IDs are `run:node:step:digest(capability, input)`, so a resumed run replays
recorded gateway receipts instead of calling vendors again. Each step is journalled as
`agent.step.<action>` with tool, input/output/receipt digests and error codes — never
content.

## Offline

The recorded model answers the loop protocol with an immediate schema-shaped `final`
fixture and never calls tools, so offline runs make no connector calls nobody scripted.

## Loop skills

A loop may list business skills (`config.loop.skills`) the model can choose to run, next to its
connectors. The model names a skill and its parameters, nothing else:

- **The runtime builds the input.** It assembles a context pack from that skill's own selectors (a
  subset of the node's), resolves the case's pinned policy projected to the skill's fields, and
  builds `SkillCapabilityInput.v1` exactly as for a skill node. Missing required records, an
  unresolved policy or a case pinned to another policy means the skill is not called; the model
  sees a `NEEDS_EVIDENCE` observation with the gaps.
- **The loop checks the call first.** A skill that is not the node's, parameters that fail the
  skill's parameter schema (the pinned candidate's contract) and a repeat of an observed call are
  refused without reaching the gateway.
- **The gateway checks the skill.** The call carries a selection record naming the skill
  (`reason: agent_selected`), and the gateway accepts it only as a pinned candidate of this node's
  binding for that skill (`skillBindingForNode(plan, node, skillId)`); a call to a loop skill's
  candidate without a selection record is refused. The skills adapter and dependency delegation
  resolve the binding the same way.
- **Results are observations.** Loop skills must be read-only (harnessc); their payloads come back
  as untrusted observations and commit nothing. A finding worth keeping goes into the agent's
  final output, which is captured as agent-derived evidence.

harnessc refuses: a skill the package does not bind (`workflow.loop_skill_undeclared`), a
non-read-only skill (`workflow.loop_skill_not_read_only`), a skill outside the agent profile
(`workflow.loop_skill_not_allowed_by_agent_profile`, and its candidates must be in the profile's
`allowedCapabilities`), a selector the node does not read
(`workflow.loop_skill_selector_not_on_node`), duplicates and unknown fields, and loop skills on a
node without an agent profile. Admission re-checks that every candidate is in the node's envelope
and the skill is read-only.

## Task completion

An agent node may declare `config.completion`: criteria over predecessor skill nodes that run as
the same agent profile (each node's accepted statuses and required payload fields) and a failure
policy, as in the library's TaskSpec. After the loop the runtime evaluates it
(`evaluateTaskCompletion`) and attaches the result to the node value as `__taskCompletion`, with
an `agent.task.<status>` event. The outcome is the most severe failed criterion's mapped outcome
(`BLOCKED` > `NEEDS_EVIDENCE` > `NEEDS_REVIEW`), or `COMPLETED`. An agent that asks for human review
raises a completed task to `NEEDS_REVIEW`; nothing the model says can lower an outcome. harnessc
requires a loop, an agent profile, skill-node targets of the same profile and targets upstream of
the node.

