# Agentic KYC and KYB: archive the deterministic flows, build an agent flow

Status: approved 2026-11-09; phases 0 to 4 built, phase 5 started (section 11). Phases 5 and 6 continue as the waves of the [delivery plan](agentic-onboarding-delivery-plan.md). Decisions are recorded in section 10;
markers **(decide)** remain only where a choice is still open.

Companions: [production slice 1](production-slice-1.md) (the first agent-profile plan and its
evaluation harness), [agent profiles](agent-profiles.md), [agent loop](agent-loop.md),
[runtime adapters](runtime-adapters.md), [capability adapters](capability-adapters.md),
[jurisdiction source authorization](jurisdiction-source-policy.md),
[test context corpus](test-context-corpus.md).

## 1. Goal

Replace the two deterministic reference flows (KYC 45 nodes, KYB 49 nodes, 28 and 33 hard-wired
skill steps) with one simple, readable flow:

```
intake agent ─▶ POLICY ─▶ gate ─▶ { documents · identity · ownership* · screening · investigation } ─▶ risk & EDD agent
     ─▶ gate ─▶ decision agent ─▶ QA agent ─▶ gate ─▶ HUMAN (dual control) ─▶ result
                                                         * KYB only
```

About 10 agents, a policy layer and a human decision, where:

- **agents** own a mandate and run business skills (deterministic code) plus bounded model
  reasoning for judgment;
- **policy** is selected per case from the case's jurisdiction, bank (institution and booking
  entity), product and customer type, and decides which skills are required, with which thresholds;
- **gates** are deterministic policy checks between stages; agents can never pass them by
  assertion;
- **humans** make every consequential decision.

Agents and skills run where the bank wants: the local runtime, a hosted runtime (Azure, including
next to Azure AI Foundry), or Databricks. Local development and evaluation use OpenRouter.

## 2. What exists and what changes

| Exists | Use in the new flow |
| --- | --- |
| 229 library skills (deterministic Python), skill host, `skill.execution.v1` | Unchanged: agents call them |
| 7 library business agent profiles (`apps/fincrime-host/profiles`) and task specs with completion criteria and failure policies | The roster's starting point (section 4) |
| Agent profiles, bounded agent loop, context plane, gateway receipts and budgets | The agent node's machinery |
| KYC policy-as-code (`domains/kyc/policy`: catalog, decision tables, golden corpus, OPA bundle), candidate banking policy, source-policy artifacts | Policy layer, generalized to policy packs (section 5) |
| Runtime adapters `local_http`, `hosted_http`, `databricks`; capability adapters `openrouter`, `databricks-serving`, `databricks-uc`, `skills` | Execution targets (section 7) |
| Production slice 1: profile-per-skill plan, slice policy, evaluation harness, held-out split, `agent.qualification.v1` | Carried over: policy, evaluation and qualification path |
| Context corpus heroes and answer keys | Local end-to-end tests and parity checks |

What the platform cannot do yet, and this plan builds:

1. **An agent node that runs several business skills.** Today a node binds one skill, and a loop
   may only select among that skill's implementations. A call to another skill has no selection
   record, so the gateway refuses it.
2. **Runtime-built input for agent-chosen skills.** Skill input (records, pinned policy section,
   context envelope) must be assembled by the runtime, never written by a model. The model may
   supply only parameters validated against the skill's input schema, as the library's own
   `AgentRunner.prepare` does.
3. **Task completion checked by the runtime.** The library's task specs say which steps must
   complete and what an ambiguous, missing or unavailable result means (`NEEDS_REVIEW`,
   `NEEDS_EVIDENCE`, `BLOCKED`). The platform does not enforce them yet.
4. **Policy selected per case.** A plan pins one policy today. Cases for different jurisdictions or
   banks need several pinned packs and a deterministic choice among them.
5. **KYB gates.** KYB has no OPA bundle.

## 3. Archive the deterministic flows

**What moves.** Only the two deterministic workflow packages:

