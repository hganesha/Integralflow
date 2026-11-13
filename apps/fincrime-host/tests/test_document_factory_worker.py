"""The Factory worker end to end on fakes: control-api in memory, Azure that trains instantly and reads back gold values."""
import hashlib
import json
from pathlib import Path

import pytest

from document_factory.render import text_pdf
from document_factory.synthetic import generate
from document_factory.worker import Backend, Cancelled, ControlApi, DatasetStore, JobRun, run_once, stable_digest, sync


def write_store(root: Path, document_type: str, count: int) -> dict:
    directory = root / document_type
    (directory / "samples").mkdir(parents=True)
    (directory / "labels").mkdir()
    golds, lines = {}, []
    for seed in range(count):
        data, sample, label = generate(document_type, seed)
        (directory / "samples" / sample.sample_id).write_bytes(data)
        (directory / "labels" / f"{sample.sample_id}.json").write_text(label.model_dump_json())
        lines.append(sample.model_dump_json())
        golds[hashlib.sha256(text_pdf(data.decode())).hexdigest()] = label
    (directory / "samples.jsonl").write_text("\n".join(lines) + "\n")
    return golds


class FakeApi:
    """control-api's worker routes, in memory."""

    def __init__(self):
        self.strategies, self.datasets, self.models, self.classifiers, self.reports, self.releases, self.progress = {}, {}, {}, {}, [], [], []
        self.cancel = False

    def __call__(self, method, path, body):
        if path.endswith("/worker/registry"):
            return {"strategies": list(self.strategies.values()), "datasets": list(self.datasets.values()), "models": list(self.models.values()), "classifiers": list(self.classifiers.values())}
        if path.endswith("/worker/strategies"):
            self.strategies[body["documentType"]] = body
            return body
        if path.endswith("/worker/datasets"):
            self.datasets[body["documentType"]] = body
            return body
        if path.endswith("/worker/models"):
            self.models[body["modelVersionId"]] = body
            return body
        if path.endswith("/worker/classifiers"):
            self.classifiers[body["classifierVersionId"]] = body
            return body
        if path.endswith("/worker/reports"):
            body_without = {k: v for k, v in body.items() if k != "reportDigest"}
            assert stable_digest(body_without) == body["reportDigest"]
            self.reports.append(body)
            return body
        if path.endswith("/release"):
            self.releases.append(body)
            return {"digest": stable_digest(body), "release": body}
        if path.endswith("/progress"):
            self.progress.append(body)
            return {"job": {}, "cancellationRequested": self.cancel}
        raise AssertionError(path)


class FakeDI:
    """Layout from the rendered text; custom and prebuilt analysis returns the gold values for the document."""

    def __init__(self, golds, wrong=()):
        self.golds, self.wrong, self.built, self.calls = golds, set(wrong), {}, []

    def analyze(self, model_id, content):
        self.calls.append(("analyze", model_id))
        gold = self.golds[hashlib.sha256(content).hexdigest()]
        if model_id == "prebuilt-layout":
            words = [{"content": w, "polygon": [0, 0, 1, 0, 1, 1, 0, 1], "confidence": 0.99} for p in gold.pages for w in p.text.split()]
            return {"pages": [{"pageNumber": 1, "width": 8.5, "height": 11, "unit": "inch", "words": words}]}
        values = gold.result.extracted_fields
        if model_id.startswith("prebuilt-"):
            given, _, family = values["person_name"].partition(" ")
            text = lambda v: {"type": "string", "valueString": v, "content": v, "confidence": 0.9}
            date = lambda v: {"type": "date", "valueDate": v, "content": v, "confidence": 0.9}
            return {"modelId": model_id, "documents": [{"docType": "idDocument.passport", "fields": {
                "DocumentNumber": text(values["document_number"]), "FirstName": text(given), "LastName": text(family),
                "DateOfBirth": date(values["date_of_birth"]), "DateOfExpiration": date(values["expiry_date"])}}]}
        fields = {k: {"type": "string", "valueString": ("WRONG" if k in self.wrong else v), "content": v, "confidence": 0.95}
                  for k, v in values.items() if isinstance(v, str)}
        return {"modelId": model_id, "documents": [{"docType": gold.document_type, "fields": fields}]}

    def build_model(self, model_id, mode, url, prefix, description=""):
        self.built[model_id] = (mode, prefix)
        return {"modelId": model_id}

    def build_classifier(self, classifier_id, url, prefixes, description=""):
        assert "other" in prefixes
        self.built[classifier_id] = ("classifier", sorted(prefixes))
        return {}

    def compose(self, model_id, classifier_id, models, description=""):
        self.built[model_id] = ("compose", classifier_id, sorted(models))
        return {}


class FakeContainer:
    def __init__(self):
        self.blobs = {}

    def url(self):
        return "https://data.blob.core.windows.net/train?sv=redacted"

    def put(self, name, data, content_type):
        self.blobs[name] = data


