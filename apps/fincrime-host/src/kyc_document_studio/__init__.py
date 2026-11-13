"""Stateless document-skill preview. No Store, case commands, or provider credentials.

The platform supplies parsed pages and, on evaluation, its live provider response. When it also ran a
provider extraction model on the original (Route A, `modelRoute`), evaluation runs the adjudicating
wrapper with every prebuilt type in shadow instead (whatever the case route policy), so the Test Bench
shows both routes and their field outcomes.
Use the released wrapper functions so source validation matches case extraction.
"""
import re
from datetime import datetime, timezone
from types import SimpleNamespace

from kyc_documents import runtime
from kyc_documents.route_policy import SHADOW_ROUTE_POLICY
from financial_crime.contracts import SkillError
from financial_crime.skills.document_wrappers import adjudicated_extract, classify_catalog, contract_extract, validity_assess

ROUTE_ERROR = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")


class PreviewContext:
    def __init__(self, pages, assertions=(), versions=()):
        self.pages, self.assertions, self.versions = pages, assertions, versions

    def rows(self, kind):
        return {"DocumentPage": self.pages, "ExtractedAssertion": self.assertions, "DocumentVersion": self.versions}.get(kind, [])


def prepare(body):
    profile = runtime.resolve(body["documentType"])
    source = runtime.parse_pages(body["pages"])
    if not source or len(source) > 100 or len({p.document_version for p in source}) != 1:
        raise ValueError("invalid source pages")
    pages = [dict(id=p.page_id, page=i + 1, document_version=p.document_version,
                  text=p.text, _ref={"object_id": p.page_id}, _synthetic=False) for i, p in enumerate(source)]
    classification = classify_catalog({}, PreviewContext(pages), None)
    compiled = runtime.contract(profile.id)
    request = {"document_type": profile.id, "contract_hash": compiled["contract_hash"],
               "instructions": compiled["instructions"], "extraction_schema": runtime.extraction_schema(profile.id),
               "pages": [p.model_dump(mode="json") for p in source], "source_digest": runtime.source_digest(source)}
    return {"request": request, "classification": classification, "pages": pages}


async def evaluate(body):
    prepared = prepare(body)
    request = prepared["request"]
    response = body["response"]
    validation = runtime.validate_extraction(body["documentType"], response, request["pages"])
    if not validation["valid"]:
        return {"classification": prepared["classification"], "extraction": None, "validity": None, "validation": validation}

    version = request["pages"][0]["document_version"]
    model_route = body.get("modelRoute")

    async def provider(capability, value):
        if capability == "document.fields" and value == request:
            return SimpleNamespace(payload=response)
        if capability == "document.model" and model_route is not None and value.get("artifact_hash") == version:
            # The platform ran the model on the original already; report its outcome, never a new call.
            if model_route.get("status") != "answered":
                code = str(model_route.get("code") or "SOURCE_UNAVAILABLE")
                raise SkillError(code if ROUTE_ERROR.match(code) else "SOURCE_UNAVAILABLE", "the model route did not answer")
            return SimpleNamespace(payload=model_route["candidates"])
        raise ValueError("unexpected provider request")

    service = SimpleNamespace(provider=provider, invocation=SimpleNamespace(as_of_time=datetime.now(timezone.utc)),
                              route_policy=SHADOW_ROUTE_POLICY)
    # The selected contract is a test target, never a claimed classifier decision.
    target = [{"document_version": version, "document_type": body["documentType"]}]
    if model_route is not None:
        versions = [{"artifact_hash": version, "artifact_ref": "document-studio:" + version, "media_type": "application/octet-stream"}]
        result = await adjudicated_extract({"classifications": target, "subject": "studio-sample"},
                                           PreviewContext(prepared["pages"], versions=versions), service)
    else:
        result = await contract_extract({"classifications": target, "subject": "studio-sample"}, PreviewContext(prepared["pages"]), service)
    assertions = [dict(subject="studio-sample", field=a["path"].split("/")[2], value=a["value"],
                       document_version=a["document_version"], _ref={"path": a["path"]})
                  for a in validation["candidate_assertions"] if a["path"].count("/") == 2]
    return {"classification": prepared["classification"], "extraction": result.payload,
            "validity": validity_assess({}, PreviewContext([], assertions), service), "validation": validation}
