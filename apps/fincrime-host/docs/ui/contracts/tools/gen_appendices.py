#!/usr/bin/env python3
"""Regenerate the appendices of docs/ui/BUILD-SPEC.md from the contract pack (v2).

  python3 docs/ui/contracts/tools/gen_appendices.py

Everything below the GENERATED marker in BUILD-SPEC.md is replaced. Fails on unknown
screen ids, so a new operation can't silently reference a surface the spec doesn't define.
"""
import json
import pathlib
import re
import sys

import yaml

HERE = pathlib.Path(__file__).resolve()
CONTRACTS = HERE.parents[1]
UI = CONTRACTS.parent
SPEC = UI / "BUILD-SPEC.md"
MARK = "<!-- GENERATED APPENDICES BELOW — do not edit by hand; regenerate with docs/ui/contracts/tools/gen_appendices.py -->"

spec = yaml.safe_load((CONTRACTS / "experience-api.openapi.yaml").read_text())
per = json.loads((CONTRACTS / "fixtures" / "personas.json").read_text())
scn = json.loads((CONTRACTS / "fixtures" / "scenario.kyb-1042.json").read_text())
ehf = json.loads((CONTRACTS / "fixtures" / "ehf.kyb-1042.json").read_text())
text = SPEC.read_text()
head = text.split(MARK)[0]

known = set(re.findall(r"\b((?:PLT|CXT|AGT|BIZ|ASR)-\d{2})\b", head)) | {"shell", "all"}
out = [MARK, ""]

# A — operations
out += ["## Appendix A — Operation matrix", "",
        "Generated from `experience-api.openapi.yaml`. *Upstream* is the service and route a relay calls (`bff` = composed in the BFF). *Action* is the EHF platform action enforced upstream. *Poll* is the `x-poll` interval.", ""]
unknown = []
tags = [t["name"] for t in spec["tags"]]
for tag in tags:
    rows = []
    for path, methods in spec["paths"].items():
        for m, o in methods.items():
            if o["tags"][0] != tag:
                continue
            u = o.get("x-upstream", {})
            ups = f"{u['service'].replace('experience-bff', 'bff')} `{u['method']} {u['path']}`" if u.get("path") else ("bff" if u else ("mock" if o.get("x-mock-only") else "—"))
            scr = o.get("x-screens", [])
            unknown += [s for s in scr if s not in known]
            poll = f"{o['x-poll']['intervalMs'] // 1000}s" if o.get("x-poll") else ""
            flag = f" · *{o['x-status']}*" if o.get("x-status") else ""
            rows.append(f"| `{o['operationId']}` | `{m.upper()} {path}` | {ups} | {o.get('x-action', '')} | {', '.join(scr)} | {poll}{flag} |")
    if rows:
        out += [f"### {tag}", "", "| operationId | Route | Upstream | Action | Screens | Poll |", "|---|---|---|---|---|---|", *rows, ""]
if unknown:
    sys.exit(f"unknown screen ids in x-screens: {sorted(set(unknown))}")

# B — personas
out += ["## Appendix B — Personas", "", "From `fixtures/personas.json`. Actions are the union of the roles' actions in `packages/identity/src/authorization.ts`.", "",
        "| Persona | Principal | Roles | # actions | Landing | Notes |", "|---|---|---|---|---|---|"]
for p in per["personas"]:
    q, s = p["persona"], p["session"]
    out.append(f"| {q['roleLabel']} (`{q['personaId']}`) | `{s['subject']['subjectId']}` | {', '.join(q['roles'])} | {len(s['actions'])} | `{q['landingRoute']}` | {q['notes']} |")
out.append("")

# C — role → actions
out += ["## Appendix C — Roles → platform actions (pinned)", "", "| Role | Actions |", "|---|---|"]
for r, acts in sorted(per["roleActions"].items()):
    out.append(f"| `{r}` | {', '.join(f'`{a}`' for a in acts)} |")
out.append("")

# D — scenario
out += ["## Appendix D — Scenario KYB-1042", "", "| S | State | Case status | caseSequence | Open human work (required approvals · decisions so far) | Clock |", "|---|---|---|---|---|---|"]
for i, (name, st) in enumerate(ehf["states"].items(), 1):
    hw = "; ".join(f"`{q['workItem']['workItemId']}` ({q['requiredApprovals']} · {len(q['decisions'])})" for q in st["humanQueue"]) or "—"
    out.append(f"| S{i} | `{name}` | {st['caseStatus']} | {st['snapshot']['caseSequence']} | {hw} | {st['clock']} |")
