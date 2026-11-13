# Archived deterministic flows

Archived 2026-11-09 ([agentic KYC and KYB plan](../../docs/implementation/agentic-kyc-kyb-plan.md),
decision 1). These are the deterministic reference flows that ran library skills as a fixed chain of
nodes with no agent profile:

| Package | Was | Compiled plan |
| --- | --- | --- |
| `kyc-v2-deterministic/` | `domains/kyc/v2`: individual CDD, 28 skill steps, three OPA gates, dual-control approval | `artifacts/archive/kyc-v2.plan.json` |
| `kyb-deterministic/` | `domains/kyb`: synthetic KYB, 33 skill steps, no OPA bundle, single approval | `artifacts/archive/kyb.plan.json` |

**Frozen, not deleted.** Every file inside the two package directories is byte-identical to the
version that was archived, so both plans compile to the same digests as before
(`7636d720…` for KYC, `4c3a9f2a…` for KYB). Their READMEs and generated headers therefore still
name the old paths. CI keeps regenerating (`scripts/sync-kyc-package.mjs`,
`scripts/sync-kyb-package.mjs`), compiling (`make compile`) and testing them.

**Why they are kept.** They are the regression baseline and the parity oracle for the agentic flows:
where an agentic flow and its deterministic predecessor disagree on a corpus hero, the difference is
reviewed, never silently accepted.

**What did not move.** The KYC policy-as-code (`domains/kyc/policy`), the candidate banking policy
(`domains/fincrime`) and the connector stages (`scripts/lib/kyb-connectors.mjs`) are inputs to the
agentic flows and stay where they are. Do not start new work from these packages; start from the
agentic templates.