| From | To |
| --- | --- |
| `domains/kyc/v2` | `domains/archive/kyc-v2-deterministic` (done) |
| `domains/kyb` | `domains/archive/kyb-deterministic` (done) |
| `artifacts/kyc-v2.plan.json`, `artifacts/kyb.plan.json` | `artifacts/archive/` (done) |
| `scripts/sync-kyc-package.mjs`, `scripts/sync-kyb-package.mjs` | stay, with paths updated, so archived packages still regenerate |

**What stays.** `domains/kyc/policy` (policy-as-code and its golden corpus), `domains/fincrime/
banking-policy.json`, the connector stages (`scripts/lib/kyb-connectors.mjs`), the library, the
skill host and every platform package. These are inputs to the new flow, not part of the old one.

**How it stays useful (decided: frozen in the repository).** Archived packages stay
compiled and tested in CI as a frozen regression baseline, marked archived in `domains/archive/README.md` (the packages' own files stay byte-identical, so their plan digests do not change), in the
authoring templates (read-only "Archived (deterministic)" entries) and in the UI catalog. Their run
results on the corpus heroes become the **parity oracle**: where the agentic flow and the
deterministic flow disagree on a hero, the difference is reviewed, never silently accepted.
Production slice 1 (`domains/kyb-screening`) is folded into the new KYB flow once that flow reaches
parity, then archived too.

**Blast radius (measured).** 28 code, test and configuration files reference the two packages: control-API
package and policy-authoring tests, case-API gate tests, runtime-langgraph KYC/KYB tests, admission
and plan tests, the catalog snapshot, the document-extraction plan script, the UI catalog fixtures,
the Makefile and CI. Most are path updates; tests that exercise generic platform behavior through
these plans keep running against the archived copies.

## 4. The agents

Ten agents for KYB, nine for KYC (no ownership agent). Seven come from the library; three are new.
Each agent profile states its mandate, the skills it may run (required ones chosen by policy), the
read-only connectors it may call, its context purposes, its output schema, its model tier and its
loop limits.

| # | Agent | Source | Skills (examples) | Model tier |
| --- | --- | --- | --- | --- |
| 1 | Intake & profile | library `agent.intake_profile` | `case.create`, `party.profile.build`, `party.type.classify`, `party.role.resolve`, `party.activity.profile`, `party.product.profile` | standard |
| 2 | Document intelligence | library `agent.document_intelligence` | `document.classify.catalog`, `document.fields.contract_extract`, `document.validity.assess`, `document.consistency.assess`, `document.request.compose` | standard |
| 3 | Identity & verification | new (split from `agent.identity_ownership`) | `entity.resolve`, `entity.identity.verify`, `entity.identifiers.validate`, `registry.company.verify` | standard |
| 4 | Ownership & control (KYB) | library `agent.identity_ownership` | `ownership.graph.build`, `ownership.interest.calculate`, `ownership.ubo.resolve`, `ownership.ubo.verify`, `ownership.control.resolve` | deep |
| 5 | Screening | library `agent.screening` | `screening.name.normalize`, `screening.sanctions.execute`, `screening.pep.execute`, `screening.match.disambiguate`, `screening.sanctions.ownership.evaluate` | standard |
| 6 | Adverse media & investigation | new | `screening.adverse_media.execute`, `investigation.evidence.collect`, `investigation.contradiction.detect`, `investigation.gaps.identify`, `investigation.findings.synthesize` | deep |
| 7 | Risk & EDD | library `agent.risk_edd` | `risk.factor.evaluate`, `risk.customer.assess`, `risk.tier.assign`, `edd.trigger.evaluate`, `edd.scope.plan`, `edd.source_of_funds.verify` | deep |
| 8 | Relationship & product | new | banking-product readiness, `party.product.profile`, `party.expected_behavior.model`, `monitor.customer.schedule` | standard |
| 9 | Decision support | library `agent.decision_support` | `decision.requirements.compile`, `decision.rules.evaluate`, `decision.gaps.evaluate`, `decision.recommendation.generate` | deep |
| 10 | QA & assurance | library `agent.qa_assurance` | `quality.coverage.assess`, `quality.findings.verify`, `quality.hallucination.detect`, `quality.policy.compliance` | judge (a different model) |

The policy layer and the human are not agents. A later monitoring and periodic-review agent reuses
the same roster for lifecycle events.

**(decide)** Roster: split identity from ownership (recommended, so KYC uses one fewer agent and
each mandate stays narrow), and add relationship & product as its own agent rather than folding it
into intake or risk.

## 5. Policy: per case, per jurisdiction, per bank

### Policy packs

A **policy pack** is the unit of policy, layered and content-addressed:

```
baseline (jurisdiction-neutral control semantics)
  └─ jurisdiction pack      US · UK · EU (each its own regulatory requirements and sources)
       └─ institution pack  the bank's risk appetite, thresholds, approval roles, EDD triggers
            └─ product pack deposit · payments · lending · trade finance · correspondent · ...
```

Each layer may only tighten the layer below (a stricter threshold, an added requirement, a narrower
allowed source), never loosen it. The compiler resolves the layers into one **effective pack** per
(jurisdiction, institution, product, customer type), digests it, and emits:

- the skill policy projections (`policy_context_fields`) every skill already reads;
- the agent requirements: for each agent, which skills are required, which are optional, and the
  completion criteria (from the library task specs, narrowed by policy);
- an OPA bundle for the gates (generalizing the KYC decision tables to KYB);
- the source-policy artifacts for external data (jurisdiction source authorization).

This reuses existing pieces: the KYC catalog, decision tables and golden corpus compile path, the
banking policy's party roles and product controls, the slice policy's per-value basis, and the
source-policy artifacts.

### Selection per case

A plan pins every effective pack it may use, by digest. At intake, a deterministic **policy
resolution** node reads the case's reviewed source context (institution, booking entity,
jurisdiction, product, customer type, lifecycle event) and selects exactly one pinned pack, or
stops for a person when none or more than one applies. The case is then pinned to that pack;
every skill, agent and gate reads only it. A case can never select a pack its plan did not pin.

