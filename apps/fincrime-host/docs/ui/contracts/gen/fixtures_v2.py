"""Fixtures v2: the mock store seed for the Experience API v2.

  python3 docs/ui/contracts/gen/fixtures_v2.py [path-to-ehfconcept]   (or $EHF_ROOT)


Inputs (all pinned in SOURCES.lock.json):
  kyc        catalog/ehf-catalog.json, catalog/context-matrix.json, catalog/catalog.json, docs/ui/contracts/fixtures/records.kyb-1042.json
  ehfconcept packages/identity/src/authorization.ts (role -> action table)
Outputs (docs/ui/contracts/fixtures/):
  personas.json            personas mapped to real EHF roles + derived actions + Session objects
  fincrime.catalog.json    CatalogView, SkillSummary[], ContextProductView[], ContextReadinessMatrix, agent cards
  ehf.kyb-1042.json        EHF-shaped store per scenario state (caseSnapshot, work items, human queue, runs, events, releases)
  scenario.kyb-1042.json   FinCrime view models per state + transitions the mock applies
  platform.json            control-ui view-model seeds for platform surfaces
"""
import copy
import hashlib
import json
import re

import os
import pathlib
import sys

_CONTRACTS = pathlib.Path(__file__).resolve().parents[1]
ROOT = str(_CONTRACTS.parents[2])                      # kyc repo root
UI = str(_CONTRACTS)
OUT = UI + "/fixtures"
_EHF = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("EHF_ROOT", str(pathlib.Path(ROOT).parent / "ehfconcept")))
EHF_ID = str(_EHF / "packages/identity/src/authorization.ts")
UP = json.load(open(UI + "/upstream/ehf-contracts.schema.json"))["$defs"]
VW = json.load(open(UI + "/upstream/control-ui-views.schema.json"))["$defs"]

H = lambda s: hashlib.sha256(s.encode()).hexdigest()
T = "tenant_demo"
CASE = "KYB-1042"
PLAN = H("plan:fincrime-kyb:1.0.0")
POLICY_BUNDLE = H("policy-bundle:kyc:2026.11")
POLICY_SNAP = H("policy-snapshot:kyc:2026.11")
PERM_ENV = H("permission-envelope:fincrime-kyb")
DEP_DIGEST = H("dependencies:fincrime-kyb")
RUN = "run_kyb_1042"
TRACE = H("trace:" + RUN)[:32]


def J(name, obj):
    with open(f"{OUT}/{name}", "w") as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)
        f.write("\n")


# ---------------------------------------------------------------- roles
def role_actions():
    src = open(EHF_ID).read()
    read = re.search(r"const READ_ACTIONS: PlatformAction\[\] = \[(.*?)\];", src, re.S).group(1)
    read_actions = re.findall(r'"([a-z_.]+)"', read)
    table = re.search(r"const ROLE_ACTIONS: Record<string, PlatformAction\[\]> = \{(.*?)\n\};", src, re.S).group(1)
    out = {}
    for m in re.finditer(r'"([A-Za-z.]+)":\s*(READ_ACTIONS|\[(.*?)\]),', table, re.S):
        role, whole, body = m.group(1), m.group(2), m.group(3) or ""
        acts = list(read_actions) if whole == "READ_ACTIONS" else []
        if "...READ_ACTIONS" in body:
            acts += read_actions
        acts += [a for a in re.findall(r'"([a-z_.]+)"', body)]
        out[role] = sorted(set(acts))
    return out


ROLE_ACTIONS = role_actions()
WORKLOAD = {"Control.Api.Access", "Case.Api.Access", "Capability.Invoke", "Runtime.State.Write", "Case.Outbox.Publish", "Policy.Authority.Read",
            "Envelope.Delegate", "Skill.Host", "Integration.Dispatch", "Factory.Worker", "Discovery.Launch"}
HUMAN_ROLES = {k: v for k, v in ROLE_ACTIONS.items() if k not in WORKLOAD}

PERSONAS = [
    # id, principal, name, label, roles, landing, notes
    ("cdd_analyst", "r.okafor", "R. Okafor", "CDD / KYB Analyst", ["Case.Analyst", "Case.Reviewer"], "/work", "Claims and decides ownership review work items."),
    ("screening_analyst", "l.nakamura", "L. Nakamura", "Sanctions & Screening Analyst", ["Case.Analyst", "Case.Reviewer"], "/work", "Decides screening review work items."),
    ("compliance_officer", "s.varga", "S. Varga", "Compliance Officer / MLRO", ["Case.Reviewer"], "/work", "First approver on the dual-control decision gate."),
    ("second_approver", "h.adeyemi", "H. Adeyemi", "Deputy MLRO", ["Case.Reviewer"], "/work", "Second, distinct approver for dual control."),
    ("qa_reviewer", "t.brandt", "T. Brandt", "QA Reviewer", ["Case.Reviewer", "Harness.Reader"], "/assurance", "Reads everything; reviews QA work items."),
    ("relationship_manager", "d.patel", "D. Patel", "Relationship Manager", ["Case.Analyst"], "/work", "Can add evidence; cannot decide."),
    ("case_manager", "m.castillo", "M. Castillo", "KYC Team Manager", ["Case.Manager"], "/work", "Assigns cases to teams and people; oversees the queue; cannot decide."),
    ("ops_manager", "a.ruiz", "A. Ruiz", "KYC Operations Manager", ["Harness.Operator"], "/assurance", "Resolves conflicting decisions; starts/cancels runs."),
    ("agent_architect", "j.moreau", "J. Moreau", "Agent Architect", ["Harness.Author"], "/platform/drafts", "Authors drafts; cannot approve own drafts."),
    ("harness_approver", "e.kowalski", "E. Kowalski", "Harness Approver", ["Harness.Approver"], "/platform/drafts", "Approves and publishes drafts authored by others."),
    ("context_architect", "m.lindqvist", "M. Lindqvist", "Context Architect", ["Harness.Author"], "/context", "Edits context selectors and classification policies on drafts."),
    ("auditor", "p.lindgren", "P. Lindgren", "Internal Auditor", ["Platform.Auditor"], "/assurance", "Read-only including admin configuration and change log."),
    ("platform_admin", "n.osei", "N. Osei", "Platform Administrator", ["Platform.Admin"], "/platform/admin", "Writes admin configuration; not an author or approver."),
]
NAMES = {p[1]: p[2] for p in PERSONAS}


def session(p):
    pid, sub, name, label, roles, landing, _ = p
    acts = sorted({a for r in roles for a in HUMAN_ROLES[r]})
    return {"subject": {"subjectId": sub, "displayName": name, "actorType": "human", "email": None},
            "tenant": {"tenantId": T, "name": "Demo tenant (synthetic)"},
            "roles": roles, "actions": acts, "authoringEnabled": True,
            "environment": {"name": "mock", "managedConfiguration": False, "runtimeMode": "Recorded", "build": "ui-mock 2.0.0", "synthetic": True},
            "domains": [{"id": "fincrime", "label": "Financial crime (KYC/KYB)", "catalogDigest": None, "sourceRelease": None}],
            "csrfToken": "mock-csrf-" + sub, "expiresAt": "2026-11-08T23:59:59Z"}


# ---------------------------------------------------------------- catalog
EC = json.load(open(ROOT + "/catalog/ehf-catalog.json"))
CC = json.loads(EC["content"])
CAT_DIGEST = EC["sha256"]
AGENTS = [json.loads(a["canonical"]) for a in CC["agents"]]
TASKS = [json.loads(t["canonical"]) for t in CC["tasks"]]
PRODUCTS = CC["contextProducts"]
SKILLS = [json.loads(s["canonical"]) for s in CC["skills"]]
SK = {s["id"]: s for s in SKILLS}
MATRIX = json.load(open(ROOT + "/catalog/context-matrix.json"))

AGENT_OF_SKILL, TASK_OF_SKILL = {}, {}
for t in TASKS:
    for st in t["steps"]:
        AGENT_OF_SKILL.setdefault(st["skill_id"], set()).add(t["agent_profile"])
        TASK_OF_SKILL.setdefault(st["skill_id"], set()).add(t["id"])
OBJ_PRODUCT = {o: p["id"] for p in PRODUCTS for o in p["objects"]}


def skill_summary(s):
    objs = sorted({r["object_type"] for r in s.get("required_context", [])} | {r["object_type"] for r in s.get("optional_context", [])})
    return {"skill_id": s["id"], "version": s["semver"], "business_outcome": s["business_outcome"], "domain": s["id"].split(".")[0],
            "execution_mode": s.get("execution_mode"), "effects": [s["effects"]] if isinstance(s.get("effects"), str) else list(s.get("effects", [])),
            "context_object_types": objs, "agent_ids": sorted(AGENT_OF_SKILL.get(s["id"], [])), "task_ids": sorted(TASK_OF_SKILL.get(s["id"], []))}


SKILL_SUMMARIES = [skill_summary(s) for s in SKILLS]
SS = {s["skill_id"]: s for s in SKILL_SUMMARIES}


def field_req(row):
    return {"object_type": row["object_type"], "field": row["field"], "required": bool(row.get("required")), "min_count": int(row.get("min_count") or 0),
            "on_missing": row.get("on_missing") or "NEEDS_EVIDENCE", "freshness_policy": row.get("freshness_policy"), "temporal": row.get("temporal"), "skill_id": row["skill_id"]}


