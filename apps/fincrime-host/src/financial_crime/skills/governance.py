"""Case lifecycle, deterministic policy, evidence integrity and assurance skills."""
from collections import defaultdict
from datetime import datetime, timedelta
import json

from ..contracts import Computation, SkillError, Status, UnresolvedItem, canonical, digest
from ..primitives import bounded_cycles, calibrated, differences, evaluate, field
from ..registry import A, B, I, N, O, S, array, enum, skill
from .ownership import _pinned


def _pinned(c, key):
    """A policy key the skill cannot run without: absent is unresolved, never an empty or invented default."""
    if key not in c.policy or c.policy[key] is None:
        raise SkillError("POLICY_UNRESOLVED", f"policy states no {key}", Status.BLOCKED)
    return c.policy[key]


def command(services, kind, data, object_id=None):
    object_id = object_id or services.invocation.case_id or services.invocation.execution_id
    rev, _ = services.state(kind, object_id)
    return {"kind": "state", "type": kind, "id": object_id, "expected_revision": rev, "data": data}


@skill("case.create", params={"case_type": S}, returns={"case_id": S, "state": S}, effects="internal_write")
def case_create(p, c, s):
    """Create an idempotent synthetic case with immutable invocation provenance."""
    case_id = s.invocation.case_id or "case-" + digest([s.invocation.tenant_id, s.invocation.idempotency_key])[:16]
    rev, old = s.state("case", case_id)
    if old:
        raise SkillError("CONTROL_FAILED", "case already exists")
    return Computation(payload={"case_id": case_id, "state": "OPEN"}, commands=[command(s, "case", {"state": "OPEN", "case_type": p["case_type"]}, case_id)])


@skill("case.context.hydrate", params={"target_skill": S}, returns={"manifest": O, "context_hash": S})
def case_context(p, c, s):
    """Return the admitted context manifest without recursive compilation."""
    payload = {"manifest": c.manifest.model_dump(mode="json"), "context_hash": digest(c.manifest)}
    # An optional record that exists but was left out (stale, or missing a declared field) makes the
    # hydrated context a partial view; an optional type with no records at all is not a gap.
    excluded = [g for g in c.manifest.gaps if g.object]
    if not excluded:
        return payload
    return Computation(payload=payload, status=Status.PARTIAL, unresolved_items=[
        UnresolvedItem(code=g.code, subject_ref=g.object, explanation=f"optional record {g.object} was excluded" + (f": missing {', '.join(g.fields)}" if g.fields else ": stale"))
        for g in excluded])


@skill("case.tasks.plan", context={"WorkflowDefinition": ["steps"]}, returns={"tasks": A})
def case_tasks(p, c, s):
    """Compile stable tasks and explicit prerequisites from a workflow definition."""
    steps = {}
    for w in c.rows("WorkflowDefinition"):
        for x in w["steps"]:
            if x["id"] in steps and canonical(steps[x["id"]]) != canonical(x):
                # Two definitions state the same step differently: never pick one silently.
                raise SkillError("SOURCE_CONFLICT", f"workflow step {x['id']} is defined differently by two definitions", Status.NEEDS_REVIEW)
            steps.setdefault(x["id"], x)
    def task_id(step_id):
        return digest([s.invocation.case_id, step_id])[:20]
    # Prerequisites name the planned task ids, so the plan's dependencies resolve against its own tasks.
    tasks = [{**x, "id": task_id(x["id"]), "dependencies": [task_id(d) for d in x["dependencies"]]} for x in steps.values()]
    dangling = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"step {x['id']} depends on {d}, which no workflow definition states")
                for x in steps.values() for d in x["dependencies"] if d not in steps]
    if dangling:
        return Computation(payload={"tasks": tasks}, status=Status.NEEDS_REVIEW, unresolved_items=dangling)
    return {"tasks": tasks}


@skill("case.tasks.assign", context={"Task": ["role", "status"]}, params={"assignments": O}, returns={"assignments": A}, effects="internal_write")
def case_assign(p, c, s):
    """Assign tasks to policy-authorized role members using revision checks."""
    members = _pinned(c, "role_members")
    if not p["assignments"]:
        raise SkillError("INPUT_INVALID", "no assignment requested", Status.FAILED)
    tasks = {t["id"]: t for t in c.rows("Task")}
    unknown = sorted(set(p["assignments"]) - set(tasks))
    if unknown:
        # An assignment for a task that is not admitted is never dropped: nothing is written.
        raise SkillError("CONTEXT_MISSING", f"no admitted task {', '.join(unknown)}", Status.NEEDS_EVIDENCE)
    assignments, commands = [], []
    for task in tasks.values():
        assignee = p["assignments"].get(task["id"])
        if assignee is None:
            continue
        if assignee not in members.get(task["role"], []):
            raise SkillError("ACCESS_DENIED", "assignee lacks required role")
        item = {"task_id": task["id"], "actor": assignee, "role": task["role"]}
        assignments.append(item)
        commands.append(command(s, "assignment", item, task["id"]))
    return Computation(payload={"assignments": assignments}, commands=commands)


