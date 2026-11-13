"""Fraud signals and specialist-provider contracts; synthetic responses are labeled."""
import hashlib
import hmac
from collections import defaultdict
from statistics import mean

from ..contracts import Computation, SkillError, Status, UnresolvedItem, canonical
from ..primitives import dec, number
from ..registry import A, B, O, S, skill

SPECIALISTS = {
    "fraud.identity.synthetic.detect": ("Identity", ["attributes"], "fraud.synthetic_identity"),
    "fraud.identity.theft.assess": ("Identity", ["attributes"], "fraud.identity_theft"),
    "fraud.document.tamper.detect": ("DocumentPage", ["text", "document_version"], "fraud.document_tamper"),
    "fraud.deepfake.detect": ("Session", ["artifact_hash", "modality"], "fraud.deepfake"),
    "fraud.liveness.verify": ("Session", ["artifact_hash", "challenge_id"], "fraud.liveness"),
    "fraud.account_takeover.detect": ("AuthenticationEvent", ["signals", "session_id"], "fraud.account_takeover"),
}


def _pinned(c, key):
    """A policy key the skill cannot run without: absent is unresolved, never an empty default."""
    if key not in c.policy or c.policy[key] is None:
        raise SkillError("POLICY_UNRESOLVED", f"policy states no {key}", Status.BLOCKED)
    return c.policy[key]


def _cited(c):
    """Whether cited evidence holds up: something is cited, and when Evidence is admitted, only
    admitted Evidence (a citation outside the admitted context supports nothing)."""
    admitted = {x["id"] for x in c.rows("Evidence")}
    return lambda ids: bool(ids) and (not admitted or set(ids) <= admitted)


async def attested(p, c, s):
    """Relay an admitted request-bound specialist assessment citing every record sent; INCONCLUSIVE or absent is never clean."""
    # The KYC/KYB document check runs as an observed hydration check, so its NEEDS_EVIDENCE is shown to
    # the document agent without blocking the process.
    object_type, fields, capability = SPECIALISTS[s.invocation.skill_id]
    rows = c.rows(object_type)
    request = {"records": [{"id": x["id"], **{k: x[k] for k in fields}} for x in rows]}
    response = await s.provider(capability, request)
    payload = response.payload
    required = {"score", "model_version", "limitations", "assessment"}
    if not required <= payload.keys() or not 0 <= dec(payload["score"]) <= 1 or not isinstance(payload["limitations"], list):
        raise SkillError("INTEGRITY_FAILURE", "detector output missing calibration/limitation metadata")
    # The provider attests only to the record versions it cites: its answer (a liveness or deepfake
    # pass included) says nothing about a record it was sent but does not cite.
    cited = {(r.object_type, r.object_id, r.version_id) for r in response.evidence_refs}
    uncited = [x["id"] for x in rows if (object_type, x["id"], x["_ref"]["version_id"]) not in cited]
    if uncited:
        raise SkillError("EVIDENCE_INSUFFICIENT", f"{capability} assessment does not cite {', '.join(uncited)}", Status.NEEDS_EVIDENCE)
    result = {"assessment": payload, "provider_id": response.provider_id, "synthetic": response.synthetic, "final_decision": False}
    if str(payload["assessment"]).upper() != "INCONCLUSIVE":
        return result
    # An inconclusive detector (every sandbox simulator answers so) settled nothing: never "no fraud".
    return Computation(payload=result, status=Status.NEEDS_EVIDENCE, unresolved_items=[
        UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"{capability} answered INCONCLUSIVE for {x['id']}") for x in rows])


for _id, (_type, _fields, _cap) in SPECIALISTS.items():
    skill(_id, context={_type: _fields}, returns={"assessment": O, "provider_id": S, "synthetic": B, "final_decision": B}, mode="provider", capabilities=(_cap,),
          limitations=("specialist accuracy requires independent real-data evaluation",))(attested)


