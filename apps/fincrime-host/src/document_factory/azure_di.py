"""Azure Document Intelligence training operations for the Factory worker (API 2024-11-30).

Build a custom extraction model (`template` or `neural`) from a Blob training folder, build a classifier from
per-type folders (including `other`), compose models under a classifier, and analyze with a model for evaluation.
Every long-running call returns an operation that is polled to a terminal state; nothing is retried until it
succeeds. Training data is read by the Document Intelligence resource itself from Blob Storage: a container URL
the resource can reach with its managed identity, or a SAS URL handed in by the caller and never logged.

Template and classifier training are free on Azure; neural training is billed by the hour beyond a monthly
allowance, so the worker only builds what an approved plan names.
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable

API_VERSION = "2024-11-30"
ENDPOINT = re.compile(r"^https://[a-z0-9][a-z0-9-]{1,62}\.(cognitiveservices\.azure\.com|services\.ai\.azure\.com)$")
MODEL_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._~-]{1,63}$")
TERMINAL = {"succeeded", "failed", "canceled"}
MAX_THROTTLE_RETRIES = 8


class AzureDIError(RuntimeError):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code, self.detail = code, detail


Transport = Callable[[str, str, dict, bytes | None], tuple[int, dict, bytes]]


def urllib_transport(timeout: float = 60.0) -> Transport:
    def send(method: str, url: str, headers: dict, body: bytes | None):
        request = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, dict(response.headers), response.read(4_000_000)
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers or {}), error.read(200_000)
    return send


@dataclass
class AzureDI:
    endpoint: str
    credential: Callable[[], dict]  # returns {"Ocp-Apim-Subscription-Key": ...} or {"Authorization": "Bearer ..."}
    transport: Transport
    sleep: Callable[[float], None] = time.sleep
    poll_seconds: float = 5.0
    max_wait_seconds: float = 6 * 3600

    def __post_init__(self):
        self.endpoint = self.endpoint.rstrip("/")
        if not ENDPOINT.match(self.endpoint):
            raise AzureDIError("endpoint_invalid", "expected https://<resource>.cognitiveservices.azure.com")

    def _url(self, path: str) -> str:
        return f"{self.endpoint}/documentintelligence/{path}{'&' if '?' in path else '?'}api-version={API_VERSION}"

    def _call(self, method: str, url: str, body: dict | None = None) -> tuple[int, dict, dict]:
        if not url.startswith(self.endpoint + "/"):
            raise AzureDIError("operation_host_mismatch")
        headers = {"Accept": "application/json", **self.credential(), **({"Content-Type": "application/json"} if body is not None else {})}
        # Azure throttles per resource: honour Retry-After on 429 a bounded number of times, never indefinitely.
        for _ in range(MAX_THROTTLE_RETRIES):
            status, response_headers, raw = self.transport(method, url, headers, json.dumps(body).encode() if body is not None else None)
            if status != 429:
                break
            retry = {k.lower(): v for k, v in response_headers.items()}.get("retry-after", "")
            self.sleep(min(float(retry) if retry.replace(".", "", 1).isdigit() else 2.0, 60.0))
        try:
            payload = json.loads(raw) if raw else {}
        except ValueError:
            payload = {}
        if status >= 400:
            error = payload.get("error") or {}
            raise AzureDIError(f"http_{status}", str(error.get("code") or "")[:80])
        return status, {k.lower(): v for k, v in response_headers.items()}, payload

    def _start(self, path: str, body: dict) -> str:
        status, headers, _ = self._call("POST", self._url(path), body)
        location = headers.get("operation-location")
        if status != 202 or not location:
            raise AzureDIError("operation_not_started")
        return location

    def wait(self, location: str) -> dict:
        """Poll an operation to its terminal state. A failed or canceled operation raises with Azure's error code."""
        waited = 0.0
        while True:
            _, headers, payload = self._call("GET", location)
            status = payload.get("status")
            if status in TERMINAL:
                if status != "succeeded":
                    error = payload.get("error") or {}
                    inner = (error.get("innererror") or {}).get("code") or ""
                    raise AzureDIError(f"operation_{status}", f"{error.get('code', '')} {inner}".strip()[:160])
                return payload
            delay = float(headers.get("retry-after") or self.poll_seconds)
            if waited + delay > self.max_wait_seconds:
                raise AzureDIError("operation_timeout")
            self.sleep(delay)
            waited += delay

    def build_model(self, model_id: str, mode: str, container_url: str, prefix: str, description: str = "") -> dict:
        if not MODEL_ID.match(model_id) or mode not in ("template", "neural"):
            raise AzureDIError("build_request_invalid")
        result = self.wait(self._start("documentModels:build", {
            "modelId": model_id, "buildMode": mode, "description": description[:400],
            "azureBlobSource": {"containerUrl": container_url, "prefix": prefix.rstrip("/") + "/"}}))
        return result.get("result") or {}

    def build_classifier(self, classifier_id: str, container_url: str, prefixes: dict[str, str], description: str = "") -> dict:
        if not MODEL_ID.match(classifier_id) or len(prefixes) < 2:
            raise AzureDIError("classifier_request_invalid", "a classifier needs at least two classes")
        result = self.wait(self._start("documentClassifiers:build", {
            "classifierId": classifier_id, "description": description[:400],
            "docTypes": {t: {"azureBlobSource": {"containerUrl": container_url, "prefix": p.rstrip("/") + "/"}} for t, p in sorted(prefixes.items())}}))
        return result.get("result") or {}

    def compose(self, model_id: str, classifier_id: str, models: dict[str, str], description: str = "") -> dict:
        """A composed model: the classifier routes each document to its type's model; `other` routes to no model."""
        if not MODEL_ID.match(model_id) or not models:
            raise AzureDIError("compose_request_invalid")
        result = self.wait(self._start("documentModels:compose", {
            "modelId": model_id, "classifierId": classifier_id, "description": description[:400],
            "docTypes": {t: {"modelId": m} for t, m in sorted(models.items())}}))
        return result.get("result") or {}

    def analyze(self, model_id: str, content: bytes) -> dict:
        """Analyze one document with a model; returns `analyzeResult`."""
        if not MODEL_ID.match(model_id):
            raise AzureDIError("model_id_invalid")
        import base64
        location = self._start(f"documentModels/{model_id}:analyze?stringIndexType=unicodeCodePoint",
                               {"base64Source": base64.b64encode(content).decode()})
        return self.wait(location).get("analyzeResult") or {}

    def delete_model(self, model_id: str) -> None:
        if not MODEL_ID.match(model_id):
            raise AzureDIError("model_id_invalid")
        try:
            self._call("DELETE", self._url(f"documentModels/{model_id}"))
        except AzureDIError as error:
            if error.code != "http_404":
                raise
