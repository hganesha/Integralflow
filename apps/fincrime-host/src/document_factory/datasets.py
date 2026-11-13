"""Dataset samples, gold labels, group splits and immutable dataset versions (plan §8.4–8.5).

A dataset directory holds a sample's bytes under ``samples/<sha256>``, one JSON record per sample
in ``samples.jsonl`` and an approved gold label per sample in ``labels/<sample_id>.json``.
``build_dataset_version`` turns it into a digest-pinned version for one document type.

Rules enforced here:

* Splits are assigned per **group** (issuing entity, template or person-equivalent), from a hash of
  the group key and a pinned salt. A sample therefore never moves between splits across versions,
  and one group never spans two splits.
* A sample is used for a split only if its rights snapshot allows that purpose. It is excluded,
  never moved to another split, so rights can't steer leakage.
* Exact and near duplicates (same bytes, same normalized text) collapse to one sample. A
  duplicate across two groups is a grouping error and excludes both copies.
* Every included sample has a gold label that passes ``validate_extraction`` against its pages, and
  label provenance from a person or by construction. An unreviewed model pre-label is a queue
  state, never a dataset label.
* The test split is sealed: the version records exactly which samples it holds.
"""
from __future__ import annotations

import hashlib
import json
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator

from kyc_documents.model import ClosedModel, ExtractionResult, SourcePage, fingerprint
from kyc_documents.profiles import PROFILES
from kyc_documents.runtime import contract, validate_extraction

from . import FACTORY_API_VERSION
from .sourcing import ManifestEntry, Rights, SourceKind

Split = Literal["train", "validation", "test"]
SPLITS: tuple[Split, ...] = ("train", "validation", "test")
LabelProvenance = Literal["by_construction", "structured_crosscheck_and_human", "human", "human_double"]
Capture = Literal["born_digital", "scanned", "photo", "unknown"]


class Sample(ClosedModel):
    sample_id: str = Field(pattern=r"^[a-f0-9]{64}$", description="sha256 of the sample bytes")
    document_type: str
    variant: str | None = None
    source_id: str
    source_kind: SourceKind
    source_ref: str | None = Field(default=None, description="URL, filing accession or generator seed")
    retrieved_at: datetime
    collector_version: str
    media_type: str
    byte_length: int = Field(gt=0)
    group_key: str = Field(min_length=1, description="issuing entity or template; the unit of splitting")
    rights: Rights
    capture: Capture = "unknown"
    language: str | None = None
    page_count: int | None = Field(default=None, gt=0)


class GoldLabel(ClosedModel):
    sample_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    document_type: str
    pages: tuple[SourcePage, ...]
    result: ExtractionResult
    provenance: dict[str, LabelProvenance] = Field(description="per top-level field; '*' sets the default")
    labelled_by: tuple[str, ...] = Field(min_length=1)
    approved_at: datetime

    @model_validator(mode="after")
    def _provenance_is_complete(self):
        fields = set(PROFILES[self.document_type].field_names)
        unknown = set(self.provenance) - fields - {"*"}
        if unknown:
            raise ValueError(f"provenance names unknown fields: {sorted(unknown)}")
        if "*" not in self.provenance and fields - set(self.provenance):
            raise ValueError("provenance must cover every field or set a '*' default")
        if "human_double" in self.provenance.values() and len(set(self.labelled_by)) < 2:
            raise ValueError("human_double provenance needs two distinct labellers")
        return self

    def provenance_for(self, field: str) -> LabelProvenance:
        return self.provenance.get(field, self.provenance.get("*"))


class SplitPolicy(ClosedModel):
    salt: str = Field(min_length=8)
    weights: dict[Split, int]

    @model_validator(mode="after")
    def _weights(self):
        if set(self.weights) != set(SPLITS) or sum(self.weights.values()) <= 0 or min(self.weights.values()) < 0:
            raise ValueError("weights must name train, validation and test with a positive total")
        return self

    def split_for(self, group_key: str) -> Split:
        bucket = int.from_bytes(hashlib.sha256(f"{self.salt}\0{group_key}".encode()).digest()[:8], "big") % sum(self.weights.values())
        for split in SPLITS:
            if bucket < self.weights[split]:
                return split
            bucket -= self.weights[split]
        raise AssertionError("unreachable")


def split_policy_for(entry: ManifestEntry, salt: str) -> SplitPolicy:
    needs = entry.needs
    return SplitPolicy(salt=salt, weights={"train": needs.train, "validation": needs.validation, "test": needs.test})


def normalized_text_key(pages) -> str:
    text = " ".join(" ".join(unicodedata.normalize("NFKC", p.text).casefold().split()) for p in pages)
    return hashlib.sha256(text.encode()).hexdigest()


def _rights_allow(rights: Rights, split: Split) -> bool:
    return (rights.evaluation_use if split in ("validation", "test") else rights.training_use) == "allowed"


