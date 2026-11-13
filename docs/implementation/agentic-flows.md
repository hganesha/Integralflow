# Agentic KYC and KYB flows

Status: phase 4 of the [agentic KYC and KYB plan](agentic-kyc-kyb-plan.md) is built. Phase 5 has started:
the document and identity agents have run live over corpus heroes with Claude models. Built on the
[agent roster](agent-roster.md) (phase 3) and the [policy packs](policy-packs.md) (phase 2).

## The two flows

`scripts/sync-agentic-flows.ts` composes `domains/agents/roster.json` and `artifacts/policy/packs` into two
domain packages. `make compile` compiles each to its plan.

| Flow | Package | Customer | Agents | Pinned packs |
| --- | --- | --- | --- | --- |
| KYC | `domains/kyc-agentic` → `artifacts/kyc-agentic.plan.json` | individual | nine: all except ownership | US and GB personal banking |
| KYB | `domains/kyb-agentic` → `artifacts/kyb-agentic.plan.json` | corporate | all ten | US and GB business banking |

The run's main path, as in KYB:

```
intake → intake skills → intake review → [pack: intake-ready]
       → document skills → document review → identity skills → identity review
       → ownership skills → ownership review → screening skills → screening review
       → investigation → risk and EDD → relationship and product → [pack: decision-ready]
       → decision support → QA (judge model) → [pack: disposition] → a person decides (dual control)
```

**Skill nodes**
- Each agent's required skills run as skill nodes under the agent's profile, in roster order. Each node keeps the write path, approvals and commits of an ordinary skill node.
- Parameters are bound from earlier payloads, such as the classifications for extraction and the risk tier for the decision rules.
- Parameters also come from the case: the subject's id and display name.
- Every bound node sets `requireBoundParameters`, so an unresolved binding fails the node closed. No skill ever runs on a placeholder.
- KYC drops company-only checks (`registry.company.verify`, `screening.sanctions.ownership.evaluate`) from both steps and completion.

**Reviews**
- Each agent's bounded review runs after its own skills and before the next agent's.
- It sees its own skills' results (below), the records it `reads`, and its read-only loop skills.
- The runtime then judges the agent's task over those skills.

**Pack checkpoints** are three business-policy-v2 gates (`intake-ready`, `decision-ready`, `disposition`) over the `canonical.onboarding.v2` input profile.
- They sit after intake's review, before decision support's skills and before the person.
- Each is evaluated under the pack the case is pinned to. DECIDED continues the run; anything else goes to the stop node.
- Every skill that reads policy carries one projection per pinned pack (`skillPolicies`), and the case's pin chooses between them.
- The rules are **SYNTHETIC placeholders** (`packages/flow-composer/src/gate-rules.ts`, re-exported by `scripts/lib/agentic-gate-rules.ts`; every rule id starts `synthetic.`). Their policy sets stay CANDIDATE, and the case API refuses to evaluate a candidate set until an installation owner approves it.
  - Each gate passes first and explains after. Its pass rule needs every agent's **latest** task outcome to be COMPLETED: an outcome other than COMPLETED (BLOCKED, NEEDS_EVIDENCE, anything unknown) holds the case until a strictly later COMPLETED outcome of the same agent supersedes it (the `after` predicate over the claims' `created_at`). Only a case that does not pass meets the explanatory rules, so a superseded block never masks the real reason.
  - `intake-ready`: a banking relationship and settled agent tasks; otherwise BANKING_RELATIONSHIP_MISSING or AGENT_TASK_INCOMPLETE.
  - `decision-ready`: also needs, for each screening type the pack requires, a completed, untruncated run within list freshness (a later failed or truncated re-run does not undo a valid one; a fresh re-run supersedes an expired one), a VERIFIED identity by an accepted method within verification freshness and, for a company under standard or enhanced due diligence, **ownership computed from the ownership agent's completed task** (its graph, effective-interest, beneficial-owner and verification skills answer NEEDS_EVIDENCE while a range, cycle, opaque holder or unaccounted interest is open; a seeded `ownershipComplete` flag is not evidence). An event review that does not run the ownership agent keeps the ownership established before. Why not, in order: EDD source of funds unverified, SCREENING_INCOMPLETE, AGENT_TASK_INCOMPLETE, else DECISION_EVIDENCE_INCOMPLETE.
  - `disposition`: two independent reviewers (dual control) decide, except for the pack's low-risk carve-out (`automatic_approval_low_risk`). That carve-out approves only when every decision-ready requirement holds and every check is clear: no screening candidate or hit, no PEP relationship or adverse media, no finding still standing (an agent's REVIEW or BLOCKING finding is recorded UNVERIFIED; RESOLVED and EXCULPATORY findings do not hold the case), no open contradiction, no high document-tamper signal, every risk factor at or below `low_risk_max_factor_score`, and a decision-support recommendation that is not DECLINE. An open material contradiction holds every approval, human or automatic, until it is resolved. A case whose agent tasks are not settled is returned for evidence rather than sent to people.