@skill("case.state.transition", params={"target": S, "expected_revision": I}, returns={"state": S, "revision": I}, effects="internal_write")
def case_transition(p, c, s):
    """Apply an allowed case-state transition at the expected revision."""
    transitions = _pinned(c, "case_transitions")
    revision, state = s.state("case")
    if not state:
        raise SkillError("CONTEXT_MISSING", "case does not exist", Status.NEEDS_EVIDENCE)
    if revision != p["expected_revision"]:
        raise SkillError("REVISION_CONFLICT", "case revision changed")
    if p["target"] == "CLOSED":
        # Closure has its own preconditions (completed tasks, satisfied controls, independent approval).
        raise SkillError("CONTROL_FAILED", "a case is closed only through case.close")
    if state.get("state") not in transitions:
        raise SkillError("CONTROL_FAILED", f"current case state {state.get('state')!r} has no pinned transitions")
    if p["target"] not in transitions[state["state"]]:
        raise SkillError("CONTROL_FAILED", "case transition prohibited")
    return Computation(payload={"state": p["target"], "revision": revision+1}, commands=[command(s, "case", {**state, "state": p["target"]})])


@skill("case.dependencies.evaluate", context={"Task": ["status", "dependencies"]}, returns={"ready": A, "blocked": A, "cycles": A})
def case_dependencies(p, c, s):
    """Evaluate explicit task prerequisites and detect cyclic dependencies."""
    import networkx as nx
    tasks = {x["id"]: x for x in c.rows("Task")}
    g = nx.DiGraph((d, x["id"]) for x in tasks.values() for d in x["dependencies"])
    ready, blocked = [], []
    cycles = bounded_cycles(g)
    cycle_nodes = {n for cycle in cycles for n in cycle}
    for t in tasks.values():
        # Only work not yet started can be ready; running, completed or cancelled tasks are neither.
        if t["status"] not in {"PENDING", "BLOCKED"}:
            continue
        target = ready if t["id"] not in cycle_nodes and all(tasks.get(d, {}).get("status") == "COMPLETED" for d in t["dependencies"]) else blocked
        target.append(t["id"])
    items = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=t["id"], explanation=f"{t['id']} depends on {d}, which is not an admitted task")
             for t in tasks.values() for d in t["dependencies"] if d not in tasks]
    items += [UnresolvedItem(code="DEPENDENCY_CYCLE", subject_ref=cycle[0], explanation="tasks depend on each other: " + " -> ".join(cycle)) for cycle in cycles]
    status = Status.NEEDS_REVIEW if cycles else Status.NEEDS_EVIDENCE if items else Status.COMPLETED
    return Computation(payload={"ready": ready, "blocked": blocked, "cycles": cycles}, status=status, unresolved_items=items)


@skill("case.sla.monitor", context={"SLA": ["deadline", "task_id"]}, returns={"deadlines": A})
def case_sla(p, c, s):
    """Measure task deadlines at the invocation's business timestamp."""
    rows = c.rows("SLA")
    # Deadlines are aware timestamps compared as instants, whatever offset each is written in.
    instants = {x["id"]: datetime.fromisoformat(x["deadline"]) for x in rows}
    deadlines = [{"task_id": x["task_id"], "overdue": instants[x["id"]] < s.invocation.as_of_time,
                  "seconds_remaining": (instants[x["id"]]-s.invocation.as_of_time).total_seconds()} for x in rows]
    grouped = defaultdict(set)
    for x in rows:
        grouped[x["task_id"]].add(instants[x["id"]])
    conflicts = [UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=k, explanation=f"{len(v)} different deadlines are recorded for task {k}")
                 for k, v in sorted(grouped.items()) if len(v) > 1]
    if conflicts:
        return Computation(payload={"deadlines": deadlines}, status=Status.NEEDS_REVIEW, unresolved_items=conflicts)
    return {"deadlines": deadlines}


@skill("case.escalate", params={"reason": S, "role": S}, returns={"escalation_id": S}, effects="internal_write")
def case_escalate(p, c, s):
    """Persist an escalation task for a policy-authorized role."""
    members = _pinned(c, "role_members")
    if p["role"] not in members:
        raise SkillError("POLICY_UNRESOLVED", "unknown escalation role")
    if not members[p["role"]]:
        # An escalation nobody can pick up is not an escalation.
        raise SkillError("POLICY_UNRESOLVED", "escalation role has no members")
    _, state = s.state("case")
    if not state:
        raise SkillError("CONTEXT_MISSING", "case does not exist", Status.NEEDS_EVIDENCE)
    if state.get("state") == "CLOSED":
        raise SkillError("CONTROL_FAILED", "case is closed")
    eid = digest([s.invocation.case_id, p])[:20]
    return Computation(payload={"escalation_id": eid}, commands=[command(s, "escalation", p, eid)])


