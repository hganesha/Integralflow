import json
from datetime import datetime, timezone

import pytest

from document_factory.cli import main
from document_factory.datasets import build_dataset_version, split_policy_for
from document_factory.evaluation import Prediction, RunInfo, evaluate, wilson
from document_factory.sourcing import build_entry
from document_factory.synthetic import generate
from kyc_documents.comparators import compare

RUN = RunInfo(route="oracle", run_id="test-run", started_at=datetime(2026, 11, 12, tzinfo=timezone.utc))


def dataset(document_type, count=60):
    samples, labels = [], {}
    for seed in range(count):
        _, sample, label = generate(document_type, seed)
        samples.append(sample)
        labels[sample.sample_id] = label
    entry = build_entry(document_type)
    return entry, build_dataset_version(entry, samples, labels, policy=split_policy_for(entry, "salt-0001")), labels


def oracle(labels, ids, **changes):
    return [Prediction(sample_id=i, route="oracle", status="completed", result=labels[i].result.model_dump(mode="json"), latency_ms=100.0 + n,
                       cost_usd=0.001) for n, i in enumerate(ids)]


def with_result(prediction, mutate):
    payload = json.loads(json.dumps(prediction.result))
    mutate(payload)
    return prediction.model_copy(update={"result": payload})


@pytest.mark.parametrize(("comparator", "left", "right", "outcome"), [
    ("legal_name_equivalent", "ACME HOLDINGS LIMITED", "Acme Holdings Ltd", "equivalent"),
    ("legal_name_equivalent", "Acme Holdings Ltd", "Acme Group Ltd", "different"),
    ("identifier_exact", "SY 123456", "sy123456", "equivalent"),
    ("identifier_exact", "SY123456", "SY123457", "different"),
    ("person_name_equivalent", "Alex Example", "Example Alex", "ambiguous"),
    ("name_equivalent", "Northmock Limited", "Northmock Ltd", "equivalent"),
    ("date_strict", "2021-03", "2021-03-12", "ambiguous"),
    ("date_strict", "2021-03-12", "2021-12-03", "different"),
    ("amount_currency", "1,234.50", "1234.5", "equivalent"),
    ("form_designation", "Form W-8BEN-E", "W-8BEN-E", "equivalent"),
    ("form_designation", "Form W-9", "W-8BEN", "different"),
])
def test_comparators(comparator, left, right, outcome):
    assert compare(comparator, left, right) == outcome


def test_wilson_interval():
    assert wilson(9, 10) == [0.5958, 0.9821] and wilson(0, 0) is None


def test_an_oracle_route_scores_perfectly_on_the_sealed_test_split_only():
    entry, version, labels = dataset("certificate_of_incorporation")
    report = evaluate(entry, version, labels, oracle(labels, list(labels)), RUN)
    assert report["sealed_test_reads"] == version["sealed_test"] and report["test_documents"] == len(version["sealed_test"])
    assert set(report["ignored_predictions"]) == set(labels) - set(version["sealed_test"])
    assert report["fields"]["all"]["precision"] == report["fields"]["all"]["recall"] == 1.0
    assert report["documents"]["rate"] == 1.0 and report["documents"]["abstained"] == 0
    assert report["latency_ms"]["p50"] is not None and report["cost_usd"]["total"] > 0
    assert report == evaluate(entry, version, labels, oracle(labels, list(labels)), RUN)


def test_wrong_values_missing_predictions_and_integrity_failures_are_counted():
    entry, version, labels = dataset("certificate_of_incorporation")
    test = version["sealed_test"]
    predictions = oracle(labels, test)
    predictions[0] = with_result(predictions[0], lambda r: r["extracted_fields"].update(entity_name="Wrong Name Ltd"))
    del predictions[1]
    def tamper(r):
        observation = next(o for o in r["observations"] if o["status"] == "present")
        observation["spans"][0]["quote"] = "TAMPERED"
    predictions[1] = with_result(predictions[1], tamper)  # now the third test sample
    report = evaluate(entry, version, labels, predictions, RUN)
    by_id = {s["sample_id"]: s for s in report["samples"]}
    assert by_id[test[0]]["outcomes"].get("wrong") == 1 and not by_id[test[0]]["all_key_fields_correct"]
    assert by_id[test[1]]["status"] == "abstained" and by_id[test[1]]["error_code"] == "no_prediction"
    assert by_id[test[2]]["status"] == "integrity_failure" and "SOURCE_SPAN_MISMATCH" in by_id[test[2]]["issues"]
    assert report["documents"]["abstained"] == 1 and report["documents"]["integrity_failures"] == 1
    assert report["documents"]["all_key_fields_correct"] == len(test) - 3
    assert report["fields"]["per_field"]["entity_name"]["wrong"] == 1