@skill("fraud.device.fingerprint", context={"Device": ["attributes", "permitted"]}, returns={"fingerprints": A})
def fingerprint(p, c, s):
    """Build purpose-permitted synthetic tenant-keyed device fingerprints from allowed features."""
    key = c.policy.get("synthetic_fingerprint_key")
    if not c.manifest.synthetic or not key:
        raise SkillError("POLICY_UNRESOLVED", "production fingerprinting requires a qualified keyed provider")
    fields = _pinned(c, "device_fields")
    if not fields:
        # Keyed on no feature, every device would share one fingerprint.
        raise SkillError("POLICY_UNRESOLVED", "device_fields names no feature to fingerprint", Status.BLOCKED)
    results, gaps = [], []
    for x in c.rows("Device"):
        if not x["permitted"]:
            raise SkillError("ACCESS_DENIED", "device processing not permitted")
        missing = [k for k in fields if x["attributes"].get(k) is None]
        if missing:
            # A fingerprint over fewer features would collide with unrelated devices: none is made.
            gaps.append(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"device {x['id']} lacks {', '.join(missing)}"))
            continue
        selected = {k: x["attributes"][k] for k in fields}
        value = hmac.new(key.encode(), canonical([s.invocation.tenant_id, selected]).encode(), hashlib.sha256).hexdigest()
        results.append({"device_id": x["id"], "fingerprint": value, "synthetic": True})
    if not gaps:
        return {"fingerprints": results}
    return Computation(payload={"fingerprints": results}, status=Status.NEEDS_EVIDENCE, unresolved_items=gaps)


@skill("fraud.behavior.anomaly", context={"Session": ["features", "baseline"]}, returns={"anomalies": A})
def behavior(p, c, s):
    """Compare sourced session features to explicit baseline intervals and retain unknown features."""
    anomalies, gaps = [], []
    for x in c.rows("Session"):
        features, baseline = x["features"], x["baseline"]
        if not features:
            gaps.append(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"session {x['id']} has no observed feature"))
        for name in sorted(features):
            value, bounds = features[name], baseline.get(name)
            if bounds is None:
                gaps.append(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"no baseline for {name}"))
            elif dec(bounds["minimum"]) > dec(bounds["maximum"]):
                gaps.append(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"baseline for {name} has its minimum above its maximum"))
                bounds = None
            if bounds is None:
                anomalies.append({"session_id": x["id"], "feature": name, "status": "UNKNOWN_BASELINE"})
            elif dec(value) < dec(bounds["minimum"]) or dec(value) > dec(bounds["maximum"]):
                anomalies.append({"session_id": x["id"], "feature": name, "value": value, "bounds": bounds})
        for name in sorted(set(baseline) - set(features)):
            gaps.append(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"baseline feature {name} was not observed"))
    if not gaps:
        return {"anomalies": anomalies}
    return Computation(payload={"anomalies": anomalies}, status=Status.NEEDS_EVIDENCE, unresolved_items=gaps)


@skill("fraud.payment.anomaly", context={"Payment": ["amount", "currency", "baseline_maximum"]}, returns={"anomalies": A})
def payment(p, c, s):
    """Detect payment amounts exceeding explicitly sourced same-currency baselines."""
    anomalies, unclear = [], []
    for x in c.rows("Payment"):
        if dec(x["amount"]) < 0 or dec(x["baseline_maximum"]) < 0:
            # A negative amount never exceeds a ceiling, so it is not compared: a person decides.
            unclear.append(UnresolvedItem(code="HUMAN_REVIEW_REQUIRED", subject_ref=x["id"],
                                          explanation=f"payment {x['id']} has a negative amount or baseline and was not compared"))
        elif dec(x["amount"]) > dec(x["baseline_maximum"]):
            anomalies.append({"payment_id": x["id"], "amount": x["amount"], "currency": x["currency"]})
    if not unclear:
        return {"anomalies": anomalies}
    return Computation(payload={"anomalies": anomalies}, status=Status.NEEDS_REVIEW, unresolved_items=unclear)