def ceilings_for(product):
    out = []
    for a in AGENTS:
        fields = {o: f for o, f in a["execution"].get("context_fields", {}).items() if o in product["objects"]}
        if "Policy" in product["objects"] and a["execution"].get("policy_fields"):
            fields["Policy"] = a["execution"]["policy_fields"]
        if fields:
            out.append({"agentId": a["id"], "fields": fields})
    return out


def product_view(p):
    rows = [field_req(r) for r in MATRIX if OBJ_PRODUCT.get(r["object_type"]) == p["id"]]
    return {"product": p,
            "consumers": {"agents": sorted(a["id"] for a in AGENTS if p["id"] in a["context_products"]),
                          "skills": sorted({r["skill_id"] for r in rows})},
            "fieldRequirements": rows, "ceilings": ceilings_for(p),
            "capabilityReadiness": {"status": "pending_upstream", "note": "Provider binding readiness waits for the canonical external capability model (ehfconcept, proposed)."}}


def readiness_matrix():
    cells = []
    for a in AGENTS:
        agent_skills = set(a["execution"]["allowed_skills"])
        for p in PRODUCTS:
            sub = p["id"] in a["context_products"]
            req = [r for r in MATRIX if r["skill_id"] in agent_skills and OBJ_PRODUCT.get(r["object_type"]) == p["id"] and r.get("required")]
            ceil = {(o, f) for o, fs in a["execution"].get("context_fields", {}).items() if o in p["objects"] for f in fs}
            if "Policy" in p["objects"]:  # policy fields have their own ceiling (AgentProfile.policy_fields)
                ceil |= {("Policy", f) for f in a["execution"].get("policy_fields", [])}
            gaps = sorted({f"{r['object_type']}.{r['field']}" for r in req if (r["object_type"], r["field"]) not in ceil})
            status = "not_subscribed" if not sub and not req else ("gaps" if gaps or (req and not sub) else "ready")
            cells.append({"agentId": a["id"], "productId": p["id"], "subscribed": sub, "requiredFields": len({(r["object_type"], r["field"]) for r in req}),
                          "ceilingFields": len(ceil), "status": status, "gaps": gaps[:20]})
    return {"products": [p["id"] for p in PRODUCTS], "agents": [a["id"] for a in AGENTS], "cells": cells}


MATRIX_VIEW = readiness_matrix()
CATALOG_VIEW = {"catalogDigest": CAT_DIGEST, "apiVersion": CC["apiVersion"], "sourceRelease": CC["sourceRelease"], "bundleCodeHash": CC["bundleCodeHash"],
                "contextSchemaVersion": CC["contextSchemaVersion"], "agents": AGENTS, "tasks": TASKS, "contextProducts": PRODUCTS, "skillCount": len(SKILLS)}


def task_composition(t):
    crit = {c["step_id"]: c for c in t["completion_criteria"]}
    groups, order = {}, 0
    for st in t["steps"]:
        key = tuple(sorted(st["dependencies"]))
        if key not in groups:
            groups[key] = order
            order += 1
    peers = {}
    for st in t["steps"]:
        peers.setdefault(tuple(sorted(st["dependencies"])), []).append(st["id"])
    steps = [{"id": st["id"], "skill": SS[st["skill_id"]], "dependencies": st["dependencies"],
              "parallelGroup": groups[tuple(sorted(st["dependencies"]))] if len(peers[tuple(sorted(st["dependencies"]))]) > 1 else None,
              "requiresHumanDecision": bool(crit.get(st["id"], {}).get("requires_human_decision")),
              "acceptedStatuses": crit.get(st["id"], {}).get("accepted_statuses", []),
              "requiredPayloadFields": crit.get(st["id"], {}).get("required_payload_fields", [])} for st in t["steps"]]
    edges = [{"from": d, "to": st["id"]} for st in t["steps"] for d in st["dependencies"]]
    ids = {st["id"] for st in t["steps"]}
    validation = [
        {"check": "Every dependency names a step in this task", "outcome": "PASS" if all(d in ids for st in t["steps"] for d in st["dependencies"]) else "FAIL", "detail": None},
        {"check": "Every step has a completion criterion", "outcome": "PASS" if all(st["id"] in crit for st in t["steps"]) else "FAIL", "detail": None},
        {"check": "Every skill is allowed by the agent profile", "outcome": "PASS" if all(st["skill_id"] in next(a for a in AGENTS if a["id"] == t["agent_profile"])["execution"]["allowed_skills"] for st in t["steps"]) else "FAIL", "detail": None},
        {"check": "Failure policy covers ambiguous, missing and unavailable evidence", "outcome": "PASS" if {"ambiguous_evidence", "missing_required_evidence", "unavailable_required_source"} <= set(t["failure_policy"]) else "FAIL", "detail": None}]
    return {"task": t, "steps": steps, "edges": edges, "validation": validation}


# ---------------------------------------------------------------- EHF objects
def ts(h, m, s=0, d=7):
    return f"2026-11-{d:02d}T{h:02d}:{m:02d}:{s:02d}Z"


def actor(kind, principal, roles=None, execution=None):
    a = {"type": kind, "principalId": principal, "roles": roles or []}
    if execution:
        a["executionId"] = execution
    return a


AGENT_LABEL = {a["id"]: a["mandate"] for a in AGENTS}
TASK_LABEL = {"task.intake_profile": "Intake & profile", "task.identity_ownership": "Identity & ownership", "task.screening": "Screening",
              "task.risk_edd": "Risk & EDD", "task.qa_assurance": "QA & assurance", "task.decision_support": "Decision"}
TASK_ORDER = ["task.intake_profile", "task.identity_ownership", "task.screening", "task.risk_edd", "task.qa_assurance", "task.decision_support"]
TASK = {t["id"]: t for t in TASKS}


def work_item(wid, task_id, step_id, status, *, seq, updated, human=False, dual=False, reason=None, deadline=None, result=None, objective=None, priority=50):
    t = TASK[task_id]
    st = next(s for s in t["steps"] if s["id"] == step_id) if step_id else None
    wi = {
        "apiVersion": "harness.factory/execution-work-item-v1", "kind": "ExecutionWorkItem", "tenantId": T, "caseId": CASE, "workItemId": wid,
        "workType": "human_review" if human else "fincrime.skill_step",
        "capabilityId": None if human else st["skill_id"],
        "assuranceClass": "consequential" if human else "standard", "revision": 1, "caseSequenceBasis": seq, "planDigest": PLAN,
        "policyContextRef": "policy:kyc@2026.11", "schemaVersion": "1.0.0",
        "objective": objective or (t["objective"] if not st else f"{SS[st['skill_id']]['business_outcome']}"),
        "subjectRefs": ["subject:acme"], "requiredOutputs": [] if human else next((c["required_payload_fields"] for c in t["completion_criteria"] if c["step_id"] == step_id), []),
        "constraints": {"runId": RUN, "taskId": task_id, "stepId": step_id, "agentProfile": t["agent_profile"],
                        **({"dualControlRequired": True} if dual else {}), **({"gate": "consequential decision"} if dual else ({"gate": "ambiguous evidence"} if human else {}))},
        "dependencyIds": [], "dependencyDigest": H("deps:" + wid), "invalidationPolicy": "REEVALUATE" if human else "REWORK",
        "status": status, "reasonCode": reason, "priority": priority, "readyAt": updated, "deadlineAt": deadline,
        "terminalAt": updated if status in ("COMPLETED", "CANCELLED", "FAILED", "EXPIRED") else None,
        "dispatch": {"generation": 1, "queue": "human" if human else "fincrime", "publishedAt": updated, "brokerMessageId": None},
        "lease": None,
        "limits": {"maxAttempts": 1 if human else 3, "maxReworkCycles": 2, "maxDurationMs": 86400000 if human else 120000, "maxCostUsd": 0 if human else 0.5, "maxModelCalls": 0 if human else 8, "maxCapabilityCalls": 0 if human else 6},
        "result": result, "createdBy": actor("SYSTEM", "service:controller"), "transitionSequence": 3, "traceId": TRACE,
        "createdAt": updated, "updatedAt": updated}
    return wi


def done(wid, task_id, step_id, seq, at):
    return work_item(wid, task_id, step_id, "COMPLETED", seq=seq, updated=at, reason="fincrime.step_completed",
                     result={"agentResultRef": f"outcome:{wid}", "acceptedCommandRefs": [f"cmd:{wid}"], "outputRefs": [], "failureCode": None, "failureDetailRef": None})


def decision(did, wid, principal, dec, reason, rationale, at, evidence=()):
    return {"decisionId": did, "tenantId": T, "caseId": CASE, "workItemId": wid, "principalId": principal, "decision": dec,
            "reasonCode": reason, "rationale": rationale, "evidenceRefs": list(evidence), "decidedAt": at}


def queue_item(wi, decisions=(), assigned=(), overdue=False, escalated=False):
    return {"workItem": wi, "overdue": overdue, "escalated": escalated, "assignedTo": list(assigned), "decisions": list(decisions),
            "requiredApprovals": 2 if wi["constraints"].get("dualControlRequired") else 1}


def snapshot(seq, at, data):
    return {"apiVersion": "harness.factory/case-snapshot-v1", "kind": "CaseSnapshot", "snapshotId": f"snap_{CASE}_{seq}", "snapshotDigest": H(f"snapshot:{CASE}:{seq}"),
            "tenantId": T, "caseId": CASE, "caseSequence": seq, "dependencyDigest": DEP_DIGEST, "planDigest": PLAN,
            "policyAuthority": {"policyId": "kyc", "policyVersion": "2026.11", "policySnapshotDigest": POLICY_SNAP, "policyBundleDigest": POLICY_BUNDLE},
            "consistency": "strong", "classification": "confidential", "data": data, "capturedAt": at}


