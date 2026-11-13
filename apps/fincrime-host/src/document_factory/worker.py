"""The Document Factory worker (plan §7.2–7.4, Phase 3): dataset sync and release jobs.

    python -m document_factory.worker sync      register strategies and dataset versions from the dataset store
    python -m document_factory.worker run       claim and run approved release jobs until stopped
    python -m document_factory.worker once      claim and run at most one job

The worker never decides what may run: control-api plans each job from the registry, a person other than its
planner approves the spend, and the worker claims only approved jobs, reporting every step under its lease. It
stops at the next step when a job is cancelled, and a job is resumable at step granularity: a model already
ready in the registry is not rebuilt.

A job, per type in its plan:

* `train`: training documents (rendered if the sample is text), their layout (`.ocr.json`) and labels from gold
  (`.labels.json`) go to the training container; Azure builds a template or neural model.
* `reuse` / `prebuilt`: the existing model is used as it is.
* `llm_only`: nothing to release; the LLM route always runs.

Custom models are composed under a classifier with an `other` class. Every released type is then evaluated on its
sealed test documents, anchored on the page text exactly as Route A is in production (`kyc_documents.route_answers`)
and scored by `document_factory.evaluation`. Only types whose gates are met go into the release manifest, which
control-api registers with the job's planner as registrant.

Settings: CONTROL_API_URL, FACTORY_WORKER_SERVICE_TOKEN, FACTORY_DATASET_ROOT, FACTORY_SPLIT_SALT,
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT and AZURE_DOCUMENT_INTELLIGENCE_AUTH (key or managed_identity),
FACTORY_TRAINING_CONTAINER_URL (a private container URL; local development can supply a SAS URL).
"""
from __future__ import annotations

import hashlib
import json
import os
import signal
import sys
import time
import uuid

import httpx
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import urlsplit
from pathlib import Path
from typing import Callable

from financial_crime.runtimes.workload_identity import OutboundToken
from kyc_documents.route_answers import answer_from_model_fields

from .azure_di import AzureDI, AzureDIError, urllib_transport
from .azure_training import fields_json, labels_json
from .blob import TrainingContainer
from .datasets import GoldLabel, Sample, build_dataset_version, load_directory, split_policy_for
from .evaluation import Prediction, RunInfo, evaluate
from .model_fields import from_custom, from_prebuilt, prebuilt_routes
from .render import text_pdf
from .sourcing import build_entry
from .synthetic import VALUES, generate

DEFAULT_GATES = {"minSealedTest": 10, "minKeyPrecision": 0.95, "minKeyRecall": 0.8, "maxWrongKeyValues": 0, "maxIntegrityFailures": 0}
OTHER_CLASS_SAMPLES = 6


class Cancelled(Exception):
    pass


def canonical(value):
    """JSON as the platform's `stableDigest` sees it: integral floats as integers."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {k: canonical(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [canonical(v) for v in value]
    return value


def stable_digest(value) -> str:
    return hashlib.sha256(json.dumps(canonical(value), sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def evaluate_gates(gates: dict, metrics: dict) -> list[dict]:
    """The same gates as `evaluateGates` in @ehf/contracts/document-factory."""
    p, r = metrics["keyPrecision"], metrics["keyRecall"]
    return [
        {"gate": "min_sealed_test", "threshold": gates["minSealedTest"], "value": metrics["documents"], "met": metrics["documents"] >= gates["minSealedTest"]},
        {"gate": "min_key_precision", "threshold": gates["minKeyPrecision"], "value": p, "met": p is not None and p >= gates["minKeyPrecision"]},
        {"gate": "min_key_recall", "threshold": gates["minKeyRecall"], "value": r, "met": r is not None and r >= gates["minKeyRecall"]},
        {"gate": "max_wrong_key_values", "threshold": gates["maxWrongKeyValues"], "value": metrics["wrongKeyValues"], "met": metrics["wrongKeyValues"] <= gates["maxWrongKeyValues"]},
        {"gate": "max_integrity_failures", "threshold": gates["maxIntegrityFailures"], "value": metrics["integrityFailures"], "met": metrics["integrityFailures"] <= gates["maxIntegrityFailures"]},
    ]


# ---------------------------------------------------------------- control-api

class ControlApi:
    """The worker's calls to control-api, as workload `Factory.Worker`."""

    def __init__(self, base_url: str, token: str | Callable[[], str | None], send: Callable | None = None):
        self._client = httpx.Client(base_url=base_url.rstrip("/"), timeout=60.0) if send is None else None
        self._send = send
        self._token = token if callable(token) else lambda: token

    def call(self, method: str, path: str, body=None):
        if self._send is not None:
            return self._send(method, path, body)
        response = self._client.request(method, path, json=body, headers={"Authorization": f"Bearer {self._token()}"})
        if response.status_code >= 400:
            raise RuntimeError(f"control-api {method} {path}: {response.status_code} {response.text[:300]}")
        return response.json()