### Gates

| Gate | Before | Checks |
| --- | --- | --- |
| intake-ready | the parallel stage | policy authority pinned, customer and parties established, required documents known |
| decision-ready | decision support | required evidence present and current, screening complete for every required subject, EDD scoped where triggered |
| disposition | the human | what the platform may route without a person (nothing by default); BLOCK and UNKNOWN stop |

Gate outcomes come only from OPA over canonical records. An agent's findings can raise a case to
REVIEW; they can never satisfy a gate.

## 6. How an agent node runs skills

One agent node replaces a chain of skill nodes:

1. **Plan (deterministic).** The runtime reads the case's effective pack and the agent's task:
   required skills and their bound parameters.
2. **Run required skills (deterministic).** Each runs with runtime-built input (records, pinned
   policy section, context envelope) and its own selection record and receipt. Results commit
   through the existing skill-commit path.
3. **Reason (model, bounded loop).** The model sees the skill results and context. It may run
   optional skills from its allowed set and call its read-only connectors. For a skill it names
   only the skill and parameters; the runtime builds the rest and refuses anything outside the
   profile. Observations return as untrusted, provenance-labelled sections.
4. **Check completion (deterministic).** The task's completion criteria and failure policy decide
   the node's outcome: `COMPLETED`, `NEEDS_REVIEW`, `NEEDS_EVIDENCE` or `BLOCKED`. The model cannot
   mark a task complete.
5. **Commit.** Skill effects via the skill-commit path. The agent's own output (findings,
   proposals, rationale) is schema-validated `AGENT_DERIVED` evidence. Agents cannot write gate
   results, status changes or dispositions (already enforced by the compiler).

The deterministic flow becomes the floor: every skill the policy requires still runs, in a known
order, with recorded inputs. The model adds judgment where the data needs it: disambiguation,
ownership gaps, adverse-media relevance, EDD scoping and rationale.

Platform work: a node-level `config.skills` list (validated against the profile's `allowedSkills`
and pinned bindings), several skill bindings per node in the plan and the gateway's selection
check, `skill` tool calls in the loop protocol with runtime-built input, and task completion
evaluation in the runtime.