def run_record(status, at, node, completed=None):
    return {"runId": RUN, "idempotencyKey": "kyb-1042-onboarding", "planDigest": PLAN, "status": status, "terminalOutcome": "completed" if status == "completed" else None,
            "input": {"tenantId": T, "caseId": CASE}, "output": None, "attempt": 1, "fencingEpoch": 1, "latestCheckpointId": f"cp_{node}", "currentNodeId": node,
            "errorCode": None, "traceId": TRACE, "rootSpanId": TRACE[:16], "traceFlags": 1, "costUsd": 0.42, "costComplete": False, "modelCalls": 14, "capabilityCalls": 9,
            "createdAt": ts(9, 12, 4), "startedAt": ts(9, 12, 4), "completedAt": completed, "updatedAt": at}


# case events (business command log), 1-based sequences
EV = []
def ev(seq, ctype, summary, act, at):
    EV.append({"sequence": seq, "commandType": ctype, "summary": summary, "actor": act, "occurredAt": at})
SYS = actor("SYSTEM", "service:case-api")
AGT = lambda a, wi: actor("AGENT", a, ["Case.Api.Access"], f"exec_{wi}")
HUM = lambda p, *roles: actor("HUMAN", p, list(roles) or ["Case.Reviewer"])
ev(1, "AddSubject", "Case opened for Acme Trading Ltd (corporate onboarding)", HUM("d.patel", "Case.Analyst"), ts(9, 12, 4))
ev(2, "ProposeWorkItem", "Intake & profile planned", SYS, ts(9, 12, 5))
ev(3, "LinkEvidence", "Certificate of incorporation and share register linked", AGT("agent.intake_profile", "wi_intake"), ts(9, 12, 8))
ev(4, "CompleteWorkItem", "Intake & profile completed", AGT("agent.intake_profile", "wi_intake"), ts(9, 12, 9))
ev(5, "ProposeWorkItem", "Identity & ownership planned (entity ∥ registry → UBO resolve → verify)", SYS, ts(9, 12, 10))
ev(6, "ProposeClaim", "Registry: Acme Trading Ltd active, SYN-0001", AGT("agent.identity_ownership", "wi_reg"), ts(9, 12, 11))
ev(7, "AcceptClaimAsFact", "Legal existence verified against authoritative registry", AGT("agent.identity_ownership", "wi_reg"), ts(9, 12, 12))
ev(8, "ProposeClaim", "Alice Example 33.0% effective interest", AGT("agent.identity_ownership", "wi_ubo_resolve"), ts(9, 12, 20))
ev(9, "ProposeClaim", "Bram Okoro holds 22% (declaration) vs 12% (register)", AGT("agent.identity_ownership", "wi_ubo_resolve"), ts(9, 12, 21))
ev(10, "RaiseContradiction", "Bram Okoro interest: declaration 22% vs register 12%", AGT("agent.identity_ownership", "wi_ubo_verify"), ts(9, 12, 26))
ev(11, "RecordAssumption", "Meridian Nominees Ltd treated as nominee pending declaration", AGT("agent.identity_ownership", "wi_ubo_verify"), ts(9, 12, 27))
ev(12, "LinkExecution", "UBO verification returned NEEDS_REVIEW (ambiguous evidence)", AGT("agent.identity_ownership", "wi_ubo_verify"), ts(9, 12, 29))
ev(13, "RequestHumanReview", "Human review requested: unresolved ownership path", SYS, ts(9, 12, 30))
ev(14, "TransitionCaseStatus", "Case status → INVESTIGATING", SYS, ts(9, 12, 30))
# after ownership review
ev(15, "ResolveContradiction", "Register value (12%) accepted; declaration superseded", HUM("r.okafor", "Case.Analyst", "Case.Reviewer"), ts(11, 31, 2))
ev(16, "RecordReview", "Ownership findings validated by analyst", HUM("r.okafor", "Case.Analyst", "Case.Reviewer"), ts(11, 34, 17))
ev(17, "ProposeWorkItem", "Screening planned (sanctions ∥ PEP ∥ watchlist → disambiguate)", SYS, ts(11, 34, 18))
ev(18, "RecordScreeningFinding", "Sanctions: no candidates within checked scope", AGT("agent.screening", "wi_scr_sanctions"), ts(11, 34, 21))
ev(19, "RecordScreeningFinding", "PEP: candidate Chen Wei (pep-88231) for 27.0% owner", AGT("agent.screening", "wi_scr_pep"), ts(11, 34, 22))
ev(20, "RecordScreeningFinding", "Watchlist: no candidates within checked scope", AGT("agent.screening", "wi_scr_watch"), ts(11, 34, 22))
ev(21, "RequestHumanReview", "Human review requested: PEP match ambiguous", SYS, ts(11, 34, 25))
ev(22, "TransitionCaseStatus", "Case status → SCREENING", SYS, ts(11, 34, 25))
# after screening review
ev(23, "RecordReview", "PEP candidate confirmed false match (DOB and nationality contradict)", HUM("l.nakamura", "Case.Analyst", "Case.Reviewer"), ts(11, 40, 2, d=8))
ev(24, "ProposeWorkItem", "Risk & EDD planned", SYS, ts(11, 40, 3, d=8))
ev(25, "ProposeClaim", "Risk tier MEDIUM (score 0.41)", AGT("agent.risk_edd", "wi_risk"), ts(11, 41, 0, d=8))
ev(26, "RecordGateResult", "EDD gate: not required at MEDIUM", AGT("agent.risk_edd", "wi_risk"), ts(11, 41, 2, d=8))
ev(27, "RecordQAResult", "Independent QA: 9 of 9 checks passed", AGT("agent.qa_assurance", "wi_qa"), ts(11, 45, 2, d=8))
ev(28, "RecordPolicyEvaluation", "Policy evaluation: REVIEW (consequential decision requires human)", actor("SYSTEM", "service:policy-evaluator"), ts(15, 10, 0, d=8))
ev(29, "SubmitDecisionRecommendation", "Recommendation: APPROVE onboarding", AGT("agent.decision_support", "wi_dec_rec"), ts(15, 12, 0, d=8))
ev(30, "RequestHumanReview", "Dual-control decision requested", SYS, ts(15, 12, 1, d=8))
ev(31, "TransitionCaseStatus", "Case status → HUMAN_REVIEW", SYS, ts(15, 12, 1, d=8))
ev(32, "FinalizeDisposition", "Onboarding APPROVED under dual control", HUM("h.adeyemi"), ts(15, 25, 0, d=8))
ev(33, "TransitionCaseStatus", "Case status → APPROVED", SYS, ts(15, 25, 0, d=8))

STATES = ["ownership_review", "screening_review", "decision_pending", "second_approval", "decided"]
SEQ = {"ownership_review": 14, "screening_review": 22, "decision_pending": 31, "second_approval": 31, "decided": 33}
CLOCK = {"ownership_review": ts(14, 5), "screening_review": ts(11, 50, d=8), "decision_pending": ts(15, 14, 30, d=8), "second_approval": ts(15, 20, d=8), "decided": ts(15, 26, d=8)}
STATUS = {"ownership_review": "INVESTIGATING", "screening_review": "SCREENING", "decision_pending": "HUMAN_REVIEW", "second_approval": "HUMAN_REVIEW", "decided": "APPROVED"}

D_OWN = decision("dec_own_okafor", "wi_own_review", "r.okafor", "APPROVE", "kyc.ownership.findings_supported",
                 "Register (authoritative) shows 12%; declaration superseded. Alice Example verified 33.0%. Meridian path explained as nominee.", ts(11, 34, 17), ["ev-f221", "ev-register-acme"])
D_SCR = decision("dec_scr_nakamura", "wi_scr_review", "l.nakamura", "APPROVE", "kyc.screening.false_match",
                 "Candidate pep-88231 DOB 1961 vs subject 1984; nationality differs; no shared identifiers.", ts(11, 40, 2, d=8), ["ev-pep-88231"])
D_DEC1 = decision("dec_final_varga", "wi_decision", "s.varga", "APPROVE", "kyc.onboarding.approve", "Controls passed; residual risk MEDIUM within appetite.", ts(15, 19, 0, d=8))
D_DEC2 = decision("dec_final_adeyemi", "wi_decision", "h.adeyemi", "APPROVE", "kyc.onboarding.approve", "Independent review concurs; no open contradictions.", ts(15, 25, 0, d=8))


