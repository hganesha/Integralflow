"""Synthetic pilot documents whose gold labels are known by construction (plan §8.4 step 7).

Each layout is a list of lines with ``{path}`` placeholders, where a path addresses a leaf of the
catalog's ``extracted_fields`` (``person_name``, ``subject_address/lines/0``,
``accounts/0/closing_balance``). Rendering records the exact Unicode span of every placeholder,
so the label's observations and spans come from the rendering itself, not from a model. Every
label is checked with ``validate_extraction`` before it is returned.

All data is fictional and marked as such: SYNTHETIC/SPECIMEN headers, the ICAO specimen state
"Utopia", "SY" registry prefixes, "00-" tax identifiers (not issued as EINs) and names built from
words such as Example, Sample and Mock. Identity documents carry a SPECIMEN marking and no
security features (plan §8.4).

Phase 0 renders text documents only. Scanned and photographed variants come with the layout
adapter (Phase 1).
"""
from __future__ import annotations

import hashlib
import random
import re
from datetime import date, datetime, timedelta, timezone

from kyc_documents.fields import FIELDS, OBJECTS
from kyc_documents.profiles import PROFILES
from kyc_documents.runtime import _leaves, contract, source_digest, validate_extraction

from .datasets import GoldLabel, Sample
from .sourcing import SOURCE_DEFAULTS, Rights

GENERATOR = "document_factory.synthetic/1"
_PLACEHOLDER = re.compile(r"\{([a-z0-9_/]+)\}")

GIVEN = ("Alex", "Jordan", "Sam", "Robin", "Casey", "Morgan", "Taylor", "Jamie", "Riley", "Avery", "Quinn", "Rowan")
FAMILY = ("Example", "Sampleton", "Placeholder", "Fictor", "Mockridge", "Testwell", "Demoford", "Specimen", "Exampleby")
COMPANY_WORDS = ("Northmock", "Silverfixture", "Lumen Sample", "Oakplaceholder", "Zephyr Example", "Quillmock", "Brightsample",
                 "Fernexample", "Cobaltmock", "Harbour Sample")
COMPANY_SUFFIX = ("Limited", "Ltd", "Holdings Limited", "Trading Limited", "Group Ltd")
LOCALITIES = ("Testbury", "Sampleford", "Mockton", "Exampleham", "Fixture Bay")
JURISDICTIONS = ("England and Wales", "Scotland", "Delaware", "Ontario", "Jersey")
BANKS = ("Example Bank (Synthetic)", "Sample Savings Bank (Synthetic)", "Mockridge Building Society (Synthetic)")
UTILITIES = ("Example Power (Synthetic)", "Sample Water Services (Synthetic)", "Mockton Energy (Synthetic)")


def _date(rng: random.Random, start: date, end: date) -> str:
    return (start + timedelta(days=rng.randrange((end - start).days))).isoformat()


def _person(rng):
    given, family = rng.choice(GIVEN), rng.choice(FAMILY)
    return given, family, f"{given} {family}"


def _company(rng):
    return f"{rng.choice(COMPANY_WORDS)} {rng.choice(COMPANY_SUFFIX)}"


def _address(rng, country="United Kingdom"):
    number, street = rng.randrange(1, 240), rng.choice(("Example Street", "Sample Road", "Mock Lane", "Fixture Avenue"))
    postal = f"ZX{rng.randrange(1, 9)} {rng.randrange(1, 9)}YY" if country == "United Kingdom" else f"{rng.randrange(10000, 99999)}"
    return {"lines": [f"{number} {street}"], "locality": rng.choice(LOCALITIES), "postal_code": postal, "country": country}


def _money(rng, low, high):
    return f"{rng.randrange(low * 100, high * 100) / 100:.2f}"


# --- Values and layouts per pilot type -----------------------------------------------------------

