"""System 1 advisory questions over an adjudication (document factory plan §6.5), question set `document.advisory.v1`.

A System 1 decision model answers bounded multiple-choice questions where the deterministic rules cannot
decide. It never decides an outcome. This module builds the questions from an adjudication result and
applies the answers under four rules:

1. **Answers can only add review.** An answer can turn agreement into a conflict, require review or attach a
   hint. It never selects a value, clears a question, accepts a fact or lowers review depth.
2. **Abstention is not an answer.** An abstained batch, a `cannot_tell` answer or a missing answer is
   recorded with its status and changes nothing.
3. **Everything is pinned.** The binding, model, returned model, question-set version and the question's
   input digest are recorded on the outcome; a change to any of them makes the answer stale.
4. **Probabilities are not calibrated confidence.** They are recorded and never compared with a threshold.

| Question | Asked when | Possible effect |
| --- | --- | --- |
| `same_value` | the routes agree only after normalization (different raw text), or the comparator could not decide | `different` turns AGREED_GROUNDED into CONFLICT |
| `span_support` | a critical field's value came from one route (SINGLE_ROUTE) or was selected over another (SELECTED_GROUNDED) | `not_supported` attaches a hint; review is already required |
| `document_type` | two classifiers disagree | the answer is shown; the type stays UNKNOWN until a person confirms it |

Answers are advice for review. The adjudicator's own outcome and evidence stay as they were, beside the advice.
"""
from __future__ import annotations

from copy import deepcopy

from .fields import FIELDS
from .model import fingerprint
from .profiles import PROFILES

QUESTION_SET = "document.advisory.v1"
EXCERPT = 300  # characters of page text either side of a cited span

SAME_VALUE = {"type": "choice", "instructions": "The state holds two readings of the same field of one document, from two extraction routes. "
              "Do both readings state the same value for this field? Formatting, letter case and standard abbreviations alone do not make values different.",
              "criteria": {"same": "Both readings state the same value", "different": "The readings state different values",
                           "cannot_tell": "The state does not allow a decision"}}
SPAN_SUPPORT = {"type": "choice", "instructions": "The state holds a value extracted for a field of a document, and the page text around the place it was "
                "cited from. Does the cited text state this value for this field?",
                "criteria": {"supported": "The text states this value for this field", "not_supported": "The text does not state this value for this field",
                             "cannot_tell": "The text does not allow a decision"}}


def _excerpt(pages: list[dict], spans: list[dict]) -> str | None:
    if not spans:
        return None
    span = spans[0]
    page = next((p for p in pages if p.get("page_id") == span.get("page_id")), None)
    if page is None:
        return None
    text = page["text"]
    return text[max(0, span["start"] - EXCERPT):span["end"] + EXCERPT]


def _key(path: str, kind: str) -> str:
    return f"{kind}:{path}"


def advisory_requests(document_type: str, pages: list[dict], adjudication: dict, classification: dict | None = None) -> list[dict]:
    """The advisory questions for one adjudicated document version, one System 1 request each.

    Each item: `key` (stable within the document), `path`, `kind`, `input_digest` (the pinned inputs) and
    `request` (`{state, questions}` for `decision.system1.v1`). `classification` is
    `{"candidates": [type_a, type_b]}` when two classifiers disagree.
    """
    out = []
    profile = PROFILES[document_type]
    for outcome in adjudication["outcomes"]:
        field = FIELDS.get(outcome["field"])
        description = field.description if field else outcome["field"]
        candidates = {r: c for r, c in outcome["candidates"].items() if c.get("value") is not None}
        if len(candidates) == 2 and (outcome["comparison"] == "ambiguous" or (
                outcome["outcome"] == "AGREED_GROUNDED" and len({c["value"] for c in candidates.values()}) > 1)):
            state = {"document_type": profile.display_name, "field": outcome["path"], "field_description": description,
                     "readings": {r: c["value"] for r, c in sorted(candidates.items())}}
            out.append({"key": _key(outcome["path"], "same_value"), "path": outcome["path"], "kind": "same_value",
                        "request": {"state": state, "questions": {"same_value": SAME_VALUE}}})
        if outcome["criticality"] == "critical" and outcome["outcome"] in ("SINGLE_ROUTE", "SELECTED_GROUNDED") and outcome["selected"]:
            excerpt = _excerpt(pages, outcome["selected"].get("spans") or [])
            if excerpt is None:
                continue
            state = {"document_type": profile.display_name, "field": outcome["path"], "field_description": description,
                     "value": outcome["selected"]["value"], "cited_text": excerpt}
            out.append({"key": _key(outcome["path"], "span_support"), "path": outcome["path"], "kind": "span_support",
                        "request": {"state": state, "questions": {"span_support": SPAN_SUPPORT}}})
    if classification and len(classification.get("candidates", [])) == 2:
        options = {t: PROFILES[t].display_name for t in classification["candidates"]}
        question = {"type": "choice", "instructions": "Which catalog document type is this document?",
                    "criteria": {**options, "other": "Neither of these types", "cannot_tell": "The text does not allow a decision"}}
        text = "\n".join(p["text"] for p in pages)[:4000]
        out.append({"key": _key("document_type", "document_type"), "path": "document_type", "kind": "document_type",
                    "request": {"state": {"text": text}, "questions": {"document_type": question}}})
    for item in out:
        item["input_digest"] = fingerprint({"question_set": QUESTION_SET, "request": item["request"], "inputs": adjudication["inputs_digest"]})
    return out