def items_for(state):
    i = STATES.index(state)
    items = [done("wi_intake", "task.intake_profile", "decision_requirements_compile", 1, ts(9, 12, 9)),
             done("wi_entity", "task.identity_ownership", "entity_resolve", 5, ts(9, 12, 11)),
             done("wi_reg", "task.identity_ownership", "registry_company_verify", 5, ts(9, 12, 12)),
             done("wi_ubo_resolve", "task.identity_ownership", "ownership_ubo_resolve", 7, ts(9, 12, 21)),
             work_item("wi_ubo_verify", "task.identity_ownership", "ownership_ubo_verify", "COMPLETED", seq=9, updated=ts(9, 12, 29), reason="fincrime.needs_review",
                       result={"agentResultRef": "outcome:wi_ubo_verify", "acceptedCommandRefs": ["cmd:wi_ubo_verify"], "outputRefs": [], "failureCode": "NEEDS_REVIEW", "failureDetailRef": None})]
    own = work_item("wi_own_review", "task.identity_ownership", None, "WAITING_HUMAN" if i == 0 else "COMPLETED", seq=12, updated=ts(9, 12, 30) if i == 0 else ts(11, 34, 17),
                    human=True, reason="workflow.human_decision_required" if i == 0 else "kyc.ownership.findings_supported", deadline=ts(17, 0, d=8),
                    objective="Accept supported ownership findings or request further evidence")
    items.append(own)
    if i >= 1:
        items += [done("wi_scr_sanctions", "task.screening", "screening_sanctions_execute", 17, ts(11, 34, 21)),
                  done("wi_scr_pep", "task.screening", "screening_pep_execute", 17, ts(11, 34, 22)),
                  done("wi_scr_watch", "task.screening", "screening_watchlist_execute", 17, ts(11, 34, 22)),
                  work_item("wi_scr_disamb", "task.screening", "screening_match_disambiguate", "COMPLETED", seq=20, updated=ts(11, 34, 25), reason="fincrime.needs_review",
                            result={"agentResultRef": "outcome:wi_scr_disamb", "acceptedCommandRefs": [], "outputRefs": [], "failureCode": "NEEDS_REVIEW", "failureDetailRef": None})]
        items.append(work_item("wi_scr_review", "task.screening", None, "WAITING_HUMAN" if i == 1 else "COMPLETED", seq=21, updated=ts(11, 34, 25) if i == 1 else ts(11, 40, 2, d=8),
                               human=True, reason="workflow.human_decision_required" if i == 1 else "kyc.screening.false_match", deadline=ts(17, 0, d=8),
                               objective="Disposition the PEP candidate for Chen Wei"))
    if i >= 2:
        risk_task = TASK["task.risk_edd"]["steps"][0]["id"]
        qa_task = TASK["task.qa_assurance"]["steps"][0]["id"]
        dec_steps = TASK["task.decision_support"]["steps"]
        items += [done("wi_risk", "task.risk_edd", risk_task, 24, ts(11, 41, 2, d=8)), done("wi_qa", "task.qa_assurance", qa_task, 26, ts(11, 45, 2, d=8)),
                  done("wi_dec_rec", "task.decision_support", dec_steps[0]["id"], 28, ts(15, 12, 0, d=8))]
        status = {2: "WAITING_HUMAN", 3: "WAITING_HUMAN", 4: "COMPLETED"}[i]
        reason = {2: "workflow.human_decision_required", 3: "workflow.dual_control_pending", 4: "kyc.onboarding.approve"}[i]
        last = next(s for s in dec_steps if s["skill_id"] == "decision.human.review")["id"] if any(s["skill_id"] == "decision.human.review" for s in dec_steps) else dec_steps[-1]["id"]
        items.append(work_item("wi_decision", "task.decision_support", None, status, seq=30, updated={2: ts(15, 12, 1, d=8), 3: ts(15, 19, 0, d=8), 4: ts(15, 25, 0, d=8)}[i],
                               human=True, dual=True, reason=reason, deadline=ts(17, 0, d=9), priority=90,
                               objective=f"Authorize onboarding decision ({last})"))
    return items


def human_queue(state, items):
    q = []
    by = {w["workItemId"]: w for w in items}
    if state == "ownership_review":
        q.append(queue_item(by["wi_own_review"]))
    if state == "screening_review":
        q.append(queue_item(by["wi_scr_review"], assigned=["l.nakamura"]))
    if state == "decision_pending":
        q.append(queue_item(by["wi_decision"]))
    if state == "second_approval":
        q.append(queue_item(by["wi_decision"], decisions=[D_DEC1], assigned=["s.varga"]))
    return q


SNAPDATA = {
    "subject": {"subjectId": "acme", "name": "Acme Trading Ltd", "kind": "company", "identifiers": ["SYN-0001"]},
    "caseType": "KYB", "jurisdiction": "US", "synthetic": True}


def build_store():
    store = {}
    for s in STATES:
        items = items_for(s)
        seq = SEQ[s]
        decisions = {"ownership_review": [], "screening_review": [D_OWN], "decision_pending": [D_OWN, D_SCR],
                     "second_approval": [D_OWN, D_SCR, D_DEC1], "decided": [D_OWN, D_SCR, D_DEC1, D_DEC2]}[s]
        rstat = {"ownership_review": "manual_review", "screening_review": "manual_review", "decision_pending": "manual_review", "second_approval": "manual_review", "decided": "completed"}[s]
        node = {"ownership_review": "identity_ownership.review", "screening_review": "screening.review", "decision_pending": "decision.review", "second_approval": "decision.review", "decided": "decision.finalize"}[s]
        store[s] = {
            "clock": CLOCK[s], "caseStatus": STATUS[s],
            "caseSummary": {"tenantId": T, "caseId": CASE, "caseType": "KYB", "jurisdiction": "US", "status": STATUS[s], "caseSequence": seq,
                            "externalRef": "ONB-88412", "harnessPlanDigest": PLAN, "classification": "confidential", "createdAt": ts(9, 12, 4), "updatedAt": CLOCK[s]},
            "snapshot": snapshot(seq, CLOCK[s], {**SNAPDATA, "status": STATUS[s]}),
            "workItems": items, "humanQueue": human_queue(s, items), "decisions": decisions,
            "run": run_record(rstat, CLOCK[s], node, completed=CLOCK[s] if rstat == "completed" else None),
            "caseEvents": [e for e in EV if e["sequence"] <= seq]}
    return store


def runtime_events(state):
    seq_codes = [("node.started", "intake_profile", "observed"), ("node.completed", "intake_profile", "passed"), ("node.started", "identity_ownership", "observed"),
                 ("capability.invoked", "identity_ownership", "observed"), ("node.completed", "identity_ownership", "passed"), ("gate.evaluated", "identity_ownership.review", "observed"),
                 ("human.task.created", "identity_ownership.review", "observed")]
    if STATES.index(state) >= 1:
        seq_codes += [("human.resumed", "identity_ownership.review", "passed"), ("node.started", "screening", "observed"), ("node.completed", "screening", "passed"),
                      ("human.task.created", "screening.review", "observed")]
    if STATES.index(state) >= 2:
        seq_codes += [("human.resumed", "screening.review", "passed"), ("node.completed", "risk_edd", "passed"), ("node.completed", "qa_assurance", "passed"),
                      ("policy.evaluated", "decision.gate", "observed"), ("human.task.created", "decision.review", "observed")]
    if state == "decided":
        seq_codes += [("human.resumed", "decision.review", "passed"), ("run.completed", None, "passed")]
    base = 9 * 3600 + 12 * 60 + 4
    out = []
    for i, (code, node, status) in enumerate(seq_codes, 1):
        t = base + i * 3
        out.append({"runId": RUN, "sequence": i, "code": code, "nodeId": node, "status": status, "values": {}, "occurredAt": f"2026-11-07T{t // 3600:02d}:{t % 3600 // 60:02d}:{t % 60:02d}Z"})
    return out


RELEASES = [{"releaseId": "rel_fincrime_1_0_0", "manifestDigest": H("release-manifest:fincrime:1.0.0"), "status": "active", "revision": 3, "activatedAt": ts(8, 0, d=6),
             "deprecatedAt": None, "revokedAt": None, "reasonCode": "release.operator_decision", "updatedAt": ts(8, 0, d=6)},
            {"releaseId": "rel_fincrime_1_1_0", "manifestDigest": H("release-manifest:fincrime:1.1.0"), "status": "candidate", "revision": 1, "activatedAt": None,
             "deprecatedAt": None, "revokedAt": None, "reasonCode": None, "updatedAt": ts(16, 0)}]

# ---------------------------------------------------------------- FinCrime view models
LABELS = {
    "wi_own_review": [("APPROVE", "Accept supported findings", "Ownership findings become case facts; screening starts."),
                      ("REJECT", "Reject findings", "Findings are rejected; the identity & ownership task is reworked."),
                      ("RETURN", "Request further evidence", "Work returns to the relationship manager for documents.")],
    "wi_scr_review": [("APPROVE", "Confirm false match", "The candidate is recorded as a false match; risk assessment starts."),
                      ("REJECT", "Treat as potential true match", "The match stands; the case escalates to EDD."),
                      ("RETURN", "Return for more evidence", "Screening re-runs after more identifiers are collected.")],
    "wi_decision": [("APPROVE", "Approve onboarding", "With two distinct approvals the case is APPROVED and the run completes."),
                    ("REJECT", "Decline onboarding", "With two distinct rejections the case is DECLINED."),
                    ("RETURN", "Return to analyst", "The recommendation is withdrawn for rework.")]}
REASONS = {"wi_own_review": [("kyc.ownership.findings_supported", "Findings supported by authoritative evidence"), ("kyc.ownership.evidence_insufficient", "Evidence insufficient")],
           "wi_scr_review": [("kyc.screening.false_match", "False match"), ("kyc.screening.potential_true_match", "Potential true match")],
           "wi_decision": [("kyc.onboarding.approve", "Within risk appetite"), ("kyc.onboarding.decline", "Outside risk appetite"), ("kyc.onboarding.rework", "Needs rework")]}


