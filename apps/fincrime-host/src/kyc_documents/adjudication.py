"""Deterministic field adjudication between extraction routes (document factory plan §6).

Two or more routes (for example Azure Document Intelligence and the LLM contract extraction) read the
same document version. Each route's answer is first checked with `validate_extraction` against the
same pages: an answer that fails is unusable as a whole, exactly as it would be on its own. The usable
answers are then compared leaf by leaf with the catalog comparators, and each leaf gets one outcome:

| Rule | Situation | Outcome |
| --- | --- | --- |
| R1 | values equivalent, every candidate grounded | AGREED_GROUNDED |
| R2 | values differ, exactly one grounded (or agree with only one grounded) | SELECTED_GROUNDED |
| R3 | one route has a grounded value, every other usable route states it absent | SINGLE_ROUTE |
| R4 | one route has a grounded value and no other route produced a usable answer | SINGLE_ROUTE |
| R5 | a value with no grounded candidate | UNGROUNDED |
| R6 | values differ and both grounded, or the comparator cannot decide | CONFLICT |
| R7 | the selected value fails a policy validator on a material or critical field | VALIDATION_FAILED |
| R8 | no route has a value | NOT_PRESENT |
| R9 | a vision reading differs from the text routes' value | OCR_DISAGREEMENT |

"Grounded" means the candidate's value appears literally in one of its own cited quotes on the pages
(the library has already checked every quote against the page text). A value that is not literal
(normalized, inferred) is never grounded here.

Nothing here establishes truth or accepts a fact. Agreement between routes that read the same wrong
OCR is still wrong. The outcome decides what a reviewer sees and the minimum review depth: `required`
for every outcome except agreement, `standard` for agreement, and `light` only when an explicitly
qualified policy allows it. Adjudication runs no model and calls no network.
"""
from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import Field, model_validator

from .comparators import compare, comparator_for_leaf
from .fields import FIELDS
from .leaves import aligned_leaves
from .model import ClosedModel, fingerprint
from .profiles import PROFILES
from .runtime import contract, source_digest, validate_extraction

Criticality = Literal["informational", "material", "critical"]
Outcome = Literal["AGREED_GROUNDED", "SELECTED_GROUNDED", "SINGLE_ROUTE", "UNGROUNDED", "CONFLICT",
                  "VALIDATION_FAILED", "NOT_PRESENT", "OCR_DISAGREEMENT"]
RANK = {"informational": 0, "material": 1, "critical": 2}
VALIDATORS = ("date_not_future", "after_issue_date", "after_date_of_birth")


class LightReview(ClosedModel):
    """Lighter review for agreed, grounded values, admitted only with evidence that it is safe."""
    qualification_ref: str = Field(min_length=1)
    max_criticality: Criticality = "informational"


class AdjudicationPolicy(ClosedModel):
    policy_id: str = Field(min_length=1)
    version: str = Field(min_length=1)
    default_criticality: Criticality = "informational"
    criticality: dict[str, Criticality] = {}
    validators: dict[str, tuple[str, ...]] = {}
    light_review: LightReview | None = None

    @model_validator(mode="after")
    def _known(self):
        unknown = (set(self.criticality) | set(self.validators)) - set(FIELDS)
        if unknown:
            raise ValueError(f"policy names unknown fields: {sorted(unknown)}")
        bad = {v for vs in self.validators.values() for v in vs} - set(VALIDATORS)
        if bad:
            raise ValueError(f"unknown validators: {sorted(bad)}")
        return self

    @property
    def digest(self) -> str:
        return fingerprint(self.model_dump(mode="json"))

    def criticality_of(self, field: str) -> Criticality:
        return self.criticality.get(field, self.default_criticality)

    def tightened(self, overlay: "AdjudicationPolicy") -> "AdjudicationPolicy":
        """A tenant overlay applied to this policy. It may raise criticality, add validators or remove light
        review; anything that would loosen review is refused."""
        for field, level in overlay.criticality.items():
            if RANK[level] < RANK[self.criticality_of(field)]:
                raise ValueError(f"overlay lowers the criticality of {field}")
        if RANK[overlay.default_criticality] < RANK[self.default_criticality]:
            raise ValueError("overlay lowers the default criticality")
        if overlay.light_review and (not self.light_review or RANK[overlay.light_review.max_criticality] > RANK[self.light_review.max_criticality]):
            raise ValueError("overlay widens light review")
        validators = {f: tuple(dict.fromkeys(self.validators.get(f, ()) + overlay.validators.get(f, ())))
                      for f in set(self.validators) | set(overlay.validators)}
        return AdjudicationPolicy(policy_id=f"{self.policy_id}+{overlay.policy_id}", version=f"{self.version}+{overlay.version}",
                                  default_criticality=overlay.default_criticality,
                                  criticality={**self.criticality, **overlay.criticality}, validators=validators,
                                  light_review=overlay.light_review)


