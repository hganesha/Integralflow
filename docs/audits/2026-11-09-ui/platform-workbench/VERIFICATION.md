# Verified acceptance evidence

2026-11-09, rebased onto `main` at `9741752f` (Context editing and blue-slate theme included).

| Check | Result |
| --- | --- |
| Targeted regression suites | 190 passed across 42 files; 5 existing environment-dependent tests skipped |
| Workbench HTTP/SQL/container integration | 6 passed, including restricted control/gateway roles, real edited Python/library execution, pinned agent tools, cancellation, admission enforcement/fencing, and bounded output |
| Azure Blob/job adapter | 1 passed using actual SDK, Azurite signed URLs and restricted Docker job; ARM transport simulated |
| PostgreSQL service grant matrix | 9 passed against a migrated disposable PostgreSQL database |
| HTTP browser journeys | 4 passed: edit/recovery/folder move/Markdown links/evaluate/review/publish; reader canonical source + Services; runtime stop/resume + reload; concurrent revision rebase |
| Accessibility | No serious/critical WCAG A/AA findings on the evaluated workbench, Services and Runtime screens |
| Responsive layout | 390 px evaluation view has no horizontal page overflow; desktop/mobile screenshots retained |
| Types | 11 touched packages plus strict integration-suite compilation passed |
| API contracts | 1,122 checks passed; Redocly lint clean; generated sync current; 201 operations |
| Web | HTTP production bundle built, 118 files after navigation consolidation; mock code exclusion check passed |
| Node services | All platform service bundles built |
| Evaluator image | Built from digest-pinned Node/Python bases; actual kernel restrictions passed for UID, environment, sockets, parent process and source permissions |
| Azure templates | Job and runtime Bicep compiled; existing runtime safe-access linter warnings remain |
| Patch | `git diff --check` clean |

The local acceptance stack uses actual case/context stores with pgvector/AGE, PostgreSQL checkpoints, authenticated journal access, real workers and an OTLP receiver. No Azure resources were created and no paid model request was sent. The agent suite uses a deterministic model transport fixture; it does execute the pinned skill code and gateway/provider SDK path. Live model endpoint credentials, managed-identity/RBAC propagation, the Container Apps kernel policy and deployment networking require the Azure acceptance run described in [AZURE.md](AZURE.md).

Screenshots: [repository](screenshots/repository-desktop.png), [evaluation desktop](screenshots/evaluation-desktop.png), [evaluation mobile](screenshots/evaluation-mobile.png), [Services](screenshots/services-desktop.png), [Runtime](screenshots/runtime-desktop.png).

Navigation and authoring follow-up: UI suites now pass 245 tests across 55 files, and the control API suite passes 156 tests with OPA available (17 environment-dependent tests skipped). Eleven HTTP browser journeys cover Process Studio navigation, inline process names, agent/human/policy canvas editing, Data sources, compatibility redirects and persisted Databricks/Fabric configuration alongside the earlier workbench/context journeys. The [navigation verification](../navigation/README.md) records those flows and current screenshots.