def options(wid):
    return [{"decision": d, "label": l, "consequence": c, "requiresRationale": True, "reasonCodes": [{"code": k, "label": v} for k, v in REASONS[wid]],
             "form": {"rationale": {"label": "Rationale", "help": "Recorded verbatim in the case ledger.", "control": "textarea", "order": 1},
                      "evidenceRefs": {"label": "Supporting evidence", "help": "Cite the evidence you relied on.", "control": "evidence", "order": 2}}} for d, l, c in LABELS[wid]]


def stages(state):
    i = STATES.index(state)
    st = {"task.intake_profile": "done", "task.identity_ownership": "needs_review" if i == 0 else "done",
          "task.screening": "pending" if i == 0 else ("needs_review" if i == 1 else "done"),
          "task.risk_edd": "done" if i >= 2 else "pending", "task.qa_assurance": "done" if i >= 2 else "pending",
          "task.decision_support": "done" if i == 4 else ("current" if i >= 2 else "pending")}
    return [{"taskId": t, "label": TASK_LABEL[t], "agentId": TASK[t]["agent_profile"], "status": st[t]} for t in TASK_ORDER]


def wi_card(w):
    c = w["constraints"]
    return {"workItemId": w["workItemId"], "objective": w["objective"], "status": w["status"], "agentId": None if w["workType"] == "human_review" else c["agentProfile"],
            "taskId": c["taskId"], "stepId": c["stepId"], "skillStatus": (w["result"] or {}).get("failureCode") or ("COMPLETED" if w["status"] == "COMPLETED" and w["workType"] != "human_review" else None),
            "updatedAt": w["updatedAt"]}


def case_room(state, st):
    snap = st["snapshot"]
    counts = {"ownership_review": (6, 2, 1, 1, 9, 0), "screening_review": (6, 3, 0, 1, 11, 3), "decision_pending": (7, 5, 0, 1, 13, 3),
              "second_approval": (7, 5, 0, 1, 13, 3), "decided": (7, 6, 0, 1, 13, 3)}[state]
    return {"caseId": CASE, "caseType": "KYB", "jurisdiction": "US", "status": st["caseStatus"], "caseSequence": snap["caseSequence"], "snapshotDigest": snap["snapshotDigest"],
            "planDigest": PLAN, "policyAuthority": snap["policyAuthority"], "subject": SNAPDATA["subject"], "stages": stages(state),
            "workItems": [wi_card(w) for w in st["workItems"]], "humanWork": st["humanQueue"],
            "counts": dict(zip(["claims", "facts", "openContradictions", "assumptions", "evidence", "screeningFindings"], counts)),
            "lenses": [{"lens": "ownership", "label": "Ownership & control", "badge": "1 open" if state == "ownership_review" else None, "available": True},
                       {"lens": "documents", "label": "Documents", "badge": None, "available": True},
                       {"lens": "screening", "label": "Screening", "badge": "1 to review" if state == "screening_review" else None, "available": STATES.index(state) >= 1},
                       {"lens": "risk", "label": "Risk", "badge": None, "available": STATES.index(state) >= 2},
                       {"lens": "decision", "label": "Decision", "badge": "awaiting" if state in ("decision_pending", "second_approval") else None, "available": STATES.index(state) >= 2}],
            "recentEvents": list(reversed(st["caseEvents"]))[:6], "synthetic": True}


def attention(state, st):
    groups = {"needs_action": [], "prepared_by_agents": [], "waiting_on_others": [], "approaching_deadline": [], "escalated_or_blocked": []}
    for q in st["humanQueue"]:
        w = q["workItem"]
        item = {"workItemId": w["workItemId"], "caseId": CASE, "caseStatus": st["caseStatus"], "subject": {"name": "Acme Trading Ltd", "kind": "company"},
                "objective": w["objective"], "agentId": w["constraints"]["agentProfile"], "taskId": w["constraints"]["taskId"], "stepId": w["constraints"]["stepId"],
                "gate": w["constraints"].get("gate"), "workStatus": w["status"],
                "claim": {"assignedTo": q["assignedTo"], "mine": False, "claimable": True},
                "requiredApprovals": q["requiredApprovals"], "decisionsSoFar": len(q["decisions"]), "overdue": q["overdue"], "escalated": q["escalated"],
                "deadlineAt": w["deadlineAt"], "priority": w["priority"], "group": "needs_action",
                "route": {"wi_own_review": f"/cases/{CASE}/ownership", "wi_scr_review": f"/cases/{CASE}/screening", "wi_decision": f"/cases/{CASE}/decision"}[w["workItemId"]]}
        if q["decisions"]:
            item["group"] = "waiting_on_others"
        groups[item["group"]].append(item)
    labels = {"needs_action": "Needs your decision", "prepared_by_agents": "Prepared by agents", "waiting_on_others": "Waiting on a second approver",
              "approaching_deadline": "Approaching deadline", "escalated_or_blocked": "Escalated or blocked"}
    n = sum(len(v) for v in groups.values())
    return {"generatedAt": st["clock"],
            "kpis": [{"key": "open", "label": "Open human work", "value": n, "emphasis": "attention" if n else "none"},
                     {"key": "overdue", "label": "Overdue", "value": 0, "emphasis": "none"},
                     {"key": "dual", "label": "Awaiting second approver", "value": 1 if state == "second_approval" else 0, "emphasis": "attention" if state == "second_approval" else "none"}],
            "groups": [{"group": g, "label": labels[g], "items": v} for g, v in groups.items() if v]}


def claims(state, st):
    rows = [("c-reg", "fact", "acme", "legal_status", "ACTIVE (SYN-0001)", "accepted", "fact", 7, "agent.identity_ownership"),
            ("c-alice", "claim" if state == "ownership_review" else "fact", "alice", "effective_interest", "33.0%", "proposed" if state == "ownership_review" else "accepted",
             "claim" if state == "ownership_review" else "fact", 8, "agent.identity_ownership"),
            ("c-bram", "contradiction" if state == "ownership_review" else "fact", "bram", "interest", "22% (declaration) vs 12% (register)" if state == "ownership_review" else "12%",
             "open" if state == "ownership_review" else "resolved", "claim" if state == "ownership_review" else "fact", 10 if state == "ownership_review" else 15, "agent.identity_ownership"),
            ("a-meridian", "assumption", "meridian", "role", "nominee pending declaration", "recorded", "assumption", 11, "agent.identity_ownership")]
    if STATES.index(state) >= 1:
        rows += [("s-sanc", "screening_finding", "acme", "sanctions", "no candidates within checked scope", "recorded", "finding", 18, "agent.screening"),
                 ("s-pep", "screening_finding", "chen", "pep", "candidate pep-88231" if state == "screening_review" else "false match (human)", "open" if state == "screening_review" else "decided", "finding", 19, "agent.screening"),
                 ("s-watch", "screening_finding", "acme", "watchlist", "no candidates within checked scope", "recorded", "finding", 20, "agent.screening")]
    if STATES.index(state) >= 2:
        rows += [("c-risk", "claim", "acme", "risk_tier", "MEDIUM (0.41)", "proposed", "recommendation", 25, "agent.risk_edd")]
    items = [{"id": i, "kind": k, "subjectRef": s, "field": f, "value": v, "status": stt, "epistemic": e, "evidenceIds": ["ev-register-acme"] if s in ("acme", "bram") else [],
              "sourceCommandId": f"cmd_{CASE}_{q}", "caseSequence": q, "recordedBy": AGT(a, "wi"), "acceptedBy": HUM("r.okafor", "Case.Analyst", "Case.Reviewer") if (stt in ("accepted", "resolved") and q >= 15) else None}
             for i, k, s, f, v, stt, e, q, a in rows]
    return {"caseSequence": st["snapshot"]["caseSequence"], "items": items}


CONTRA = {
    "contradictionId": "cf-12", "status": "OPEN", "subjectLabel": "Bram Okoro → Acme Trading Ltd", "field": "interest",
    "assertions": [
        {"assertionId": "as-reg", "value": "12%", "claim": "Bram Okoro holds 12% of ordinary shares", "source": {"kind": "registry", "id": "src-registry", "authority": "authoritative"},
         "observedAt": "2026-11-07T09:12:11Z", "effectiveAt": "2026-10-31", "span": None, "evidenceId": "ev-register-acme"},
        {"assertionId": "as-decl", "value": "22%", "claim": "Bram Okoro holds 22% (customer declaration)", "source": {"kind": "customer_declaration", "id": "src-decl", "authority": "customer"},
         "observedAt": "2026-11-06T16:40:00Z", "effectiveAt": "2026-09-30", "span": {"documentVersion": "decl-v2", "page": 2, "quote": "B. Okoro — 22% ordinary"}, "evidenceId": "ev-decl-acme"}],
    "whyItMatters": "At 22% Bram Okoro crosses the 20% UBO threshold and must be verified; at 12% he does not.",
    "reconciliation": [{"field": "interest", "values": [{"sourceId": "src-registry", "value": "12%"}, {"sourceId": "src-decl", "value": "22%"}], "status": "disagree"},
                       {"field": "share_class", "values": [{"sourceId": "src-registry", "value": "ordinary"}, {"sourceId": "src-decl", "value": "ordinary"}], "status": "agree"},
                       {"field": "as_of", "values": [{"sourceId": "src-registry", "value": "2026-10-31"}, {"sourceId": "src-decl", "value": "2026-09-30"}], "status": "different_as_of"}],
    "producedBy": {"agentId": "agent.identity_ownership", "skillId": "ownership.ubo.verify", "workItemId": "wi_ubo_verify"},
    "commands": [
        {"commandType": "ResolveContradiction", "label": "Accept register value (12%)", "enabled": True, "disabledReason": None,
         "payloadTemplate": {"contradictionId": "cf-12", "resolution": "ACCEPT_ASSERTION", "assertionId": "as-reg", "rationale": ""}, "needsPreview": True},
        {"commandType": "ResolveContradiction", "label": "Accept declaration (22%)", "enabled": True, "disabledReason": None,
         "payloadTemplate": {"contradictionId": "cf-12", "resolution": "ACCEPT_ASSERTION", "assertionId": "as-decl", "rationale": ""}, "needsPreview": True},
        {"commandType": "LinkEvidence", "label": "Attach certified share register", "enabled": True, "disabledReason": None,
         "payloadTemplate": {"evidenceId": "", "supports": ["cf-12"]}, "needsPreview": True}]}


