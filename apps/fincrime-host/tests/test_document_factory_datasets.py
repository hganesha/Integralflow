import hashlib
import json

import pytest
from pydantic import ValidationError

from document_factory.cli import main
from document_factory.datasets import GoldLabel, Sample, build_dataset_version, load_directory, split_policy_for
from document_factory.sourcing import build_entry
from document_factory.synthetic import LAYOUTS, VALUES, generate
from kyc_documents.runtime import validate_extraction

TYPE = "certificate_of_incorporation"


def corpus(count=60, document_type=TYPE):
    samples, labels = [], {}
    for seed in range(count):
        _, sample, label = generate(document_type, seed)
        samples.append(sample)
        labels[sample.sample_id] = label
    return samples, labels


def build(samples, labels, salt="salt-0001", previous=None, document_type=TYPE):
    entry = build_entry(document_type)
    return build_dataset_version(entry, samples, labels, policy=split_policy_for(entry, salt), previous=previous)


def test_every_pilot_layout_renders_a_valid_fictional_label_deterministically():
    for document_type, layouts in LAYOUTS.items():
        for index, layout in enumerate(sorted(layouts)):
            data, sample, label = generate(document_type, index)
            assert sample.variant == layout and generate(document_type, index)[0] == data
            assert hashlib.sha256(data).hexdigest() == sample.sample_id == label.result.document_version
            assert "SYNTHETIC" in data.decode() or "SPECIMEN" in data.decode()
            assert validate_extraction(document_type, label.result, label.pages)["valid"]
    assert set(VALUES) == set(LAYOUTS)


def test_splits_are_by_group_sealed_and_stable():
    samples, labels = corpus()
    version = build(samples, labels)
    included = [i for split in version["splits"].values() for i in split]
    assert len(included) == len(set(included)) and version["sealed_test"] == version["splits"]["test"]
    assert version["readiness"]["test_pipeline_proof"] and version == build(samples, labels)
    group = {s.sample_id: s.group_key for s in samples}
    owners = {}
    for split, ids in version["splits"].items():
        for sample_id in ids:
            assert owners.setdefault(group[sample_id], split) == split


def test_a_new_version_never_moves_a_sample_and_the_split_policy_is_pinned():
    samples, labels = corpus(40)
    first = build(samples, labels)
    more_samples, more_labels = corpus(70)
    second = build(more_samples, more_labels, previous=first)
    for split in first["splits"]:
        assert set(first["splits"][split]) <= set(second["splits"][split])
    assert second["previous_digest"] == first["dataset_digest"]
    with pytest.raises(ValueError, match="pinned"):
        build(more_samples, more_labels, salt="another-salt", previous=first)


def test_duplicates_rights_sources_and_labels_are_excluded_with_reasons():
    samples, labels = corpus(30)
    base = samples[0]
    # The same bytes under a second group is a grouping error: both copies go.
    samples.append(base.model_copy(update={"group_key": "another-group"}))
    # A public source whose rights are still pending review.
    pending = samples[1].model_copy(update={
        "source_id": "companies_house_documents", "source_kind": "authentic_public",
        "rights": samples[1].rights.model_copy(update={"training_use": "pending_review", "evaluation_use": "pending_review",
                                                        "redistribution": "pending_review", "commit_to_repo": False,
                                                        "reviewed_by": None, "reviewed_at": None})})
    samples[1] = pending
    samples.append(samples[2].model_copy(update={"source_id": "irs_forms", "source_kind": "official_template"}))
    del labels[samples[3].sample_id]
    tampered = labels[samples[4].sample_id].result.model_dump(mode="json")
    tampered["observations"][[o["status"] for o in tampered["observations"]].index("present")]["spans"][0]["quote"] = "TAMPERED"
    labels[samples[4].sample_id] = labels[samples[4].sample_id].model_copy(
        update={"result": type(labels[samples[4].sample_id].result).model_validate_json(json.dumps(tampered))})
    version = build(samples, labels)
    reasons = {(e["sample_id"], e["reason"]) for e in version["excluded"]}
    assert (base.sample_id, "duplicate_across_groups") in reasons
    assert (pending.sample_id, "rights_not_allowed_for_split") in reasons
    assert (samples[2].sample_id, "source_not_in_manifest") in reasons
    assert (samples[3].sample_id, "no_approved_label") in reasons
    assert (samples[4].sample_id, "label_invalid") in reasons
    included = {i for ids in version["splits"].values() for i in ids}
    assert not included & {base.sample_id, pending.sample_id, samples[3].sample_id, samples[4].sample_id}


def test_label_provenance_rules():
    _, _, label = generate(TYPE, 0)
    payload = json.loads(label.model_dump_json())
    with pytest.raises(ValidationError, match="two distinct labellers"):
        GoldLabel.model_validate_json(json.dumps({**payload, "provenance": {"*": "human_double"}, "labelled_by": ["a"]}))
    with pytest.raises(ValidationError, match="unknown fields"):
        GoldLabel.model_validate_json(json.dumps({**payload, "provenance": {"*": "human", "nonsense": "human"}}))
    with pytest.raises(ValidationError, match="every field"):
        GoldLabel.model_validate_json(json.dumps({**payload, "provenance": {"entity_name": "human"}}))


def test_cli_generates_a_directory_and_builds_a_version(tmp_path, capsys):
    main(["synthetic", "generate", "--type", "utility_bill", "--count", "25", "--dir", str(tmp_path / "d")])
    samples, labels = load_directory(tmp_path / "d")
    assert len(samples) == len(labels) == 25
    main(["dataset", "build", "--type", "utility_bill", "--dir", str(tmp_path / "d"), "--salt", "salt-0001",
          "--out", str(tmp_path / "v.json")])
    version = json.loads((tmp_path / "v.json").read_text())
    assert sum(version["counts"].values()) == 25 and version["document_type"] == "utility_bill"
    blob = next((tmp_path / "d" / "samples").iterdir())
    blob.write_bytes(blob.read_bytes() + b"x")
    with pytest.raises(ValueError, match="digest"):
        load_directory(tmp_path / "d")


def test_sample_records_are_closed():
    _, sample, _ = generate(TYPE, 0)
    with pytest.raises(ValidationError):
        Sample.model_validate_json(json.dumps({**json.loads(sample.model_dump_json()), "extra": 1}))
