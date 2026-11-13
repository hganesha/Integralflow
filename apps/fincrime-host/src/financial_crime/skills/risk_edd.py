"""Versioned deterministic risk scoring and evidence-based EDD analysis."""
from ..contracts import Computation, SkillError, Status, UnresolvedItem
from ..primitives import calibrated, dec, differences, evaluate, number
from ..registry import A, B, N, O, S, array, skill
from .alerts_investigations import _cited
from .ownership import _pinned


def score_factors(rows, policy):
    weights = policy.get("risk_weights")
    if not weights:
        raise SkillError("POLICY_UNRESOLVED", "risk model weights missing")
    observed = {}
    for x in rows:
        prior = observed.get(x["name"])
        if prior is not None and dec(prior["score"]) != dec(x["score"]):
            # Two sources disagree on one factor: never pick one silently.
            raise SkillError("SOURCE_CONFLICT", f"conflicting scores for risk factor {x['name']}", Status.NEEDS_REVIEW)
        observed[x["name"]] = x
    missing = sorted(set(weights)-set(observed))
    contributions = [{"factor": k, "value": observed[k]["score"], "weight": w,
                      "contribution": number(dec(observed[k]["score"])*dec(w))} for k, w in weights.items() if k in observed]
    total_weight = sum((dec(w) for w in weights.values()), dec("0"))
    if total_weight <= 0 or any(dec(w) < 0 for w in weights.values()):
        raise SkillError("POLICY_UNRESOLVED", "risk weights must be nonnegative with positive sum")
    score = None if missing else number(sum((dec(x["contribution"]) for x in contributions), dec("0"))/total_weight)
    return {"score": score, "contributions": contributions, "missing": missing, "model_version": policy.get("risk_model_version", "unversioned")}


@skill("risk.customer.assess", context={"RiskFactor": ["name", "score"]}, returns={"assessment": O, "tier": S})
def customer_risk(p, c, s):
    """Calculate a pinned weighted score with unknown factors retained and no acceptance decision."""
    assessment = score_factors(c.rows("RiskFactor"), c.policy)
    tier = "UNKNOWN"
    if assessment["score"] is not None:
        for boundary in sorted(c.policy.get("risk_tiers", []), key=lambda x: dec(x["minimum"]), reverse=True):
            if dec(assessment["score"]) >= dec(boundary["minimum"]):
                tier = boundary["tier"]
                break
    return Computation(payload={"assessment": assessment, "tier": tier}, status=Status.NEEDS_EVIDENCE if assessment["missing"] else Status.COMPLETED)


@skill("risk.inherent.calculate", context={"RiskFactor": ["name", "score"]}, returns={"assessment": O})
def inherent(p, c, s):
    """Calculate inherent risk from exact configured weights and sourced factor scores."""
    # The score is only reproducible against a named model: no "unversioned" default.
    _pinned(c, "risk_model_version")
    assessment = score_factors(c.rows("RiskFactor"), c.policy)
    # A weighted factor without a sourced score leaves the score unknown: evidence is missing, never low risk.
    return Computation(payload={"assessment": assessment}, status=Status.NEEDS_EVIDENCE if assessment["missing"] else Status.COMPLETED)


@skill("risk.residual.calculate", params={"inherent_score": S, "control_effectiveness": S}, returns={"residual_score": S})
def residual(p, c, s):
    """Apply the explicit synthetic residual-risk formula with bounded effectiveness."""
    effectiveness = dec(p["control_effectiveness"])
    if not 0 <= effectiveness <= 1:
        raise SkillError("INPUT_INVALID", "control effectiveness outside 0..1", Status.FAILED)
    if dec(p["inherent_score"]) < 0:
        raise SkillError("INPUT_INVALID", "inherent score below 0", Status.FAILED)
    return {"residual_score": number(dec(p["inherent_score"])*(1-effectiveness))}


