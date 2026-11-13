# Context plane: how agents get context

## Problem it fixes

Before this change an agent or evaluate node sent `{ input, prompt }` to its model
capability, where `prompt` was the node's hand-copied template and `input` was the raw
selector projection. The compiled agent contract — its system prompt, its playbooks'
instructions and their `allowedCapabilityIds` (now one agent profile,
[agent-profiles.md](agent-profiles.md)) — was embedded in every plan and never read at
runtime. Retrieved evidence and predecessor output reached the model with the
same standing as the institution's own records, nothing recorded what a model had been
shown, and there was no size discipline.

## What the context plane is

`packages/context-plane` is the only path by which an agent reasoning node receives
context. It is a pure library (no database, no network): authority over *which* fields
may be read stays with the case store's purpose-bound selector projection
(`GET /v2/cases/:id/snapshot`), and the context plane decides how that authorized
material is presented and accounted for.

`assembleContextPack({ plan, nodeId, runId, selection, snapshot, upstream, task })`:

1. **Instructions** — resolves `node.config.agentRef` to the plan's agent profile
   (`agentProfiles`) and takes its prompt and `instructions`. A dangling reference, an
   `agentVersion` mismatch or a retired `config.skillRefs` fails the node. The node's
   `capabilityId` must be in the profile's `allowedCapabilities`
   (`context.capability_not_allowed_by_agent_profile`); a profile without instructions
   allows only its `primaryCapabilityId`. The pack carries them as
   `instructions.instructions` (formerly `instructions.skills`), so pack digests changed
   with the format.
2. **Sections** — one per compiled selector, labelled with trust
   (`TRUSTED_DATA` for case and policy records, `UNTRUSTED_EXTERNAL` for evidence,
   `UNTRUSTED_DATA` for predecessor output), classification, purpose, provenance
   (`case:<id>@<sequence>/<source>:<path>`) and a content digest.
3. **Quarantine** — untrusted sections are scanned for instruction-like content
   (ignore-previous-instructions, role override, decision steering, fake markup). A hit
   withholds the section from the model, keeps its digest, and records a signal.
4. **Budget** — required sections first, then optional ones while they fit
   (`node.config.context.maxChars`, default 60,000 chars). A required section that does
   not fit fails the node rather than being truncated.
5. **Manifest** — a schema-valid `ContextManifest` (`harness.factory/context-manifest-v1`)
   listing every item shown, bound to the snapshot ID/digest/sequence and the node's
   permission envelope. Pack and manifest digests exclude timestamps, so a replay over the
   same snapshot reproduces them.

`renderContextPrompt(pack)` separates instructions from data structurally: role, system
prompt, the profile's instructions (an `# Instructions` section) and task are instructions; every section is fenced in a `<context>` block
with its labels, preceded by rules that state the content is data, that the agent
proposes and never decides, and that claims must cite context ids.

## Runtime wiring

`lowerHarnessPlanV2` routes every `agent`/`evaluate` node that has an `agentRef` or
context selectors through the context plane. The capability receives
`{ input, prompt, contextPackDigest, contextManifestDigest }`; the model adapter uses the
rendered prompt as-is. The run journal records `context.resolved` (or
`context.resolved_with_quarantine`) with digests, section ids, dropped and quarantined
ids — never content — so a reviewer can tie a recommendation to exactly what the model
saw. Tool nodes are unchanged.

## Where packs go

Every pack a model is shown is recorded in the context store (`ehf_context`) before the model
sees it, and the pack an agent's proposal came from is promoted to the case's evidence and
cited by the proposal; see [data-stores-plan.md](data-stores-plan.md) §3.3 and §4.4.
`verifyContextPackDigest` is what the recorder and the case service use to refuse a pack
nobody assembled.

## Not yet done

- `POST /v2/cases/:id/context:resolve` as a service endpoint for non-LangGraph runtimes
  (a skill host or a runtime outside the LangGraph executor) so they get the same packs.
- Retrieval sections (vector/document search) as first-class `UNTRUSTED_EXTERNAL`
  sections with per-chunk provenance, and token- rather than character-based budgets.

## Interactive preview and source setup

The structured source workbench and non-dispatching case preview are described in
[context-source-setup.md](context-source-setup.md). Hosted-skill runtime preparation and
preview share `prepareSkillContext`; interactive previews use distinct authority and
never enter the runtime pack recorder or case commit path. Source-backed preview
requires a current source-use proof bound to the exact projected snapshot.

Scheduled source refresh, deterministic mapping extensions, filtered lexical document retrieval and platform Application contracts are documented in [context-operations.md](context-operations.md). Document retrieval enters the existing untrusted tool-observation/quarantine/manifest path.

## Bank API case context

The [Salesforce/Fenergo implementation](context-api-connectors.md) supports reviewed, on-demand case pulls against the pinned ontology. [The v2 plan](context-connectors-v2-plan.md) separates implemented acquisition from bank-specific live qualification and later portfolio work. CDC is deferred.
