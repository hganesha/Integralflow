## Business outcome

Create an idempotent next-review schedule command from the pinned review interval and invocation business time. Scheduling is a work handoff, not proof of an operating review or monitoring integration.

## Procedure

1. Require a positive review_interval_seconds in the pinned policy. Reject missing/nonpositive intervals; do not choose an arbitrary periodicity from the current risk label.
2. Calculate due_at from invocation as_of_time plus the configured interval. Derive schedule identity from case, review action and due time so the intended invocation can be retried consistently.
3. Propose the schedule state command through the executor with expected revision and internal_write authority. Preserve the due date, case scope, policy/context basis and committed-versus-held state.
4. Have the platform hand off to durable due work/approved delivery. Monitor command persistence, delivery acknowledgment, review execution and resulting control reassessment separately.
5. If customer/ownership/product/risk context changes, follow the approved event/review policy instead of assuming the old schedule covers the new basis. A completed work item alone does not satisfy its underlying evidence requirement.

## Evidence and uncertainty

Keep source record versions, selected fields, as-of/knowledge-cutoff, policy snapshot and context/instruction hashes. Preserve contradictory claims and optional gaps. Source references support traceability but do not themselves establish truth or qualification. COMPLETED is an execution status; inspect domain outputs and parent requirements before a business conclusion.

## Variations

Review periodicity varies by approved institution/product/customer/risk policy and lifecycle. This handler uses a seconds interval, not a business calendar; legal/calendar schedules require a supported separately qualified implementation. Tenant and case scope cannot widen through the schedule payload.

## Examples and acceptance

- Positive interval: exact due time relative to as-of, stable schedule ID and executor-governed command.
- Missing or nonpositive interval: POLICY_UNRESOLVED.
- Replay same invocation: no duplicate committed effect.
- Due schedule with stopped worker: outstanding handoff, not completed monitoring.
- Material ownership change: explicit reassessment/event work required in addition to periodic schedule.

## Limitations

No external worker execution or monitoring acknowledgment in the schedule calculation. Consequential effects remain synthetic-only in the current library executor. No business-calendar or regulator-approved interval is implied. Current maturity remains implemented_synthetic. Independent evaluation, policy/source approvals and operating qualification are required before production.