@skill("risk.factor.evaluate", params={"factor": S, "value": S}, returns={"factor": S, "score": {"type": ["string", "null"], "pattern": r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$"}, "outcome": S})
def factor_evaluate(p, c, s):
    """Map a factor value through an explicitly configured score table."""
    mapping = c.policy.get("risk_factor_maps", {}).get(p["factor"])
    if mapping is None:
        raise SkillError("POLICY_UNRESOLVED", "factor mapping missing")
    value = mapping.get(p["value"])
    # SCORED only says the value is in the table; it is not a risk verdict. An unmapped value is
    # UNKNOWN and leaves the factor open (NEEDS_EVIDENCE), never a low score.
    if value is None:
        return Computation(payload={"factor": p["factor"], "score": None, "outcome": "UNKNOWN"}, status=Status.NEEDS_EVIDENCE)
    return {"factor": p["factor"], "score": value, "outcome": "SCORED"}


# Where each risk dimension's values come from in the case's records.
FACTOR_SOURCES = {
    "geography": ("GeographyExposure", "country"),
    "product": ("Product", "product_type"),
    "industry": ("Party", "industry"),
    "customer_type": ("Party", "customer_type"),
    "behavior": ("ExpectedActivity", "behavior_category"),
}


@skill("risk.factors.derive", optional={"GeographyExposure": ["country"], "Party": ["customer_type", "industry?"], "Product": ["product_type"],
       "ExpectedActivity": ["behavior_category"]}, returns={"factors": A}, dependencies=("risk.factor.evaluate",))
def factors_derive(p, c, s):
    """Score each weighted risk dimension from the case's recorded values through the pinned factor maps (highest value wins)."""
    weights = c.policy.get("risk_weights")
    maps = c.policy.get("risk_factor_maps")
    if not weights or maps is None:
        raise SkillError("POLICY_UNRESOLVED", "risk weights or factor maps missing", Status.BLOCKED)
    factors = []
    for name in sorted(weights):
        source = FACTOR_SOURCES.get(name)
        table = maps.get(name)
        if source is None or table is None:
            factors.append({"name": name, "score": None, "values": [], "basis": "No source or score table for this factor."})
            continue
        values = sorted({x[source[1]] for x in c.rows(source[0]) if x.get(source[1])})
        unmapped = [v for v in values if v not in table]
        if not values:
            factors.append({"name": name, "score": None, "values": [], "basis": f"No {source[0]} {source[1]} is recorded."})
        elif unmapped:
            factors.append({"name": name, "score": None, "values": values, "basis": f"No score for {', '.join(unmapped)}."})
        else:
            factors.append({"name": name, "score": number(max(dec(table[v]) for v in values)), "values": values,
                            "basis": "The highest score of the recorded values."})
    # A weighted factor left unscored keeps the assessment open: evidence is missing, never a low score.
    return Computation(payload={"factors": factors}, status=Status.NEEDS_EVIDENCE if any(x["score"] is None for x in factors) else Status.COMPLETED)


FACTOR_CONTEXT = {
    "risk.geography.assess": ("GeographyExposure", "country", "geography"),
    "risk.industry.assess": ("Party", "industry", "industry"),
    "risk.product.assess": ("Product", "product_type", "product"),
    "risk.behavior.assess": ("ExpectedActivity", "behavior_category", "behavior"),
}


def factor_assess(p, c, s):
    """Evaluate sourced exposures using a configured domain-specific risk mapping."""
    object_type, field, factor = FACTOR_CONTEXT[s.invocation.skill_id]
    table = c.policy.get("risk_factor_maps", {}).get(factor)
    if table is None:
        raise SkillError("POLICY_UNRESOLVED", "risk mapping missing")
    factors = [{"id": x["id"], "factor": factor, "value": x[field], "score": table.get(x[field]), "known": x[field] in table} for x in c.rows(object_type)]
    # A recorded value the table does not score stays listed with score null, and the result stays open.
    return Computation(payload={"factors": factors}, status=Status.COMPLETED if all(x["known"] for x in factors) else Status.NEEDS_EVIDENCE)


for _id, (_type, _field, _) in FACTOR_CONTEXT.items():
    skill(_id, context={_type: [_field]}, returns={"factors": A})(factor_assess)


@skill("risk.score.explain", context={"RiskAssessment": ["contributions", "model_version", "score"]}, returns={"explanations": A})
def score_explain(p, c, s):
    """Explain scores from captured contributions and model versions without generated rationale."""
    rows = c.rows("RiskAssessment")
    # A captured score with no captured contributions has nothing to explain it.
    bare = [x["id"] for x in rows if not x["contributions"]]
    return Computation(payload={"explanations": rows}, status=Status.NEEDS_EVIDENCE if bare else Status.COMPLETED, unresolved_items=[
        UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=k, explanation=f"assessment {k} has no captured contributions") for k in bare])


@skill("risk.score.calibrate", params={"samples": array(O, 1)}, returns={"sample_count": {"type": "integer"}, "brier_score": N, "promoted": B})
def score_calibrate(p, c, s):
    """Measure held-out risk calibration without changing the active model."""
    return calibrated(p["samples"])


@skill("risk.change.detect", params={"before": O, "after": O}, returns={"changes": A})
def risk_change(p, c, s):
    """Distinguish explicit risk snapshot differences for review."""
    before, after = p["before"], p["after"]
    # Scores are compared as exact decimals: "0.2" and "0.20" are the same score.
    changes = [x for x in differences(before, after)
               if not (x["field"] == "score" and x["before"] is not None and x["after"] is not None and dec(x["before"]) == dec(x["after"]))]
    status, items = Status.COMPLETED, []
    if not before or not after:
        status = Status.NEEDS_EVIDENCE
        items += [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=k, explanation=f"the {k} snapshot is empty")
                  for k, v in (("before", before), ("after", after)) if not v]
    else:
        # A field captured on one side only is unknown on the other, not a change to nothing.
        one_sided = sorted(set(before) ^ set(after))
        if one_sided:
            status = Status.NEEDS_EVIDENCE
            items += [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=k, explanation=f"{k} is captured in only one snapshot") for k in one_sided]
    if before.get("model_version") and after.get("model_version") and before["model_version"] != after["model_version"]:
        # Scores from different model versions are not comparable: a score difference is not a risk change.
        status = Status.NEEDS_REVIEW
        items.append(UnresolvedItem(code="MODEL_VERSION_CHANGED", explanation=f"model {before['model_version']} vs {after['model_version']}"))
    return Computation(payload={"changes": changes}, status=status, unresolved_items=items)


