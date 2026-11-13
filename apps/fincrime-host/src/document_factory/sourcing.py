"""The sourcing manifest: one record per catalog document type (plan §8.3).

The manifest answers four questions per type: where samples come from, whether they may be used
for training or evaluation, which fields they provide, and how accuracy is measured.

It is built from two inputs:

* generated defaults, derived deterministically from the catalog and the family source table
  below, and
* human reviews (``resources/sourcing-reviews.yaml``): rights decisions, status and notes.

Regenerating never overwrites a review. Rights default to ``pending_review``; only an explicit
review, or the one standing rule for generated synthetic content, can allow a use.
"""
from __future__ import annotations

from datetime import date
from importlib import resources
from typing import Literal

import yaml
from pydantic import Field, model_validator

from kyc_documents import CATALOG_VERSION
from kyc_documents.fields import FIELDS
from kyc_documents.model import ClosedModel, fingerprint
from kyc_documents.profiles import PROFILES
from kyc_documents.runtime import contract

from . import FACTORY_API_VERSION

SourceKind = Literal["authentic_public", "official_template", "specimen", "synthetic", "partner_authorized", "tenant_provided"]
Collection = Literal["api", "bulk", "download", "reference", "render", "partner", "tenant_upload"]
Decision = Literal["allowed", "prohibited", "pending_review"]
Strategy = Literal["azure_prebuilt", "azure_neural", "azure_template", "layout_llm", "llm_only", "structured_input"]
StructuredTruth = Literal["xbrl", "companies_house_api", "by_construction", "none"]
PersonalData = Literal["none_expected", "officers_and_psc", "natural_persons", "identity_document_subjects", "unknown"]
Status = Literal["unreviewed", "planned", "collecting", "labeled", "ready", "blocked"]
Purpose = Literal["train", "validation", "test"]

COMPARATORS = ("identifier_exact", "legal_name_equivalent", "person_name_equivalent", "name_equivalent", "form_designation", "date_strict", "address_components",
               "amount_currency", "percent_fraction", "text_normalized", "rows_by_key")
NEEDS = {  # samples per split; prebuilt and LLM strategies are evaluated, not trained (plan §8.5)
    "azure_neural": (15, 5, 30), "azure_template": (15, 5, 30),
    "azure_prebuilt": (0, 5, 30), "layout_llm": (0, 5, 30), "llm_only": (0, 5, 30), "structured_input": (0, 0, 0)}
PIPELINE_PROOF_TEST_MINIMUM = 10


class Rights(ClosedModel):
    licence: str | None = None
    licence_url: str | None = None
    training_use: Decision = "pending_review"
    evaluation_use: Decision = "pending_review"
    redistribution: Decision = "pending_review"
    commit_to_repo: bool = False
    attribution: str | None = None
    agreement_ref: str | None = None
    reviewed_by: str | None = None
    reviewed_at: date | None = None

    @model_validator(mode="after")
    def _decisions_are_attributed(self):
        decided = {self.training_use, self.evaluation_use, self.redistribution} != {"pending_review"}
        if decided and not (self.reviewed_by and self.reviewed_at):
            raise ValueError("a rights decision requires reviewed_by and reviewed_at")
        if self.commit_to_repo and self.redistribution != "allowed":
            raise ValueError("committing to the repository requires redistribution: allowed")
        return self


class Privacy(ClosedModel):
    personal_data: PersonalData
    handling: Literal["none", "minimize_and_restrict", "exclude_natural_person_filings", "specimen_only", "tenant_policy"]