# ---------------------------------------------------------------- dataset store

@dataclass
class DatasetStore:
    """Per type, `<root>/<type>/samples.jsonl`, `samples/<sha256>` and `labels/<sha256>.json` (Phase 0 layout)."""
    root: Path
    salt: str

    def types(self) -> list[str]:
        return sorted(p.name for p in self.root.iterdir() if (p / "samples.jsonl").is_file()) if self.root.is_dir() else []

    def load(self, document_type: str) -> tuple[dict, list[Sample], dict[str, GoldLabel]]:
        samples, labels = load_directory(self.root / document_type)
        entry = build_entry(document_type)
        version = build_dataset_version(entry, samples, labels, policy=split_policy_for(entry, self.salt))
        return version, samples, labels

    def original(self, document_type: str, sample: Sample) -> tuple[bytes, str]:
        """The sample as a file Azure can read: the stored bytes, or a rendered PDF for text samples."""
        data = (self.root / document_type / "samples" / sample.sample_id).read_bytes()
        if sample.media_type.startswith("text/"):
            return text_pdf(data.decode("utf-8")), "application/pdf"
        return data, sample.media_type


def sync(store: DatasetStore, api: ControlApi, worker_id: str) -> list[dict]:
    """Register each type's current dataset version, and the manifest's strategy where none is registered."""
    registry = api.call("GET", "/v1/document-factory/worker/registry")
    known = {s["documentType"] for s in registry["strategies"]}
    out = []
    registered = {d["datasetDigest"] for d in registry.get("datasets", [])}
    for document_type in store.types():
        version, _, _ = store.load(document_type)
        entry = build_entry(document_type)
        if document_type not in known:
            strategy = entry.strategy_hypothesis if entry.strategy_hypothesis != "azure_prebuilt" or document_type in prebuilt_routes() else "layout_llm"
            api.call("POST", "/v1/document-factory/worker/strategies", {"documentType": document_type, "contractHash": version["contract_hash"],
                                                                       "strategy": strategy, "modelFamily": None, "rationale": entry.rationale[:2000], "owner": "sourcing-manifest"})
        if version["dataset_digest"] in registered:
            continue
        body = {"datasetDigest": version["dataset_digest"], "documentType": document_type, "contractHash": version["contract_hash"],
                "previousDigest": version["previous_digest"], "counts": version["counts"], "groups": version["groups"],
                "labelSetDigest": version["label_set_digest"], "readiness": version["readiness"], "storageRef": f"datasets/{document_type}",
                "excluded": len(version["excluded"]), "registeredAt": now(), "registeredBy": worker_id}
        out.append(api.call("POST", "/v1/document-factory/worker/datasets", body))
    return out


# ---------------------------------------------------------------- release job

@dataclass
class Backend:
    di: AzureDI
    container: TrainingContainer | None  # needed only to train custom models