def _identity(rng, title, number_field):
    given, family, name = _person(rng)
    issued = _date(rng, date(2018, 1, 1), date(2024, 12, 31))
    return {"document_title": title, "issuing_jurisdiction": "Utopia", "given_names": given, "family_name": family,
            "person_name": name, number_field: f"SYN{rng.randrange(10**6, 10**7)}",
            "date_of_birth": _date(rng, date(1950, 1, 1), date(2004, 12, 31)), "issue_date": issued,
            "expiry_date": (date.fromisoformat(issued) + timedelta(days=3652)).isoformat(),
            "issuer_name": "Utopia Synthetic Identity Office"}


VALUES = {
    # A passport's number is its document number; an identity card's printed number is the personal ID number.
    "passport": lambda rng: _identity(rng, "SYNTHETIC PASSPORT", "document_number"),
    "national_identity_card": lambda rng: _identity(rng, "SYNTHETIC NATIONAL IDENTITY CARD", "identity_number"),
    "w9": lambda rng: (lambda person, addr: {
        "document_title": "Request for Taxpayer Identification Number and Certification", "tax_form_type": "Form W-9",
        "form_revision": "Rev. SYN-01", "subject_name": person[2], "tax_identifier": f"00-{rng.randrange(10**6, 10**7)}",
        "tax_entity_classification": rng.choice(("Individual/sole proprietor", "C corporation", "Limited liability company")),
        "subject_address": addr})(_person(rng), _address(rng, "United States")),
    "w8bene": lambda rng: (lambda company, signer: {
        "document_title": "Certificate of Status of Beneficial Owner for United States Tax Withholding and Reporting (Entities)",
        "tax_form_type": "Form W-8BEN-E", "subject_name": company,
        "chapter3_status": rng.choice(("Corporation", "Partnership", "Simple trust")),
        "chapter4_status": rng.choice(("Active NFFE", "Passive NFFE", "Exempt beneficial owner")),
        "foreign_tax_identifier": f"SYN-TIN-{rng.randrange(10**5, 10**6)}", "permanent_residence_address": _address(rng),
        "signatures": [{"signer_name": signer[2], "capacity": "Director", "signed_at": _date(rng, date(2025, 1, 1), date(2026, 10, 31))}]})(
            _company(rng), _person(rng)),
    "certificate_of_incorporation": lambda rng: {
        "document_title": "CERTIFICATE OF INCORPORATION OF A PRIVATE LIMITED COMPANY", "entity_name": _company(rng),
        "registration_number": f"SY{rng.randrange(10**5, 10**6)}", "formation_jurisdiction": rng.choice(JURISDICTIONS),
        "formation_date": _date(rng, date(1995, 1, 1), date(2025, 12, 31)),
        "registration_authority": "Registrar of Companies (Synthetic)", "entity_legal_form": "private company limited by shares"},
    "articles_of_association": lambda rng: {
        "document_title": "ARTICLES OF ASSOCIATION", "entity_name": _company(rng), "entity_legal_form": "private company limited by shares",
        "governing_law": rng.choice(JURISDICTIONS), "effective_date": _date(rng, date(2000, 1, 1), date(2025, 12, 31)),
        "issued_capital": f"{rng.randrange(1, 500) * 100}", "capital_currency": rng.choice(("GBP", "USD", "EUR"))},
    "annual_return": lambda rng: (lambda company, owners: {
        "document_title": "CONFIRMATION STATEMENT", "entity_name": company, "registration_number": f"SY{rng.randrange(10**5, 10**6)}",
        "record_as_of_date": _date(rng, date(2023, 1, 1), date(2026, 10, 31)),
        "ownership_interests": [{"owner_name": o, "share_class": "Ordinary", "units_held": str(u), "percentage": p}
                                for o, u, p in owners]})(_company(rng), _owners(rng)),
    "substantial_shareholder_disclosure": lambda rng: (lambda company, owner: {
        "document_title": "SCHEDULE 13G (SYNTHETIC)", "entity_name": company,
        "record_as_of_date": _date(rng, date(2023, 1, 1), date(2026, 10, 31)),
        "ownership_interests": [{"owner_name": owner, "share_class": "Common Stock", "units_held": str(rng.randrange(10**5, 10**7)),
                                 "percentage": f"{rng.randrange(50, 250) / 10:.1f}", "direct_or_indirect": "direct"}]})(
            _company(rng), _company(rng)),
    "bank_statement": lambda rng: (lambda person, bank: {
        "document_title": "ACCOUNT STATEMENT", "issuer_name": bank, "subject_name": person[2], "subject_address": _address(rng),
        "period_start": "2026-09-01", "period_end": "2026-09-30",
        "accounts": [{"holder_name": person[2], "account_identifier": f"SYN-{rng.randrange(10**7, 10**8)}", "institution_name": bank,
                      "currency": "GBP", "opening_balance": _money(rng, 100, 9000), "closing_balance": _money(rng, 100, 9000)}]})(
            _person(rng), rng.choice(BANKS)),
    "utility_bill": lambda rng: (lambda person: {
        "document_title": "ENERGY BILL", "issuer_name": rng.choice(UTILITIES), "subject_name": person[2],
        "subject_address": _address(rng), "issue_date": "2026-10-05", "period_start": "2026-09-01", "period_end": "2026-09-30",
        "service_type": rng.choice(("Electricity", "Gas", "Water")), "total_amount": _money(rng, 20, 400), "currency": "GBP",
        "due_date": "2026-10-26"})(_person(rng)),
}