- Each agent review records the runtime's task-completion outcome as an `agent_task_outcome` claim, which is how the checkpoints see a blocked task.
- Decision support's `decision.controls.assess` records one `Control` per pinned requirement (PASS, FAIL, UNKNOWN or NOT_APPLICABLE, from the requirement's `control` predicate over facts bound from the earlier steps: documents, identity, registry and owner verifications, profile completeness, screening candidates, verified funds). The recommendation, gap and QA compliance skills read them. A fact the process cannot bind is absent and its control stays UNKNOWN.
- Context producers: `risk.factors.derive` scores each weighted risk factor from the case's recorded exposures through the pinned maps (the highest value of a factor), recorded as `RiskFactor` for `risk.customer.assess`; `ownership.ubo.resolve`'s candidates are recorded as `BeneficialOwner` for `ownership.ubo.verify`. Each record has a stable id per case, versioned by run. VerificationRecord and PEPRelationship come from providers, not skills: the connector normalizer records identity verification results and PEP data's relatives and close associates of a screened subject (verified only when the provider confirms the relationship); application intake records declared ones (unverified).
- Freshness (C5): an agent's record selectors (its reads and loop tools) admit a record only within the pinned packs' `freshness_seconds` for its type, the strictest of the plan's packs; an older one is a STALE gap. Workflow skills apply the pinned freshness in the skill host; the checkpoints' selectors stay unbounded because their rules judge freshness.
- `scripts/lib/agentic-gate-rules.test.ts` runs the scenarios through a reference interpreter and, where OPA is installed (CI), through the emitted bundle.
- `scripts/lib/agentic-flow-faults.test.ts` injects faults into the recorded H04 walk (today's compiled KYB plan, with real completion judgment, output schemas and loop limits) and evaluates the checkpoints on the resulting task outcomes: a provider down blocks the screening task, leaves the EDD task needing the evidence its trigger facts could not bind, and holds the case (AGENT_TASK_INCOMPLETE); an incomplete search holds it for evidence; an unavailable model, an answer outside the output schema (an agent proposing APPROVE) and an agent that never stops calling tools each fail the agent; an instruction injected into a case record is quarantined before any model sees it. The interpreter is shared (`scripts/lib/policy-interpreter.ts`).

`packages/runtime-langgraph/src/agentic-flows.test.ts` checks:
- the order, and the checkpoint edges;
- that bindings fail closed;
- that the projection is chosen per pack;
- the customer-type differences;
- that the identity review receives the document agent's assertions;
- a pack checkpoint over corpus records.

### What a review sees: its own skills' results

**The gap:** an agent node with case selectors received only its selection. Its own skills' results never reached the model, although its instructions told it to use them; only the runtime's completion check saw them.

**The fix:**
- The context plane now takes `skillResults`, and the runtime fills it for any agent node with completion criteria (`agent-skill-results.ts`).
- It contains each criterion's skill node, with lifecycle and computation (business status, payload, unresolved items). Runtime-internal fields are left out.
- It is shown as an untrusted `upstream` section.

## Documents into identity

The document agent and the identity agent split the document work:
- **The document agent** classifies, extracts, assesses validity and consistency, resolves requirements, and composes requests.
  - Its loop can re-read pages through `document.parse.artifact`, which is read-only and reaches the OCR connector when there is no admitted page text.
  - It names each document by catalog type id: `documentType` is an enum of the 293 catalog ids, which the generator fills in from `CATALOG_DOCUMENT_TYPES`.
- **The identity agent** reads the document agent's `ExtractedAssertion` records and the pages themselves, next to the Identity, IdentityIdentifier, VerificationRecord, RegistryRecord and Address records. It declares these with `reads:` (`domains/agents/README.md`).
  - Its output adds `documentChecks`. For every field it compared, it gives the document's value, the record's value, `MATCH`, `CONFLICT` or `NOT_ON_RECORD`, and its sources.
  - Reading pages matters because the library proposes assertions only for scalar fields. A company's registered office is nested, so the identity agent compares it from the page.

### Corpus documents

`tools/context-corpus/src/context_corpus/documents.py` writes synthetic customer documents for three heroes, with `context-corpus generate`, which also checks them:
- `parties/<hero>/documents.jsonl` holds DocumentVersion records and full-text DocumentPage records, as the evidence pipeline admits a parsed document.
- `documents.expected.yaml` is the answer key.

| Hero | Documents | Planted defects |
| --- | --- | --- |
| H02 (individual, ES) | national identity card, utility bill | none (the clean case) |
| H03 (individual, GB) | passport, driving licence, utility bill | passport date of birth transposed against the identity record; licence expired before the as-of date |
| H04 (company, GB) | certificate of incorporation, director register, register of members, director's passport | certificate's registered office (Unit 9) against the registry (Unit 7); no identity document for one director and no proof of address for another (per-party requirements, reported but not scored) |

**Checks** (`tools/context-corpus/tests/test_documents.py`):
- The library's own classifier types every document as the key says, by title.
- Every stated key field is on its page.
- Only planted defects disagree with the records.

**The skill bridge** (`skill_bridge.py`) runs any library skill over a hero for an out-of-process caller.
- A provider request, such as `document.fields`, is captured, not answered.
- The caller answers it through the platform connector, and the skill runs again with that answer as an exact-request recording.
- A model's answer therefore reaches a skill only through the connector, bound to the request it answers. The answer cites the pages the request carried, as the skill host's gateway provider does.

## Models through the intelligence connectors

The agents' model tiers are reasoning profiles (`model.fast|standard|deep|judge.v1`). A profile's provider binding decides the transport, the same way the Intelligence registry's reasoning bindings do. Document field extraction runs on the standard profile through the same connector. So pointing the tiers at Claude is an administrative change:

| Provider kind | Transport | Use |
| --- | --- | --- |
| `openrouter` | OpenRouter (any model it serves, Claude included) | `config/model-profiles.claude-openrouter.json`: Haiku 5.5, Sonnet 5.5, Opus 5.5, and Fable 5.1 as the judge |
| `anthropic` (new) | Anthropic's Messages API through the official SDK (`packages/adapters/src/anthropic.ts`) | `config/model-profiles.claude.json`, credential `ANTHROPIC_API_KEY` |
| `openai_compatible` | any OpenAI-compatible endpoint | unchanged |

**The tier mapping:**
- Standard work runs on Sonnet, and deep work (ownership, investigation, risk, decision support) on Opus.
- QA runs on Fable 5.1, a model no agent it reviews uses.

**The `anthropic` connector:**
- It uses only the binding's endpoint and the administered key. It ignores `ANTHROPIC_BASE_URL` and stored sign-ins in the process environment.
- There is no fallback to another model on a refusal: the profile pins one model, and an answer from another one would not come from the qualified agent. A refusal or a truncated answer fails the call.
- The `anthropic` kind is admitted by:
  - the contracts;
  - the Intelligence adapter catalog;
  - the admin seed;
  - migration `046_anthropic_provider.sql`.
- The admin UI's provider list and deployment onboarding still offer only the existing kinds; that change belongs to the UI contract pack.

## Live runs

`scripts/live-agent-run.ts` walks a compiled flow over a hero with real models (`runAgentFlow` in
`packages/runtime-langgraph/src/agent-flow-run.ts`):
- every skill node on the plan's main path in order, with its bindings, and the review of each chosen agent (all by default) with its loop skills, schema and completion;
- the library's skills through the bridge; the authenticity detectors answered by their sandbox connectors;
- model calls through `invokeModel` and `invokeDocumentFieldsModel`;
- the context plane's packs, and the runtime's agent loop and completion check.

The case store, the gateway and the commit path are stood in for: a skill's proposed assertions go straight to later skills, and agents' tool calls are reported unavailable. The report scores the agents against the answer key.

```sh
NODE_USE_ENV_PROXY=1 node --import tsx scripts/live-agent-run.ts --flow kyb-agentic --party H04 \
  [--agents all | agent.document_intelligence,agent.identity_verification] \
  --profiles config/model-profiles.claude-openrouter.json --python <python with the library's locked deps> \
  [--record fixtures/agent-recordings/kyb-agentic.H04.json | --replay <recording> [--strict]] --out report.json
```

`--record` keeps the library's results and the models' answers, keyed by what was asked; CI replays every
recording (`agent-flow-replay.test.ts`) so all agents of both flows run without a model. The answer key
(`agent-answer-key.ts`) covers every agent where the hero's facts settle the answer. Delivery plan
section 2.1 has the all-agent results.

First results on 2026-11-09, Claude through OpenRouter, document and identity agents only:

| Hero | Answer key | Assertions extracted | Model calls | Cost |
| --- | --- | --- | --- | --- |
| H02 | 2/2, and no conflict reported on the clean case | 18 | 5 | $0.28 |
| H03 | 5/5: date-of-birth conflict reported by both agents, licence `EXPIRED` | 25 | 6 | $0.30 |
| H04 | 5/5: registered-office conflict reported by the identity agent | 25 | 7 | $0.43 |

**Other observations:**
- **Unplanted conflict:** on an earlier H04 run, the identity agent found a conflict I had not planted. The register of members named a member differently from the records. It was a fixture error, now corrected.
- **Library limitation:** on H04, the identity agent noted that extraction attributes a director's passport fields to the case subject. That is a library limitation: `document.fields.contract_extract` takes one subject per execution.
- **Never automatic:** every agent asked for human review where it should. No task completed on its own.

These are single runs, not an evaluation: phase 6 repeats them over held-out parties under owner thresholds.

### What the live runs found and fixed

Five defects that scripted tests could not show:

1. **Agent steps returned `{}`.** An agent loop's model call was sent as a provider-enforced structured output of `{type: object, required: [action]}`. A provider that closes objects answers that with `{}`, so every step failed as a protocol error.
   - **Fix:** agent-loop calls (`isAgentLoopCall`) ask for JSON in the prompt. The loop already validates the action and the output schema, with a repair.
2. **Claude rejected the extraction schema.** It contains an "any value" schema (`{}`) that Claude's structured outputs refuse.
   - **Fix:** schemas for Claude models are narrowed to the subset Claude enforces (`anthropicOutputSchema`, which keeps `$ref` and `$defs`). Otherwise they go in the prompt (`withSchemaInstruction`).
3. **Extractions could never bind to their source.** The answer must echo the document version and source digest, hashes the model is never shown.
   - **Fix:** the connector sets the provenance fields from the request it sent (`bindDocumentFieldsAnswer`): document type, profile version, contract hash, document version and source digest.
4. **Span offsets and page ids were wrong.** Models count characters unreliably and rebuild page ids instead of copying them. The quotes were right.
   - **Fix:** the connector moves a span to its quote's verbatim occurrence, counted in code points (`relocateDocumentSpans`). A span citing an unknown page goes to the one sent page that holds the quote. A quote on no page stays wrong, and the library still rejects it.
5. **Reviews never saw their own skills' results** (above).

## Open

- **Per-party document requirements.** `document.requirements.resolve` evaluates requirements per case. "An identity document for every director" needs a policy and library change.
- **Extraction subject attribution.** It is per execution: a director's documents need extraction per party.
- **The live harness is not the platform.**
  - No case store, gateway or commit path: phase 5 proper runs the composed services.
  - Agents' read-only tools are unavailable in the harness.
  - Each agent has single recorded runs on the development heroes; repeated and held-out runs are still to do.
- **Admin and onboarding UI** for the `anthropic` provider kind (a UI contract pack change).
- **OPA bundles** for the pack checkpoints, left to the separate OPA rework, as in phase 2.