@dataclass
class JobRun:
    job: dict
    api: ControlApi
    store: DatasetStore
    backend: Backend
    owner: str
    progress: dict = field(default_factory=dict)

    def report(self, **patch):
        result = self.api.call("POST", f"/v1/document-factory/worker/jobs/{self.job['jobId']}/progress", {"owner": self.owner, **patch})
        if result.get("cancellationRequested"):
            raise Cancelled()
        return result

    def step(self, document_type: str, status: str, detail: str | None = None, stage: str | None = None):
        self.progress[document_type] = {"status": status, "detail": (detail or None) and detail[:500]}
        self.report(progress={document_type: self.progress[document_type]}, **({"stage": stage} if stage else {}))

    def short(self) -> str:
        return self.job["jobId"].removeprefix("job_")[:12]

    # -- training ------------------------------------------------------
    def train(self, document_type: str, kind: str, dataset: dict, samples: list[Sample], labels: dict[str, GoldLabel]) -> dict:
        if self.backend.container is None:
            raise RuntimeError("no training container is configured (FACTORY_TRAINING_CONTAINER_URL); custom models cannot be trained")
        model_version_id = f"{document_type}-{self.short()}"
        provider_model_id = f"ehf-{document_type.replace('_', '-')}-{self.short()}"[:64]
        registry = self.api.call("GET", "/v1/document-factory/worker/registry")
        ready = next((m for m in registry["models"] if m["modelVersionId"] == model_version_id and m["status"] == "ready"), None)
        if ready:
            return ready
        by_id = {s.sample_id: s for s in samples}
        prefix = f"{self.job['jobId']}/models/{document_type}"
        labelled = 0
        for sample_id in dataset["splits"]["train"] + dataset["splits"]["validation"]:
            sample, gold = by_id[sample_id], labels.get(sample_id)
            if gold is None:
                continue
            content, media_type = self.store.original(document_type, sample)
            layout = self.backend.di.analyze("prebuilt-layout", content)
            name = f"{sample_id[:24]}.pdf" if media_type == "application/pdf" else f"{sample_id[:24]}"
            document, _ = labels_json(document_type, name, gold.result.model_dump(mode="json"), [p.model_dump(mode="json") for p in gold.pages], layout)
            self.backend.container.put(f"{prefix}/{name}", content, media_type)
            self.backend.container.put(f"{prefix}/{name}.ocr.json", json.dumps({"status": "succeeded", "analyzeResult": layout}).encode(), "application/json")
            self.backend.container.put(f"{prefix}/{name}.labels.json", json.dumps(document).encode(), "application/json")
            labelled += 1
        self.backend.container.put(f"{prefix}/fields.json", json.dumps(fields_json(document_type)).encode(), "application/json")
        model = {"modelVersionId": model_version_id, "documentType": document_type, "kind": kind, "providerModelId": provider_model_id,
                 "datasetDigest": dataset["dataset_digest"], "contractHash": dataset["contract_hash"], "trainingJobId": self.job["jobId"],
                 "trainingHours": None, "costUsd": None, "status": "training", "createdAt": now()}
        self.api.call("POST", "/v1/document-factory/worker/models", model)
        started = time.monotonic()
        try:
            self.backend.di.build_model(provider_model_id, kind, self.backend.container.url(), prefix, f"EHF {document_type}, job {self.job['jobId']}, {labelled} documents")
        except AzureDIError as error:
            self.api.call("POST", "/v1/document-factory/worker/models", {**model, "status": "failed"})
            raise RuntimeError(f"training {document_type} failed: {error}") from None
        hours = round((time.monotonic() - started) / 3600, 3) if kind == "neural" else None
        return self.api.call("POST", "/v1/document-factory/worker/models", {**model, "status": "ready", "trainingHours": hours, "costUsd": 0 if kind == "template" else None})

    def classify_and_compose(self, custom: dict[str, dict], loaded: dict) -> tuple[dict, str]:
        """A classifier over the custom types plus `other`, and the composed model under it."""
        classifier_id = f"ehf-cls-{self.short()}"
        prefixes = {}
        for document_type in custom:
            dataset, samples, _ = loaded[document_type]
            by_id = {s.sample_id: s for s in samples}
            prefix = f"{self.job['jobId']}/classes/{document_type}"
            for sample_id in dataset["splits"]["train"][:50]:
                content, media_type = self.store.original(document_type, by_id[sample_id])
                self.backend.container.put(f"{prefix}/{sample_id[:24]}.pdf", content, media_type)
            prefixes[document_type] = prefix
        # `other`: documents of catalog types outside the composition, so an unrelated document is not forced into a class.
        others = [t for t in sorted(VALUES) if t not in custom][:OTHER_CLASS_SAMPLES]
        prefix = f"{self.job['jobId']}/classes/other"
        for index, document_type in enumerate(others):
            text_bytes, _, _ = generate(document_type, 1000 + index)
            self.backend.container.put(f"{prefix}/{document_type}.pdf", text_pdf(text_bytes.decode("utf-8")), "application/pdf")
        prefixes["other"] = prefix
        classifier = {"classifierVersionId": classifier_id, "providerClassifierId": classifier_id, "classes": sorted(prefixes),
                      "datasetDigests": {t: loaded[t][0]["dataset_digest"] for t in custom}, "parent": None, "status": "training", "createdAt": now()}
        self.api.call("POST", "/v1/document-factory/worker/classifiers", classifier)
        self.backend.di.build_classifier(classifier_id, self.backend.container.url(), prefixes, f"EHF job {self.job['jobId']}")
        self.api.call("POST", "/v1/document-factory/worker/classifiers", {**classifier, "status": "ready"})
        composed_id = f"ehf-release-{self.short()}"
        self.backend.di.compose(composed_id, classifier_id, {t: m["providerModelId"] for t, m in custom.items()}, f"EHF job {self.job['jobId']}")
        return classifier, composed_id

    # -- evaluation ----------------------------------------------------
    def evaluate_type(self, document_type: str, route: str, model_id: str, loaded) -> tuple[dict, dict]:
        dataset, samples, labels = loaded
        by_id = {s.sample_id: s for s in samples}
        entry = build_entry(document_type)
        predictions, pages, classified = [], {}, 0
        for index, sample_id in enumerate(dataset["sealed_test"]):
            if index and index % 10 == 0:
                self.report()  # heartbeat: renews the lease and stops here if the job was cancelled
            gold = labels[sample_id]
            source = [p.model_dump(mode="json") for p in gold.pages]
            pages[sample_id] = source
            content, _ = self.store.original(document_type, by_id[sample_id])
            started = time.monotonic()
            try:
                result = self.backend.di.analyze(model_id, content)
                doc_type = ((result.get("documents") or [{}])[0].get("docType") or "")
                classified += route != "custom" or doc_type == document_type or doc_type.endswith(":" + document_type)
                sha = hashlib.sha256(content).hexdigest()
                candidates = from_custom(result, document_type, sha) if route == "custom" else from_prebuilt(result, document_type, sha)
                answer, _ = answer_from_model_fields(document_type, source, candidates)
                predictions.append(Prediction(sample_id=sample_id, route="azure_di", status="completed", result=answer,
                                              latency_ms=round((time.monotonic() - started) * 1000, 1)))
            except (AzureDIError, ValueError) as error:
                predictions.append(Prediction(sample_id=sample_id, route="azure_di", status="failed", error_code=str(error)[:120]))
        run = RunInfo(route="azure_di", run_id=f"{self.job['jobId']}-{document_type}", started_at=datetime.now(timezone.utc), notes=model_id)
        scored = evaluate(entry, dataset, labels, predictions, run, source_pages=pages)
        key = scored["fields"]["key"]
        metrics = {"documents": scored["test_documents"], "allKeyFieldsCorrect": scored["documents"]["all_key_fields_correct"],
                   "keyPrecision": key["precision"], "keyRecall": key["recall"], "wrongKeyValues": key["wrong"],
                   "integrityFailures": scored["documents"]["integrity_failures"]}
        return metrics, {"documents": len(dataset["sealed_test"]), "correct": classified}

    # -- the job -------------------------------------------------------
    def run(self) -> str:
        job, gates = self.job, {**DEFAULT_GATES, **(self.job.get("gates") or {})}
        self.progress = dict(job.get("progress") or {})
        plan = [p for p in job["plan"] if p["action"] != "blocked"]
        loaded, custom, prebuilt = {}, {}, {}
        registry = self.api.call("GET", "/v1/document-factory/worker/registry")
        self.report(stage="train")
        for item in plan:
            t = item["documentType"]
            if item["action"] == "llm_only":
                self.step(t, "skipped", "The LLM route needs no model release.")
                continue
            loaded[t] = self.store.load(t)
            if loaded[t][0]["dataset_digest"] != item["datasetDigest"]:
                self.step(t, "excluded", "The dataset store changed since the job was planned; plan the release again.")
                loaded.pop(t)
                continue
            self.step(t, "running", f"{item['action']} ({item['strategy']})")
            try:
                if item["action"] == "train":
                    custom[t] = self.train(t, "neural" if item["strategy"] == "azure_neural" else "template", *loaded[t])
                elif item["action"] == "reuse":
                    custom[t] = next(m for m in registry["models"] if m["modelVersionId"] == item["reuseModelVersionId"])
                elif item["action"] == "prebuilt":
                    prebuilt[t] = prebuilt_routes()[t]["model"]
            except (RuntimeError, AzureDIError) as error:
                self.step(t, "failed", str(error))
                loaded.pop(t, None)
        classifier, composed_id = None, None
        if custom:
            self.report(stage="classifier")
            classifier, composed_id = self.classify_and_compose(custom, loaded)
            self.report(stage="compose")
        self.report(stage="evaluate")
        types, classification = [], {"documents": 0, "correct": 0}
        for t in sorted(set(custom) | set(prebuilt)):
            route = "custom" if t in custom else "prebuilt"
            metrics, classified = self.evaluate_type(t, route, composed_id if route == "custom" else prebuilt[t], loaded[t])
            if route == "custom":
                classification["documents"] += classified["documents"]
                classification["correct"] += classified["correct"]
            results = evaluate_gates(gates, metrics)
            met = all(g["met"] for g in results)
            types.append({"documentType": t, "datasetDigest": loaded[t][0]["dataset_digest"], "route": route, "release": metrics,
                          "baseline": None, "activeRelease": None, "gates": results, "gatesMet": met})
            self.step(t, "done" if met else "excluded", "Gates met." if met else "Gates not met: " + ", ".join(g["gate"] for g in results if not g["met"]))
        self.report(stage="report")
        body = canonical({"jobId": job["jobId"], "gates": gates, "types": types, "regressions": [], "createdAt": now(),
                          "classification": {**classification, "otherRecall": None} if custom else None})
        report = {**body, "reportDigest": stable_digest(body)}
        self.api.call("POST", "/v1/document-factory/worker/reports", report)
        passing = [t for t in types if t["gatesMet"]]
        release_digest = None
        if passing:
            released_custom = [t for t in passing if t["route"] == "custom"]
            manifest = {"apiVersion": "document-factory/v1", "kind": "DocumentModelRelease", "releaseId": f"rel-{self.short()}", "provider": "azure_document_intelligence",
                        "classifier": {"classifierVersionId": classifier["classifierVersionId"], "providerClassifierId": classifier["providerClassifierId"]} if released_custom else None,
                        "composedModelId": composed_id if released_custom else None,
                        "types": [{"documentType": t["documentType"], "route": t["route"], "mode": "shadow",
                                   "modelVersionId": custom[t["documentType"]]["modelVersionId"] if t["route"] == "custom" else None,
                                   "providerModelId": custom[t["documentType"]]["providerModelId"] if t["route"] == "custom" else prebuilt[t["documentType"]],
                                   "datasetDigest": t["datasetDigest"], "evaluationDigest": report["reportDigest"], "gatesMet": True} for t in passing],
                        "routePolicyDigest": stable_digest({"route_policy": "ehf.default-routes", "version": "0.1.0"}),
                        "adjudicationPolicyDigest": stable_digest({"adjudication_policy": "ehf.default-adjudication", "version": "0.1.0"}),
                        "evaluationReportDigest": report["reportDigest"], "previousReleaseDigest": None, "createdAt": now()}
            release_digest = self.api.call("POST", f"/v1/document-factory/worker/jobs/{job['jobId']}/release", manifest)["digest"]
        self.report(status="completed", reportDigest=report["reportDigest"], releaseDigest=release_digest,
                    error=None if passing else "No type met its gates; nothing was released.")
        return report["reportDigest"]


