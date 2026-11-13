"""Field-level evaluation of an extraction route on a dataset version's sealed test split (plan §10).

Inputs are a dataset version, the dataset directory (gold labels and pages) and one prediction per
sample from a route: a catalog extraction result made from the same pages. The scorer:

* reads only the sealed test split and records exactly which samples it read;
* counts a missing or failed prediction as an abstention, never as a skip;
* runs ``validate_extraction`` on every prediction against the gold pages, and treats an invalid
  result as producing no values (the platform would commit no assertions from it);
* compares leaves with the manifest's comparators (``kyc_documents.comparators``), aligning rows of
  array fields by content rather than position;
* reports field precision and recall, key-field accuracy with Wilson 95% intervals, document-level
  "all key fields correct", abstention and integrity-failure rates, latency and cost, and accuracy
  by confidence band when a route records confidence.

A report from fewer test documents than the type's qualification need is labelled
``pipeline_proof``; it shows the harness works, not that the route is qualified.
"""
from __future__ import annotations

import math
from datetime import datetime
from typing import Literal

from pydantic import Field, JsonValue

from kyc_documents.comparators import compare, comparator_for_leaf
from kyc_documents.leaves import aligned_leaves
from kyc_documents.model import ClosedModel, fingerprint
from kyc_documents.profiles import PROFILES
from kyc_documents.runtime import validate_extraction

from . import FACTORY_API_VERSION
from .datasets import GoldLabel
from .sourcing import ManifestEntry

Route = Literal["llm", "azure_di", "adjudicated", "oracle", "other"]


class Prediction(ClosedModel):
    sample_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    route: Route
    status: Literal["completed", "failed", "abstained"]
    result: dict[str, JsonValue] | None = Field(default=None, description="the route's raw answer; validated when scored")
    error_code: str | None = None
    latency_ms: float | None = Field(default=None, ge=0)
    cost_usd: float | None = Field(default=None, ge=0)


class RunInfo(ClosedModel):
    route: Route
    run_id: str
    started_at: datetime
    model_profile: str | None = None
    model_profile_digest: str | None = None
    notes: str | None = None


def wilson(successes: int, total: int, z: float = 1.96) -> list[float] | None:
    if total == 0:
        return None
    p = successes / total
    denominator = 1 + z * z / total
    centre = (p + z * z / (2 * total)) / denominator
    half = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return [round(max(0.0, centre - half), 4), round(min(1.0, centre + half), 4)]


def compare_fields(document_type: str, gold: dict, predicted: dict | None, declared: dict[str, str]) -> list[dict]:
    """One outcome per leaf: correct, wrong, missed (gold only), unsupported (prediction only)."""
    outcomes = []
    for leaf in aligned_leaves(document_type, gold, predicted):
        field, path, g, p = leaf["field"], leaf["path"], leaf["left"], leaf["right"]
        comparator = comparator_for_leaf(leaf["member"], leaf["kind"], declared.get(field) if path == field else None)
        if g is not None and p is not None:
            verdict = compare(comparator, g, p)
            outcome = "correct" if verdict == "equivalent" else "wrong"
        else:
            outcome, verdict = ("missed", None) if g is not None else ("unsupported", None)
        outcomes.append({"field": field, "path": path, "comparator": comparator, "outcome": outcome,
                         "comparison": verdict, "key_field": field in PROFILES[document_type].key_fields})
    return outcomes


def _confidences(result: dict) -> dict[str, float]:
    return {o["path"].removeprefix("/extracted_fields/"): o["confidence"] for o in result.get("observations", [])
            if isinstance(o.get("confidence"), (int, float))}


def _percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, max(0, math.ceil(q * len(ordered)) - 1))], 3)


