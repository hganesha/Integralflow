# Implementation notes

How the platform is built today, one component or contract per file. See also the [implemented skill catalog foundation](skill-catalog-implementation.md). Where a note and the code
disagree, the code wins; fix the note.

| Area | Notes |
| --- | --- |
| Plans and compilation | [harness-control-plane.md](harness-control-plane.md), [artifact-registry.md](artifact-registry.md) |
| Draft testing | [Canvas tests, sample data and execution isolation](draft-testing.md) |
| Orchestration and runtimes | [execution-control-plane.md](execution-control-plane.md), [runtime-adapters.md](runtime-adapters.md), [runtime-conformance.md](runtime-conformance.md) |
| Bank context connectors | [Salesforce/Fenergo on-demand case pulls](context-api-connectors.md), [v2 portfolio plan](context-connectors-v2-plan.md); live bank qualification required, CDC deferred |
| Agents and context | [context-plane.md](context-plane.md), [agent-loop.md](agent-loop.md), [agent-profiles.md](agent-profiles.md), [Context experience proposal](context-experience.md), [experience alignment plan](context-experience-alignment-plan.md), [implemented source setup](context-source-setup.md) |
| Context ontology | [Canonical graph, source mappings and packet relationships](context-ontology.md), [integration plan](context-ontology-integration-plan.md) |
| Capabilities and connectors | [agent-runtime-capability-gateway.md](agent-runtime-capability-gateway.md), [capability-adapters.md](capability-adapters.md), [capability-naming.md](capability-naming.md), [kyc-adapters.md](kyc-adapters.md) |
| Business skills and the skill library | [business-skills.md](business-skills.md), [library-contracts.md](library-contracts.md), [skill-library-integration-contract.md](skill-library-integration-contract.md), [skill-library-change-request.md](skill-library-change-request.md), [fincrime-integration.md](../fincrime-integration.md) |
| Case store and records | [canonical-case-ledger-evidence-store.md](canonical-case-ledger-evidence-store.md), [canonical-records.md](canonical-records.md), [data stores plan](data-stores-plan.md) |
| Document intelligence | [document-intelligence.md](document-intelligence.md), [plan](document-intelligence-plan.md), [Model Factory and dual-route plan](document-intelligence-factory-plan.md), [factory Phase 0](document-factory.md) |
| Identity, configuration, observability | [identity-authorization-observability.md](identity-authorization-observability.md), [administered-configuration.md](administered-configuration.md) |
| Platform users and roles | [user-management.md](user-management.md) |
| User interface | [Catalog experience](catalog-experience.md), `apps/web` (Vite SPA), `apps/experience-bff` (fastify BFF), `packages/ui-*`: spec in [apps/fincrime-host/docs/ui](../../apps/fincrime-host/docs/ui/README.md), open contract gaps in [CONTRACT-GAPS.md](../../apps/web/CONTRACT-GAPS.md) |
| Roadmap | [production-delivery-plan.md](production-delivery-plan.md), [Policy Studio builder plan](policy-studio-builder-plan.md), [Product Policy Studio and taxonomy plan](product-policy-studio-plan.md), [skill catalog audit and production evolution plan](skill-catalog-production-plan.md), [production slice 1: KYB screening and ownership](production-slice-1.md), [agentic KYC and KYB plan](agentic-kyc-kyb-plan.md), [policy packs](policy-packs.md), [agent roster](agent-roster.md), [agentic flows](agentic-flows.md), [agentic onboarding delivery plan](agentic-onboarding-delivery-plan.md) |

Domain packages document themselves: [`domains/archive/kyc-v2-deterministic/README.md`](../../domains/archive/kyc-v2-deterministic/README.md)
and [`domains/archive/kyb-deterministic/README.md`](../../domains/archive/kyb-deterministic/README.md).

- [Context operations and extensions](context-operations.md): bounded refresh/checkpoints, mapping templates and crosswalks, filtered document search and Application contracts.