@skill("case.summary.generate", context={"Finding": ["claim", "status", "evidence_ids"]}, returns={"summary": O})
def case_summary(p, c, s):
    """Render a structured source-attributed case summary without generated claims."""
    findings = c.rows("Finding")
    summary = {"summary": {"case_id": s.invocation.case_id, "findings": findings, "gaps": c.manifest.gaps}}
    # A finding with no cited evidence is reported as such, never as a sourced finding.
    uncited = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"finding {x['id']} cites no evidence") for x in findings if not x["evidence_ids"]]
    if uncited:
        return Computation(payload=json.loads(canonical(summary)), status=Status.NEEDS_REVIEW, unresolved_items=uncited)
    return summary


@skill("case.close", context={"Task": ["status"], "Control": ["requirement_id", "outcome"]}, returns={"closed": B}, effects="human_gated")
def case_close(p, c, s):
    """Close a case only when tasks are complete and an independent approval is consumed."""
    transitions = _pinned(c, "case_transitions")
    unfinished = sorted(t["id"] for t in c.rows("Task") if t["status"] != "COMPLETED")
    if unfinished:
        raise SkillError("CONTROL_FAILED", f"unfinished tasks: {', '.join(unfinished)}")
    _require_controls(c)
    _, state = s.state("case")
    if not state:
        raise SkillError("CONTEXT_MISSING", "case does not exist", Status.NEEDS_EVIDENCE)
    if state.get("state") == "CLOSED":
        raise SkillError("CONTROL_FAILED", "case is already closed")
    if "CLOSED" not in transitions.get(state.get("state"), []):
        # An unknown state, or one the pinned policy does not allow to close from, is never closed.
        raise SkillError("CONTROL_FAILED", f"the pinned policy does not allow closing from state {state.get('state')!r}")
    return Computation(payload={"closed": True}, commands=[command(s, "case", {**state, "state": "CLOSED"})])


@skill("decision.policy.resolve", returns={"policy_id": S, "policy_hash": S, "synthetic": B})
def policy_resolve(p, c, s):
    """Resolve the admitted effective tenant policy snapshot."""
    return {"policy_id": s.invocation.policy_snapshot_ref, "policy_hash": c.manifest.policy_hash, "synthetic": c.manifest.synthetic}


@skill("decision.requirements.compile", params={"facts": O}, returns={"requirements": A})
def requirements_compile(p, c, s):
    """Compile requirement applicability with explicit unknown conditions."""
    result = []
    for r in _requirements(c):
        applicability = evaluate(r["when"], p["facts"]) if "when" in r else "PASS"
        result.append({**r, "applicability": "NOT_APPLICABLE" if applicability == "FAIL" else applicability})
    return {"requirements": result}


@skill("decision.controls.assess", params={"facts": O}, returns={"controls": A}, dependencies=("decision.requirements.compile",))
def controls_assess(p, c, s):
    """Assess each applicable requirement's control from the pinned policy's control predicates."""
    controls = []
    for r in _requirements(c):
        applicability = evaluate(r["when"], p["facts"]) if "when" in r else "PASS"
        if applicability == "FAIL":
            controls.append({"requirement_id": r["id"], "outcome": "NOT_APPLICABLE", "applicability": "NOT_APPLICABLE", "basis": "The requirement's applicability condition does not hold."})
            continue
        control = r.get("control")
        if control is None:
            outcome, basis = "UNKNOWN", "The pinned policy states no control for this requirement."
        elif applicability == "UNKNOWN":
            outcome, basis = "UNKNOWN", "Whether the requirement applies is unknown."
        else:
            passed = evaluate(control["pass"], p["facts"])
            failed = evaluate(control["fail"], p["facts"]) if "fail" in control else "UNKNOWN"
            # A control passes only on its pass condition; it fails only on its stated failure condition.
            # Neither (or both) leaves it UNKNOWN: unmet is not failed, and disagreement is never a pass.
            outcome = "PASS" if passed == "PASS" and failed != "PASS" else "FAIL" if failed == "PASS" and passed != "PASS" else "UNKNOWN"
            basis = {"PASS": "The control's pass condition holds.", "FAIL": "The control's failure condition holds.",
                     "UNKNOWN": "Neither condition holds on the bound facts, or they disagree."}[outcome]
        controls.append({"requirement_id": r["id"], "outcome": outcome, "applicability": applicability, "basis": basis})
    return {"controls": controls}


