# UI contract boundaries

Updated 2026-11-10. The supported Experience API has registered handlers for all non-mock
operations. The former blanket `experience.not_configured` exclusions are gone. See
[UI gap closure](../../docs/implementation/ui-gap-closure.md) for source behavior, configuration
and validation, and the [production delivery plan](../../docs/implementation/production-delivery-plan.md)
for production readiness work.

- Ownership, screening, lineage and recorder views project recorded evidence. Missing references,
  unknown freshness and absent policy thresholds stay explicit; they do not grant a clearance.
- Trace queries require a configured Jaeger reader and a successful tenant authority check.
- Document reruns require a configured document-only plan, selected source version and accepted
  case authorization. No extraction is simulated when configuration is missing.
- Overview and Mission Control disclose role restrictions and bounded human-work history.
  Runtime activity is not inferred from catalog definitions.
- Health reporting and runtime admission retain their existing service-backed implementation.
- Unowned generated-presentation proposals are retired; canonical authored views remain available.
- Artifact revocation targets one registry kind/digest using `release.revoke` on Published processes.
- Previously acknowledged source/schema drift remains recorded in
  `packages/ui-contracts/drift-acknowledged.json`; generated contracts do not certify upstream
  deployment health or production provider qualification.

Context ingestion, retrieval and business-policy extensions follow their component plans.
They are not implied complete by Experience API route coverage.

## GAP-015 — acknowledged source drift

Contract, identity, route and design sources have advanced beyond the frozen upstream pin.
The drift acknowledgment records the exact groups; this change preserves those acknowledgments.

## GAP-017 — library release notes

The library release-note source is outside the vendored UI pack. See the drift acknowledgment
for the source boundary.

## GAP-076 · BIZ-02 · the live case room lists only started stages, and analysts get no events or human steps
- **Severity:** high · **Owner:** pack (task catalogue, role/action table)
- **Found:** 2026-11-11. The live BFF now derives `CaseRoom.stages` from the case's work items (one per `constraints.taskId`, labelled from the agent catalogue) and `recentEvents` from the event log. Three limits remain:
  1. *Resolved 2026-11-11 in the domain package:* the task catalogue carries neither a stage order nor stage labels, and its order differs from the fixtures'. `CASE_STAGES` in `@ehf/fincrime-views` now states both (QA before the decision; document intelligence is a supporting task, not a stage), and the live case room lists every stage, `pending` where the case has no work yet. The catalogue itself still has no order.
  2. *Resolved 2026-11-11:* `recentEvents` needed `event.read`, and the live claims and decision reads page the event log too, so case roles could open neither. `Case.Analyst` and `Case.Reviewer` now hold `event.read`.
  3. *Resolved 2026-11-11:* `humanWork` needed `human_work.read`, which `Case.Analyst` lacked. The role now holds it (read only; claim and decide stay with `Case.Reviewer`). The upstream human-work read is not scoped per case, so the role can list the whole queue.
- **Proposed:** carry the stage order and labels in the pack's task catalogue so `CASE_STAGES` can be derived from it; scope the human-work read to cases the caller can read.

## GAP-077 · BIZ-02 · the findings registry is a projection; owners, workflow states and derived items have no record
- **Severity:** medium · **Owner:** EHF (case store) + pack (policy)
- **Found:** 2026-11-11. `getFincrimeCasesCaseIdFindings` lists the case store's contradictions and findings under their stored ids, with the reviews recorded against them, and `postFincrimeCasesCaseIdFindingsFindingIdDispositions` lets a holder of `case.review` record a `FINDING_DISPOSITION` review (SUBSTANTIATED or NOT_SUBSTANTIATED, with a rationale and the evidence viewed). What the case store does not hold:
  1. An owner for a finding, and any state between open and closed (investigating, awaiting information, ready for review, reopened).
  2. A link from a work item to the finding it serves.
  3. A record for what the screen derives from projections: ownership gaps, unverified document values, missing documents. They have no id, so nothing can be recorded against them.
  4. The actor of a contradiction's resolution on the contradiction row (it is in the event log only), so the registry shows that resolution without a name.
- **Workaround:** "dispositioned" is derived from the presence of a review of the finding; the finding's own stored status does not change. Contradictions are closed by `ResolveContradiction` and screening findings by their human step, and the disposition endpoint refuses both. The two outcome values are the screen's vocabulary, not a policy catalogue.
- **Proposed:** decide the finding lifecycle and its authorities as policy; add owner, state and task links to the case store; record derived gaps as findings when they are detected.