class Source(ClosedModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    source_kind: SourceKind
    collection: Collection
    jurisdiction: str | None
    purposes: tuple[Purpose, ...]
    rights: Rights
    privacy: Privacy
    structured_truth: StructuredTruth
    note: str | None = None

    @model_validator(mode="after")
    def _kind_rules(self):
        if self.source_kind == "official_template" and "test" in self.purposes:
            raise ValueError("a blank template is never a populated test sample; use a synthetic fill")
        if self.source_kind == "partner_authorized" and self.rights.training_use == "allowed" and not self.rights.agreement_ref:
            raise ValueError("partner samples need an agreement reference before any use is allowed")
        return self

    def usable_for(self, purpose: Purpose) -> bool:
        decision = self.rights.evaluation_use if purpose in ("validation", "test") else self.rights.training_use
        return purpose in self.purposes and decision == "allowed"


class Needs(ClosedModel):
    train: int = Field(ge=0)
    validation: int = Field(ge=0)
    test: int = Field(ge=0)
    pipeline_proof_test: int = Field(ge=0)


class Measurement(ClosedModel):
    key_fields: tuple[str, ...]
    comparators: dict[str, str]


class ManifestEntry(ClosedModel):
    document_type: str
    family: str
    artifact_kind: str
    contract_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    pilot: Literal["model", "sourcing", "none"]
    strategy_hypothesis: Strategy
    rationale: str
    variants: tuple[str, ...] = ()
    needs: Needs
    sources: tuple[Source, ...]
    measurement: Measurement
    status: Status
    qualification_gap: str | None
    notes: str | None = None

    @model_validator(mode="after")
    def _status_rules(self):
        if self.status in ("collecting", "labeled", "ready") and not any(
                s.usable_for(p) for s in self.sources for p in ("train", "validation", "test")):
            raise ValueError(f"{self.document_type}: status {self.status} needs a source whose rights allow a use")
        if len({s.id for s in self.sources}) != len(self.sources):
            raise ValueError(f"{self.document_type}: duplicate source ids")
        return self


# --- Source registry -------------------------------------------------------------------------
# Defaults only. Licences are recorded as stated by the source and stay pending until reviewed.

def _pending(licence=None, url=None, attribution=None):
    return {"licence": licence, "licence_url": url, "attribution": attribution}


SYNTHETIC_RULE = "rule:synthetic-generated-content"
SOURCE_DEFAULTS: dict[str, dict] = {
    "sec_edgar": dict(source_kind="authentic_public", collection="api", jurisdiction="US", purposes=("train", "validation", "test"),
        rights=_pending("SEC EDGAR public filings; EDGAR fair-access policy (declared User-Agent, rate limit)",
                        "https://www.sec.gov/about/developer-resources"),
        privacy={"personal_data": "officers_and_psc", "handling": "minimize_and_restrict"}, structured_truth="xbrl"),
    "companies_house_documents": dict(source_kind="authentic_public", collection="api", jurisdiction="GB", purposes=("train", "validation", "test"),
        rights=_pending("Open Government Licence v3.0", "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
                        "Contains public sector information licensed under the Open Government Licence v3.0"),
        privacy={"personal_data": "officers_and_psc", "handling": "minimize_and_restrict"}, structured_truth="companies_house_api"),
    "courtlistener_recap": dict(source_kind="authentic_public", collection="api", jurisdiction="US", purposes=("train", "validation", "test"),
        rights=_pending(), privacy={"personal_data": "natural_persons", "handling": "exclude_natural_person_filings"},
        structured_truth="none", note="Business entities only; personal bankruptcy filings are excluded."),
    "regulator_publications": dict(source_kind="authentic_public", collection="download", jurisdiction=None, purposes=("train", "validation", "test"),
        rights=_pending(), privacy={"personal_data": "unknown", "handling": "minimize_and_restrict"}, structured_truth="none"),
    "irs_990_filings": dict(source_kind="authentic_public", collection="bulk", jurisdiction="US", purposes=("train", "validation", "test"),
        rights=_pending("IRS exempt organization e-file data"), privacy={"personal_data": "officers_and_psc", "handling": "minimize_and_restrict"},
        structured_truth="none"),
    "irs_forms": dict(source_kind="official_template", collection="download", jurisdiction="US", purposes=("train",),
        rights=_pending("US federal government work", "https://www.irs.gov/forms-instructions"),
        privacy={"personal_data": "none_expected", "handling": "none"}, structured_truth="none",
        note="Blank forms: the base for synthetic fills, never a populated sample."),
    "wolfsberg_questionnaires": dict(source_kind="official_template", collection="download", jurisdiction=None, purposes=("train",),
        rights=_pending("Wolfsberg Group publication terms"), privacy={"personal_data": "none_expected", "handling": "none"},
        structured_truth="none"),
    "prado_specimens": dict(source_kind="specimen", collection="reference", jurisdiction="EU", purposes=("validation", "test"),
        rights=_pending("Council of the EU PRADO reuse terms", "https://www.consilium.europa.eu/prado/en/prado-start-page.html"),
        privacy={"personal_data": "identity_document_subjects", "handling": "specimen_only"}, structured_truth="none",
        note="Classifier and layout reference; small test sets only."),
    "synthetic_render": dict(source_kind="synthetic", collection="render", jurisdiction=None, purposes=("train", "validation", "test"),
        rights={"licence": "Generated by the Factory from fictional data", "training_use": "allowed", "evaluation_use": "allowed",
                "redistribution": "allowed", "commit_to_repo": True, "reviewed_by": SYNTHETIC_RULE, "reviewed_at": "2026-11-12"},
        privacy={"personal_data": "none_expected", "handling": "none"}, structured_truth="by_construction"),
    "partner_samples": dict(source_kind="partner_authorized", collection="partner", jurisdiction=None, purposes=("validation", "test"),
        rights=_pending(), privacy={"personal_data": "natural_persons", "handling": "minimize_and_restrict"}, structured_truth="none",
        note="Needs a written agreement; required to qualify synthetic-only types."),
    "tenant_provided": dict(source_kind="tenant_provided", collection="tenant_upload", jurisdiction=None, purposes=("train", "validation", "test"),
        rights=_pending(), privacy={"personal_data": "unknown", "handling": "tenant_policy"}, structured_truth="none",
        note="Tenant overlay releases only, under a recorded training authorization."),
}

# --- Family defaults (plan §8.2 first-pass coverage) ------------------------------------------
_PUBLIC_CORPORATE = ("companies_house_documents", "sec_edgar", "synthetic_render")
_SYNTHETIC_PARTNER = ("synthetic_render", "partner_samples")
FAMILY_DEFAULTS: dict[str, tuple[Strategy, tuple[str, ...], str]] = {
    "entity_formation": ("azure_neural", _PUBLIC_CORPORATE, "Registry-issued layouts with few, stable fields."),
    "entity_changes": ("azure_neural", _PUBLIC_CORPORATE, "Registry filings with stable layouts."),
    "constitutional_and_governance": ("layout_llm", ("companies_house_documents", "sec_edgar", "synthetic_render"), "Long, variable legal text."),
    "financial_reporting": ("layout_llm", ("sec_edgar", "companies_house_documents", "synthetic_render"), "Long reports; values in tables and narrative."),
    "ownership_records": ("azure_neural", _PUBLIC_CORPORATE, "Registers and disclosures with tabular ownership rows."),
    "ownership_transactions_and_control": ("layout_llm", ("sec_edgar", "synthetic_render"), "Agreements: long, variable text."),
    "funding_and_distributions": ("layout_llm", ("sec_edgar",) + _SYNTHETIC_PARTNER, "Agreements and confirmations; mostly private."),
    "funds_and_nonprofits": ("layout_llm", ("sec_edgar", "irs_990_filings", "synthetic_render"), "Prospectuses and constitutive documents."),
    "management_and_authority": ("azure_neural", _PUBLIC_CORPORATE, "Resolutions, registers and powers of attorney."),
    "legal_and_regulatory_context": ("layout_llm", ("courtlistener_recap", "regulator_publications", "synthetic_render"), "Narrative legal text."),
    "commercial_and_trade": ("layout_llm", ("sec_edgar",) + _SYNTHETIC_PARTNER, "Contracts and invoices; mostly private."),
    "sector_licensing": ("azure_neural", ("regulator_publications",) + _SYNTHETIC_PARTNER, "Regulator-issued licences; registers are public, documents mostly not."),
    "us_tax_forms": ("azure_template", ("irs_forms", "synthetic_render"), "Fixed official layouts; fill templates by construction."),
    "tax_registration_and_returns": ("azure_template", ("irs_forms", "irs_990_filings") + _SYNTHETIC_PARTNER, "Official forms plus authentic nonprofit returns."),
    "tax_self_certification": ("azure_neural", _SYNTHETIC_PARTNER, "Institution-specific self-certification forms."),
    "personal_identity": ("azure_prebuilt", ("prado_specimens",) + _SYNTHETIC_PARTNER, "Prebuilt identity models; evaluation data only."),
    "residence_and_status": ("azure_neural", ("prado_specimens",) + _SYNTHETIC_PARTNER, "Issuer-specific layouts; specimens for reference."),
    "civil_and_representative": ("azure_neural", _SYNTHETIC_PARTNER, "Civil registry documents; real samples are private."),
    "certification_and_translation": ("azure_neural", _SYNTHETIC_PARTNER, "Short certificates with stable fields."),
    "relationship_and_application": ("azure_template", ("synthetic_render", "tenant_provided"), "Institution application forms."),
    "shipping_and_trade_finance": ("azure_neural", _SYNTHETIC_PARTNER, "Trade documents; templates are mostly proprietary."),
    "address_evidence": ("azure_neural", _SYNTHETIC_PARTNER, "Bills and letters; real samples are private."),
    "bank_and_account_evidence": ("azure_neural", _SYNTHETIC_PARTNER, "Statements; real samples are private."),
    "earnings_and_benefits": ("azure_neural", _SYNTHETIC_PARTNER, "Payslips and statements; real samples are private."),
    "employment_and_support": ("layout_llm", _SYNTHETIC_PARTNER, "Letters with variable text."),
    "property_and_occupancy": ("layout_llm", ("sec_edgar",) + _SYNTHETIC_PARTNER, "Leases and titles; some leases are SEC exhibits."),
    "asset_realization_and_investment": ("azure_neural", _SYNTHETIC_PARTNER, "Confirmations and statements; mostly private."),
    "business_operations": ("layout_llm", _SYNTHETIC_PARTNER, "Narrative business documents."),
    "trust_and_fiduciary": ("layout_llm", _SYNTHETIC_PARTNER, "Private legal instruments."),
    "estate": ("layout_llm", _SYNTHETIC_PARTNER, "Private legal instruments."),
    "wealth_and_edd_declarations": ("layout_llm", _SYNTHETIC_PARTNER, "Customer declarations; narrative."),
    "digital_asset_provenance": ("azure_neural", _SYNTHETIC_PARTNER, "Exchange statements and transfer records."),
    "insurance_evidence": ("azure_neural", _SYNTHETIC_PARTNER, "Policy schedules."),
    "institutional_assessments": ("llm_only", ("tenant_provided", "synthetic_render"), "Institution-generated records."),
    "institutional_controls": ("llm_only", ("tenant_provided", "wolfsberg_questionnaires", "synthetic_render"), "Institution documents and industry questionnaires."),
    "digital_and_verification": ("structured_input", ("tenant_provided",), "Vendor outputs, normally structured; no extraction model."),
    "digital_credentials": ("structured_input", ("tenant_provided",), "Structured credentials; no extraction model."),
    "physical_evidence": ("structured_input", ("tenant_provided",), "Capture records; no extraction model."),
}

# In these families only some types have authentic public samples (plan §8.2). The others fall back
# to synthetic and partner sources.
PARTIAL_AUTHENTIC: dict[str, frozenset[str]] = {
    "financial_reporting": frozenset({"annual_report", "audited_financial_statements", "unaudited_financial_statements"}),
    "ownership_records": frozenset({"annual_return", "beneficial_ownership_registry_extract", "substantial_shareholder_disclosure",
                                    "share_certificate"}),
    "ownership_transactions_and_control": frozenset({"business_acquisition_agreement", "share_subscription_agreement",
                                                     "shareholder_agreement"}),
    "funding_and_distributions": frozenset({"loan_agreement", "investment_funding_agreement"}),
    "funds_and_nonprofits": frozenset({"fund_prospectus", "fund_constituting_agreement"}),
    "management_and_authority": frozenset({"appointment_instrument", "board_resolution", "certificate_of_incumbency",
                                           "officeholder_list", "power_of_attorney"}),
    "legal_and_regulatory_context": frozenset({"court_judgment", "regulatory_notice", "sanctions_licence"}),
    "commercial_and_trade": frozenset({"commercial_contract", "escrow_agreement"}),
    "property_and_occupancy": frozenset({"commercial_lease"}),
    "sector_licensing": frozenset({"investment_firm_authorization", "money_services_registration", "vasp_registration"}),
}

# --- Pilots (plan §8.6) -----------------------------------------------------------------------
MODEL_PILOT: dict[str, tuple[Strategy, tuple[str, ...], tuple[str, ...]]] = {
    "passport": ("azure_prebuilt", ("prado_specimens", "synthetic_render", "partner_samples"), ()),
    "national_identity_card": ("azure_prebuilt", ("prado_specimens", "synthetic_render", "partner_samples"), ()),
    # No prebuilt W-9 model on Azure Document Intelligence API 2024-11-30 (W-2, W-4, 1040, 1098, 1099 only).
    "w9": ("azure_template", ("irs_forms", "synthetic_render"), ()),
    "w8bene": ("azure_template", ("irs_forms", "synthetic_render"), ()),
    "certificate_of_incorporation": ("azure_neural", ("companies_house_documents", "sec_edgar", "synthetic_render"),
                                     ("gb_registry_certificate", "us_state_charter")),
    "articles_of_association": ("layout_llm", ("companies_house_documents", "sec_edgar", "synthetic_render"), ()),
    "annual_return": ("azure_neural", ("companies_house_documents", "synthetic_render"), ("gb_confirmation_statement",)),
    "substantial_shareholder_disclosure": ("azure_neural", ("sec_edgar", "synthetic_render"), ("us_schedule_13d", "us_schedule_13g")),
    "bank_statement": ("azure_prebuilt", ("synthetic_render", "partner_samples"), ()),
    "utility_bill": ("azure_neural", ("synthetic_render", "partner_samples"), ()),
}
SOURCING_PILOT: dict[str, tuple[str, ...]] = {
    "company_name_change_certificate": ("companies_house_documents",),
    "beneficial_ownership_registry_extract": ("companies_house_documents",),
    "appointment_instrument": ("companies_house_documents",),
    "liquidator_appointment": ("companies_house_documents",),
    "audited_financial_statements": ("companies_house_documents", "sec_edgar"),
    "annual_report": ("sec_edgar",), "corporate_bylaws": ("sec_edgar",), "loan_agreement": ("sec_edgar",),
    "business_acquisition_agreement": ("sec_edgar",), "shareholder_agreement": ("sec_edgar",),
    "share_certificate": ("sec_edgar",), "power_of_attorney": ("sec_edgar",), "fund_prospectus": ("sec_edgar",),
    "investment_firm_authorization": ("sec_edgar",),
    "w8ben": ("irs_forms",), "w8imy": ("irs_forms",), "corporate_tax_return": ("irs_forms", "irs_990_filings"),
    "court_judgment": ("courtlistener_recap",), "insolvency_order": ("courtlistener_recap",),
    "residence_permit": ("prado_specimens",),
}

_NAME_COMPARATORS = {"entity_name": "legal_name_equivalent", "issuer_name": "legal_name_equivalent",
                     "person_name": "person_name_equivalent", "subject_name": "name_equivalent",
                     "tax_form_type": "form_designation"}
_TYPE_COMPARATORS = {"identifier": "identifier_exact", "date": "date_strict", "datetime": "date_strict",
                     "decimal": "amount_currency", "integer": "amount_currency", "Address": "address_components",
                     "text": "text_normalized", "texts": "text_normalized"}


def comparator_for(field_name: str) -> str:
    if field_name in _NAME_COMPARATORS:
        return _NAME_COMPARATORS[field_name]
    kind = FIELDS[field_name].value_type
    if kind.startswith("["):
        return "rows_by_key"
    if kind == "decimal" and ("percent" in field_name or "ownership" in field_name):
        return "percent_fraction"
    return _TYPE_COMPARATORS.get(kind, "text_normalized")


def _source(source_id: str, review: dict | None) -> Source:
    defaults = dict(SOURCE_DEFAULTS[source_id])
    rights = dict(defaults.pop("rights"))
    note = defaults.pop("note", None)
    if review:
        unknown = set(review) - {"rights", "note"}
        if unknown:
            raise ValueError(f"unknown review keys for source {source_id}: {sorted(unknown)}")
        rights.update(review.get("rights", {}))
        note = review.get("note", note)
    return Source(id=source_id, rights=Rights.model_validate(rights, strict=False), privacy=Privacy(**defaults.pop("privacy")),
                  note=note, **defaults)


def _qualification_gap(strategy: Strategy, sources: tuple[Source, ...]) -> str | None:
    if strategy == "structured_input":
        return None
    kinds = {s.source_kind for s in sources}
    if not kinds & {"authentic_public", "partner_authorized", "tenant_provided", "specimen"}:
        return "Synthetic and template sources only: production qualification needs a partner or tenant test set."
    if not kinds & {"authentic_public", "partner_authorized", "tenant_provided"}:
        return "Specimens only: production qualification needs a partner or tenant test set."
    return None


def load_reviews() -> dict:
    text = resources.files("document_factory").joinpath("resources/sourcing-reviews.yaml").read_text(encoding="utf-8")
    data = yaml.safe_load(text) or {}
    if set(data) - {"version", "reviews"}:
        raise ValueError("sourcing-reviews.yaml has unknown top-level keys")
    reviews = data.get("reviews") or {}
    unknown = set(reviews) - set(PROFILES)
    if unknown:
        raise ValueError(f"reviews name unknown document types: {sorted(unknown)}")
    return reviews


def build_entry(identifier: str, review: dict | None = None) -> ManifestEntry:
    profile = PROFILES[identifier]
    review = review or {}
    if set(review) - {"status", "sources", "notes", "strategy_hypothesis", "rationale"}:
        raise ValueError(f"{identifier}: unknown review keys")
    strategy, source_ids, rationale = FAMILY_DEFAULTS[profile.family]
    if profile.family in PARTIAL_AUTHENTIC and identifier not in PARTIAL_AUTHENTIC[profile.family]:
        source_ids = tuple(dict.fromkeys(
            [s for s in source_ids if SOURCE_DEFAULTS[s]["source_kind"] != "authentic_public"] + list(_SYNTHETIC_PARTNER)))
        rationale += " No authentic public samples for this type; synthetic and partner sources."
    variants: tuple[str, ...] = ()
    pilot = "none"
    if identifier in MODEL_PILOT:
        strategy, source_ids, variants = MODEL_PILOT[identifier]
        pilot, rationale = "model", "Model pilot (plan §8.6). " + rationale
    elif identifier in SOURCING_PILOT:
        source_ids = tuple(dict.fromkeys(SOURCING_PILOT[identifier] + source_ids))
        pilot, rationale = "sourcing", "Sourcing pilot (plan §8.6). " + rationale
    if profile.artifact_kind != "document" and strategy != "structured_input":
        strategy, rationale = "llm_only", f"Artifact kind {profile.artifact_kind}; no layout model. " + rationale
    strategy = review.get("strategy_hypothesis", strategy)
    source_reviews = review.get("sources") or {}
    unknown_sources = set(source_reviews) - set(source_ids)
    if unknown_sources:
        raise ValueError(f"{identifier}: reviews for sources not in the entry: {sorted(unknown_sources)}")
    sources = tuple(_source(s, source_reviews.get(s)) for s in source_ids)
    train, validation, test = NEEDS[strategy]
    return ManifestEntry(
        document_type=identifier, family=profile.family, artifact_kind=profile.artifact_kind,
        contract_hash=contract(identifier)["contract_hash"], pilot=pilot, strategy_hypothesis=strategy,
        rationale=review.get("rationale", rationale), variants=variants,
        needs=Needs(train=train, validation=validation, test=test,
                    pipeline_proof_test=min(PIPELINE_PROOF_TEST_MINIMUM, test)),
        sources=sources,
        measurement=Measurement(key_fields=profile.key_fields,
                                comparators={k: comparator_for(k) for k in profile.key_fields}),
        status=review.get("status", "planned" if pilot != "none" else "unreviewed"),
        qualification_gap=_qualification_gap(strategy, sources), notes=review.get("notes"))


def build_manifest(reviews: dict | None = None) -> dict:
    reviews = load_reviews() if reviews is None else reviews
    if set(reviews) - set(PROFILES):
        raise ValueError(f"reviews name unknown document types: {sorted(set(reviews) - set(PROFILES))}")
    missing = {p.family for p in PROFILES.values()} - set(FAMILY_DEFAULTS)
    if missing:
        raise ValueError(f"families without sourcing defaults: {sorted(missing)}")
    for pilot in (MODEL_PILOT, SOURCING_PILOT):
        unknown = set(pilot) - set(PROFILES)
        if unknown:
            raise ValueError(f"pilot names unknown document types: {sorted(unknown)}")
    if set(MODEL_PILOT) & set(SOURCING_PILOT):
        raise ValueError("a type is listed in both pilots")
    entries = [build_entry(i, reviews.get(i)).model_dump(mode="json") for i in sorted(PROFILES)]
    registry = {s: _source(s, None).model_dump(mode="json") for s in sorted(SOURCE_DEFAULTS)}
    body = {"api_version": FACTORY_API_VERSION, "kind": "SourcingManifest", "catalog_version": CATALOG_VERSION,
            "catalog_digest": fingerprint(sorted((e["document_type"], e["contract_hash"]) for e in entries)),
            "comparators": list(COMPARATORS), "source_registry": registry, "summary": summarize(entries),
            "entries": [_compact(e, registry) for e in entries]}
    return {**body, "manifest_digest": fingerprint(body)}


def _compact(entry: dict, registry: dict) -> dict:
    """Store each source as its id plus what a review changed; expand() restores it."""
    def diff(source):
        default = registry[source["id"]]
        changed = {k: v for k, v in source.items() if k != "id" and v != default[k]}
        return {"id": source["id"], **changed}
    return {**entry, "sources": [diff(s) for s in entry["sources"]]}


def expand(manifest: dict) -> list[ManifestEntry]:
    """The manifest's entries with every source's effective settings, validated."""
    registry = manifest["source_registry"]
    return [ManifestEntry.model_validate({**e, "sources": [{**registry[s["id"]], **s} for s in e["sources"]]}, strict=False)
            for e in manifest["entries"]]


def summarize(entries: list[dict]) -> dict:
    def count(key):
        out: dict[str, int] = {}
        for value in key:
            out[value] = out.get(value, 0) + 1
        return dict(sorted(out.items()))
    primary = [next((s["source_kind"] for s in e["sources"] if s["source_kind"] != "synthetic"), "synthetic") for e in entries]
    return {"document_types": len(entries),
            "by_strategy": count(e["strategy_hypothesis"] for e in entries),
            "by_primary_source_kind": count(primary),
            "by_status": count(e["status"] for e in entries),
            "pilot": {"model": sorted(e["document_type"] for e in entries if e["pilot"] == "model"),
                      "sourcing": sorted(e["document_type"] for e in entries if e["pilot"] == "sourcing")},
            "with_qualification_gap": sum(1 for e in entries if e["qualification_gap"]),
            "sources_with_allowed_training_use": sorted({s["id"] for e in entries for s in e["sources"]
                                                         if s["rights"]["training_use"] == "allowed"})}