def run_once(api: ControlApi, store: DatasetStore, backend: Backend, owner: str) -> str | None:
    job = api.call("POST", "/v1/document-factory/worker/claim", {"owner": owner}).get("job")
    if not job:
        return None
    runner = JobRun(job, api, store, backend, owner)
    try:
        return runner.run()
    except Cancelled:
        api.call("POST", f"/v1/document-factory/worker/jobs/{job['jobId']}/progress", {"owner": owner, "status": "cancelled"})
        return None
    except Exception as error:  # a failed job reports its reason; the worker keeps serving
        api.call("POST", f"/v1/document-factory/worker/jobs/{job['jobId']}/progress", {"owner": owner, "status": "failed", "error": str(error)[:500]})
        return None


def managed_identity_token(resource: str) -> Callable[[], str]:
    endpoint = os.environ["IDENTITY_ENDPOINT"]
    secret = os.environ["IDENTITY_HEADER"]
    params = {"api-version": "2019-08-01", "resource": resource}
    if client_id := os.environ.get("AZURE_CLIENT_ID"):
        params["client_id"] = client_id
    token = ""
    expires = 0.0

    def get() -> str:
        nonlocal token, expires
        if time.time() >= expires - 60:
            response = httpx.get(endpoint, params=params, headers={"X-IDENTITY-HEADER": secret}, timeout=10)
            if response.status_code != 200:
                raise RuntimeError(f"managed identity token request failed with HTTP {response.status_code}")
            body = response.json()
            token, expires = body["access_token"], float(body["expires_on"])
        return token

    return get


