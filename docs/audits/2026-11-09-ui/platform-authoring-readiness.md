# Platform and authoring readiness

> **Implementation update:** The requested health and source authoring gaps below are implemented in the [Platform health and source workbench](platform-workbench/README.md), with real HTTP/SQL/container/browser acceptance evidence and an [Azure acceptance setup](platform-workbench/AZURE.md). This document retains the original baseline audit; its missing-work statements describe that earlier revision. Publication releases source bundles; deployment of those bundles and live Azure model acceptance remain separate.

2026-11-09 · inspected `main` at `1451aab9` after UI PR #59 merged

The platform is not yet a complete, production-verified authoring workbench. All 179 non-mock operations have registered BFF handlers, but that count includes 18 explicitly unavailable projections and does not establish response compatibility or live service behavior. The preview at port 5301 currently serves `MODE: mock` and `VITE_API_MODE: mock`.

## Existing capabilities

| Area | Current implementation | Remaining gap |
| --- | --- | --- |
| Plans, runs and execution | Service-backed lists, admitted-plan detail, execution graph/attempts, events, start/cancel paths. | Trace-store reader is explicitly unavailable; production environment journeys still need verification. |
| Cases | Service-backed list/detail, create, snapshot, audited commands, ledger verification and exports. | Creation currently uses customer onboarding and US jurisdiction. Editing is through business commands; arbitrary record or case-type editing is not provided. Advanced evidence, risk and assurance projections remain partial or unavailable. |
| Drafts and workflows | Source editing, graph editing, compilation and approval/publication lifecycle through control API routes. | The Sources tab edits `package.yaml` and `workflow.yaml`; additional `sourceFiles` are flat, read-only text areas. No general file/folder workspace. |
| Policy Studio | Policy files, compilation, corpus/sample evaluation and real OPA integration. | This is a policy-specific facility, not a skill or agent evaluation workbench. |
| Agent Studio | Source-catalog agent definitions, tasks, allowed skills, context requirements and execution bounds are viewable. | Canonical business-agent definitions are not edited here. Runtime activity is explicitly unobserved when not associated with actual execution. |
| Agent authoring | Registry forms create/edit runtime profiles: prompt, role, model profile, target, I/O schemas, permitted case writes and instruction references. GitHub import exists. | No unified agent file workspace or dataset test bench. Creating a runtime profile does not automatically modify a catalog business-agent definition or an already published plan. |
| Canonical business skills | All catalog skill manifests, I/O schemas, requirements, guardrails, entrypoint and code digest are viewable. Business-skill read APIs exist. | The full Markdown, implementation code, folders, assets and tests are not available as an editable repository. No single-skill source revision/publish workflow in the UI. |
| “Skills” in agent authoring | The legacy form edits instruction text, metadata and capability access. | These are **agent instructions**, served upstream as `agent-instructions`; they are distinct from the canonical business-skill catalog. The UI terminology needs separation. |
| Model profiles and administration | Backend supports model-profile revisions, activation/rollback, providers, settings and change history. UI forms exist. | Production configuration locks still apply. Live model/provider execution tests are not a general test bench. Response mismatches found below are repaired in this follow-up. |
| Intelligence | Proposal editing, immutable history and configuration checks. | Proposals are not activated execution bindings. Consumer impact is not indexed. |
| Integrations and provider bindings | Real service routes and UI for connection/binding configuration and lifecycle operations. | Live credentials, provider execution and deployment-specific qualifications need environment acceptance. |
| Operational status | Existing overview/system/runtime-administration projections are explicitly unavailable. | The separately owned runtime/operations/case-store status view should supply these health contracts. This follow-up adds no competing status UI. |

## Reproduced and repaired response mismatches

Ten controlled BFF probes supplied the current control API response shapes. Agent listing passed; these nine cases returned `502 bff.upstream_contract_invalid` before the repair:

1. Agent-instruction listing: service returns `instructions[].instruction`, while the existing browser contract expects `items[].skill`.
2. Provider listing: service returns `providers`.
3. Model-profile listing: service returns `profiles`.
4. Settings listing: service returns `sections`.
5. Change-log listing: service returns `changes`.
6. Agent registration: service creation metadata was rejected by the browser's registry view schema.
7. Instruction registration: both the renamed field and creation metadata differed.
8. GitHub import: service returns an agent plus instruction records, while the existing browser contract expects an agent plus skill records.
9. Model-profile creation: the service returns 201 and creation metadata, but the browser pack only declared 200 and a revision view.

The follow-up adds reviewed, operation-specific projections and declares both successful model-profile statuses. It retains response validation, authorization, CSRF and upstream error handling. Unknown row fields still fail validation rather than being hidden behind empty lists.

Verification uses the actual BFF and control API handlers with persistence and GitHub retrieval stubbed. It covers empty and populated admin lists, model revision history, instruction listing, agent/instruction registration, GitHub import, 200/201 model-profile saves and malformed rows. It is not a certification of a deployed database or provider.

The follow-up passes 54 BFF tests across 18 files, including 12 cross-service handler checks; 1,093 contract checks and Redocly lint; generated sync; web/BFF type checks; strict type checking of the integration suite; the BFF service build; and `git diff --check`.

## Original implementation plan (superseded by the implementation update)

1. **Finish HTTP acceptance and terminology.** Add browser journeys against real BFF/control/case services and test stores for every platform read and mutation. Verify save → persisted reload → version/actor/tenant evidence, denied roles and stale revisions. Label agent instructions separately from canonical business skills. The status-view owner retains runtime/operations/store health.
2. **Build a shared skill/agent workspace.** Provide a folder tree, Markdown preview, code/config editors, schemas, tests and assets; create/rename/delete files; unsaved-change handling; revision conflicts; diffs and history. Start with versioned bundles plus Git import/export. Catalog items should open the exact source revision. Editing a published item creates a draft revision.
3. **Add skill and agent evaluation workbenches.** Select a version, dataset or supplied test JSON, model profile and execution mode. Run schema checks and behavioral assertions through the execution services. Show expected/actual output, failures, tool receipts, traces, latency, tokens and cost. Persist reports pinned to source, dataset and model-profile versions. Keep structural compilation checks visibly separate from behavioral evaluations.
4. **Complete creation and promotion flows.** Create agents and business skills from templates or imports; attach exact skill versions and capability/context access; evaluate; approve; publish a digest-pinned bundle. Existing plans retain their pins. Extend case-type-specific forms and connect model-profile testing to the same evaluation evidence.

Completion requires a real HTTP browser journey from create/import through source editing, dataset evaluation, approval/publication, execution and persisted reload. Mock success or BFF route registration alone does not satisfy that acceptance criterion.

## Code evidence

- [Skill manifest presentation](../../../apps/web/src/domains/fincrime/agents/skill-sections.tsx)
- [Current agent/instruction forms](../../../apps/web/src/platform/surfaces/authoring/AgentsTab.tsx)
- [Draft Sources tab](../../../apps/web/src/platform/surfaces/authoring/SourcesTab.tsx)
- [Structural plan evaluation](../../../apps/control-api/src/authoring.ts)
- [Model-profile revision controls](../../../apps/web/src/platform/surfaces/admin/models-tab.tsx)
- [Reviewed unavailable operations](../../../apps/experience-bff/src/availability.ts)
- [Cross-service regression checks](../../../apps/experience-bff/test/platform-authoring.test.ts)