@skill("decision.rules.evaluate", params={"facts": O}, returns={"evaluations": A, "outcome": S})
def rules_evaluate(p, c, s):
    """Evaluate pinned allowlisted rules; unknown inputs never produce PASS."""
    rules = c.policy.get("rules", [])
    if not rules:
        raise SkillError("POLICY_UNRESOLVED", "policy contains no rules")
    results = [{"rule_id": r["id"], "outcome": evaluate(r["predicate"], p["facts"]), "input_hash": digest(p["facts"])} for r in rules]
    outcomes = [r["outcome"] for r in results]
    return {"evaluations": results, "outcome": "FAIL" if "FAIL" in outcomes else "UNKNOWN" if "UNKNOWN" in outcomes else "PASS"}


@skill("decision.exceptions.evaluate", context={"Exception": ["scope", "expires_at", "issuer", "approved"]}, params={"scope": S}, returns={"exceptions": A})
def exceptions_evaluate(p, c, s):
    """Validate exception scope, issuer authority and expiration."""
    issuers = _pinned(c, "exception_issuers")
    # An exception issued by the actor who now relies on it is self-approval, never a valid exception.
    return {"exceptions": [{"id": r["id"], "valid": r["approved"] is True and r["issuer"] in issuers and r["issuer"] != s.principal.actor_id
                            and r["scope"] == p["scope"] and datetime.fromisoformat(r["expires_at"]) > s.invocation.as_of_time}
                           for r in c.rows("Exception")]}


@skill("decision.gaps.evaluate", context={"Control": ["requirement_id", "outcome"]}, returns={"gaps": A})
def decision_gaps(p, c, s):
    """Find obligations without a satisfied control."""
    controls = _control_outcomes(c)
    return {"gaps": [{"requirement_id": r["id"], "outcome": controls.get(r["id"], "UNKNOWN")} for r in _requirements(c) if controls.get(r["id"]) not in {"PASS", "NOT_APPLICABLE"}]}


@skill("decision.risk.acceptance.evaluate", context={"RiskAssessment": ["tier"]}, returns={"eligible": B, "required_role": S})
def risk_acceptance(p, c, s):
    """Evaluate acceptance eligibility and required review authority."""
    acceptable, role = _pinned(c, "acceptable_tiers"), _pinned(c, "acceptance_role")
    rows = c.rows("RiskAssessment")
    tiers = {r["tier"] for r in rows}
    if len(tiers) > 1:
        # Assessments that disagree on the tier cannot make the customer acceptable by each being acceptable.
        return Computation(payload={"eligible": False, "required_role": role}, status=Status.NEEDS_REVIEW, unresolved_items=[
            UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=", ".join(sorted(tiers)),
                           explanation="risk assessments " + ", ".join(f"{r['id']} ({r['tier']})" for r in rows) + " disagree on the tier")])
    return {"eligible": tiers <= set(acceptable), "required_role": role}


@skill("decision.recommendation.generate", context={"Control": ["outcome", "requirement_id"]}, returns={"recommendation": S, "reasons": A})
def decision_recommend(p, c, s):
    """Map control outcomes to a policy-defined review recommendation."""
    reasons = c.rows("Control")
    outcomes = [x["outcome"] for x in reasons]
    outcome = "FAIL" if "FAIL" in outcomes else "UNKNOWN" if "UNKNOWN" in outcomes else "PASS"
    return {"recommendation": c.policy.get("recommendations", {}).get(outcome, "REVIEW"), "reasons": reasons}


@skill("decision.approval.route", params={"action": S}, returns={"role": S, "eligible_actors": A})
def approval_route(p, c, s):
    """Find independent policy-authorized approvers for an action."""
    role = c.policy.get("approval_roles", {}).get(p["action"])
    if role is None:
        raise SkillError("POLICY_UNRESOLVED", "approval route missing")
    members = _pinned(c, "role_members").get(role)
    if not members:
        raise SkillError("POLICY_UNRESOLVED", f"policy names no members of the approval role {role}", Status.BLOCKED)
    eligible = list(dict.fromkeys(a for a in members if a != s.principal.actor_id))
    if not eligible:
        # The proposer is never their own approver; a route with no one else is not a route.
        raise SkillError("CONTROL_FAILED", f"no approver independent of {s.principal.actor_id} holds the role {role}", Status.BLOCKED)
    return {"role": role, "eligible_actors": eligible}


@skill("decision.human.review", params={"action": S}, returns={"action": S, "review_required": B}, effects="human_gated")
def human_review(p, c, s):
    """Suspend for an authenticated independent human review."""
    return {"action": p["action"], "review_required": True}