def ownership(state):
    resolved = state != "ownership_review"
    nodes = [("acme", "acme", "company", "Acme Trading Ltd", "SYN-0001", True, "fact", None, None, (380, 40)),
             ("alice", "alice", "person", "Alice Example", "33.0% effective", False, "fact" if resolved else "claim", "0.33", "verified", (120, 200)),
             ("holdco", "holdco", "company", "Northwind Holdings Ltd", "45% direct", False, "fact", None, None, (380, 200)),
             ("bram", "bram", "person", "Bram Okoro", "12% register" if resolved else "12% / 22%", False, "fact" if resolved else "claim", "0.12", "not_ubo" if resolved else "unknown", (640, 200)),
             ("meridian", "meridian", "company", "Meridian Nominees Ltd", "nominee", False, "assumption", None, None, (380, 340)),
             ("chen", "chen", "person", "Chen Wei", "27.0% effective", False, "fact", "0.27", "verified" if resolved else "candidate", (380, 470))]
    edges = [("e1", "alice", "acme", "equity", "0.33", None, "verified", None), ("e2", "holdco", "acme", "equity", "0.45", None, "verified", None),
             ("e3", "bram", "acme", "equity", "0.12", None if resolved else "0.22", "verified" if resolved else "conflict", None if resolved else "cf-12"),
             ("e4", "meridian", "holdco", "equity", "0.60", None, "candidate", None), ("e5", "chen", "meridian", "equity", "1.00", None, "verified" if resolved else "unresolved", None)]
    return {"complete": resolved, "threshold": "0.20", "mode": "effective", "asOf": "2026-11-07T09:12:29Z",
            "nodes": [{"id": i, "entityId": e, "kind": k, "label": l, "sublabel": s, "isRoot": r, "epistemic": ep, "effectiveInterest": ei, "uboStatus": u, "layout": {"x": x, "y": y}}
                      for i, e, k, l, s, r, ep, ei, u, (x, y) in nodes],
            "edges": [{"id": i, "source": a, "target": b, "kind": k, "interest": v, "interestAlternative": alt, "status": stt, "evidenceIds": ["ev-register-acme"], "contradictionId": cid,
                       "label": f"{float(v) * 100:.0f}%" + (f" / {float(alt) * 100:.0f}%" if alt else "")} for i, a, b, k, v, alt, stt, cid in edges],
            "gaps": [] if resolved else [{"node": "chen", "reason": "Indirect path via nominee lacks corroborating declaration", "path": ["chen", "meridian", "holdco", "acme"], "interest": "0.27"}],
            "producedBy": {"agentId": "agent.identity_ownership", "skillId": "ownership.ubo.verify", "workItemId": "wi_ubo_verify"}}


def screening(state, st):
    decided = STATES.index(state) >= 2
    q = next((x for x in st["humanQueue"] if x["workItem"]["workItemId"] == "wi_scr_review"), None)
    view = {"findings": [{"findingId": "s-sanc", "listType": "sanctions", "subjectName": "Acme Trading Ltd", "entryName": "—", "listVersion": "2026.11.07", "disposition": None, "status": "decided", "workItemId": None},
                         {"findingId": "s-pep", "listType": "pep", "subjectName": "Chen Wei", "entryName": "Wei Chen", "listVersion": "2026.10", "disposition": "false_match" if decided else None,
                          "status": "decided" if decided else "open", "workItemId": "wi_scr_review"},
                         {"findingId": "s-watch", "listType": "watchlist", "subjectName": "Acme Trading Ltd", "entryName": "—", "listVersion": "2026.11.01", "disposition": None, "status": "decided", "workItemId": None}],
            "coverage": [{"list": "Sanctions (synthetic consolidated)", "version": "2026.11.07", "complete": True, "stale": False, "limitations": []},
                         {"list": "PEP (synthetic)", "version": "2026.10", "complete": True, "stale": False, "limitations": ["Family members not in scope"]},
                         {"list": "Watchlist (synthetic)", "version": "2026.11.01", "complete": False, "stale": False, "limitations": ["Regional lists unavailable in synthetic environment"]}],
            "universalClearance": False}
    comp = {"findingId": "s-pep", "listType": "pep", "entryId": "pep-88231", "listVersion": "2026.10", "subject": {"name": "Chen Wei", "exposure": "27.0% effective owner via Meridian Nominees Ltd"},
            "rows": [{"field": "Name", "subjectValue": "Chen Wei", "entryValue": "Wei Chen", "result": "partial"}, {"field": "Date of birth", "subjectValue": "1984-03-02", "entryValue": "1961-07-19", "result": "contradict"},
                     {"field": "Nationality", "subjectValue": "Singapore", "entryValue": "China", "result": "contradict"}, {"field": "Identifiers", "subjectValue": "SYN-P-0442", "entryValue": None, "result": "missing"}],
            "recommendation": {"kind": "false_match", "skillId": "screening.match.disambiguate", "rationale": "Name similarity only; DOB and nationality contradict."},
            "coverage": view["coverage"][1:2], "humanWork": q, "options": options("wi_scr_review")}
    return view, comp


def desk(state, st):
    q = next((x for x in st["humanQueue"] if x["workItem"]["workItemId"] == "wi_decision"), None)
    decided = [d for d in st["decisions"] if d["workItemId"] == "wi_decision"]
    snap = st["snapshot"]
    return {"caseId": CASE, "status": st["caseStatus"], "basis": {"caseSequence": snap["caseSequence"], "snapshotDigest": snap["snapshotDigest"]},
            "recommendation": {"disposition": "APPROVE", "rationale": "Ownership established (2 UBOs verified), screening clear within scope, risk MEDIUM within appetite.",
                               "agentId": "agent.decision_support", "commandId": f"cmd_{CASE}_29"},
            "gates": [{"gateId": "edd.required", "result": "ALLOW", "at": ts(11, 41, 2, d=8)}, {"gateId": "decision.consequential", "result": "REVIEW", "at": ts(15, 10, 0, d=8)}],
            "policyEvaluation": {"decision": "REVIEW", "policyId": "kyc", "policyVersion": "2026.11", "bundleDigest": POLICY_BUNDLE,
                                 "controls": [{"requirementId": r, "label": l, "note": None, "outcome": o, "evidenceIds": e} for r, l, o, e in [
                                     ("req-legal-existence", "Legal existence verified (registry)", "PASS", ["ev-register-acme"]),
                                     ("req-ubo-identified", "All UBOs ≥ 20% identified & verified", "PASS", ["ev-f221", "ev-passport-alice"]),
                                     ("req-screening", "Sanctions/PEP/watchlist screening dispositioned", "PASS", ["ev-pep-88231"]),
                                     ("req-risk", "Risk assessed with reproducible model", "PASS", []),
                                     ("req-watchlist-coverage", "Watchlist coverage complete", "UNKNOWN", [])]]},
            "qa": [{"check": "Evidence cited for every fact", "outcome": "PASS", "by": AGT("agent.qa_assurance", "wi_qa")},
                   {"check": "No unresolved contradictions", "outcome": "PASS", "by": AGT("agent.qa_assurance", "wi_qa")}],
            "risk": {"tier": "MEDIUM", "score": "0.41", "modelVersion": "risk-synthetic-2.1", "contributions": [{"factor": "Ownership complexity", "contribution": "0.14", "share": "0.35"},
                                                                                                              {"factor": "Geography", "contribution": "0.27", "share": "0.65"}]},
            "humanWork": q,
            "requirements": {"requiredApprovals": 2, "decided": decided, "youMay": {"claim": q is not None, "decide": q is not None, "resolve": False},
                             "reasonIfNot": None if q else "No open decision work item.", "options": options("wi_decision")},
            "limitations": [{"kind": "synthetic", "text": "All data synthetic; providers recorded."},
                            {"kind": "coverage", "text": "Watchlist coverage incomplete (regional lists unavailable)."},
                            {"kind": "negative_search", "text": "No candidates means none returned within the checked scope — not a legal clearance."}]}


