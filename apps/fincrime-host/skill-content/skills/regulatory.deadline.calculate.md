## Business outcome

Calculate configured synthetic calendar/business-day deadlines from an aware timestamp. Use `regulatory.deadline.calculate` for this bounded operation in the parent business workflow. The supplied context must come from authorized canonical producers. A result describes the admitted records as of the invocation time; it does not independently establish facts outside those records.

## Procedure

1. Identify the target subject/relationship and the workflow requirement this operation addresses. Confirm that its required inputs are present: the admitted identity and pinned policy. Preserve gaps instead of copying values from an unrelated party or historical assessment.
2. Validate `event_at`, `report_type` against the input contract. Resolve the pinned policy fields `reporting_obligations`. Unsupported applicability or a missing required rule must remain visible; use only the handler's defined result or error, never a model-invented default.
3. Perform the stated bounded behavior: Calculate configured synthetic calendar/business-day deadlines from an aware timestamp. Execute the registered implementation rather than recreating financial calculations or verification in model prose. Shared helper logic does not grant permission to invoke undeclared providers.
4. Inspect `deadline`, `calendar_basis`. Retain uncertainty, candidates, conflicts and supporting record references. Check the actual payload meaning before the workflow treats execution completion as satisfying its requirement.
5. Hand off unresolved evidence or judgment to the appropriate producer/reviewer. Effects mode is `read_only`: proposed or queued changes require the executor's effect controls, and human-gated work cannot execute on the strength of this document.

## Evidence and uncertainty

Use only selected source versions and their admitted policy/context basis. Preserve original values alongside normalization and derived results. Evidence references locate support; they do not by themselves prove authenticity, identity or semantic truth. `COMPLETED` means execution completed under this contract; the parent workflow must inspect the business payload and remaining requirements.

## Variations

Apply the domain guidance below to institution, legal form/role, product, jurisdiction, lifecycle, source and time. Only combinations supported by the pinned policy, data contracts and qualified integration may be selected. Unknown applicability is a review/evidence gap. Provider coverage and verification standards are configuration/evidence, not assumptions inferred from a vendor or document name.

## Examples and acceptance

- Normal input: CTR (3 business days, Monday to Friday, no holidays) from Friday 2026-11-06T00:00Z: `deadline: 2026-11-11T00:00:00+00:00`, `calendar_basis: business_days`. SAR (7 calendar days) from 2026-11-01T00:00Z: `deadline: 2026-11-08T00:00:00+00:00`, `calendar_basis: calendar_days`. Both obligations are pinned with `time_zone: UTC`, returned as `time_zone`, and both `COMPLETED`.
- Offsets: days are counted on the obligation zone's local dates. Under UTC, 2026-11-06T20:00-05:00 is Saturday 01:00; it and 2026-11-07T01:00Z both give `deadline: 2026-11-11T01:00:00+00:00`.
- Obligation time zone: with `time_zone: America/New_York`, 2026-11-06T20:00-05:00 is Friday local, so the CTR deadline is `2026-11-11T20:00:00-05:00` (a day earlier than under UTC). Daylight saving: SAR 7 calendar days from 2026-10-30T12:00-04:00 keep the local wall time: `2026-11-06T12:00:00-05:00`.
- Holiday: with 2026-11-09 among the calendar's holidays, the CTR deadline from Friday 2026-11-06T00:00Z is `2026-11-12T00:00:00+00:00`.
- Conflict and gaps: a second pinned CTR obligation of 5 business days: `SOURCE_CONFLICT` / `NEEDS_REVIEW`, neither is picked. No BusinessCalendar for a business-day rule: `CONTEXT_MISSING` / `NEEDS_EVIDENCE`. No `reporting_obligations`, or an obligation zone that is not a known IANA name: `POLICY_UNRESOLVED` / `BLOCKED`. Two CTR obligations differing only in `time_zone`: `SOURCE_CONFLICT`. An obligation with no `time_zone` is refused when the policy is admitted.

## Limitations

This package is an implemented synthetic reference, not a qualified production service. Its scope is the behavior stated above and the typed input/output contracts. Independent representative evaluation, approved institution policy and supported source mappings remain required. No independent real-source accuracy or institution-specific acceptance authority is established by the bundled examples. Days are counted on the local dates of the obligation's `time_zone` and the deadline keeps the event's local wall time; a wall time skipped by a daylight-saving change is written as the instant it maps to, and a repeated one takes its first occurrence. The BusinessCalendar's holidays are read as dates in that zone; it does not state a zone of its own. A calendar-day deadline is not moved off a weekend or holiday.