def _owners(rng):
    shares = [rng.randrange(1, 100) for _ in range(rng.choice((1, 2, 3)))]
    total = sum(shares)
    return [(" ".join(_person(rng)[2:]), s, f"{s * 100 / total:.1f}".rstrip("0").rstrip(".")) for s in shares]


# Leaves the document states through another leaf's text: the contract asks for the value twice, and
# the same span supports both (a 13G row's owned entity is the named issuer; a typed signature is both
# the signer's name and the signature text).
ALIASES = {
    "substantial_shareholder_disclosure": lambda v: {"ownership_interests/0/owned_entity_name": "entity_name"},
    "annual_return": lambda v: {f"ownership_interests/{i}/owned_entity_name": "entity_name" for i in range(len(v["ownership_interests"]))},
    "w8bene": lambda v: {"signatures/0/signature_text": "signatures/0/signer_name"},
}

_ADDRESS = ("{%s/lines/0}", "{%s/locality}", "{%s/postal_code}", "{%s/country}")


def _address_lines(prefix, sep=", "):
    return sep.join(part % prefix for part in _ADDRESS)


LAYOUTS: dict[str, dict[str, list[str]]] = {
    "passport": {
        "classic": ["{document_title}", "SPECIMEN - NOT A VALID TRAVEL DOCUMENT", "Issuing state: {issuing_jurisdiction}",
                    "Surname: {family_name}", "Given names: {given_names}", "Holder: {person_name}", "Passport No.: {document_number}",
                    "Date of birth: {date_of_birth}", "Date of issue: {issue_date}", "Date of expiry: {expiry_date}", "Authority: {issuer_name}"],
        "compact": ["{document_title} / SPECIMEN", "{issuing_jurisdiction} | No. {document_number}", "Name {person_name}",
                    "({family_name}, {given_names})", "Born {date_of_birth}; issued {issue_date}; valid until {expiry_date}",
                    "Issued by {issuer_name}"],
    },
    "national_identity_card": {
        "classic": ["{document_title}", "SPECIMEN", "Name: {person_name}", "Surname: {family_name}", "Forenames: {given_names}",
                    "Personal ID number: {identity_number}", "Date of birth: {date_of_birth}", "Expiry: {expiry_date}", "Issuer: {issuer_name}",
                    "State: {issuing_jurisdiction}", "Issued: {issue_date}"],
        "compact": ["{document_title} - SPECIMEN - {issuing_jurisdiction}", "{person_name} ({given_names} {family_name})",
                    "ID {identity_number} DOB {date_of_birth}", "Issued {issue_date} by {issuer_name}, expires {expiry_date}"],
    },
    "w9": {
        "form": ["{tax_form_type} ({form_revision})", "{document_title}", "SYNTHETIC SAMPLE", "1 Name: {subject_name}",
                 "3a Federal tax classification: {tax_entity_classification}", "5 Address: {subject_address/lines/0}",
                 "6 City: {subject_address/locality}, ZIP {subject_address/postal_code}, {subject_address/country}",
                 "Part I Taxpayer Identification Number: {tax_identifier}"],
        "flat": ["SYNTHETIC SAMPLE OF {tax_form_type}, {form_revision}: {document_title}",
                 "Name of taxpayer {subject_name}; classification {tax_entity_classification}; TIN {tax_identifier}",
                 "Address " + _address_lines("subject_address")],
    },
    "w8bene": {
        "form": ["{tax_form_type}", "{document_title}", "SYNTHETIC SAMPLE", "Part I 1 Name of organization: {subject_name}",
                 "4 Chapter 3 status: {chapter3_status}", "5 Chapter 4 status: {chapter4_status}",
                 "6 Permanent residence address: " + _address_lines("permanent_residence_address"),
                 "9b Foreign TIN: {foreign_tax_identifier}",
                 "Part XXX Signature: {signatures/0/signer_name}, capacity {signatures/0/capacity}, date {signatures/0/signed_at}"],
        "flat": ["SYNTHETIC SAMPLE {tax_form_type} - {document_title}",
                 "Entity {subject_name} with chapter 3 status {chapter3_status} and chapter 4 status {chapter4_status}.",
                 "Residence: " + _address_lines("permanent_residence_address", "; ") + ". Foreign TIN {foreign_tax_identifier}.",
                 "Signed {signatures/0/signed_at} by {signatures/0/signer_name} ({signatures/0/capacity})."],
    },
    "certificate_of_incorporation": {
        "registry": ["SYNTHETIC SAMPLE", "{document_title}", "Company number {registration_number}",
                     "The {registration_authority} hereby certifies that {entity_name} is this day incorporated under the law of "
                     "{formation_jurisdiction}, and that the company is a {entity_legal_form}.",
                     "Given on {formation_date}."],
        "state": ["{document_title} (SYNTHETIC)", "Name of corporation: {entity_name}", "File number: {registration_number}",
                  "Jurisdiction: {formation_jurisdiction}", "Date of incorporation: {formation_date}", "Type: {entity_legal_form}",
                  "Issued by: {registration_authority}"],
    },
    "articles_of_association": {
        "model": ["SYNTHETIC SAMPLE", "{document_title}", "of {entity_name}", "a {entity_legal_form}", "Adopted on {effective_date}.",
                  "1. These articles are governed by the law of {governing_law}.",
                  "2. The issued share capital is {issued_capital} {capital_currency} divided into ordinary shares.",
                  "3. The directors may exercise all the powers of the company."],
        "short": ["{document_title} - {entity_name} (SYNTHETIC)", "Form: {entity_legal_form}. Effective {effective_date}.",
                  "Law: {governing_law}. Capital: {capital_currency} {issued_capital}."],
    },
    "annual_return": {
        "statement": ["SYNTHETIC SAMPLE", "{document_title}", "Company name: {entity_name}", "Company number: {registration_number}",
                      "Confirmation date: {record_as_of_date}", "Shareholdings:", "OWNERS"],
        "table": ["{document_title} (SYNTHETIC) for {entity_name}, number {registration_number}, made up to {record_as_of_date}",
                  "| Shareholder | Class | Shares | % |", "OWNERS"],
    },
    "substantial_shareholder_disclosure": {
        "schedule": ["{document_title}", "Name of issuer: {entity_name}", "Date of event: {record_as_of_date}",
                     "1. Name of reporting person: {ownership_interests/0/owner_name}",
                     "Title of class of securities: {ownership_interests/0/share_class}",
                     "9. Aggregate amount beneficially owned: {ownership_interests/0/units_held}",
                     "11. Percent of class: {ownership_interests/0/percentage}%",
                     "Nature of ownership: {ownership_interests/0/direct_or_indirect}"],
        "narrative": ["{document_title}", "On {record_as_of_date}, {ownership_interests/0/owner_name} held "
                      "{ownership_interests/0/units_held} shares of {ownership_interests/0/share_class} of {entity_name}, "
                      "{ownership_interests/0/percentage} percent of the class, held {ownership_interests/0/direct_or_indirect}."],
    },
    "bank_statement": {
        "statement": ["{issuer_name}", "{document_title} - SYNTHETIC SAMPLE", "{subject_name}", "{subject_address/lines/0}",
                      "{subject_address/locality} {subject_address/postal_code}", "{subject_address/country}",
                      "Statement period: {period_start} to {period_end}", "Account holder: {accounts/0/holder_name}",
                      "Account number: {accounts/0/account_identifier}", "Bank: {accounts/0/institution_name}",
                      "Currency: {accounts/0/currency}", "Opening balance: {accounts/0/opening_balance}",
                      "Closing balance: {accounts/0/closing_balance}"],
        "summary": ["SYNTHETIC SAMPLE {document_title} from {issuer_name} for {subject_name}, " + _address_lines("subject_address"),
                    "From {period_start} until {period_end}",
                    "Acct {accounts/0/account_identifier} ({accounts/0/holder_name}) at {accounts/0/institution_name} in {accounts/0/currency}: "
                    "opened {accounts/0/opening_balance}, closed {accounts/0/closing_balance}"],
    },
    "utility_bill": {
        "bill": ["{issuer_name}", "{document_title} - SYNTHETIC SAMPLE", "Customer: {subject_name}",
                 "{subject_address/address_role}: " + _address_lines("subject_address"), "Bill date: {issue_date}", "Service: {service_type}",
                 "Billing period: {period_start} - {period_end}", "Amount due: {total_amount} {currency}", "Pay by: {due_date}"],
        "letter": ["{issuer_name} | SYNTHETIC SAMPLE", "{subject_name}", "{subject_address/lines/0}", "{subject_address/locality}",
                   "{subject_address/postal_code}", "{subject_address/country}", "{document_title} dated {issue_date}",
                   "Your {service_type} use from {period_start} to {period_end} comes to {currency} {total_amount}, due {due_date}."],
    },
}

