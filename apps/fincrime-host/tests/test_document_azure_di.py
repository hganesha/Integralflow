"""The Factory's Azure Document Intelligence training client, on recorded-style responses."""
import json

import pytest

from document_factory.azure_di import AzureDI, AzureDIError

ENDPOINT = "https://ehf-test-docs.cognitiveservices.azure.com"


class Fake:
    def __init__(self, polls):
        self.calls, self.polls = [], list(polls)

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, headers, json.loads(body) if body else None))
        if method == "POST":
            return 202, {"Operation-Location": f"{ENDPOINT}/documentintelligence/operations/1?api-version=2024-11-30"}, b""
        status, payload = self.polls.pop(0)
        return status, {"Retry-After": "1"}, json.dumps(payload).encode()


def client(fake):
    return AzureDI(ENDPOINT, lambda: {"Ocp-Apim-Subscription-Key": "k"}, fake, sleep=lambda s: None)


def test_build_polls_to_success_and_sends_the_blob_folder():
    fake = Fake([(200, {"status": "running"}), (200, {"status": "succeeded", "result": {"modelId": "w9-v1", "docTypes": {"w9-v1": {}}}})])
    assert client(fake).build_model("w9-v1", "template", "https://data.blob.core.windows.net/train", "w9/v1")["modelId"] == "w9-v1"
    method, url, headers, body = fake.calls[0]
    assert url == f"{ENDPOINT}/documentintelligence/documentModels:build?api-version=2024-11-30"
    assert body == {"modelId": "w9-v1", "buildMode": "template", "description": "", "azureBlobSource": {"containerUrl": "https://data.blob.core.windows.net/train", "prefix": "w9/v1/"}}
    assert headers["Ocp-Apim-Subscription-Key"] == "k" and len(fake.calls) == 3


def test_a_failed_operation_raises_with_azures_codes():
    fake = Fake([(200, {"status": "failed", "error": {"code": "InvalidRequest", "innererror": {"code": "TrainingContentMissing"}}})])
    with pytest.raises(AzureDIError) as raised:
        client(fake).build_model("w9-v1", "neural", "https://x.blob.core.windows.net/c", "w9")
    assert raised.value.code == "operation_failed" and "TrainingContentMissing" in raised.value.detail


def test_classifier_needs_two_classes_and_compose_names_the_classifier():
    with pytest.raises(AzureDIError):
        client(Fake([])).build_classifier("cls-v1", "https://x.blob.core.windows.net/c", {"w9": "w9"})
    fake = Fake([(200, {"status": "succeeded", "result": {"modelId": "release-v1"}})])
    client(fake).compose("release-v1", "cls-v1", {"w9": "w9-v1", "passport": "prebuilt-idDocument"})
    assert fake.calls[0][3] == {"modelId": "release-v1", "classifierId": "cls-v1", "description": "",
                                "docTypes": {"passport": {"modelId": "prebuilt-idDocument"}, "w9": {"modelId": "w9-v1"}}}


def test_refuses_other_hosts_and_bad_ids():
    with pytest.raises(AzureDIError):
        AzureDI("https://evil.example.com", dict, Fake([]))
    with pytest.raises(AzureDIError):
        client(Fake([])).build_model("../x", "template", "u", "p")
    di = client(Fake([]))
    with pytest.raises(AzureDIError) as raised:
        di.wait("https://evil.example.com/operations/1")
    assert raised.value.code == "operation_host_mismatch"


def test_throttling_is_retried_a_bounded_number_of_times():
    calls = []

    def throttled(method, url, headers, body):
        calls.append(method)
        return 429, {"Retry-After": "1"}, b'{"error": {"code": "429"}}'
    with pytest.raises(AzureDIError) as raised:
        AzureDI(ENDPOINT, dict, throttled, sleep=lambda s: None).build_model("w9-v1", "template", "u", "p")
    assert raised.value.code == "http_429" and len(calls) == 8