@skill("fraud.beneficiary.risk", context={"Counterparty": ["entity_id", "risk_indicators", "evidence_ids"]}, optional={"Evidence": ["content"]},
       returns={"assessments": A})
def beneficiary(p, c, s):
    """Assess captured beneficiary indicators and evidence gaps without final disposition."""
    rows, cited = c.rows("Counterparty"), _cited(c)
    indicator_sets = defaultdict(set)
    for x in rows:
        indicator_sets[x["entity_id"]].add(tuple(sorted(x["risk_indicators"])))
    # Records that disagree on a beneficiary's indicators are not collapsed into the cleaner one.
    conflicted = sorted(k for k, v in indicator_sets.items() if len(v) > 1)
    assessments, items = [], []
    for x in rows:
        sufficient = cited(x["evidence_ids"])
        assessments.append({"entity_id": x["entity_id"], "indicators": x["risk_indicators"], "evidence_sufficient": sufficient,
                            "review_required": bool(x["risk_indicators"]) or not sufficient or x["entity_id"] in conflicted})
        if not sufficient:
            items.append(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"counterparty {x['id']} cites no admitted evidence"))
    items += [UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=k, explanation=f"counterparty records for {k} disagree on risk indicators") for k in conflicted]
    if not items:
        return {"assessments": assessments}
    return Computation(payload={"assessments": assessments}, status=Status.NEEDS_REVIEW if conflicted else Status.NEEDS_EVIDENCE, unresolved_items=items)


@skill("fraud.network.detect", context={"Entity": ["attributes"]}, returns={"candidate_groups": A, "collusion_proven": B})
def fraud_network(p, c, s):
    """Identify governed shared-attribute candidate groups without proving collusion."""
    from .network import shared_groups
    attributes = _pinned(c, "link_attributes")
    if not attributes:
        raise SkillError("POLICY_UNRESOLVED", "link_attributes names no attribute to compare", Status.BLOCKED)
    payload = {"candidate_groups": shared_groups(c.rows("Entity"), attributes), "collusion_proven": False}
    # No group among entities that carry none of the governed attributes is not "no network".
    compared, gaps = 0, []
    for x in c.rows("Entity"):
        if any(x["attributes"].get(k) is not None for k in attributes):
            compared += 1
        else:
            gaps.append(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"entity {x['id']} has none of {', '.join(attributes)}"))
    if compared < 2:
        gaps.append(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", explanation="fewer than two entities carry a link attribute; nothing was compared"))
    if not gaps:
        return payload
    return Computation(payload=payload, status=Status.NEEDS_EVIDENCE, unresolved_items=gaps)


@skill("fraud.case.assess", context={"FraudSignal": ["score", "kind", "model_version", "evidence_ids"]}, optional={"Evidence": ["content"]},
       returns={"signals": A, "recommendation": S, "final": B})
def fraud_case(p, c, s):
    """Assess fraud signals against pinned thresholds with unknown evidence retained."""
    thresholds = _pinned(c, "fraud_thresholds")
    rows, cited, items, elevated = c.rows("FraudSignal"), _cited(c), [], False
    for x in rows:
        threshold = thresholds.get(x["kind"])
        if threshold is None:
            items.append(UnresolvedItem(code="POLICY_UNRESOLVED", subject_ref=x["id"], explanation=f"no pinned threshold for {x['kind']} signals"))
        elif dec(x["score"]) >= dec(threshold):
            elevated = True
        if not cited(x["evidence_ids"]):
            items.append(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"signal {x['id']} cites no admitted evidence"))
    # An elevated signal is never softened to REVIEW by another signal's gap.
    recommendation = "STEP_UP_OR_ESCALATE" if elevated else "REVIEW" if items else "REVIEW_FOR_CLEARANCE"
    payload = {"signals": rows, "recommendation": recommendation, "final": False}
    if not items:
        return payload
    return Computation(payload=payload, status=Status.NEEDS_REVIEW, unresolved_items=items)