def load_directory(directory: Path) -> tuple[list[Sample], dict[str, GoldLabel]]:
    samples = [Sample.model_validate_json(line) for line in (directory / "samples.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    labels = {}
    for path in sorted((directory / "labels").glob("*.json")):
        label = GoldLabel.model_validate_json(path.read_text(encoding="utf-8"))
        if path.stem != label.sample_id:
            raise ValueError(f"{path.name}: file name and sample_id differ")
        labels[label.sample_id] = label
    for sample in samples:
        blob = directory / "samples" / sample.sample_id
        if blob.is_file():
            data = blob.read_bytes()
            if hashlib.sha256(data).hexdigest() != sample.sample_id or len(data) != sample.byte_length:
                raise ValueError(f"sample {sample.sample_id[:12]}: bytes do not match the recorded digest or length")
    return samples, labels


def build_dataset_version(entry: ManifestEntry, samples: list[Sample], labels: dict[str, GoldLabel], *,
                          policy: SplitPolicy, previous: dict | None = None) -> dict:
    """A digest-pinned dataset version for one document type. Pure: reads nothing, writes nothing."""
    if previous is not None:
        if previous["document_type"] != entry.document_type:
            raise ValueError("the previous version is for another document type")
        if previous["split_policy"] != policy.model_dump(mode="json"):
            raise ValueError("the split policy is pinned by the first version and cannot change")
    allowed_sources = {s.id: s for s in entry.sources}
    excluded: list[dict] = []
    def exclude(sample, reason, **details):
        excluded.append({"sample_id": sample.sample_id, "reason": reason, **details})

    candidates = []
    for sample in samples:
        if sample.document_type != entry.document_type:
            continue
        if sample.source_id not in allowed_sources or allowed_sources[sample.source_id].source_kind != sample.source_kind:
            exclude(sample, "source_not_in_manifest")
            continue
        label = labels.get(sample.sample_id)
        if label is None:
            exclude(sample, "no_approved_label")
            continue
        if label.document_type != entry.document_type:
            exclude(sample, "label_for_other_type")
            continue
        check = validate_extraction(entry.document_type, label.result, label.pages)
        if not check["valid"]:
            exclude(sample, "label_invalid", issues=sorted({i["code"] for i in check["issues"]}))
            continue
        candidates.append((sample, label))

    by_digest: dict[str, list] = {}
    by_text: dict[str, list] = {}
    for sample, label in candidates:
        by_digest.setdefault(sample.sample_id, []).append((sample, label))
        by_text.setdefault(normalized_text_key(label.pages), []).append((sample, label))
    dropped: set[str] = set()
    for key, group in [*by_digest.items(), *by_text.items()]:
        if len(group) < 2:
            continue
        groups = {s.group_key for s, _ in group}
        ids = sorted({s.sample_id for s, _ in group})
        if len(groups) > 1:
            for sample_id in ids:
                if sample_id not in dropped:
                    dropped.add(sample_id)
                    excluded.append({"sample_id": sample_id, "reason": "duplicate_across_groups", "groups": sorted(groups)})
        else:
            for sample_id in ids[1:]:
                if sample_id not in dropped:
                    dropped.add(sample_id)
                    excluded.append({"sample_id": sample_id, "reason": "duplicate", "kept": ids[0]})
    seen: set[str] = set()
    splits: dict[Split, list[str]] = {s: [] for s in SPLITS}
    provenance_counts: dict[str, int] = {}
    for sample, label in candidates:
        if sample.sample_id in dropped or sample.sample_id in seen:
            continue
        seen.add(sample.sample_id)
        split = policy.split_for(sample.group_key)
        if not _rights_allow(sample.rights, split):
            excluded.append({"sample_id": sample.sample_id, "reason": "rights_not_allowed_for_split", "split": split})
            continue
        splits[split].append(sample.sample_id)
        for field in PROFILES[entry.document_type].field_names:
            p = label.provenance_for(field)
            provenance_counts[p] = provenance_counts.get(p, 0) + 1
    if previous is not None:
        for split in SPLITS:
            moved = set(previous["splits"][split]) & set().union(*(set(splits[o]) for o in SPLITS if o != split))
            if moved:
                raise ValueError(f"samples changed split from {split}: {sorted(moved)[:3]}")
    included = {sid for ids in splits.values() for sid in ids}
    sample_records = {s.sample_id: s for s, _ in candidates}
    groups_by_split = {split: sorted({sample_records[i].group_key for i in ids}) for split, ids in splits.items()}
    leaks = [g for g in set().union(*map(set, groups_by_split.values()))
             if sum(g in groups_by_split[s] for s in SPLITS) > 1]
    if leaks:
        raise AssertionError(f"group leakage across splits: {sorted(leaks)[:3]}")
    needs = entry.needs
    counts = {s: len(splits[s]) for s in SPLITS}
    body = {
        "api_version": FACTORY_API_VERSION, "kind": "DatasetVersion", "document_type": entry.document_type,
        "contract_hash": contract(entry.document_type)["contract_hash"], "split_policy": policy.model_dump(mode="json"),
        "splits": {s: sorted(splits[s]) for s in SPLITS}, "sealed_test": sorted(splits["test"]),
        "counts": counts, "groups": {s: len(groups_by_split[s]) for s in SPLITS},
        "source_kinds": {s: sorted({sample_records[i].source_kind for i in splits[s]}) for s in SPLITS},
        "captures": {s: sorted({sample_records[i].capture for i in splits[s]}) for s in SPLITS},
        "label_provenance": dict(sorted(provenance_counts.items())),
        "label_set_digest": fingerprint(sorted((i, labels[i].result.model_dump(mode="json")) for i in included)),
        "excluded": sorted(excluded, key=lambda e: (e["reason"], e["sample_id"])),
        "readiness": {
            "train": counts["train"] >= needs.train, "validation": counts["validation"] >= needs.validation,
            "test_pipeline_proof": counts["test"] >= needs.pipeline_proof_test,
            "test_qualification": counts["test"] >= needs.test},
        "previous_digest": previous["dataset_digest"] if previous else None,
    }
    return {**body, "dataset_digest": fingerprint(body)}


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
