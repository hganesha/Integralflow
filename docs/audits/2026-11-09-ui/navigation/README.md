# Process Studio and data source navigation

Implemented on `codex/platform-workbench`, including `main` through `b91c477e`.

## Product structure

Process Studio replaces Agent Studio in the experience navigation. Its persistent navigation exposes Draft processes, Published processes, Agents, Skills and Policy Studio. Draft authoring and release controls now have one primary home instead of separate Platform entries. Published processes retains the existing release manifest and trusted transition workflow; an authoring source can still be inspected after publication.

Agents and Skills have separate source workspaces, catalog choices, creation forms and grouped inventories. Agent mandates, tasks and skill definitions remain reachable from these workspaces and their catalog links. Folder/code/Markdown editing, exact revision evaluations and publication use the existing workbench APIs.

Platform has one Data sources entry with Connections, Mappings, Product bindings, Status, Calls and Refresh. Connections exposes shared datasets and product source connections. Both existing backend models remain intact: shared connection/resource/mapping definitions and reviewed enterprise connection/product bindings. Connection revisions, activation history and pinned bindings are preserved.

New mapping starts with a source connector chooser. PostgreSQL, Salesforce/FSC and Fenergo open their existing shared-source forms. Databricks SQL, Microsoft Fabric, OpenAPI/REST, Snowflake, BigQuery, Kafka and object storage open the full product connection form with the selected provider. The product filter carries into that flow. Saving clears the creation link, refreshes the real inventory and makes the saved revision selectable in a product binding. Required connection fields are checked with the same schema as the API before submission. Kafka and object storage retain their external gateway requirement; the UI does not imply additional built-in adapters.

Role and authoring gates remain enforced. Tabs are filtered by the actions required by their reads. Shared-source form state stays mounted when changing tabs, retaining unsaved edits. A deployment with authoring disabled can still reach released processes and existing agent definitions.

## Canonical routes and compatibility

| Surface | Primary route | Legacy link behavior |
| --- | --- | --- |
| Process Studio | `/studio` | Selects drafts, releases or read-only agent definitions according to access |
| Draft processes | `/studio/drafts` | `/platform/drafts` and draft detail/policy links redirect with IDs and query filters |
| Published processes | `/studio/published` | `/platform/releases` redirects, preserving query filters |
| Agents | `/studio/agents` | `/platform/workbench?workspace=…` resolves the persisted workspace kind before redirecting |
| Skills | `/studio/skills` | Legacy source links retain the selected source, workspace and revision |
| Agent definitions | `/studio/agents/mandates` | `/agents` and all registered agent/task/skill routes redirect with parameters |
| Data sources | `/platform/data-sources` | `/context/connections`, source and mapping links retain product/source/mapping IDs |
| Product bindings | `/platform/data-sources?tab=bindings` | `/platform/context-sources` preserves product filters |
| Source operations | `/platform/data-sources?tab=status` | `/platform/data-connectors` preserves tab, run and pagination filters |

The source Calls view exposed a pre-existing response mismatch: the control API returns persisted `receipts`, while the browser expects a reviewed `items` page. The BFF now projects that response into an owned contract. It retains recorded timing/result/trace evidence and represents unretained envelope, adapter and idempotency values as null. Private source output is excluded.

## Inline process and node authoring

The process heading has an inline name editor with Save, Cancel and Escape. A rename writes the workflow display title and the persisted draft name, preserving package/workflow identifiers and source files. It uses the same expected-revision and authoring permission checks as graph edits. A concurrent change retains the typed name and requires an explicit rebase before retrying; published processes and readers have no rename control.

The palette and contextual canvas insertion now share one step list: Agent, Human review, Policy gate, Transform, Decision, Join, Aggregator and Fan out. Agent insertion resolves an active registration on the server and copies its version, instructions, model profile, schemas and allowed case writes into the same saved revision. The selected edge's predicate and sibling branches are preserved. There is no persisted intermediate placeholder node. An ordinary inline name/note edit retains the pinned agent version even when its registry entry has changed; choosing another registered agent is an explicit rebind.

Human review uses the existing native approval primitive. Policy gates expose their bound policy reference and gate ID in both creation and inline editing. The server rejects unresolved policy bindings and attempts to apply gate configuration to another node type. Policy Studio authors/tests policies; the process source editor owns package policy bindings. Gate and human decision authority remains enforced by the existing compiler and runtime.

Inline editing closes the inspector and focuses the selected card. Longer forms scroll within the card with visible Save/Cancel actions. The mobile canvas retains a usable height, and breadcrumb targets meet the minimum size checked by accessibility tooling.

Authoring verification: 247 UI regressions, 157 control API tests (17 environment-dependent tests skipped), 17 mock authoring/canvas browser cases and 11 HTTP browser journeys. The two new HTTP journeys cover rename/cancel/reload/conflict/read-only behavior, agent/human/policy insertion and inline edits, preserved agent pins, explicit agent replacement, rejected agent insertion without partial persistence, bounded inline editor geometry and the visible 390px canvas. OPA-backed control tests use an installed `OPA_PATH`; no paid model or live warehouse execution is needed for these checks.

## Agent case access, generated IDs and Skill Studio