_OWNER_ROW = {"statement": "- {ownership_interests/%d/owner_name}: {ownership_interests/%d/units_held} {ownership_interests/%d/share_class} "
                           "shares ({ownership_interests/%d/percentage}%%)",
              "table": "| {ownership_interests/%d/owner_name} | {ownership_interests/%d/share_class} | {ownership_interests/%d/units_held} | "
                       "{ownership_interests/%d/percentage} |"}


def _complete(document_type: str, partial: dict) -> dict:
    """Every profile field, and every member of every object, present (None when not stated)."""
    def fill(value, kind):
        if value is None:
            return None
        if kind in OBJECTS:
            unknown = set(value) - set(OBJECTS[kind])
            if unknown:
                raise ValueError(f"{document_type}: {kind} has no members {sorted(unknown)}")
            return {name: fill(value.get(name), member) for name, member in OBJECTS[kind].items()}
        if kind.startswith("["):
            return [fill(item, kind[1:-1]) for item in value]
        return value
    unknown = set(partial) - set(PROFILES[document_type].field_names)
    if unknown:
        raise ValueError(f"{document_type}: not catalog fields: {sorted(unknown)}")
    return {name: fill(partial.get(name), FIELDS[name].value_type) for name in PROFILES[document_type].field_names}


def _lookup(values: dict, path: str):
    node = values
    for part in path.split("/"):
        node = node[int(part)] if isinstance(node, list) else node[part]
    return node