@skill("decision.disposition.record", params={"disposition": enum("ACCEPT", "REJECT", "ESCALATE")}, context={"Control": ["outcome", "requirement_id"]}, returns={"disposition": S}, effects="human_gated")
def disposition(p, c, s):
    """Record a human-approved disposition only with satisfied acceptance controls."""
    if p["disposition"] == "ACCEPT":
        _require_controls(c)
    _, state = s.state("case")
    if not state:
        raise SkillError("CONTEXT_MISSING", "missing case", Status.NEEDS_EVIDENCE)
    if state.get("state") == "CLOSED":
        raise SkillError("CONTROL_FAILED", "a closed case's disposition cannot be changed")
    return Computation(payload={"disposition": p["disposition"]}, commands=[command(s, "case", {**state, "disposition": p["disposition"]})])


def _requirements(context):
    """The pinned policy's requirements; a policy that does not state them is unresolved, never 'nothing required'."""
    if "requirements" not in context.policy:
        raise SkillError("POLICY_UNRESOLVED", "policy states no requirements", Status.BLOCKED)
    return context.policy["requirements"]


def _control_outcomes(context):
    """One outcome per requirement. A FAIL in any row wins; rows that otherwise disagree are UNKNOWN,
    so a later row can never hide an earlier one."""
    grouped = {}
    for row in context.rows("Control"):
        grouped.setdefault(row["requirement_id"], set()).add(row["outcome"])
    return {k: "FAIL" if "FAIL" in v else next(iter(v)) if len(v) == 1 else "UNKNOWN" for k, v in grouped.items()}


def _require_controls(context):
    required = {x["id"] for x in _requirements(context)}
    controls = _control_outcomes(context)
    if any(controls.get(k) not in {"PASS", "NOT_APPLICABLE"} for k in required):
        raise SkillError("CONTROL_FAILED", "mandatory acceptance controls unresolved")


@skill("decision.explain", context={"Control": ["outcome", "requirement_id"]}, returns={"explanation": A, "policy_hash": S})
def decision_explain(p, c, s):
    """Explain exact control outcomes and their pinned policy basis."""
    rows = c.rows("Control")
    payload = {"explanation": rows, "policy_hash": c.manifest.policy_hash}
    by_requirement = defaultdict(list)
    for x in rows:
        by_requirement[x["requirement_id"]].append(x)
    # Controls that disagree on one requirement are both explained and flagged; neither one is the explanation.
    conflicts = [UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=k,
                                explanation="controls " + ", ".join(f"{x['id']} ({x['outcome']})" for x in v) + f" disagree on {k}")
                 for k, v in sorted(by_requirement.items()) if len({x["outcome"] for x in v}) > 1]
    return Computation(payload=payload, status=Status.NEEDS_REVIEW, unresolved_items=conflicts) if conflicts else payload


@skill("decision.audit.verify", returns={"valid": B, "events": I})
def audit_verify(p, c, s):
    """Verify the tenant audit hash chain without exposing other tenants."""
    chain = s.store.audit_chain(s.invocation.tenant_id)
    if not chain:
        # Nothing to verify is not a verified chain.
        raise SkillError("EVIDENCE_INSUFFICIENT", "the tenant audit chain has no events to verify", Status.NEEDS_EVIDENCE)
    previous, broken = None, []
    for position, (body, hash_value) in enumerate(chain, 1):
        if body.get("previous_hash") != previous or digest(body) != hash_value:
            broken.append(UnresolvedItem(code="INTEGRITY_FAILURE", subject_ref=str(position),
                explanation=f"audit event {position} does not match its recorded hash or does not link to the event before it"))
        previous = hash_value
    payload = {"valid": not broken, "events": len(chain)}
    return Computation(payload=payload, status=Status.NEEDS_REVIEW, unresolved_items=broken) if broken else payload


@skill("evidence.collect", context={"SourceRecord": ["content", "source", "coverage"]}, returns={"artifacts": A})
def evidence_collect(p, c, s):
    """Collect admitted source artifacts with content hashes and coverage."""
    rows = c.rows("SourceRecord")
    payload = {"artifacts": [{"ref": x["_ref"], "content_hash": digest(x["content"]), "source": x["source"], "coverage": x["coverage"]} for x in rows]}
    # A source that reports incomplete coverage may hold more than was collected.
    gaps = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"source {x['source']} reports incomplete coverage for {x['id']}")
            for x in rows if x["coverage"].get("complete") is not True]
    return Computation(payload=payload, status=Status.PARTIAL, unresolved_items=gaps) if gaps else payload


@skill("evidence.normalize", context={"Evidence": ["content", "source_id"]}, returns={"evidence": A})
def evidence_normalize(p, c, s):
    """Normalize evidence metadata while retaining raw content and source IDs."""
    return {"evidence": [{"id": x["id"], "source_id": x["source_id"], "hash": digest(x["content"]), "content": x["content"]} for x in c.rows("Evidence")]}


@skill("evidence.provenance.attach", context={"Evidence": ["source_id", "content"]}, returns={"lineage": A})
def provenance_attach(p, c, s):
    """Attach source/version hashes to evidence; reject absent source identifiers."""
    return {"lineage": [{"evidence_id": x["id"], "source_id": x["source_id"], "source_ref": x["_ref"], "content_hash": digest(x["content"])} for x in c.rows("Evidence")]}