def recorder(state, st):
    entries = []
    for e in st["caseEvents"]:
        entries.append({"ref": f"case_event:{CASE}:{e['sequence']}", "source": "case_event", "sequence": e["sequence"], "code": e["commandType"], "summary": e["summary"],
                        "actor": {"type": e["actor"]["type"], "principalId": e["actor"]["principalId"], "label": NAMES.get(e["actor"]["principalId"], AGENT_LABEL.get(e["actor"]["principalId"], e["actor"]["principalId"]))},
                        "status": "recorded", "occurredAt": e["occurredAt"], "runId": RUN, "workItemId": None, "traceId": TRACE, "interrupt": e["commandType"] == "RequestHumanReview"})
    for d in st["decisions"]:
        entries.append({"ref": f"human_decision:{d['decisionId']}:0", "source": "human_decision", "sequence": 0, "code": "HumanDecision." + d["decision"], "summary": d["rationale"],
                        "actor": {"type": "HUMAN", "principalId": d["principalId"], "label": NAMES[d["principalId"]]}, "status": "recorded", "occurredAt": d["decidedAt"],
                        "runId": RUN, "workItemId": d["workItemId"], "traceId": TRACE, "interrupt": False})
    entries.sort(key=lambda x: (x["occurredAt"], x["source"] != "human_decision", x["sequence"]))  # a decision precedes the events it causes
    return {"caseId": CASE, "historical": state == "decided", "finalState": "APPROVED" if state == "decided" else None,
            "counts": {"events": len(entries), "interrupts": sum(1 for e in entries if e["interrupt"])}, "entries": entries, "traces": [{"traceId": TRACE, "runId": RUN}]}


def causality(state, st):
    nodes = [("n1", "case_event:KYB-1042:9", "business", "Claim: Bram 22% vs 12%", "agent.identity_ownership", "event", ts(9, 12, 21)),
             ("n2", "case_event:KYB-1042:10", "business", "Contradiction raised", "ownership.ubo.verify", "event", ts(9, 12, 26)),
             ("n3", None, "agent_workflow", "UBO verify → NEEDS_REVIEW", "wi_ubo_verify", "event", ts(9, 12, 29)),
             ("n4", "case_event:KYB-1042:13", "human", "Human review requested", "wi_own_review", "interrupt", ts(9, 12, 30)),
             ("n5", None, "capabilities", "registry lookup (recorded)", "capability-gateway", "event", ts(9, 12, 11)),
             ("n6", None, "technical", "trace " + TRACE[:8], "otel", "event", ts(9, 12, 4))]
    if STATES.index(state) >= 1:
        nodes.append(("n7", "human_decision:dec_own_okafor:0", "human", "R. Okafor: APPROVE", "wi_own_review", "human", ts(11, 34, 17)))
    edges = [("n5", "n1"), ("n1", "n2"), ("n2", "n3"), ("n3", "n4")] + ([("n4", "n7")] if STATES.index(state) >= 1 else [])
    focus = {"n2", "n3", "n4"}
    return {"focus": "case_event:KYB-1042:13", "lanes": ["business", "agent_workflow", "capabilities", "human", "technical"],
            "nodes": [{"id": i, "ref": r, "lane": l, "label": lb, "sublabel": sb, "kind": k, "at": at, "inFocus": i in focus} for i, r, l, lb, sb, k, at in nodes],
            "edges": [{"from": a, "to": b, "inFocus": a in focus and b in focus} for a, b in edges]}


def lineage(st):
    N = lambda i, col, epi, t, sub, cmd=None: {"id": i, "column": col, "epistemic": epi, "title": t, "subtitle": sub, "sourceCommandId": cmd, "corrected": False}
    nodes = [N("d", "decision", "decision", "Onboarding APPROVED", "dual control: S. Varga + H. Adeyemi", f"cmd_{CASE}_32"),
             N("p", "policy_evaluation", "finding", "Policy kyc@2026.11 → REVIEW", "consequential decision requires human", f"cmd_{CASE}_28"),
             N("f1", "findings", "finding", "UBOs identified: Alice 33.0%, Chen 27.0%", "ownership.ubo.verify", f"cmd_{CASE}_16"),
             N("f2", "findings", "finding", "PEP candidate is a false match", "human review", f"cmd_{CASE}_23"),
             N("f3", "findings", "recommendation", "Risk MEDIUM (0.41)", "risk-synthetic-2.1", f"cmd_{CASE}_25"),
             N("c1", "facts_claims", "fact", "Acme Trading Ltd active", "registry", f"cmd_{CASE}_7"),
             N("c2", "facts_claims", "fact", "Bram Okoro 12%", "contradiction resolved", f"cmd_{CASE}_15"),
             N("e1", "evidence", "observation", "Share register 2026-10-31", "ev-register-acme"), N("e2", "evidence", "observation", "Passport — Alice Example", "ev-passport-alice"),
             N("e3", "evidence", "observation", "PEP entry pep-88231", "ev-pep-88231"),
             N("s1", "sources", "observation", "Synthetic registry", "authoritative"), N("s2", "sources", "observation", "Synthetic PEP list 2026.10", "provider")]
    edges = [("p", "d"), ("f1", "p"), ("f2", "p"), ("f3", "p"), ("c1", "f1"), ("c2", "f1"), ("e1", "c1"), ("e1", "c2"), ("e2", "f1"), ("e3", "f2"), ("s1", "e1"), ("s2", "e3")]
    return {"caseId": CASE, "decisionRef": f"case_event:{CASE}:32", "asOf": ts(15, 25, 0, d=8), "columns": ["decision", "policy_evaluation", "findings", "facts_claims", "evidence", "sources"],
            "nodes": nodes, "edges": [{"from": a, "to": b} for a, b in edges], "gaps": ["Watchlist coverage incomplete — recorded as limitation, not a gap in the chain"],
            "authority": {"decidedBy": ["s.varga", "h.adeyemi"], "preparedBy": ["agent.decision_support", "agent.risk_edd", "agent.qa_assurance"], "distinctActors": 5}}


def mission(state, st):
    open_ = len(st["humanQueue"])
    return {"generatedAt": st["clock"],
            "kpis": [{"key": "cases_open", "label": "Cases in flight", "value": 12, "unit": None, "definition": "Cases not in APPROVED, DECLINED or CLOSED"},
                     {"key": "auto_share", "label": "Steps completed without human", "value": 0.83, "unit": "ratio", "definition": "COMPLETED skill work items / all skill work items, 24h"},
                     {"key": "decision_latency_p50", "label": "Human decision latency p50", "value": 42, "unit": "min", "definition": "WAITING_HUMAN → decision, 24h"}],
            "humanWork": {"open": open_ + 6, "overdue": 1, "escalated": 0, "awaitingSecondApprover": 1 if state == "second_approval" else 0},
            "runs": {"queued": 1, "running": 3, "retrying": 0, "completed": 41, "manual_review": 5, "denied": 0, "failed": 1, "cancelled": 0},
            "agents": [{"agentId": a["id"], "running": n, "waitingHuman": w, "failed": f} for a, (n, w, f) in zip(AGENTS, [(1, 0, 0), (1, 2, 0), (0, 2, 1), (1, 1, 0), (0, 0, 0), (0, 1, 0)])],
            "exceptions": [{"kind": "run_failed", "label": "Run failed: provider timeout (screening)", "count": 1, "route": "/platform/runs?status=failed"},
                           {"kind": "stale_basis", "label": "Decisions refused: case changed under review", "count": 0, "route": "/platform/human-work"}]}


def agent_cards(st):
    out = []
    for a in AGENTS:
        cells = [c for c in MATRIX_VIEW["cells"] if c["agentId"] == a["id"] and (c["subscribed"] or c["requiredFields"])]
        status = "gaps" if any(c["status"] == "gaps" for c in cells) else "ready"
        waiting = sum(1 for q in st["humanQueue"] if q["workItem"]["constraints"]["agentProfile"] == a["id"])
        out.append({"agent": a, "readiness": status, "contextReadiness": [{"productId": c["productId"], "status": c["status"]} for c in cells],
                    "activeWork": {"running": 0, "waitingHuman": waiting, "failed": 0},
                    "publication": {"catalogDigest": CAT_DIGEST, "planDigest": PLAN, "release": RELEASES[0]}})
    return out


# ---------------------------------------------------------------- platform (control-ui views)
def synth(schema, defs, path="x"):
    """Deterministic minimal instance of a JSON Schema (required properties only)."""
    if "$ref" in schema:
        return synth(defs[schema["$ref"].split("/")[-1]], defs, path)
    if "const" in schema:
        return schema["const"]
    if "enum" in schema:
        return schema["enum"][0]
    for k in ("anyOf", "oneOf"):
        if k in schema:
            opts = [o for o in schema[k] if o.get("type") != "null"]
            return synth(opts[0] if opts else schema[k][0], defs, path)
    t = schema.get("type")
    if isinstance(t, list):
        t = next((x for x in t if x != "null"), "null")
    if t == "object" or "properties" in schema:
        return {k: synth(v, defs, f"{path}.{k}") for k, v in schema.get("properties", {}).items() if k in schema.get("required", [])}
    if t == "array":
        return []
    if t == "string":
        if schema.get("format") == "date-time" or path.endswith(("At", "Through")):
            return "2026-11-07T14:00:00Z"
        return path.split(".")[-1]
    if t in ("number", "integer"):
        return 0
    if t == "boolean":
        return False
    return None


def deep(base, over):
    if isinstance(base, dict) and isinstance(over, dict):
        out = dict(base)
        for k, v in over.items():
            out[k] = deep(base.get(k), v) if k in base else v
        return out
    return over


def view(_schema, **over):
    return deep(synth(VW[_schema], VW, _schema), over)