## 7. Where agents and skills run

Each agent profile names a runtime target; administered runtime bindings can repoint a target
without recompiling (`runtime-adapters.md`).

| Option | Agent loop runs in | Skills run in | Models | Status |
| --- | --- | --- | --- | --- |
| Local | `local_http` runtime host (Compose) | skill host container | OpenRouter, or recorded offline | exists |
| Azure (models from Azure OpenAI / Foundry) | `hosted_http`: the runtime image on Azure Container Apps (`scripts/deploy-azure.mjs`) | skill host on Azure | OpenRouter, or Azure OpenAI / Foundry models through a new gateway model adapter | runtime exists; model adapter new (phase 7) |
| Databricks | `databricks`: runtime image as a Databricks App | skill host as a Databricks App (`SKILL_HOST_AUTH=databricks_app`), or Unity Catalog functions (`databricks-uc`) | Databricks serving endpoints (`databricks-serving`) | exists; asset-bundle templates open |
| Vendor-native agent | the agent is a capability called from a node (a Databricks Mosaic AI agent endpoint through `databricks-serving:<endpoint>:responses`) | inside the vendor agent; its tools are not platform skills | vendor | exists for Databricks |

**Foundry (decided).** Migration `041_cloud_neutral` deliberately removed the Azure Foundry runtime
adapter and the `foundry-agent` capability adapter, and they stay removed. Foundry enters as a
**model provider**: an Azure OpenAI / Foundry model adapter in the capability gateway, beside
OpenRouter, selected through model profiles. The agent loop keeps running in the platform's own
runtime (local, `hosted_http` on Azure, or Databricks), so every skill and tool call stays
governed. Agents running inside Foundry Agent Service are out of scope.

## 8. Testing locally with OpenRouter

1. `cp .env.local.example .env.local`, set `OPENROUTER_API_KEY`; `make up`. The key reaches only the
   capability gateway. Without it the recorded model answers, so CI never calls a model.
2. Seed corpus heroes into cases (`pnpm corpus:seed --party H04`), each pinned to its effective
   policy pack.
3. Compile, admit and release the new plans; run them on the heroes. KYC: H01, H02, H03, H10.
   KYB: H04, H06, H12, plus generated held-out parties.
4. Compare each run with the hero's answer key and with the archived deterministic flow's result
   (the parity oracle).
5. Agent evaluation, live on OpenRouter: proposal agreement, citation validity, escalation recall,
   authority violations (must be zero) and an injection pack, producing `agent.qualification.v1`
   evidence. Budgets cap cost per run (`maxCostUsd`, `maxModelCalls`).
6. CI runs the same flows with the recorded model and scripted loop fixtures, so it is
   deterministic, offline and free.

## 9. Phases

| Phase | Scope | Exit |
| --- | --- | --- |
| 0. Archive | Move the two packages and plans; mark them archived in READMEs, authoring templates and the UI catalog; keep them compiled and tested; update the visual story | CI green; archived plans compile byte-identically; new authoring starts from the agentic templates |
| 1. Agent-with-skills node | `config.skills`, several skill bindings per node, `skill` tool calls with runtime-built input, task completion evaluation, gateway selection records per skill | Compiler, runtime and gateway tests; one agent runs its required skills plus an optional one on a hero, recorded model |
| 2. Policy packs | Layered pack format, effective-pack compiler, per-case selection, OPA gates for KYC and KYB, migration of the KYC catalog, banking policy and slice policy into packs | US baseline plus one institution pack compile; golden-corpus decisions unchanged for KYC; KYB gate corpus added |
| 3. Agents | Ten profiles (seven imported, three new), instructions, output schemas, tool sets, model tiers | Profiles compile within their bounds; each agent passes its scripted-model tests |
| 4. Flows | `domains/kyc-agentic` and `domains/kyb-agentic` from one topology and generator; compiled plans | About 15 graph nodes each; package tests like production slice 1's |
| 5. Local end to end | Compose run on seeded heroes with OpenRouter; recorded fixtures for CI | Every KYC and KYB hero reaches the expected human decision point; parity differences reviewed |
| 6. Evaluation | Agent harness on dev and held-out splits; corpus documents (corpus Phase 4) and adverse media (H09) | `agent.qualification.v1` evidence per agent with owner thresholds; skill evidence per pack |
| 7. Hosted runtimes | Per-agent targets on Azure (`hosted_http`) and Databricks; Databricks asset bundle; Azure OpenAI / Foundry model provider adapter | The same hero runs complete on each target with identical gate outcomes |
| 8. Retire | Fold production slice 1 into KYB agentic; archive it | One active KYC flow and one active KYB flow |