@skill("evidence.integrity.verify", context={"Evidence": ["content", "content_hash"]}, returns={"checks": A, "valid": B})
def integrity_verify(p, c, s):
    """Verify every selected evidence content hash."""
    checks = [{"id": x["id"], "valid": digest(x["content"]) == x["content_hash"]} for x in c.rows("Evidence")]
    payload = {"checks": checks, "valid": all(x["valid"] for x in checks)}
    failed = [UnresolvedItem(code="INTEGRITY_FAILURE", subject_ref=x["id"], explanation=f"the content of {x['id']} does not match its recorded hash")
              for x in checks if not x["valid"]]
    return Computation(payload=payload, status=Status.NEEDS_REVIEW, unresolved_items=failed) if failed else payload


@skill("evidence.facts.extract", context={"Assertion": ["claim", "evidence_ids", "verification"]}, returns={"assertions": A, "verified_facts": A})
def facts_extract(p, c, s):
    """Separate extracted assertions from facts with explicit verification records."""
    rows = c.rows("Assertion")
    methods = _pinned(c, "verification_methods")
    return {"assertions": rows, "verified_facts": [x for x in rows if x["verification"].get("status") == "VERIFIED" and x["verification"].get("method") in methods and x["evidence_ids"]]}


@skill("evidence.conflicts.resolve", context={"Assertion": ["subject", "field", "value", "evidence_ids"]}, returns={"conflicts": A})
def conflicts_resolve(p, c, s):
    """Detect incompatible assertions while preserving both sources for review."""
    groups = defaultdict(list)
    for a in c.rows("Assertion"):
        groups[(a["subject"], a["field"])].append(a)
    conflicts = [{"subject": k[0], "field": k[1], "assertions": v, "resolution": "UNRESOLVED"} for k, v in groups.items() if len({canonical(x["value"]) for x in v}) > 1]
    items = [UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=x["subject"],
                            explanation=f"assertions {', '.join(a['id'] for a in x['assertions'])} disagree on {x['field']} of {x['subject']}") for x in conflicts]
    return Computation(payload={"conflicts": conflicts}, status=Status.NEEDS_REVIEW if conflicts else Status.COMPLETED, unresolved_items=items)


@skill("evidence.sufficiency.assess", context={"Evidence": ["requirement_ids", "verified"]}, returns={"sufficient": B, "missing": A})
def sufficiency(p, c, s):
    """Assess evidence coverage against explicit pinned requirement IDs."""
    required = {r["id"] for r in _requirements(c)}
    covered = {k for x in c.rows("Evidence") if x["verified"] for k in x["requirement_ids"]}
    missing = sorted(required-covered)
    return {"sufficient": not missing, "missing": missing}


@skill("evidence.lineage.trace", context={"Provenance": ["target", "sources"]}, params={"target": S}, returns={"sources": A, "cycles": A})
def lineage_trace(p, c, s):
    """Trace a derivation graph to roots and surface lineage cycles."""
    import networkx as nx
    g = nx.DiGraph((x["target"], source) for x in c.rows("Provenance") for source in x["sources"])
    if p["target"] not in g:
        # No recorded derivation of the target is a lineage gap, not a target without sources.
        raise SkillError("EVIDENCE_INSUFFICIENT", f"no provenance records a source of {p['target']}", Status.NEEDS_EVIDENCE)
    reachable = nx.descendants(g, p["target"])
    payload = {"sources": sorted(x for x in reachable if g.out_degree(x) == 0), "cycles": bounded_cycles(g.subgraph(reachable | {p["target"]}))}
    if payload["cycles"]:
        # A derivation that depends on itself does not trace to its roots.
        return Computation(payload=payload, status=Status.NEEDS_REVIEW, unresolved_items=[UnresolvedItem(code="INTEGRITY_FAILURE", subject_ref=p["target"],
            explanation=f"the lineage of {p['target']} contains the cycle " + " -> ".join(cycle + cycle[:1])) for cycle in payload["cycles"]])
    return payload


@skill("evidence.bundle.compile", context={"Evidence": ["content", "source_id"]}, returns={"manifest": A, "bundle_hash": S})
def bundle_compile(p, c, s):
    """Compile an ordered immutable evidence bundle manifest."""
    manifest = [{"ref": x["_ref"], "hash": digest(x["content"]), "source_id": x["source_id"]} for x in c.rows("Evidence")]
    return {"manifest": manifest, "bundle_hash": digest(manifest)}


