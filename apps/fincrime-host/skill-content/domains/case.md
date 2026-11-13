### Case lifecycle and human work

Case state and tasks change only through authorized commands with expected revisions and stable idempotency. A proposed transition is not committed state; an enqueued task is not completed work.

Preserve case/subject/tenant scope, dependency status, assignee role, deadline/calendar and independent approval basis. Changed context or approval expiry requires reassessment rather than reuse of stale authority.

Closure, reopen, escalation, assignment and review differ by case type and institution workflow. A generic owner role must not imply authority to accept risk or resolve a regulated finding.

Test concurrent revisions, repeated commands, task dependency cycles, invalid transitions, denied roles, stale approvals, restart and cancellation. Confirm durable work delivery and reconciliation rather than only queue insertion.
