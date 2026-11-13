# Draft workflow tests

Open **Draft workspace → Workflow → Test draft**. Select a synthetic individual,
synthetic company, or input-schema template; edit the test JSON and choose **Run draft
test**. Tests execute the saved revision without advancing its release lifecycle.
Finish canvas edits and save source buffers before starting a test.

The shared LangGraph lowering executes the workflow, including agent reasoning loops,
conditional routing, joins and transforms. Canvas badges show node progress. Select a
node to inspect its input, output and error in the test panel. Test history includes the
source revision, compiled plan digest, model/tool providers and reported cost. A result
from an older revision is labelled and its badges are removed from the current canvas.
The selected test is retained in the `testRun` URL parameter.

## Test data and models

The editable JSON contains:

```json
{
  "input": { "vendorName": "Acme" },
  "context": { "case": {}, "subjects": [], "facts": [] },
  "capabilityOutputs": { "vendor.lookup": { "vendor": "Acme", "fixture": true } }
}
```

`input` must satisfy the compiled workflow input schema. `context` supplies only the
case fields the compiled node selectors permit. The bundled synthetic records from
`apps/fincrime-host/examples/records.json` are grouped by object type for canonical-record
selectors. The samples specify their observation time; authored samples can set
`context.asOfTime` to select the rehearsal snapshot time. Tenant and case identity are
rebound to the test, never used to load a real case.

`capabilityOutputs` contains explicit sample responses keyed by capability ID. Generated
tool templates are schema-shaped placeholders and need author review. Missing responses
and invalid output schemas fail the relevant node rather than inventing success. A
package can include `samples/<name>.json` in its `sourceFiles`, with `name`, `description`,
`input`, `context` and `capabilityOutputs`, to supply additional selectable examples.

**Recorded responses** uses deterministic model responses without provider calls. This
exercises orchestration and contracts, not model quality. **Configured models** performs
live inference using the tenant's pinned model profiles and provider credentials, with
no recorded fallback; provider charges can apply. This version supports the existing
`openrouter:` model transport, including its administered OpenAI-compatible endpoints.
Other model adapter bindings produce an explicit unsupported-adapter error. External
tools always use the supplied sample responses in both modes.

## Isolation and limits

Tests never admit a plan, create an operational run, write case data, register evidence,
commit a hosted skill's effects, or release held effects. Downstream nodes that require
those effects must receive the needed fields in the sample context. Policy gates and
human approvals stop with a blocked result; this version does not rehearse their
authoritative decisions. Hosted skill and subgraph capabilities also require explicit
sample responses. No test result is a release evaluation attestation.

Tests enforce compiled node capability permissions, input/output contracts, capability
and model call budgets, and a maximum two-minute duration. Cancellation reaches active
model requests. Model costs are recorded when the provider reports them. History is
tenant-, environment- and draft-scoped and expires after seven days. Expired records are
removed when a subsequent test starts. The latest ten tests are shown.

The control API executes the bounded job asynchronously in its process and persists
progress in PostgreSQL. A control API restart does not resume a test; stale running tests
are marked `draft_test.worker_interrupted` on the next history read after 150 seconds.
Cancellation is stored first so another replica's late completion cannot overwrite it.

## API and deployment

Apply control migration **056_draft_test_runs.sql** and the updated grants before
deploying. The control API now depends on the shared runtime and model adapter packages;
update the lockfile/install dependencies and rebuild the control API and web app.

- `GET /v1/authoring/drafts/:draftId/test-samples`: sample catalogue and source revision.
- `POST /v1/authoring/drafts/:draftId/test-runs`: `expectedRevision`, `mode`, `input`,
  `context`, `capabilityOutputs`; requires `Idempotency-Key`, `draft.evaluate` and
  `draft.compile`. Repeated requests return the same test; changed bodies under the
  same key fail with 409.