@skill("evidence.retention.enforce", context={"RetentionRule": ["retain_until", "legal_hold", "object_id"]}, returns={"deletion_candidates": A, "held": A}, effects="human_gated")
def retention(p, c, s):
    """Identify deletable records and legal holds; deletion needs a configured storage adapter."""
    rules = defaultdict(list)
    for x in c.rows("RetentionRule"):
        rules[x["object_id"]].append(x)
    held, candidates = [], []
    # Every rule for an object applies: any legal hold holds it, and it is deletable only once every rule has expired.
    for object_id, xs in sorted(rules.items()):
        if any(x["legal_hold"] for x in xs):
            held.append(object_id)
        elif all(datetime.fromisoformat(x["retain_until"]) <= s.invocation.as_of_time for x in xs):
            candidates.append(object_id)
    commands = [{"kind": "outbox", "id": digest(["retention", x]), "action": "delete_artifact", "object_id": x} for x in candidates]
    return Computation(payload={"deletion_candidates": candidates, "held": held}, commands=commands)


@skill("quality.data.validate", params={"rows": array(O), "required_fields": array(S)}, returns={"issues": A, "valid": B})
def data_validate(p, c, s):
    """Validate required-field missingness and duplicate row identities."""
    if not p["rows"]:
        raise SkillError("EVIDENCE_INSUFFICIENT", "no rows to validate", Status.NEEDS_EVIDENCE)
    if not p["required_fields"]:
        raise SkillError("INPUT_INVALID", "no required fields to validate", Status.FAILED)
    issues, seen = [], set()
    for i, row in enumerate(p["rows"]):
        for f in p["required_fields"]:
            value = field(row, f)
            # A blank string carries no value: it is missing, not present.
            if value is None or (isinstance(value, str) and not value.strip()):
                issues.append({"row": i, "code": "MISSING", "field": f})
        identity = None if row.get("id") is None else canonical(row["id"])
        if identity is not None and identity in seen:
            issues.append({"row": i, "code": "DUPLICATE_ID"})
        if identity is not None:
            seen.add(identity)
    return {"issues": issues, "valid": not issues}


ANNOTATIONS = {"$schema", "$id", "$comment", "title", "description", "examples", "default"}


def formats(schema):
    """Every `format` a schema asks for, skipping literal values (const, enum, default, examples)."""
    if isinstance(schema, list):
        return set().union(*(formats(x) for x in schema))
    if not isinstance(schema, dict):
        return set()
    found = {schema["format"]} if isinstance(schema.get("format"), str) else set()
    return found.union(*(formats(v) for k, v in schema.items() if k not in {"const", "enum", "default", "examples"}))


@skill("quality.schema.validate", params={"instance": O, "schema": O}, returns={"valid": B, "errors": A})
def schema_validate(p, c, s):
    """Validate self-contained schemas with local references; prohibit remote retrieval."""
    from jsonschema import Draft202012Validator, SchemaError
    try:
        Draft202012Validator.check_schema(p["schema"])
    except SchemaError:
        raise SkillError("INPUT_INVALID", "provided schema is invalid", Status.FAILED)
    def external(value):
        if isinstance(value, dict):
            return any(key in value and not (value[key] == "#" or value[key].startswith("#/")) for key in ("$ref", "$dynamicRef")) or any(external(x) for x in value.values())
        return isinstance(value, list) and any(external(x) for x in value)
    if external(p["schema"]):
        raise SkillError("INPUT_INVALID", "external schema references prohibited", Status.FAILED)
    from referencing import Registry
    from referencing.exceptions import Unresolvable
    from jsonschema import FormatChecker
    if not set(p["schema"]) - ANNOTATIONS:
        # A schema with no constraint accepts every instance; "valid" would claim a check that never ran.
        raise SkillError("INPUT_INVALID", "schema states no constraint", Status.FAILED)
    unchecked = sorted(formats(p["schema"]) - set(FormatChecker().checkers))
    if unchecked:
        # A format the checker does not support would pass unchecked rather than be validated.
        raise SkillError("INPUT_INVALID", "schema format cannot be checked: " + ", ".join(unchecked), Status.FAILED)
    def deny_retrieval(uri):
        raise Unresolvable(ref=uri)
    try:
        validator = Draft202012Validator(p["schema"], format_checker=FormatChecker(), registry=Registry(retrieve=deny_retrieval))
        errors = [f"{'.'.join(map(str, e.path)) or '$'}: failed {e.validator}" for e in validator.iter_errors(p["instance"])]
    except Unresolvable:
        raise SkillError("INPUT_INVALID", "local schema reference is unresolved", Status.FAILED)
    return {"valid": not errors, "errors": errors}


@skill("quality.findings.verify", context={"Finding": ["claim", "evidence_ids"], "Evidence": ["content"]}, returns={"checks": A, "semantic_review_required": B})
def findings_verify(p, c, s):
    """Validate finding citation existence; semantic truth remains a separate review."""
    ids = {x["id"] for x in c.rows("Evidence")}
    return {"checks": [{"id": x["id"], "citations_valid": bool(x["evidence_ids"]) and set(x["evidence_ids"]) <= ids} for x in c.rows("Finding")], "semantic_review_required": True}