@skill("risk.tier.assign", params={"score": S}, returns={"tier": S, "final_acceptance": B})
def tier_assign(p, c, s):
    """Map a numeric score to a configured recommended tier."""
    for x in sorted(c.policy.get("risk_tiers", []), key=lambda x: dec(x["minimum"]), reverse=True):
        if dec(p["score"]) >= dec(x["minimum"]):
            return {"tier": x["tier"], "final_acceptance": False}
    raise SkillError("POLICY_UNRESOLVED", "no applicable tier boundary")


@skill("edd.trigger.evaluate", params={"facts": O}, returns={"triggers": A, "required": B})
def edd_trigger(p, c, s):
    """Evaluate explicit EDD trigger predicates and preserve unknown inputs."""
    if "edd_triggers" not in c.policy or c.policy["edd_triggers"] is None:
        raise SkillError("POLICY_UNRESOLVED", "EDD trigger policy missing; an approved empty list must be explicit")
    triggers = [{"id": x["id"], "outcome": evaluate(x["predicate"], p["facts"])} for x in c.policy["edd_triggers"]]
    return {"triggers": triggers, "required": any(x["outcome"] in {"PASS", "UNKNOWN"} for x in triggers)}


@skill("edd.scope.plan", params={"trigger_ids": array(S)}, returns={"tasks": A})
def edd_scope(p, c, s):
    """Compile bounded EDD tasks from matched policy triggers."""
    if c.policy.get("edd_triggers") is None:
        raise SkillError("POLICY_UNRESOLVED", "EDD trigger policy missing; an approved empty list must be explicit", Status.BLOCKED)
    configured = {x["id"] for x in c.policy["edd_triggers"]}
    unknown = sorted(set(p["trigger_ids"]) - configured)
    if unknown:
        # A fired trigger the policy cannot scope is unresolved, never "no tasks".
        raise SkillError("POLICY_UNRESOLVED", f"no EDD scope for triggers {', '.join(unknown)}", Status.BLOCKED)
    return {"tasks": [{"trigger_id": x["id"], "task": task} for x in c.policy["edd_triggers"] if x["id"] in p["trigger_ids"] for task in x.get("tasks", [])]}


@skill("edd.source_of_funds.verify", context={"SourceOfFunds": ["claim", "evidence_ids", "verified"]}, optional={"Evidence": ["content"]}, returns={"claims": A})
def funds_verify(p, c, s):
    """Evaluate captured funds verification evidence; unsupported claims remain unverified."""
    # verified = the producer's captured flag AND the claim cites evidence AND, when Evidence is
    # admitted, every cited id is admitted Evidence. The evidence content itself is not read.
    cited = _cited(c)
    return {"claims": [{"id": x["id"], "claim": x["claim"], "verified": bool(x["verified"]) and cited(x["evidence_ids"])} for x in c.rows("SourceOfFunds")]}