def _answer(result: dict | None, kind: str) -> tuple[str, dict | None, str | None]:
    """(status, answer, abstention reason) for one question from a canonical decision.system1.v1 result."""
    if result is None:
        return "not_asked", None, None
    if result.get("status") != "answered":
        return "abstained", None, (result.get("abstention") or {}).get("reason") or "invalid_response"
    entry = (result.get("answers") or {}).get(kind)
    if not entry:
        return "abstained", None, "missing_or_unknown_questions"
    if entry.get("status") != "answered":
        return "abstained", None, entry.get("reason")
    return "answered", entry["answer"], None


def apply_advisory(adjudication: dict, requests: list[dict], results: dict[str, dict | None], binding: dict) -> dict:
    """The adjudication with System 1 advice recorded on its outcomes. Answers can only add review.

    `results` maps each request's `key` to its canonical `decision.system1.v1` result (None when it was not
    asked); `binding` pins `{id, model, returned_model}`. The adjudicator's outcome, rule and selection are
    kept as `deterministic` beside any escalation, so the advice can be audited and withdrawn.
    """
    out = deepcopy(adjudication)
    by_path = {o["path"]: o for o in out["outcomes"]}
    pinned = {"question_set": QUESTION_SET, "binding": binding["id"], "model": binding["model"], "returned_model": binding.get("returned_model")}
    advice = []
    for request in requests:
        status, answer, reason = _answer(results.get(request["key"]), request["kind"])
        record = {**pinned, "key": request["key"], "kind": request["kind"], "input_digest": request["input_digest"], "status": status,
                  "reason": reason, "choice": answer["value"] if answer else None,
                  "probabilities": answer.get("probabilities") if answer else None, "effect": "none"}
        outcome = by_path.get(request["path"])
        if status == "answered" and request["kind"] == "document_type":
            record["effect"] = "shown_to_reviewer"
        elif status == "answered" and outcome is not None:
            if request["kind"] == "same_value" and answer["value"] == "different" and outcome["outcome"] == "AGREED_GROUNDED":
                outcome["deterministic"] = {k: outcome[k] for k in ("outcome", "rule", "review", "selected")}
                outcome.update(outcome="CONFLICT", rule="R6+S1", review="required", selected=None)
                record["effect"] = "escalated_to_conflict"
            elif request["kind"] == "span_support" and answer["value"] == "not_supported":
                outcome["review"] = "required"
                record["effect"] = "review_hint"
        if outcome is not None:
            outcome.setdefault("advisory", []).append(record)
        advice.append(record)
    counts: dict[str, int] = {}
    for o in out["outcomes"]:
        counts[o["outcome"]] = counts.get(o["outcome"], 0) + 1
    out["counts"] = dict(sorted(counts.items()))
    out["review_required"] = adjudication["review_required"] or any(o["review"] == "required" for o in out["outcomes"])
    out["advisory"] = {**pinned, "asked": len(requests), "answered": sum(a["status"] == "answered" for a in advice),
                       "abstained": sum(a["status"] == "abstained" for a in advice),
                       "escalated": sum(a["effect"] == "escalated_to_conflict" for a in advice),
                       "digest": fingerprint(advice)}
    _never_lowers(adjudication, out)
    return out


RANK = {"light": 0, "standard": 1, "required": 2}


def _never_lowers(before: dict, after: dict) -> None:
    """Rule 1, checked: no outcome loses review depth, and no selection appears where there was none."""
    old = {o["path"]: o for o in before["outcomes"]}
    for o in after["outcomes"]:
        prior = old[o["path"]]
        if RANK[o["review"]] < RANK[prior["review"]] or (o["selected"] and not prior["selected"]):
            raise AssertionError(f"advisory lowered review or selected a value for {o['path']}")
    if before["review_required"] and not after["review_required"]:
        raise AssertionError("advisory cleared review")