- `GET /v1/authoring/drafts/:draftId/test-runs`: latest ten tests.
- `GET /v1/authoring/drafts/:draftId/test-runs/:testRunId`: persisted progress and results.
- `POST /v1/authoring/drafts/:draftId/test-runs/:testRunId/cancel`: cancel a running test;
  requires `draft.evaluate`.

All routes use existing authoring authorization and BFF CSRF/delegation. Mock UI mode
shows the form but explicitly requires the HTTP backend to execute; it never reports
that agents ran.

Focused checks: `draft-tests.test.ts` in control-api, experience-bff and persistence,
plus `e2e/ui/plt-draft-tests.spec.ts`. The persistence check uses the usual migrated
`EHF_TEST_DATABASE_URL` test database.

## Sandbox runs

A draft test rehearses orchestration in isolation: tools answer from samples, and policy
checkpoints and approvals stop it. A **sandbox run** is the other half: the saved revision on
the real runtime, against a synthetic test party. Open **Process Studio → Sandbox Runs** or use
**Run in sandbox** from a saved draft's Workflow tab. Choose a draft and party, then start the run.
The workspace links the execution tree, pinned process graph, trace timeline, and step inspector.
Click an event to inspect its recorded details or use **Follow live** to return to the active step.
The run also appears under **Platform → Runs**. Use a fresh sample draft to pick up updates to
the bundled workflow sources. Saved drafts keep the source they were created with.

What a sandbox run does:

1. Compiles the saved revision in memory (the draft's lifecycle does not advance) and admits
   the plan.
2. Puts the plan and its compiled policy in effect as a **sandbox release**: an ordinary
   release manifest whose `scope.cohort` is `sandbox`, registered by the author and approved by
   `system:sandbox-auto-approval`, so the history shows no person reviewed it.
3. Loads the chosen party from the test corpus (`fixtures/context-corpus`) as a **new case**,
   pinned to the plan and to the one policy pack the plan pinned for the party's relationship.
   Each run gets its own copy, so earlier runs never affect it.
4. Starts a run on that case.

A sandbox release is a rehearsal, never a governed release:

- It is refused under the production security profile and when `RELEASE_ENVIRONMENT` is
  `production`; migration `063_sandbox_releases.sql` also rejects a sandbox manifest scoped to
  production.
- It may decide under a policy bundle that still has unresolved release blockers (candidate
  policy sets, unresolved installation content). That exception applies to sandbox releases
  only, at the release check, the case API's checkpoint evaluation and the database's
  business-policy authority. Blockers are stored as compiled.
- It carries no evaluation attestation, and its result is not release evidence.
- It has its own release line, so it never supersedes a governed release of the same process,
  and a governed release of the same plan outranks it. It is not offered to new cases and is
  left out of the releases list and activation history.
- The only cases it runs on are the copies it creates from the synthetic corpus.

The test corpus is not part of the service image. `compose.yaml` mounts it into the control API
for local development (`SANDBOX_CORPUS_ROOT`); where it is absent the editor says sandbox runs
are not available. `scripts/sandbox-run.ts` runs the same path from the command line for a
flow's compiled plan in `artifacts/`.

API:

- `GET /v1/authoring/drafts/:draftId/sandbox`: whether a sandbox run is offered, why not, and
  the test parties; requires `draft.read`.
- `POST /v1/authoring/drafts/:draftId/sandbox-runs`: `expectedRevision`, `party`; requires
  `draft.evaluate` and `draft.compile` and an interactive user. A party the plan's policy packs
  do not cover is refused (`sandbox.party_not_covered`) before case creation. The UI sends an
  `Idempotency-Key` and a retry reuses the original case and run.
- `GET /v1/authoring/sandbox-runs` and `GET /v1/authoring/sandbox-runs/:runId`: recent sandbox
  history and one run's provenance. Require `run.read` and scope the results to the tenant and
  environment. Migration **064_sandbox_launches.sql** records launches made through the draft API.

Focused checks: `sandbox-run.test.ts` in control-api and
`sandbox-releases.integration.test.ts` in persistence (migrated `EHF_TEST_DATABASE_URL`).