@skill("edd.source_of_wealth.assess", context={"SourceOfWealth": ["claim", "evidence_ids", "verified"]}, optional={"Evidence": ["content"]}, returns={"assessments": A})
def wealth_assess(p, c, s):
    """Assess documented wealth claims with explicit corroboration and remaining uncertainty."""
    # corroborated = the producer's captured flag AND cited evidence that is admitted (when Evidence
    # is admitted); plausibility of the wealth itself is never assessed here.
    cited = _cited(c)
    return {"assessments": [{"id": x["id"], "claim": x["claim"], "corroborated": bool(x["verified"]) and cited(x["evidence_ids"]),
                             "plausibility_review_required": True} for x in c.rows("SourceOfWealth")]}


@skill("edd.business.purpose.validate", context={"ExpectedActivity": ["declared", "evidence_ids"]}, optional={"Evidence": ["content"]}, returns={"assessments": A})
def purpose_validate(p, c, s):
    """Evaluate whether declared commercial purpose has supporting evidence."""
    cited = _cited(c)
    assessments = [{"id": x["id"], "declared": x["declared"], "evidence_present": cited(x["evidence_ids"]), "commercial_validity": "REQUIRES_REVIEW"}
                   for x in c.rows("ExpectedActivity")]
    # A declared purpose with no admitted evidence is an open evidence gap, not a reviewed purpose.
    return Computation(payload={"assessments": assessments}, status=Status.COMPLETED if all(x["evidence_present"] for x in assessments) else Status.NEEDS_EVIDENCE)


@skill("edd.counterparty.analyze", context={"Counterparty": ["entity_id", "risk_indicators", "evidence_ids"]}, optional={"Evidence": ["content"]},
       returns={"counterparties": A})
def counterparty_analyze(p, c, s):
    """Assemble evidence-backed counterparty risk indicators without inferring final guilt."""
    rows, cited = c.rows("Counterparty"), _cited(c)
    # A counterparty record without admitted evidence stays listed, but its (possibly empty)
    # indicator list is unsupported: never read as a clean counterparty.
    unsupported = [x["id"] for x in rows if not cited(x["evidence_ids"])]
    return Computation(payload={"counterparties": rows}, status=Status.NEEDS_EVIDENCE if unsupported else Status.COMPLETED, unresolved_items=[
        UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=k, explanation=f"counterparty record {k} cites no admitted evidence") for k in unsupported])


@skill("edd.geographic.exposure", context={"GeographyExposure": ["country", "basis", "value"]}, returns={"high_risk_exposures": A})
def geographic_exposure(p, c, s):
    """Identify sourced exposures in the configured EDD geography set."""
    # No edd_geographies in the policy is unresolved, never "no high-risk exposure"; an approved empty list must be explicit.
    geographies = set(_pinned(c, "edd_geographies"))
    return {"high_risk_exposures": [x for x in c.rows("GeographyExposure") if x["country"] in geographies]}


@skill("edd.pep.exposure", context={"PEPRelationship": ["source", "target", "relation", "verified"]}, returns={"relationships": A, "review_required": B})
def pep_exposure(p, c, s):
    """Assemble PEP relationship evidence with explicit review requirements."""
    rows = c.rows("PEPRelationship")
    return {"relationships": rows, "review_required": bool(rows)}


@skill("edd.findings.synthesize", context={"Finding": ["claim", "evidence_ids", "status"]}, optional={"Evidence": ["content"]},
       returns={"supported": A, "unsupported": A})
def edd_findings(p, c, s):
    """Separate sourced EDD finding records from unsupported claims for review."""
    rows, cited = c.rows("Finding"), _cited(c)
    supported = [x for x in rows if cited(x["evidence_ids"])]
    unsupported = [x for x in rows if not cited(x["evidence_ids"])]
    return Computation(payload={"supported": supported, "unsupported": unsupported}, status=Status.NEEDS_EVIDENCE if unsupported else Status.COMPLETED)


@skill("edd.recommendation.generate", context={"Finding": ["claim", "evidence_ids", "status"]}, optional={"Evidence": ["content"]},
       returns={"recommendation": S, "reason_ids": A, "final": B})
def edd_recommendation(p, c, s):
    """Recommend escalation or review from evidence gaps and unresolved EDD findings."""
    rows, cited = c.rows("Finding"), _cited(c)
    # A finding citing evidence that is not admitted is an evidence gap, just like one citing none.
    unresolved = [x["id"] for x in rows if not cited(x["evidence_ids"]) or x["status"] != "RESOLVED"]
    return {"recommendation": "ESCALATE" if unresolved else "REVIEW", "reason_ids": unresolved, "final": False}