def evaluate(entry: ManifestEntry, dataset_version: dict, labels: dict[str, GoldLabel], predictions: list[Prediction],
             run: RunInfo, *, limit: int | None = None, source_pages: dict[str, list[dict]] | None = None) -> dict:
    """Score on the sealed test split, or on its first ``limit`` samples (a declared, recorded subset).

    ``source_pages`` replaces a sample's gold pages for citation checks when the route read different page
    text than the gold label's, for example OCR of a scanned rendering. Values are still compared with the
    gold label's values; spans are checked against the pages the route was given.
    """
    if dataset_version["document_type"] != entry.document_type:
        raise ValueError("the dataset version is for another document type")
    if dataset_version["contract_hash"] != entry.contract_hash:
        raise ValueError("the dataset version was built against another contract version")
    sealed = dataset_version["sealed_test"]
    if limit is not None and limit < 1:
        raise ValueError("limit must be positive")
    test_ids = sealed[:limit] if limit else sealed
    issue_counts: dict[str, int] = {}
    by_sample: dict[str, Prediction] = {}
    for prediction in predictions:
        if prediction.route != run.route:
            raise ValueError(f"prediction for {prediction.sample_id[:12]} is from route {prediction.route}, not {run.route}")
        if prediction.sample_id in by_sample:
            raise ValueError(f"two predictions for sample {prediction.sample_id[:12]}")
        by_sample[prediction.sample_id] = prediction
    declared = entry.measurement.comparators
    samples_out, all_outcomes = [], []
    doc_key_correct = abstained = integrity_failures = 0
    latencies, costs, banded = [], [], []
    for sample_id in test_ids:
        label = labels[sample_id]
        gold = label.result.model_dump(mode="json")["extracted_fields"]
        prediction = by_sample.get(sample_id)
        predicted_fields, status, issues, confidences = None, "abstained", [], {}
        if prediction and prediction.latency_ms is not None:
            latencies.append(prediction.latency_ms)
        if prediction and prediction.cost_usd is not None:
            costs.append(prediction.cost_usd)
        if prediction and prediction.status == "completed" and prediction.result is not None:
            pages = source_pages[sample_id] if source_pages and sample_id in source_pages else label.pages
            check = validate_extraction(entry.document_type, prediction.result, pages)
            issues = sorted({i["code"] for i in check["issues"]})
            for code in issues:
                issue_counts[code] = issue_counts.get(code, 0) + 1
            if check["valid"]:
                predicted_fields, status = prediction.result["extracted_fields"], check["status"]
                confidences = _confidences(prediction.result)
            else:
                status = "integrity_failure"
                integrity_failures += 1
        else:
            abstained += 1
        outcomes = compare_fields(entry.document_type, gold, predicted_fields, declared)
        key_outcomes = [o for o in outcomes if o["key_field"]]
        key_ok = bool(key_outcomes) and all(o["outcome"] == "correct" for o in key_outcomes)
        doc_key_correct += key_ok
        all_outcomes.extend(outcomes)
        for o in outcomes:  # top-level scalar fields only: row indices differ between gold and prediction
            if o["path"] == o["field"] and o["field"] in confidences and o["outcome"] in ("correct", "wrong", "unsupported"):
                banded.append((min(9, int(confidences[o["field"]] * 10)), o["outcome"] == "correct"))
        samples_out.append({"sample_id": sample_id, "status": status,
                            "error_code": prediction.error_code if prediction else "no_prediction",
                            "issues": issues, "all_key_fields_correct": key_ok,
                            "outcomes": {o["outcome"]: sum(1 for x in outcomes if x["outcome"] == o["outcome"]) for o in outcomes}})

    def tally(outcomes):
        counts = {k: sum(1 for o in outcomes if o["outcome"] == k) for k in ("correct", "wrong", "missed", "unsupported")}
        predicted = counts["correct"] + counts["wrong"] + counts["unsupported"]
        gold = counts["correct"] + counts["wrong"] + counts["missed"]
        return {**counts, "precision": round(counts["correct"] / predicted, 4) if predicted else None,
                "recall": round(counts["correct"] / gold, 4) if gold else None,
                "recall_interval": wilson(counts["correct"], gold)}

    per_field = {field: tally([o for o in all_outcomes if o["field"] == field])
                 for field in PROFILES[entry.document_type].field_names
                 if any(o["field"] == field for o in all_outcomes)}
    n = len(test_ids)
    calibration = {f"{band / 10:.1f}-{(band + 1) / 10:.1f}": {
        "observations": sum(1 for b, _ in banded if b == band), "correct": sum(1 for b, ok in banded if b == band and ok)}
        for band in sorted({b for b, _ in banded})}
    body = {
        "api_version": FACTORY_API_VERSION, "kind": "EvaluationReport", "document_type": entry.document_type,
        "contract_hash": entry.contract_hash, "dataset_digest": dataset_version["dataset_digest"],
        "run": run.model_dump(mode="json"),
        "claim_level": "qualification_candidate" if n >= entry.needs.test else "pipeline_proof",
        "source_pages": "supplied" if source_pages else "gold",
        "test_documents": n, "subset": {"first": n, "of_sealed_test": len(sealed)} if limit else None,
        "sealed_test_reads": sorted(test_ids), "documents_with_issue": dict(sorted(issue_counts.items())),
        "ignored_predictions": sorted(set(by_sample) - set(test_ids)),
        "documents": {
            "all_key_fields_correct": doc_key_correct, "rate": round(doc_key_correct / n, 4) if n else None,
            "interval": wilson(doc_key_correct, n), "abstained": abstained, "integrity_failures": integrity_failures,
            "abstention_rate": round(abstained / n, 4) if n else None},
        "fields": {"all": tally(all_outcomes), "key": tally([o for o in all_outcomes if o["key_field"]]), "per_field": per_field},
        "latency_ms": {"p50": _percentile(latencies, 0.5), "p95": _percentile(latencies, 0.95)},
        "cost_usd": {"total": round(sum(costs), 6) if costs else None, "per_document": round(sum(costs) / len(costs), 6) if costs else None},
        "confidence_bands": calibration or None,
        "samples": samples_out,
    }
    return {**body, "report_digest": fingerprint(body)}