def job_for(api, types, actions):
    return {"jobId": "job_0123456789abcdef01234567", "status": "running", "stage": "train", "selection": types,
            "gates": {"minSealedTest": 3, "minKeyPrecision": 0.95, "minKeyRecall": 0.8, "maxWrongKeyValues": 0, "maxIntegrityFailures": 0},
            "plan": [{"documentType": t, "strategy": api.strategies[t]["strategy"], "action": actions[t], "blockers": [],
                      "datasetDigest": api.datasets[t]["datasetDigest"], "reuseModelVersionId": None} for t in types],
            "progress": {t: {"status": "pending", "detail": None} for t in types}}


@pytest.fixture
def world(tmp_path):
    golds = {**write_store(tmp_path, "w9", 24), **write_store(tmp_path, "passport", 24)}
    api = FakeApi()
    store = DatasetStore(tmp_path, "test-salt-1234")
    sync(store, ControlApi("http://unused", "t", send=api), "worker")
    return api, store, golds


def test_sync_registers_manifest_strategies_and_dataset_versions(world):
    api, store, _ = world
    assert api.strategies["w9"]["strategy"] == "azure_template" and api.strategies["passport"]["strategy"] == "azure_prebuilt"
    version = api.datasets["w9"]
    assert version["counts"]["test"] > 0 and len(version["datasetDigest"]) == 64
    assert store.load("w9")[0]["dataset_digest"] == version["datasetDigest"]


def test_a_job_trains_composes_evaluates_and_releases_only_types_meeting_their_gates(world):
    api, store, golds = world
    di, container = FakeDI(golds), FakeContainer()
    job = job_for(api, ["passport", "w9"], {"w9": "train", "passport": "prebuilt"})
    digest = JobRun(job, ControlApi("http://unused", "t", send=api), store, Backend(di, container), "w1").run()
    assert api.reports[0]["reportDigest"] == digest
    model_id = "ehf-w9-0123456789ab"
    assert di.built[model_id][0] == "template" and di.built["ehf-cls-0123456789ab"] == ("classifier", ["other", "w9"])
    assert any(name.endswith("fields.json") for name in container.blobs) and any(name.endswith(".labels.json") for name in container.blobs)
    labels = json.loads(next(v for k, v in container.blobs.items() if k.endswith(".labels.json")))
    assert labels["labels"] and all(entry["value"][0]["boundingBoxes"] for entry in labels["labels"])
    report = api.reports[0]
    by_type = {t["documentType"]: t for t in report["types"]}
    assert by_type["w9"]["gatesMet"] and by_type["w9"]["release"]["keyPrecision"] == 1
    assert report["classification"]["correct"] == report["classification"]["documents"]
    release = api.releases[0]
    assert by_type["passport"]["gatesMet"] and [t["documentType"] for t in release["types"]] == ["passport", "w9"]
    assert release["composedModelId"] == "ehf-release-0123456789ab" and all(t["mode"] == "shadow" for t in release["types"])
    assert api.progress[-1]["status"] == "completed" and api.models["w9-0123456789ab"]["status"] == "ready"


def test_a_type_that_reads_wrong_values_is_excluded_not_released(world):
    api, store, golds = world
    from kyc_documents.profiles import PROFILES
    di = FakeDI(golds, wrong=set(PROFILES["w9"].key_fields))  # values that are not on the page: never anchored, so missed
    job = job_for(api, ["w9"], {"w9": "train"})
    JobRun(job, ControlApi("http://unused", "t", send=api), store, Backend(di, FakeContainer()), "w1").run()
    assert not api.reports[0]["types"][0]["gatesMet"] and not api.releases
    assert api.progress[-1]["error"] == "No type met its gates; nothing was released."


def test_cancellation_stops_at_the_next_step_and_failures_are_reported(world):
    api, store, golds = world
    api.cancel = True
    job = job_for(api, ["w9"], {"w9": "train"})
    with pytest.raises(Cancelled):
        JobRun(job, ControlApi("http://unused", "t", send=api), store, Backend(FakeDI(golds), FakeContainer()), "w1").run()

    class ClaimApi(FakeApi):
        def __call__(self, method, path, body):
            if path.endswith("/claim"):
                return {"job": job}
            return super().__call__(method, path, body)
    claim = ClaimApi()
    claim.strategies, claim.datasets = api.strategies, api.datasets
    claim.cancel = True
    assert run_once(ControlApi("http://unused", "t", send=claim), store, Backend(FakeDI(golds), FakeContainer()), "w1") is None
    assert claim.progress[-1] == {"owner": "w1", "status": "cancelled"}


def test_without_a_training_container_a_trained_type_fails_and_prebuilt_types_still_release(world):
    api, store, golds = world
    job = job_for(api, ["passport", "w9"], {"w9": "train", "passport": "prebuilt"})
    JobRun(job, ControlApi("http://unused", "t", send=api), store, Backend(FakeDI(golds), None), "w1").run()
    failed = [p for p in api.progress if p.get("progress", {}).get("w9", {}).get("status") == "failed"]
    assert failed and "no training container" in failed[0]["progress"]["w9"]["detail"]
    assert [t["documentType"] for t in api.releases[0]["types"]] == ["passport"] and api.releases[0]["classifier"] is None