def test_a_declared_subset_is_scored_and_recorded():
    entry, version, labels = dataset("passport", 30)
    report = evaluate(entry, version, labels, oracle(labels, version["sealed_test"][:5]), RUN, limit=5)
    assert report["subset"] == {"first": 5, "of_sealed_test": len(version["sealed_test"])}
    assert report["test_documents"] == 5 and report["documents"]["abstained"] == 0 and report["claim_level"] == "pipeline_proof"


def test_rows_are_aligned_by_content_not_position():
    entry, version, labels = dataset("annual_return")
    predictions = oracle(labels, version["sealed_test"])
    def reverse_rows(r):
        rows = r["extracted_fields"]["ownership_interests"]
        r["extracted_fields"]["ownership_interests"] = list(reversed(rows))
        paths = {}
        for o in r["observations"]:
            if o["path"].startswith("/extracted_fields/ownership_interests/"):
                parts = o["path"].split("/")
                parts[3] = str(len(rows) - 1 - int(parts[3]))
                o["path"] = "/".join(parts)
    predictions = [with_result(p, reverse_rows) for p in predictions]
    report = evaluate(entry, version, labels, predictions, RUN)
    assert report["fields"]["per_field"]["ownership_interests"]["recall"] == 1.0


def test_a_malformed_answer_is_an_integrity_failure_not_a_lost_prediction():
    entry, version, labels = dataset("passport", 30)
    predictions = oracle(labels, version["sealed_test"])
    predictions[0] = with_result(predictions[0], lambda r: r.update(unexpected="field"))
    report = evaluate(entry, version, labels, predictions, RUN)
    first = next(s for s in report["samples"] if s["sample_id"] == version["sealed_test"][0])
    assert first["status"] == "integrity_failure" and "SCHEMA_INVALID" in first["issues"]
    assert report["documents_with_issue"]["SCHEMA_INVALID"] == 1


def test_confidence_bands_and_guards():
    entry, version, labels = dataset("utility_bill", 40)
    def confident(r):
        for o in r["observations"]:
            if o["status"] == "present":
                o["confidence"] = 0.95
    predictions = [with_result(p, confident) for p in oracle(labels, version["sealed_test"])]
    report = evaluate(entry, version, labels, predictions, RUN)
    assert report["confidence_bands"]["0.9-1.0"]["correct"] == report["confidence_bands"]["0.9-1.0"]["observations"] > 0
    with pytest.raises(ValueError, match="route"):
        evaluate(entry, version, labels, predictions, RUN.model_copy(update={"route": "llm"}))
    with pytest.raises(ValueError, match="two predictions"):
        evaluate(entry, version, labels, predictions + predictions[:1], RUN)
    with pytest.raises(ValueError, match="another document type"):
        evaluate(build_entry("passport"), version, labels, predictions, RUN)


def test_cli_evaluates_a_predictions_file(tmp_path, capsys):
    directory = tmp_path / "d"
    main(["synthetic", "generate", "--type", "passport", "--count", "30", "--dir", str(directory)])
    main(["dataset", "build", "--type", "passport", "--dir", str(directory), "--salt", "salt-0001", "--out", str(tmp_path / "v.json")])
    version = json.loads((tmp_path / "v.json").read_text())
    with (tmp_path / "p.jsonl").open("w") as handle:
        for sample_id in version["sealed_test"]:
            label = json.loads((directory / "labels" / f"{sample_id}.json").read_text())
            handle.write(json.dumps({"sample_id": sample_id, "route": "oracle", "status": "completed", "result": label["result"]}) + "\n")
    main(["evaluate", "--type", "passport", "--dataset", str(tmp_path / "v.json"), "--dir", str(directory),
          "--predictions", str(tmp_path / "p.jsonl"), "--route", "oracle", "--run-id", "cli", "--out", str(tmp_path / "r.json")])
    report = json.loads((tmp_path / "r.json").read_text())
    assert report["fields"]["key"]["recall"] == 1.0 and report["claim_level"] == "pipeline_proof"


def test_citations_can_be_checked_against_the_pages_the_route_read():
    """OCR of a scan: values compare with gold; spans must point into the OCR text the model was given."""
    entry, version, labels = dataset("passport", 30)
    first = version["sealed_test"][0]
    gold = labels[first]
    ocr_text = "OCR READING\n" + gold.pages[0].text
    shift = len("OCR READING\n")
    pages = [{"page_id": "p1", "document_version": gold.pages[0].document_version, "text": ocr_text}]
    def onto_ocr(r):
        for o in r["observations"]:
            for span in o["spans"]:
                span["start"] += shift
                span["end"] += shift
        from kyc_documents.runtime import source_digest
        r["source_digest"] = source_digest(pages)
    prediction = with_result(oracle(labels, [first])[0], onto_ocr)
    against_gold = evaluate(entry, version, labels, [prediction], RUN, limit=1)
    assert against_gold["documents"]["integrity_failures"] == 1
    against_ocr = evaluate(entry, version, labels, [prediction], RUN, limit=1, source_pages={first: pages})
    assert against_ocr["source_pages"] == "supplied" and against_ocr["documents"]["all_key_fields_correct"] == 1

