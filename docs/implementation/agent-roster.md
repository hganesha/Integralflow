# Agent roster

Status: implemented 2026-11-09 (agentic KYC/KYB plan, phase 3). Profiles compile and pass
scripted-model tests; no agent has been evaluated against a live model yet.

Sources: `domains/agents/*.yaml`. Generator: `scripts/sync-agent-roster.mjs` (CI `--check`), which
writes `domains/agents/roster.json` and a roster test package compiled to
`artifacts/agent-roster.plan.json`.

## The ten agents

| # | Agent | Source | Required skills (skill nodes) | Loop skills (read-only, chosen) | Tools | Model |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `agent.intake_profile` | library | party profile build, type classify, profile completeness | activity profile | registry, identifier lookup | standard |
| 2 | `agent.document_intelligence` | library | classify, contract extract, validity, consistency, requirements | request compose | document evidence package | standard |
| 3 | `agent.identity_verification` | new (split from identity_ownership) | entity resolve, identity verify, registry company verify | identifiers validate, relationship resolve | registry, identifier, officers lookup | standard |
| 4 | `agent.identity_ownership` (ownership & control) | library, narrowed | graph build, interest calculate, UBO resolve, UBO verify | circular, control, nominee detection | ownership, officers, registry, identifier lookup | deep |
| 5 | `agent.screening` | library | sanctions, PEP, disambiguate, sanctions ownership (OFAC 50%) | name normalize, PEP relationship, sanctions control | registry, identifier lookup | standard |
| 6 | `agent.investigation` | new | adverse media, evidence collect, findings synthesize | contradiction detect, relationship analyze, gaps identify | adverse-media search, registry lookup | deep |
| 7 | `agent.risk_edd` | library | customer risk, tier assign, EDD trigger | factor evaluate, EDD scope, source of funds, source of wealth | none | deep |
| 8 | `agent.relationship_product` | new | product profile, expected behavior, monitoring schedule | geography profile, industry classify | registry lookup | standard |
| 9 | `agent.decision_support` | library, narrowed | requirements compile, rules evaluate, recommendation; owns the human review step | gaps evaluate | none | deep |
| 10 | `agent.qa_assurance` | library | findings verify, policy compliance | hallucination detect, coverage assess | none | judge |

Individual (KYC) flows leave out the ownership agent. Every skill belongs to exactly one agent.

## Rules the generator enforces

- An imported agent keeps its library mandate, personas and human gates. It may narrow its library
  skills; every skill outside the library profile is listed in `source.additions` with a reason
  (`roster.skill_not_in_library_profile`). Additions today: OFAC ownership evaluation, name
  normalization, PEP relationship and sanctions control (screening); graph, interest, circular,
  control and nominee (ownership); factor evaluation and EDD scope (risk); requirements compilation
  (decision support).
- Every skill exists in the catalog and appears in one agent only; loop skills are read-only
  (`roster.loop_skill_not_read_only`); tools are read-only lookups, never a screening acquisition
  (adverse-media search excepted for the investigator).
- Completion covers the agent's required skills only: the library task's criteria narrowed to them, or
  authored criteria for the three new agents. The human review step is a person's outcome and is not
  part of any agent's task.

## Outputs

Every agent answers in one envelope: `summary`, `findings` (each with severity and at least one cited
record), `gaps`, `requiresHumanReview`, plus its own fields (for example screening `proposals`, never
final; ownership `beneficialOwners` on an ownership or control basis; decision support
`recommendation`, never `final`, always for human review). Schemas forbid extra fields, so an agent
cannot slip in a disposition. Each agent has a worked example its schema accepts.

## Tests

`packages/runtime-langgraph/src/agent-roster.test.ts`, for every agent on the compiled roster plan: the
profile matches the roster; its loop runs a read-only skill with runtime-built input and then returns
its example; an answer missing a required field is refused after one repair; the runtime judges its
task over its own skills, and a missing skill result is `BLOCKED` whatever the agent says. Authority
tests: decision support cannot approve, finalize or skip human review; screening proposals cannot be
final or uncited; every finding needs a citation. QA runs on the judge model, which no other agent uses.

## Not yet

- Live-model evaluation (`agent.qualification.v1` evidence) on OpenRouter, and an injection pack.
- The flows themselves (phase 4): parallel stages, policy-pack projections per pinned pack, parameter
  bindings and pack checkpoints between stages.