def serve_health(port: int, api: ControlApi) -> ThreadingHTTPServer:
    class HealthHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/healthz":
                self.send_error(404)
                return
            try:
                ready = api.call("GET", "/v1/document-factory/worker/ready").get("status") == "ready"
            except Exception:
                ready = False
            self.send_response(200 if ready else 503)
            self.end_headers()

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("0.0.0.0", port), HealthHandler)
    Thread(target=server.serve_forever, daemon=True).start()
    return server


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    env = os.environ
    control_url = env["CONTROL_API_URL"]
    if env.get("SECURITY_PROFILE") == "production" and urlsplit(control_url).scheme != "https":
        raise SystemExit("Factory requires an HTTPS control API in production")
    api = ControlApi(control_url, OutboundToken("FACTORY_WORKER_SERVICE_TOKEN"))
    store = DatasetStore(Path(env["FACTORY_DATASET_ROOT"]), env.get("FACTORY_SPLIT_SALT", "ehf-factory-split-v1"))
    owner = f"factory-worker-{uuid.uuid4().hex[:8]}"
    if argv[:1] == ["sync"]:
        for version in sync(store, api, owner):
            print(f"{version['documentType']}: dataset {version['datasetDigest'][:12]} {version['counts']}")
        return 0
    if argv[:1] not in (["run"], ["once"]):
        print(__doc__)
        return 2
    identity = env.get("AZURE_DOCUMENT_INTELLIGENCE_AUTH", "key") == "managed_identity"
    if identity:
        token = managed_identity_token("https://cognitiveservices.azure.com")
        def headers() -> dict[str, str]:
            return {"Authorization": f"Bearer {token()}"}
    else:
        key = env.get("AZURE_DOCUMENT_INTELLIGENCE_KEY")
        if not key:
            raise SystemExit("AZURE_DOCUMENT_INTELLIGENCE_KEY is required in key authentication mode")
        def headers() -> dict[str, str]:
            return {"Ocp-Apim-Subscription-Key": key}
    transport = urllib_transport(120.0)
    container = None
    if url := env.get("FACTORY_TRAINING_CONTAINER_URL"):
        container = TrainingContainer(url, transport, managed_identity_token("https://storage.azure.com/") if identity else None)
    backend = Backend(AzureDI(env["AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT"], headers, transport), container)
    prebuilt_routes()
    if argv[:1] == ["once"]:
        print(run_once(api, store, backend, owner) or "no job ran")
        return 0
    stopping = []
    signal.signal(signal.SIGTERM, lambda *_: stopping.append(True))
    health = serve_health(int(env["FACTORY_HEALTH_PORT"]), api) if env.get("FACTORY_HEALTH_PORT") else None
    delay = float(env.get("FACTORY_POLL_SECONDS", "10"))
    next_sync = 0.0
    try:
        while not stopping:
            try:
                if health and time.monotonic() >= next_sync:
                    next_sync = time.monotonic() + 300
                    sync(store, api, owner)
                if run_once(api, store, backend, owner) is not None:
                    continue
            except (OSError, RuntimeError, ValueError, httpx.RequestError) as error:
                print(f"Factory polling failed ({type(error).__name__}); retrying", file=sys.stderr)
            time.sleep(delay)
    finally:
        if health:
            health.shutdown()
            health.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