@skill("quality.hallucination.detect", context={"Finding": ["claim", "evidence_ids"], "Evidence": ["content"]}, returns={"unsupported": A, "semantic_review_required": B})
def hallucination_detect(p, c, s):
    """Flag missing/broken citations without claiming automatic semantic verification."""
    ids = {x["id"] for x in c.rows("Evidence")}
    return {"unsupported": [x["id"] for x in c.rows("Finding") if not x["evidence_ids"] or not set(x["evidence_ids"]) <= ids], "semantic_review_required": True}


@skill("quality.policy.compliance", context={"Control": ["requirement_id", "outcome"]}, returns={"compliant": B, "unresolved": A})
def policy_compliance(p, c, s):
    """Verify every configured obligation has a passing or inapplicable control."""
    controls = _control_outcomes(c)
    unresolved = [x["id"] for x in _requirements(c) if controls.get(x["id"]) not in {"PASS", "NOT_APPLICABLE"}]
    return {"compliant": not unresolved, "unresolved": unresolved}


@skill("quality.coverage.assess", params={"required": array(S), "covered": array(S)}, returns={"coverage": N, "missing": A, "denominator": I})
def coverage(p, c, s):
    """Compute coverage with explicit deduplicated denominator and gaps."""
    required = set(p["required"])
    if not required:
        raise SkillError("INPUT_INVALID", "coverage denominator must be nonempty", Status.FAILED)
    missing = sorted(required-set(p["covered"]))
    return {"coverage": (len(required)-len(missing))/len(required), "missing": missing, "denominator": len(required)}


@skill("quality.confidence.calibrate", params={"samples": array(O, 1)}, returns={"sample_count": I, "brier_score": N, "promoted": B})
def confidence_calibrate(p, c, s):
    """Measure held-out binary confidence calibration without activating model changes."""
    if len({x["label"] for x in p["samples"]}) < 2:
        # Samples of one outcome only cannot show whether the scores separate the outcomes.
        raise SkillError("EVIDENCE_INSUFFICIENT", "calibration requires held-out samples of both labels", Status.NEEDS_EVIDENCE)
    return calibrated(p["samples"])


@skill("quality.agent.trace.evaluate", params={"events": array(O), "allowed_skills": array(S)}, returns={"violations": A, "valid": B})
def trace_evaluate(p, c, s):
    """Check trace skill admission and approval-before-action ordering."""
    if not p["events"]:
        # An empty trace shows nothing the agent did; it is not a compliant trace.
        raise SkillError("EVIDENCE_INSUFFICIENT", "the trace has no events to evaluate", Status.NEEDS_EVIDENCE)
    approved, consumed, violations = set(), set(), []
    for i, event in enumerate(p["events"]):
        if event.get("skill_id") and event["skill_id"] not in p["allowed_skills"]:
            violations.append({"index": i, "code": "UNADMITTED_SKILL"})
        if event.get("event") == "human_approved" and event.get("approval_id"):
            approved.add(event["approval_id"])
        if event.get("event") == "external_effect":
            # An effect needs its own earlier approval, and one approval authorizes one effect.
            approval = event.get("approval_id")
            if not approval or approval not in approved or approval in consumed:
                violations.append({"index": i, "code": "MISSING_APPROVAL"})
            if approval:
                consumed.add(approval)
    return {"violations": violations, "valid": not violations}


@skill("quality.outcome.reconcile", params={"expected": O, "observed": O}, returns={"differences": A, "matched": B})
def outcome_reconcile(p, c, s):
    """Compare structured expected and observed outputs without silent tolerances."""
    expected, observed = p["expected"], p["observed"]
    if not expected:
        raise SkillError("INPUT_INVALID", "the expected outcome states no fields to reconcile", Status.FAILED)
    # Exact JSON comparison: an absent field differs from null, and true differs from 1.
    def exact(values, key):
        return (True, canonical(values[key])) if key in values else (False, None)
    changes = [{"field": k, "before": expected.get(k), "after": observed.get(k)} for k in sorted(set(expected) | set(observed))
               if exact(expected, k) != exact(observed, k)]
    return {"differences": changes, "matched": not changes}


@skill("quality.remediation.plan", params={"issues": array(O)}, returns={"tasks": A})
def remediation(p, c, s):
    """Create attributable remediation tasks from concrete issue records."""
    role = _pinned(c, "remediation_role")
    # One task per distinct issue: a repeated issue is one piece of work, not two tasks with one ID.
    issues = {}
    for x in p["issues"]:
        issues.setdefault(digest(x)[:20], x)
    return {"tasks": [{"id": k, "issue": x, "role": role, "verification": "rerun originating validation"} for k, x in issues.items()]}