def platform():
    draft = lambda did, name, status, rev, author: view("AuthoringDraftView", draftId=did, name=name, domain="fincrime", version="1.1.0", status=status, revision=rev,
                                                        packageSource="name: fincrime-kyb\nversion: 1.1.0\n", workflowSource="nodes: []\n",
                                                        parsedPackage={"name": "fincrime-kyb"}, parsedWorkflow={}, compiledPlan=None, diagnostics=[], evaluationReport=None,
                                                        approvedBy=None, publishedPlanDigest=None, createdAt=ts(10, 0), updatedAt=ts(16, 0), events=[
                                                            {"eventId": f"{did}-e1", "eventType": "draft.created", "actor": author, "revision": 1, "details": {}, "occurredAt": ts(10, 0)}])
    drafts = [draft("draft_6f1c2c3e-0000-4000-8000-000000000001", "FinCrime KYB 1.1 — screening threshold", "COMPILED", 7, "j.moreau"),
              draft("draft_6f1c2c3e-0000-4000-8000-000000000002", "FinCrime KYB 1.1 — context selectors", "DRAFT", 3, "m.lindqvist")]
    return {
        "overview": view("OverviewView", runtimeMode="Recorded", fixture=True, globalReadiness="Ready", generatedAt=ts(14, 5), telemetryFreshThrough=ts(14, 5),
                         admittedHarnessesCount=2, activeRunsCount=4, queuedCount=1, runningCount=3, needsAttentionCount=5, failedCount=1),
        "system": view("SystemView", globalReadiness="Ready", runtimeMode="Recorded", fixture=True, generatedAt=ts(14, 5), telemetryFreshThrough=ts(14, 5)),
        "drafts": drafts,
        "harnesses": [view("HarnessSummary", planDigest=PLAN, name="fincrime-kyb", packageVersion="1.0.0", domain="fincrime", objective="Corporate KYB onboarding",
                           compilerVersion="harnessc 0.9.0", admittedAt=ts(8, 0, d=6), nodeCount=29, edgeCount=34, capabilityCount=9, runs=48, completedRuns=41)],
        "runs": [view("RunSummary", runId=RUN, planDigest=PLAN, harnessName="fincrime-kyb", packageVersion="1.0.0", domain="fincrime", status="manual_review",
                      currentNodeId="identity_ownership.review", attempt=1, fencingEpoch=1, startedAt=ts(9, 12, 4), updatedAt=ts(9, 12, 30), traceId=TRACE, rootSpanId=TRACE[:16], needsAttention=True)],
        "cases": [view("CaseSummaryView", tenantId=T, caseId=CASE, caseType="KYB", jurisdiction="US", status="INVESTIGATING", caseSequence=14, externalRef="ONB-88412",
                       harnessPlanDigest=PLAN, classification="confidential", createdAt=ts(9, 12, 4), updatedAt=ts(9, 12, 30))],
        "gatewayStatus": view("GatewayStatusView", readiness="Ready", runtimeMode="Recorded", generatedAt=ts(14, 5), telemetryFreshThrough=ts(14, 5)),
        "modelTiers": [view("ModelTierProfileView", tierId="analysis", version="v1", purpose="openrouter capability tier", profileDigest=H("tier:analysis"),
                            resolvedOpenRouterModel="synthetic/recorded", maxInputTokens=128000, maxOutputTokens=4096, timeoutMs=30000, concurrencyLimit=4, enabled=True)],
        "providers": [view("AdminProviderItemView", digest=H("provider:openrouter"), createdAt=ts(8, 0, d=6), updatedAt=ts(8, 0, d=6), updatedBy="n.osei", credentialPresent=True)],
        "modelProfiles": [view("AdminModelProfileView", createdAt=ts(8, 0, d=6), createdBy="n.osei", digest=H("profile:analysis:1"), note="initial", revision=1, revisions=[], status="active")],
        "settings": [view("AdminSettingSectionView", updatedAt=ts(8, 0, d=6), updatedBy="n.osei", appliesAt="restart", summary="Runtime limits")],
        "changeLog": [view("AdminChangeView", changeId="chg_0001", occurredAt=ts(8, 0, d=6), actorId="n.osei", actorRoles=["Platform.Admin"], resourceKind="model-profile",
                           resourceId="analysis", action="activate", beforeDigest=None, afterDigest=H("profile:analysis:1"), before=None, after=None, reason="initial activation")],
        "releases": RELEASES,
    }


# ---------------------------------------------------------------- write
def main():
    store = build_store()
    for s in STATES:
        store[s]["runEvents"] = runtime_events(s)
        store[s]["releases"] = RELEASES
    personas = {"_doc": "Mock personas mapped to EHF roles. `actions` are derived from packages/identity/src/authorization.ts (pinned); the mock authorizes with roleActions, never with persona names.",
                "default": "cdd_analyst", "roleActions": HUMAN_ROLES,
                "personas": [{"persona": {"personaId": p[0], "displayName": p[2], "roleLabel": p[3], "roles": p[4], "landingRoute": p[5], "notes": p[6]}, "session": session(p)} for p in PERSONAS]}
    J("personas.json", personas)

    J("fincrime.catalog.json", {
        "_doc": "FinCrime domain read models derived from kyc catalog/ehf-catalog.json (the artifact EHF admits via /v1/authoring/import/fincrime) and catalog/context-matrix.json. Regenerate; never hand-edit.",
        "catalog": CATALOG_VIEW, "skills": SKILL_SUMMARIES,
        "tasks": {t["id"]: task_composition(t) for t in TASKS},
        "contextProducts": {p["id"]: product_view(p) for p in PRODUCTS},
        "readiness": MATRIX_VIEW})

    J("ehf.kyb-1042.json", {
        "_doc": "EHF-shaped mock store per scenario state. Every object validates against upstream/ehf-contracts.schema.json (or the BFF-owned HumanQueueItem). The mock serves relay endpoints from here.",
        "tenantId": T, "caseId": CASE, "planDigest": PLAN, "runId": RUN, "traceId": TRACE, "default": "ownership_review", "states": store})

    scen = {}
    for s in STATES:
        st = store[s]
        scr_view, scr_comp = screening(s, st)
        scen[s] = {"clock": st["clock"], "attention": attention(s, st), "caseRoom": case_room(s, st), "claims": claims(s, st),
                   "contradictions": {"cf-12": {**CONTRA, "status": "OPEN" if s == "ownership_review" else "RESOLVED",
                                                "commands": CONTRA["commands"] if s == "ownership_review" else [{**c, "enabled": False, "disabledReason": "Contradiction already resolved"} for c in CONTRA["commands"]]}},
                   "ownership": ownership(s), "screening": scr_view, "screeningComparisons": {"s-pep": scr_comp},
                   "decision": desk(s, st) if STATES.index(s) >= 2 else None, "recorder": recorder(s, st), "causality": causality(s, st),
                   "lineage": lineage(st) if s == "decided" else None, "missionControl": mission(s, st), "agents": {"catalogDigest": CAT_DIGEST, "sourceRelease": CC["sourceRelease"],
                   "agents": agent_cards(st), "counts": {"agents": len(AGENTS), "tasks": len(TASKS), "skills": len(SKILLS), "contextProducts": len(PRODUCTS)}},
                   "ownershipOptions": options("wi_own_review")}
    J("scenario.kyb-1042.json", {
        "_doc": "FinCrime view models per state. The mock serves these for /v1/fincrime/** and advances state on the transitions below. A real BFF computes the same projections from EHF + kyc.",
        "default": "ownership_review", "states": scen,
        "transitions": [
            {"from": "ownership_review", "on": {"operation": "postOperationsHumanWorkWorkItemIdDecisions", "workItemId": "wi_own_review", "decision": "APPROVE"}, "to": "screening_review"},
            {"from": "screening_review", "on": {"operation": "postOperationsHumanWorkWorkItemIdDecisions", "workItemId": "wi_scr_review", "decision": "APPROVE"}, "to": "decision_pending"},
            {"from": "decision_pending", "on": {"operation": "postOperationsHumanWorkWorkItemIdDecisions", "workItemId": "wi_decision", "decision": "APPROVE"}, "to": "second_approval"},
            {"from": "second_approval", "on": {"operation": "postOperationsHumanWorkWorkItemIdDecisions", "workItemId": "wi_decision", "decision": "APPROVE", "distinctFromPrior": True}, "to": "decided"}],
        "rules": [
            "Decide requires a claim only when the item already has assignees (upstream: workflow.human_decision_not_assigned).",
            "Same principal deciding a dual-control item twice → 409. Upstream counts decision rows; verify the DB enforces distinct principals (ALIGNMENT G3).",
            "Differing decisions on a dual-control item → item stays WAITING_HUMAN with reason workflow.human_decision_conflict; only human_work.resolve by a non-decider clears it.",
            "Any decision whose basis.caseSequence is behind the scenario's caseSequence → 409 human.basis_stale (target behaviour; mock enforces it so the UI is ready).",
            "ResolveContradiction on cf-12 in ownership_review advances caseSequence by 1 and marks the contradiction RESOLVED; it does not change state by itself.",
            "RETURN on wi_own_review completes it with a RETURN outcome and adds wi_own_rework (READY, agent.identity_ownership); the attention item moves to prepared_by_agents.",
            "REJECT on wi_scr_review sets case status INVESTIGATING and adds an 'EDD required' attention item (EDD view is gap G11)."]})

    J("platform.json", {"_doc": "Seeds for platform surfaces, shaped by upstream/control-ui-views.schema.json (the replaced BFF's view models). Minimal but valid; extend as surfaces need.", **platform()})


if __name__ == "__main__":
    main()
    print("fixtures written")