_CRITICAL = ("person_name", "given_names", "family_name", "date_of_birth", "identity_number", "document_number", "entity_name",
             "registration_number", "tax_identifier", "us_tax_identifier", "foreign_tax_identifier", "subject_name",
             "ownership_interests", "beneficial_owners_stated", "accounts", "control_rights")
_MATERIAL = ("issue_date", "expiry_date", "issuing_jurisdiction", "nationalities", "formation_date", "formation_jurisdiction",
             "registration_authority", "entity_legal_form", "subject_address", "registered_address", "tax_form_type",
             "chapter3_status", "chapter4_status", "signatures", "record_as_of_date", "period_start", "period_end",
             "total_amount", "currency", "parties", "share_classes")
DEFAULT_POLICY = AdjudicationPolicy(
    policy_id="ehf.default-adjudication", version="0.1.0",
    criticality={**{f: "critical" for f in _CRITICAL if f in FIELDS}, **{f: "material" for f in _MATERIAL if f in FIELDS}},
    validators={f: v for f, v in {"date_of_birth": ("date_not_future",), "formation_date": ("date_not_future",),
                                  "issue_date": ("date_not_future", "after_date_of_birth"), "expiry_date": ("after_issue_date",)}.items() if f in FIELDS})


def _grounded(value, observation: dict | None) -> bool:
    if observation is None or observation.get("status") != "present" or not isinstance(value, str):
        return False
    return any(value in span.get("quote", "") for span in observation.get("spans") or [])


def _validate(rule: str, value, fields: dict, as_of: date) -> bool:
    """True when the value passes. Partial dates compare at their stated precision; non-dates pass."""
    def parsed(v):
        if not isinstance(v, str):
            return None
        try:
            return date.fromisoformat(v + {4: "-01-01", 7: "-01", 10: ""}[len(v)])
        except (KeyError, ValueError):
            return None
    d = parsed(value)
    if d is None:
        return True
    if rule == "date_not_future":
        return d <= as_of
    other = parsed(fields.get("issue_date" if rule == "after_issue_date" else "date_of_birth"))
    return other is None or d > other