def render(document_type: str, layout: str, partial: dict) -> tuple[str, dict[str, tuple[int, int]]]:
    lines = list(LAYOUTS[document_type][layout])
    if "OWNERS" in lines:
        rows = [_OWNER_ROW[layout] % ((i,) * 4) for i in range(len(partial["ownership_interests"]))]
        index = lines.index("OWNERS")
        lines[index:index + 1] = rows
    text, spans = "", {}
    for line in lines:
        cursor = 0
        for match in _PLACEHOLDER.finditer(line):
            text += line[cursor:match.start()]
            value = _lookup(partial, match.group(1))
            if not isinstance(value, str) or not value:
                raise ValueError(f"{document_type}/{layout}: {match.group(1)} has no text value")
            if match.group(1) in spans:
                raise ValueError(f"{document_type}/{layout}: {match.group(1)} is rendered twice")
            spans[match.group(1)] = (len(text), len(text) + len(value))
            text += value
            cursor = match.end()
        text += line[cursor:] + "\n"
    return text, spans


def generate(document_type: str, seed: int, *, layout: str | None = None, generated_at: datetime | None = None):
    """One synthetic sample: (bytes, Sample, GoldLabel). Deterministic for a type, seed and layout."""
    if document_type not in VALUES:
        raise ValueError(f"no synthetic template for {document_type}; available: {sorted(VALUES)}")
    rng = random.Random(f"{document_type}:{seed}")
    layout = layout or sorted(LAYOUTS[document_type])[seed % len(LAYOUTS[document_type])]
    partial = VALUES[document_type](rng)
    if document_type == "utility_bill" and layout == "bill":
        partial["subject_address"]["address_role"] = "Billing address"
    text, spans = render(document_type, layout, partial)
    for leaf, source in (ALIASES.get(document_type, lambda v: {})(partial)).items():
        parts = leaf.split("/")
        _lookup(partial, "/".join(parts[:-1]))[parts[-1]] = _lookup(partial, source)
        spans[leaf] = spans[source]
    data = text.encode("utf-8")
    digest = hashlib.sha256(data).hexdigest()
    pages = [{"page_id": "p1", "document_version": digest, "text": text}]
    values = _complete(document_type, partial)
    observations = []
    for name in PROFILES[document_type].field_names:
        for path, value, _kind in _leaves(values[name], FIELDS[name].value_type, "/extracted_fields/" + name):
            leaf = path.removeprefix("/extracted_fields/")
            if value is None:
                observations.append({"path": path, "status": "not_present", "confidence": None, "spans": [], "note": None})
                continue
            if leaf not in spans:
                raise ValueError(f"{document_type}/{layout}: {leaf} has a value but is not rendered")
            start, end = spans[leaf]
            observations.append({"path": path, "status": "present", "confidence": None, "note": None,
                                 "spans": [{"page_id": "p1", "start": start, "end": end, "quote": text[start:end]}]})
    compiled = contract(document_type)
    result = {"document_type": document_type, "profile_version": PROFILES[document_type].version,
              "contract_hash": compiled["contract_hash"], "document_version": digest, "source_digest": source_digest(pages),
              "extracted_fields": values, "observations": observations}
    check = validate_extraction(document_type, result, pages)
    if not check["valid"]:
        raise AssertionError(f"{document_type}/{layout}: generated label is invalid: {check['issues']}")
    when = generated_at or datetime(2026, 11, 12, tzinfo=timezone.utc)
    rights = Rights.model_validate(SOURCE_DEFAULTS["synthetic_render"]["rights"], strict=False)
    subject = partial.get("entity_name") or partial.get("subject_name") or partial.get("person_name")
    sample = Sample.model_validate({
        "sample_id": digest, "document_type": document_type, "variant": layout, "source_id": "synthetic_render",
        "source_kind": "synthetic", "source_ref": f"{GENERATOR};seed={seed};layout={layout}", "retrieved_at": when.isoformat(),
        "collector_version": GENERATOR, "media_type": "text/plain; charset=utf-8", "byte_length": len(data),
        "group_key": f"synthetic:{document_type}:{subject}", "rights": rights.model_dump(mode="json"),
        "capture": "born_digital", "language": "en", "page_count": 1}, strict=False)
    label = GoldLabel.model_validate({
        "sample_id": digest, "document_type": document_type, "pages": pages, "result": result,
        "provenance": {"*": "by_construction"}, "labelled_by": [GENERATOR], "approved_at": when.isoformat()}, strict=False)
    return data, sample, label