Agent definitions select default reads from the process's declared case selectors and writes from the canonical command list. New writes map named output fields into executable payload templates; the mapping/schema remains inspectable and editable. Authors can configure available case data in place without leaving the agent form. The registration API retains the selected read contracts. Attachment copies them into the node's signed selector grants and derives the agent profile's purposes from actual node grants. A conflicting selector ID or a mixed-purpose read set is rejected. Classification treatment, compiler checks and runtime authority continue to govern access. Existing registrations that never declared read defaults keep their prior attachment behavior unless the author changes the reads.

New agent, instruction, capability, provider, model-profile, connector, connection, binding, dataset and palette-node IDs are filled automatically with readable names and a stable per-form random suffix. Explicit aliases remain possible; saved identities and existing dataset references stay fixed when labels change. References to existing cases, resources, credentials or deployed artifacts are not fabricated.

Catalog skill links open Skill Studio directly with the skill highlighted and scrolled into view in its grouped library. The same surface exposes Overview, Contract & schemas, Context requirements, Guardrails, Agents & tasks, Source files, Dataset evaluations and Revisions & publication. Editing opens an existing workspace or imports the complete library bundle into a new one, retaining the selected section. Definition information is explicitly labelled as the library version while source edits/evaluation evidence belong to the exact workspace revision. Old catalog and skill-definition links redirect to this surface; browser Back restores the catalog filters. On small screens, the selected skill stays first and the library/workspace browser expands on demand.

Intelligence now includes Microsoft Azure and Azure AI Foundry models, Foundry Agent Service, Azure Machine Learning, Azure AI Document Intelligence, Foundry structured decisions and Azure-hosted MCP targets. Foundry models use the existing OpenAI-compatible transport; the other Azure service entries are labelled implementation required. Configuration checks require the resource's OpenAI v1 route and a provider-key reference for the installed model transport, and continue to report execution/activation as unverified. Project agent endpoints and Entra token-refresh support are separate runtime/authentication work. This follows the documented [Foundry model endpoints](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints) and [Agent Service protocols](https://learn.microsoft.com/en-us/azure/foundry/agents/overview). No Azure deployment or paid inference is performed by these changes.

New evidence: [agent case access](screenshots/agent-case-access-desktop.png), [Skill Studio source](screenshots/skill-studio-source-desktop.png), [mobile Skill Studio](screenshots/skill-studio-source-mobile.png). `studio-usability-http.spec.ts` verifies real registration, attached read grants, generated connection/binding/dataset IDs, catalog-to-Studio tabs, editable source and saved/reloaded Azure proposals. The updated workbench journey still executes a behavioral dataset and publishes only after independent review.

Latest validation: 247 UI tests across 56 files, 157 control API tests with 17 environment-dependent skips, 107 contract-package tests, 41 mock catalog/agent/authoring/administration browser cases (including focused reruns after corrections), 14 HTTP journeys across process authoring/navigation/source workbench/usability, four package type checks and 1,122 contract checks. Redocly, generated sync, the HTTP bundle/mock-code exclusion and diff whitespace checks pass. New browser journeys run serious/critical accessibility checks and verify 390 px overflow and the collapsed/expanded mobile library. ID boundary tests cover numeric, accented and non-Latin names and retention of uniqueness/version suffixes at length limits.


## Verification

- Real HTTP browser coverage exercises draft creation/reload, separate agent/skill views, release controls, all six source tabs, unsaved source form retention and old-link redirects.
- Databricks and Fabric tests select New mapping, save through the real BFF/control API into PostgreSQL, reload the saved connection and find its revision in the product-binding editor. No live warehouse query is performed by this configuration test.
- Existing source workbench, evaluation, independent publication, runtime admission and context mapping qualification journeys continue to pass against the isolated HTTP stack.
- Mock acceptance covers the shell, roles, agent mandates/tasks, draft authoring, source operations and release transitions. Accessibility checks found and repaired conflict-panel and unsaved-action contrast issues using semantic tokens.
- UI regression suites, touched package types, generated contract sync, 1,122 contract checks, Redocly lint and the production HTTP bundle pass. Browser evidence checks serious/critical WCAG findings and horizontal overflow at 390 px.

Use the isolated HTTP stack described in the [workbench verification](../platform-workbench/VERIFICATION.md), then run:

```sh
CONTEXT_HTTP_URL=http://127.0.0.1:5314 WORKBENCH_HTTP_URL=http://127.0.0.1:5314 pnpm --filter @ehf/e2e-ui exec playwright test process-authoring-http.spec.ts studio-navigation-http.spec.ts context-http.spec.ts workbench-http.spec.ts studio-usability-http.spec.ts
```

Screenshots: [Skills](screenshots/skills-desktop.png), [draft](screenshots/draft-desktop.png), [Data sources desktop](screenshots/data-sources-desktop.png), [Data sources mobile](screenshots/data-sources-mobile.png), [saved product connections](screenshots/mapping-connectors-desktop.png).

Authoring screenshots: [inline name on mobile](screenshots/process-name-inline-mobile.png), [node types](screenshots/authoring-node-types-desktop.png), [inline node editor](screenshots/authoring-inline-node-desktop.png), [mobile canvas](screenshots/authoring-node-types-mobile.png).

Hosted CI remains blocked before checkout by the GitHub account payment/spending-limit condition recorded in PR #65. Local verification does not depend on hosted CI. Azure acceptance remains a separate environment step; no Azure resources or paid inference were created for this navigation change.