def adjudicate(document_type: str, pages: list[dict], answers: dict[str, dict | None], *,
               policy: AdjudicationPolicy = DEFAULT_POLICY, vision_routes: tuple[str, ...] = (),
               as_of: date | None = None) -> dict:
    """Field outcomes for the routes' answers on one document version.

    `answers` maps a route name to its raw answer (a catalog extraction result), or None when the route did
    not run or failed. `vision_routes` names routes that read page images rather than the page text; their
    disagreement with the text routes is reported as OCR_DISAGREEMENT rather than resolved.
    """
    if not answers:
        raise ValueError("adjudication needs at least one route")
    as_of = as_of or date.today()
    routes: dict[str, dict] = {}
    for route, answer in sorted(answers.items()):
        if answer is None:
            routes[route] = {"status": "not_run", "issues": []}
            continue
        check = validate_extraction(document_type, answer, pages)
        routes[route] = {"status": "valid" if check["valid"] else "integrity_failure",
                         "issues": sorted({i["code"] for i in check["issues"]}),
                         "fields": answer["extracted_fields"] if check["valid"] else None,
                         "observations": {o["path"]: o for o in answer.get("observations", [])} if check["valid"] else {}}
    usable = [r for r, s in routes.items() if s["status"] == "valid"]
    text_routes = [r for r in usable if r not in vision_routes]
    # Pair every usable route against the first usable text route (or the first usable route), leaf by leaf.
    anchor = (text_routes or usable or [None])[0]
    leaves: dict[str, dict] = {}
    for route in usable:
        pairs = aligned_leaves(document_type, routes[anchor]["fields"], routes[route]["fields"])
        for leaf in pairs:
            entry = leaves.setdefault(leaf["path"], {"field": leaf["field"], "member": leaf["member"], "kind": leaf["kind"], "candidates": {}})
            pointer, value = (leaf["right_pointer"], leaf["right"])
            if route == anchor:
                pointer, value = leaf["left_pointer"], leaf["left"]
            observation = routes[route]["observations"].get(pointer) if pointer else None
            entry["candidates"][route] = {"value": value, "pointer": pointer,
                                          "status": observation.get("status") if observation else ("not_present" if value is None else "unknown"),
                                          "grounded": value is not None and _grounded(value, observation),
                                          "spans": observation.get("spans", []) if observation else [],
                                          "confidence": observation.get("confidence") if observation else None}
    outcomes = []
    for path, entry in sorted(leaves.items()):
        field, criticality = entry["field"], policy.criticality_of(entry["field"])
        comparator = comparator_for_leaf(entry["member"], entry["kind"])
        candidates = entry["candidates"]
        text = {r: c for r, c in candidates.items() if r in text_routes and c["value"] is not None}
        vision = {r: c for r, c in candidates.items() if r in vision_routes and c["value"] is not None}
        grounded = {r: c for r, c in text.items() if c["grounded"]}
        selected, rule, outcome, comparison = None, "R8", "NOT_PRESENT", None
        values = list(text.values())
        if values:
            verdicts = {compare(comparator, values[0]["value"], c["value"]) for c in values[1:]}
            comparison = "ambiguous" if "ambiguous" in verdicts else "different" if "different" in verdicts else "equivalent"
            if comparison == "equivalent" and len(values) > 1 and len(grounded) == len(values):
                rule, outcome, selected = "R1", "AGREED_GROUNDED", next(iter(grounded))
            elif comparison == "ambiguous" or (comparison == "different" and len(grounded) > 1):
                rule, outcome = "R6", "CONFLICT"
            elif len(grounded) == 1 and len(values) > 1:
                rule, outcome, selected = "R2", "SELECTED_GROUNDED", next(iter(grounded))
            elif len(grounded) == 1:
                rule = "R3" if len(text_routes) > 1 else "R4"
                outcome, selected = "SINGLE_ROUTE", next(iter(grounded))
            else:
                rule, outcome = "R5", "UNGROUNDED"
        if vision and values and any(compare(comparator, values[0]["value"], c["value"]) != "equivalent" for c in vision.values()):
            rule, outcome, selected = "R9", "OCR_DISAGREEMENT", None
        selected_value = candidates[selected]["value"] if selected else None
        if selected and RANK[criticality] >= RANK["material"] and path == field:
            merged = {**(routes[selected]["fields"] or {})}
            if any(not _validate(v, selected_value, merged, as_of) for v in policy.validators.get(field, ())):
                rule, outcome = "R7", "VALIDATION_FAILED"
        if outcome == "AGREED_GROUNDED":
            light = policy.light_review and RANK[criticality] <= RANK[policy.light_review.max_criticality]
            review = "light" if light else "standard"
        elif outcome == "NOT_PRESENT":
            review = "standard" if field not in PROFILES[document_type].key_fields else "required"
        else:
            review = "required"
        outcomes.append({"path": path, "field": field, "criticality": criticality, "key_field": field in PROFILES[document_type].key_fields,
                         "outcome": outcome, "rule": rule, "comparator": comparator, "comparison": comparison, "review": review,
                         "selected": {"route": selected, "value": selected_value, "spans": candidates[selected]["spans"]} if selected and outcome not in ("VALIDATION_FAILED",) else None,
                         "candidates": {r: candidates[r] for r in sorted(candidates)}})
    seen = {o["field"] for o in outcomes}
    for field in PROFILES[document_type].key_fields:
        if field not in seen:  # no usable route found a value for a key field
            outcomes.append({"path": field, "field": field, "criticality": policy.criticality_of(field), "key_field": True,
                             "outcome": "NOT_PRESENT", "rule": "R8", "comparator": None, "comparison": None, "review": "required",
                             "selected": None, "candidates": {r: {"value": None, "status": "not_present"} for r in usable}})
    page_digest = source_digest(pages)
    inputs = {"contract_hash": contract(document_type)["contract_hash"], "source_digest": page_digest,
              "answers": {r: fingerprint(a) if a is not None else None for r, a in sorted(answers.items())},
              "policy_digest": policy.digest, "vision_routes": sorted(vision_routes), "as_of": as_of.isoformat()}
    counts: dict[str, int] = {}
    for o in outcomes:
        counts[o["outcome"]] = counts.get(o["outcome"], 0) + 1
    return {"document_type": document_type, "routes": {r: {"status": s["status"], "issues": s["issues"]} for r, s in routes.items()},
            "policy": {"id": policy.policy_id, "version": policy.version, "digest": policy.digest},
            "inputs": inputs, "inputs_digest": fingerprint(inputs), "outcomes": outcomes, "counts": dict(sorted(counts.items())),
            "review_required": not usable or any(o["review"] == "required" for o in outcomes),
            "promotion_allowed": False, "epistemic_status": "EXTRACTED_ASSERTION"}


def is_current(result: dict, document_type: str, pages: list[dict], answers: dict[str, dict | None],
               policy: AdjudicationPolicy = DEFAULT_POLICY) -> bool:
    """False when any pinned input (contract, pages, answers, policy) changed since the result was made."""
    inputs = result["inputs"]
    return (inputs["contract_hash"] == contract(document_type)["contract_hash"] and inputs["source_digest"] == source_digest(pages)
            and inputs["answers"] == {r: fingerprint(a) if a is not None else None for r, a in sorted(answers.items())}
            and inputs["policy_digest"] == policy.digest)