out += ["", "**Transitions** (fire when the named work item completes with the decision):", ""]
for t in scn["transitions"]:
    extra = " — must be a different principal from the first approver" if t["on"].get("distinctFromPrior") else ""
    out.append(f"- `{t['from']}` → `{t['to']}` on `{t['on']['decision']}` for `{t['on']['workItemId']}`{extra}")
out += ["", "**Rules:**", ""] + [f"- {r}" for r in scn["rules"]] + [""]

# E — fixture → schema map
out += ["## Appendix E — Fixture → schema map", "", "| Fixture path | Schema |", "|---|---|",
        "| `personas.json#/personas/*/persona` | `Persona` |", "| `personas.json#/personas/*/session` | `Session` |",
        "| `fincrime.catalog.json#/catalog` | `CatalogView` |", "| `fincrime.catalog.json#/skills/*` | `SkillSummary` |",
        "| `fincrime.catalog.json#/tasks/*` | `TaskComposition` |", "| `fincrime.catalog.json#/contextProducts/*` | `ContextProductView` |",
        "| `fincrime.catalog.json#/readiness` | `ContextReadinessMatrix` |",
        "| `ehf.kyb-1042.json#/states/*/snapshot` | EHF `caseSnapshot` |", "| `…/workItems/*` | EHF `executionWorkItem` |", "| `…/humanQueue/*` | `HumanQueueItem` |",
        "| `…/decisions/*` | EHF `humanWorkDecision` |", "| `…/run` | EHF `runRecord` |", "| `…/runEvents/*` | EHF `runtimeEvent` |", "| `…/releases/*` | EHF `releaseRecord` |",
        "| `…/caseSummary` | control-ui `CaseSummaryView` |", "| `…/caseEvents/*` | `CaseEventRow` |",
        "| `scenario.kyb-1042.json#/states/*/{attention,caseRoom,claims,ownership,screening,decision,recorder,causality,lineage,missionControl,agents}` | `AttentionQueue`, `CaseRoom`, `ClaimsView`, `OwnershipView`, `ScreeningView`, `DecisionDesk`, `FlightRecorder`, `CausalGraph`, `LineageGraph`, `MissionControl`, `AgentAtlas` |",
        "| `…/contradictions/*`, `…/screeningComparisons/*`, `…/ownershipOptions/*` | `ContradictionDetail`, `ScreeningComparison`, `DecisionOption` |",
        "| `platform.json#/{overview,system,gatewayStatus}` | control-ui `OverviewView`, `SystemView`, `GatewayStatusView` |",
        "| `platform.json#/{drafts,harnesses,runs,cases,modelTiers,providers,modelProfiles,settings,changeLog}/*` | control-ui views of the same names |",
        "| `records.kyb-1042.json#/records/*` | kyc `schemas/runtime/Record` |", ""]

# F — glossary
out += ["## Appendix F — Glossary", "",
        "- **Basis:** the `{caseSequence, snapshotDigest}` a human reviewed. A decision on an older basis is stale (EHF 17).",
        "- **BusinessAgent:** a kyc agent profile: mandate, personas, tasks, human gates, context products, and execution ceilings.",
        "- **Business command:** a typed case mutation submitted to case-api (`businessCommandType`), answered with a receipt (`commandOutcome`).",
        "- **Ceiling:** the most context an agent may ever see: `context_fields` per object type, plus `policy_fields`.",
        "- **Claim (work item):** joining a human work item's assignees. It does not lock others out. Once anyone has claimed, only assignees can decide.",
        "- **Context product:** one of 12 governed canonical projections a BusinessAgent subscribes to.",
        "- **Dual control:** `constraints.dualControlRequired` → two distinct principals must submit the same decision.",
        "- **Relay:** a BFF operation that forwards 1:1 to an EHF route under delegated identity, adding no authority.",
        "- **Receipt:** the durable response that proves a mutation happened. The UI shows nothing as done before it.",
        "- **TaskSpec:** a kyc task: ordered skill steps with dependencies, completion criteria and a failure policy.", ""]

SPEC.write_text(head + "\n".join(out))
print(f"appendices regenerated: {sum(len(m) for m in spec['paths'].values())} operations, {len(per['personas'])} personas")
