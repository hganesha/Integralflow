"""Deterministic value comparators for evaluation and route adjudication.

Each comparator takes two catalog values of the same field and answers ``equivalent``,
``different`` or ``ambiguous``. None of them calls a model or a network service, and none of them
asserts truth: two equivalent values can both be wrong. ``ambiguous`` means the comparator can't
decide without more evidence (for example a day/month order that the document doesn't state).

The comparator names are the ones the sourcing manifest assigns per key field.
"""
from __future__ import annotations

import re
import unicodedata
from decimal import Decimal, InvalidOperation
from typing import Literal

Outcome = Literal["equivalent", "different", "ambiguous"]

_LEGAL_SUFFIXES = {
    "limited": "ltd", "ltd": "ltd", "public limited company": "plc", "plc": "plc",
    "incorporated": "inc", "inc": "inc", "corporation": "corp", "corp": "corp", "company": "co", "co": "co",
    "limited liability company": "llc", "llc": "llc", "limited liability partnership": "llp", "llp": "llp",
    "limited partnership": "lp", "lp": "lp", "gmbh": "gmbh", "aktiengesellschaft": "ag", "ag": "ag",
    "société anonyme": "sa", "sa": "sa",
}
_SUFFIX_PATTERN = re.compile(r"\b(" + "|".join(sorted(map(re.escape, _LEGAL_SUFFIXES), key=len, reverse=True)) + r")\b\.?$")


def text_key(value: str) -> str:
    """NFKC, case-folded, whitespace collapsed; script and diacritics preserved."""
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def _strip_punctuation(value: str) -> str:
    return " ".join("".join(c if c.isalnum() or c.isspace() else " " for c in value).split())


def legal_name_key(value: str) -> str:
    """Legal-entity name key: punctuation dropped and one trailing legal-form suffix normalized."""
    key = text_key(value).replace("&", " and ")
    key = _strip_punctuation(key)
    match = _SUFFIX_PATTERN.search(key)
    if match:
        key = key[:match.start()].rstrip() + " " + _LEGAL_SUFFIXES[match.group(1)]
    return key.strip()


def _decimal(value) -> Decimal | None:
    try:
        return Decimal(str(value).replace(",", "").strip())
    except (InvalidOperation, ValueError):
        return None


def _from_keys(left, right, key) -> Outcome:
    return "equivalent" if key(left) == key(right) else "different"


def identifier_exact(left: str, right: str) -> Outcome:
    """Identifiers match exactly after removing spaces and case: no digit or letter substitution."""
    return _from_keys(left, right, lambda v: "".join(unicodedata.normalize("NFKC", v).split()).upper())


def legal_name_equivalent(left: str, right: str) -> Outcome:
    return _from_keys(left, right, legal_name_key)


def person_name_equivalent(left: str, right: str) -> Outcome:
    """Same tokens in the same order after normalization. Reordered tokens are ambiguous, not equal."""
    a, b = _strip_punctuation(text_key(left)).split(), _strip_punctuation(text_key(right)).split()
    if a == b:
        return "equivalent"
    return "ambiguous" if sorted(a) == sorted(b) else "different"


def name_equivalent(left: str, right: str) -> Outcome:
    """A subject that may be a person or an organization: equivalent under either rule."""
    if "equivalent" in (legal_name_equivalent(left, right), person_name_equivalent(left, right)):
        return "equivalent"
    return person_name_equivalent(left, right)


def date_strict(left: str, right: str) -> Outcome:
    """ISO dates at their stated precision. A partial date that agrees with a fuller one is ambiguous."""
    if left == right:
        return "equivalent"
    shorter, longer = sorted((left, right), key=len)
    return "ambiguous" if longer.startswith(shorter) else "different"


def amount_currency(left, right) -> Outcome:
    a, b = _decimal(left), _decimal(right)
    if a is None or b is None:
        return _from_keys(str(left), str(right), text_key)
    return "equivalent" if a == b else "different"


percent_fraction = amount_currency


def text_normalized(left, right) -> Outcome:
    return _from_keys(str(left), str(right), text_key)


def address_components(left, right) -> Outcome:
    """Applied per address leaf (lines, locality, postal code...), so it is a text comparison per component."""
    return _from_keys(str(left), str(right), lambda v: _strip_punctuation(text_key(v)))


def form_designation(left: str, right: str) -> Outcome:
    """A form's designation with or without the word "Form": "Form W-8BEN-E" and "W-8BEN-E" are one form."""
    return _from_keys(left, right, lambda v: re.sub(r"^form\s+", "", _strip_punctuation(text_key(v))).replace(" ", ""))


def boolean_exact(left, right) -> Outcome:
    return "equivalent" if left is right else "different"


COMPARATORS = {
    "identifier_exact": identifier_exact, "legal_name_equivalent": legal_name_equivalent,
    "person_name_equivalent": person_name_equivalent, "name_equivalent": name_equivalent, "date_strict": date_strict, "address_components": address_components,
    "amount_currency": amount_currency, "percent_fraction": percent_fraction, "text_normalized": text_normalized,
    "boolean_exact": boolean_exact, "form_designation": form_designation,
}
_BY_KIND = {"identifier": "identifier_exact", "date": "date_strict", "datetime": "date_strict", "decimal": "amount_currency",
            "integer": "amount_currency", "percentage": "percent_fraction", "boolean": "boolean_exact", "text": "text_normalized"}
_NAME_MEMBERS = {"name", "owner_name", "owned_entity_name", "holder_name", "institution_name", "signer_name",
                 "entity_name", "issuer_name", "represented_party"}


def comparator_for_leaf(member: str, kind: str, declared: str | None = None) -> str:
    """The comparator for one leaf: a declared key-field comparator first, then names, then the value kind."""
    if declared and declared in COMPARATORS:
        return declared
    if member in ("person_name", "given_names", "family_name"):
        return "person_name_equivalent"
    if member == "subject_name":
        return "name_equivalent"
    if member == "tax_form_type":
        return "form_designation"
    if member in _NAME_MEMBERS:
        return "legal_name_equivalent"
    return _BY_KIND.get(kind, "text_normalized")


def compare(comparator: str, left, right) -> Outcome:
    return COMPARATORS[comparator](left, right)