Phases 1 and 2 are independent and can run in parallel; 3 needs 1; 4 needs 1 to 3.

## 10. Decisions (2026-11-09)

| # | Decision | Outcome |
| --- | --- | --- |
| 1 | Archive mode | **Frozen in the repository**: `domains/archive/`, compiled and tested in CI, the regression baseline and parity oracle |
| 2 | Flow packaging | Open; this plan assumes one topology generating separate KYC and KYB plans |
| 3 | Foundry | **Azure OpenAI / Foundry models as a model provider** next to OpenRouter (section 7); no Foundry runtime or agent adapter |
| 4 | Roster | Open; this plan assumes the ten agents in section 4 |
| 5 | First policy scope | **US and UK from the start**, each with a jurisdiction pack, plus one synthetic institution pack; per-case selection is tested across both jurisdictions in phase 2 |
| 6 | Model tiers and cost ceiling | Open; the section 4 tiers are the default for local OpenRouter testing |
| 7 | First build | **Phase 0 (archive) and phase 1 (agent-with-skills node)** now, tested on corpus heroes with recorded models |

## 11. Build status

| Phase | Status |
| --- | --- |
| 0. Archive | Done. `domains/archive/{kyc-v2-deterministic,kyb-deterministic}` and `artifacts/archive/`; both plans compile to their pre-archive digests; generators, Makefile, CI and tests follow; `domains/archive/README.md` |
| 1. Agent-with-skills node | Done, in this shape: required skills stay ordinary skill nodes that run as the agent's profile (they keep their write path, approvals and commits); the agent's loop may additionally choose **read-only loop skills** with runtime-built input (`call_skill`); the runtime judges **task completion** over the agent's skill nodes from the library task specs. Contracts, harnessc rules, admission, gateway, skills adapter, delegation, context plane and runtime are skill-aware ([agent-loop.md](agent-loop.md#loop-skills)). Production slice 1's two review agents use it |

| 2. Policy packs | Done ([policy-packs.md](policy-packs.md)): layered, tighten-only packs with legal basis (US and GB, synthetic bank, five product layers), four effective packs, per-case selection from the BankingRelationship, per-pack skill policy projections chosen by the case's pin, and pack checkpoints for intake-ready, decision-ready and disposition. Not done, deliberately: OPA bundles for the pack gates and a KYB decision-table catalog, which belong with the separate OPA rework |
| 3. Agents | Done ([agent-roster.md](agent-roster.md)): ten agents (seven library, three new) with mandates, required and loop skills, tools, model tiers, completion and output schemas; compiled as a roster plan and tested with scripted models |
| 4. Flows | Done ([agentic-flows.md](agentic-flows.md)): `domains/kyc-agentic` (nine agents, personal-banking packs) and `domains/kyb-agentic` (ten agents, business-banking packs) from one generator; bound parameters that fail closed, per-pack skill policies, three pack checkpoints and a person under dual control; reviews now see their own skills' results; the identity agent reads the document agent's assertions and pages |
| 5. Local end to end | Started: document and identity agents run live with Claude over H02, H03 and H04 (synthetic documents with an answer key; all scored checks pass) through `scripts/live-agent-run.ts`; five defects found and fixed. A Claude reasoning connector (`anthropic` provider kind) joins OpenRouter. Not yet: the composed services, the other eight agents live, recorded fixtures for CI |

Model-chosen skills with write effects are not supported: a write needs the skill-commit path, a
node of its own and, where required, an approval. Loop skills are therefore read-only by rule.

