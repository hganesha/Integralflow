"""Authored synthetic source/answer pairs, not OCR/model accuracy goldens."""
from kyc_documents.fields import FIELDS, OBJECTS
from kyc_documents.runtime import contract, resolve, source_digest

# Expected values are independently authored below. The helper only adds null
# members, locates exact quotes and binds the result to its current contract.
EXAMPLES = {
    "passport": {
        "text": "SYNTHETIC PASSPORT\nName: Alex Example\nPassport number: SYN-000042\nBirth date: 1987-04-12\nExpiry: 2030-05-31\n",
        "fields": {"person_name": "Alex Example", "document_number": "SYN-000042", "date_of_birth": "1987-04-12", "expiry_date": "2030-05-31"},
    },
    "bank_statement": {
        "text": "SYNTHETIC BANK STATEMENT\nCustomer: Example Trading\nAccount: ****0042\nInstitution: Synthetic Bank\nCurrency: XTS\nOpening: 1000.00\nClosing: 1250.00\nPeriod: 2026-09-01 to 2026-09-30\n",
        "fields": {"subject_name": "Example Trading", "period_start": "2026-09-01", "period_end": "2026-09-30",
            "accounts": [{"holder_name": "Example Trading", "account_identifier": "****0042", "institution_name": "Synthetic Bank", "currency": "XTS", "opening_balance": "1000.00", "closing_balance": "1250.00"}]},
    },
    "shareholder_register": {
        "text": "SYNTHETIC SHAREHOLDER REGISTER\nCompany: Example Trading\nOwner: Alex Example; owned entity: Example Trading; ordinary; 60%; direct\nOwner: Morgan Example; owned entity: Example Trading; ordinary; 40%; direct\nAs of: 2026-10-01\n",
        "fields": {"entity_name": "Example Trading", "record_as_of_date": "2026-10-01", "ownership_interests": [
            {"owner_name": "Alex Example", "owned_entity_name": "Example Trading", "share_class": "ordinary", "percentage": "60", "direct_or_indirect": "direct"},
            {"owner_name": "Morgan Example", "owned_entity_name": "Example Trading", "share_class": "ordinary", "percentage": "40", "direct_or_indirect": "direct"}]},
    },
    "trust_deed": {
        "text": "SYNTHETIC TRUST DEED\nTrust: Example Family Trust\nGoverning law: Synthetic jurisdiction\nSettlor: Alex Example\nTrustee: Morgan Example\nProtector: Taylor Example\nBeneficiary class: Descendants of Alex Example\nPower holder: Morgan Example; controlled party: Example Family Trust; right: distribution; discretionary distributions\n",
        "fields": {"trust_name": "Example Family Trust", "governing_law": "Synthetic jurisdiction",
            "trust_parties": [{"name": "Alex Example", "role": "Settlor"}, {"name": "Morgan Example", "role": "Trustee"}, {"name": "Taylor Example", "role": "Protector"}],
            "beneficiary_classes": ["Descendants of Alex Example"],
            "trust_powers": [{"controller_name": "Morgan Example", "controlled_party_name": "Example Family Trust", "right_type": "distribution", "right_description": "discretionary distributions"}]},
    },
    "w8bene": {
        "text": "SYNTHETIC W-8BEN-E EXCERPT\nName: Example Trading\nForm: W-8BEN-E\nChapter 3: Corporation\nChapter 4: Active NFFE\nRevision: Synthetic fixture, not an IRS edition\nSigned by: Alex Example\nCapacity: Director\n",
        "fields": {"subject_name": "Example Trading", "tax_form_type": "W-8BEN-E", "chapter3_status": "Corporation", "chapter4_status": "Active NFFE",
            "form_revision": "Synthetic fixture, not an IRS edition", "signatures": [{"signer_name": "Alex Example", "capacity": "Director"}]},
    },
    "commercial_invoice": {
        "text": "SYNTHETIC INVOICE\nInvoice: SYN-INV-42\nSupplier: Example Trading\nBuyer: Example Customer\nTotal: 1250.00 XTS\nItem: Test components; quantity 10; unit price 125.00; amount 1250.00\n",
        "fields": {"invoice_number": "SYN-INV-42", "currency": "XTS", "total_amount": "1250.00",
            "parties": [{"name": "Example Trading", "role": "Supplier"}, {"name": "Example Customer", "role": "Buyer"}],
            "line_items": [{"description": "Test components", "quantity": "10", "unit_price": "125.00", "amount": "1250.00"}]},
    },
}


def fixture(identifier):
    authored = EXAMPLES[identifier]
    profile = resolve(identifier)
    page = {"page_id": "synthetic-page-1", "document_version": "synthetic-version-1", "text": authored["text"]}
    observations = []

    def value_for(value, kind, path):
        if kind in OBJECTS and value is not None:
            return {key: value_for(value.get(key), member_kind, path + "/" + key) for key, member_kind in OBJECTS[kind].items()}
        if kind.startswith("[") and value is not None:
            return [value_for(item, kind[1:-1], path + f"/{i}") for i, item in enumerate(value)]
        if kind == "texts" and value is not None:
            return [value_for(item, "text", path + f"/{i}") for i, item in enumerate(value)]
        spans = []
        if value is not None:
            raw = str(value)
            start = page["text"].index(raw)
            spans = [{"page_id": page["page_id"], "start": start, "end": start + len(raw), "quote": raw}]
        observations.append({"path": path, "status": "present" if value is not None else "not_present",
                             "confidence": None, "spans": spans, "note": None})
        return value

    fields = {key: value_for(authored["fields"].get(key), FIELDS[key].value_type, "/extracted_fields/" + key) for key in profile.field_names}
    return {"synthetic": True, "qualification": "contract_and_source_span_example_not_extractor_evaluation",
        "pages": [page], "result": {"document_type": profile.id, "profile_version": profile.version,
            "contract_hash": contract(profile.id)["contract_hash"], "document_version": page["document_version"],
            "source_digest": source_digest([page]), "extracted_fields": fields, "observations": observations},
        "expected": {"valid": True, "promotion_allowed": False, "review_required": True, "issues": []}}
