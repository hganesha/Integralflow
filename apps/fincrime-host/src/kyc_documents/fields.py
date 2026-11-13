"""Authored semantic field library; no fields inferred from their names or prompts."""
from .model import ContextTarget, FieldDefinition

# Members are nullable: null means the document does not establish the value.
# Arrays preserve each row and role; percentages are source-stated percentages,
# not calculated indirect ownership or a regulatory beneficial-owner threshold.
OBJECTS = {
    "Address": {
        "lines": "texts", "locality": "text", "region": "text", "postal_code": "identifier",
        "country": "text", "address_role": "text", "valid_from": "date", "valid_to": "date",
    },
    "Party": {
        "name": "text", "role": "text", "party_kind": "text", "identifier": "identifier",
        "identifier_type": "text", "identifier_issuer": "text", "address": "Address",
        "date_of_birth": "date", "jurisdiction": "text", "effective_from": "date", "effective_to": "date",
    },
    "Ownership": {
        "owner_name": "text", "owned_entity_name": "text", "owner_identifier": "identifier",
        "owned_entity_identifier": "identifier", "interest_type": "text", "share_class": "text",
        "units_held": "decimal", "total_units": "decimal", "percentage": "percentage",
        "percentage_basis": "text", "voting_percentage": "percentage", "direct_or_indirect": "text",
        "nominee_capacity": "text", "effective_from": "date", "effective_to": "date",
    },
    "Control": {
        "controller_name": "text", "controlled_party_name": "text", "right_type": "text",
        "right_description": "text", "conditions": "text", "effective_from": "date", "effective_to": "date",
    },
    "Signature": {
        "signer_name": "text", "capacity": "text", "signed_at": "date", "signature_text": "text",
        "signature_method": "text", "represented_party": "text",
    },
    "Account": {
        "holder_name": "text", "account_identifier": "identifier", "identifier_masked": "boolean",
        "institution_name": "text", "institution_identifier": "identifier", "account_type": "text",
        "currency": "text", "opening_balance": "decimal", "closing_balance": "decimal",
    },
    "TransactionRow": {
        "transaction_date": "date", "value_date": "date", "reference": "identifier", "description": "text",
        "amount": "decimal", "currency": "text", "direction": "text", "counterparty_name": "text",
        "counterparty_account": "identifier", "running_balance": "decimal",
    },
    "LineItem": {
        "line_number": "identifier", "description": "text", "product_code": "identifier",
        "quantity": "decimal", "unit": "text", "unit_price": "decimal", "amount": "decimal", "currency": "text",
    },
    "TaxResidence": {"jurisdiction": "text", "tax_identifier": "identifier", "tin_absence_reason": "text"},
    "Asset": {
        "asset_type": "text", "description": "text", "identifier": "identifier", "owner_name": "text",
        "location": "text", "value": "decimal", "currency": "text", "valuation_date": "date",
    },
    "Distribution": {
        "payer_name": "text", "recipient_name": "text", "distribution_basis": "text",
        "amount": "decimal", "currency": "text", "payment_date": "date", "reference": "identifier",
    },
    "Licence": {
        "licence_number": "identifier", "authority": "text", "holder_name": "text", "scope": "texts",
        "status_stated": "text", "issue_date": "date", "expiry_date": "date", "jurisdiction": "text",
    },
    "Finding": {
        "subject_name": "text", "finding_text": "text", "status_stated": "text",
        "evidence_references": "texts", "author_name": "text", "finding_date": "date",
    },
    "QuestionAnswer": {"question_id": "identifier", "question_text": "text", "answer_text": "text", "qualifications": "text"},
    "SourceReference": {"title": "text", "issuer": "text", "reference": "identifier", "published_date": "date", "url": "text"},
    "Programme": {"name": "text", "purpose": "text", "locations": "texts", "delivery_partners": "texts", "beneficiary_description": "text"},
    "ExpectedFlow": {
        "direction": "text", "transaction_type": "text", "amount": "decimal", "currency": "text",
        "frequency": "text", "count": "integer", "countries": "texts", "counterparty_types": "texts",
    },
    "CryptoTransaction": {
        "network": "text", "asset": "text", "transaction_hash": "identifier", "from_address": "identifier",
        "to_address": "identifier", "amount": "decimal", "timestamp": "datetime", "acquisition_basis": "text",
    },
    "Check": {
        "check_name": "text", "result_stated": "text", "score": "decimal", "score_scale": "text",
        "performed_at": "datetime", "provider_name": "text", "method": "text", "limitations": "text",
    },
    "AuthorityLimit": {
        "person_name": "text", "capacity": "text", "permitted_action": "text", "limit_amount": "decimal",
        "currency": "text", "joint_signing_rule": "text", "effective_from": "date", "effective_to": "date",
    },
    "FinancialLine": {
        "label": "text", "amount": "decimal", "currency": "text", "period_start": "date",
        "period_end": "date", "comparative_or_current": "text", "consolidation_basis": "text", "scale": "text",
    },
}

SECTIONS = {
    "document": "Document particulars", "identity": "Identity and personal particulars",
    "address": "Addresses and physical presence", "parties": "Parties and capacities",
    "legal": "Legal existence and governance", "ownership": "Ownership and control",
    "authority": "Authority and signatures", "employment": "Occupation and income",
    "financial": "Amounts, accounts and financial position", "wealth": "Funding and wealth provenance",
    "tax": "Tax residence and classifications", "business": "Business and expected activity",
    "trust": "Trust and fiduciary arrangements", "sector": "Sector and institutional controls",
    "trade": "Trade, goods and logistics", "review": "Reviews, findings and decisions",
    "digital": "Digital credentials and verification results", "certification": "Certification and translation",
}

FIELDS: dict[str, FieldDefinition] = {}


def define(section, lines, *, sensitivity="personal"):
    for line in lines.strip().splitlines():
        name, kind, description = line.strip().split("|", 2)
        if name in FIELDS:
            raise ValueError(f"duplicate field: {name}")
        normalization = {
            "decimal": "Exact base-10 string; preserve sign and source scale; no float or FX conversion.",
            "percentage": "Exact decimal string in the source's percent scale (0–100); retain basis; do not calculate indirect holdings.",
            "identifier": "Preserve leading zeros, script, punctuation, masking and issuer; never reconstruct hidden characters.",
            "date": "Use YYYY-MM-DD, YYYY-MM or YYYY only when unambiguous; retain source quote and date precision.",
            "datetime": "RFC3339 with explicit offset only; an unknown timezone is an unresolved value, not UTC.",
            "boolean": "Only an explicit affirmative/negative statement; absence is null, not false.",
            "integer": "Only an explicit nonnegative whole-number count.",
        }.get(kind, "Preserve source meaning, role and original script; no external enrichment or inferred values.")
        FIELDS[name] = FieldDefinition(name=name, description=description, value_type=kind,
                                      section=section, sensitivity=sensitivity, normalization=normalization)


define("document", """
document_title|text|Title of the supplied document, form, credential or report as printed.
document_number|identifier|Identifier of this document or certificate, distinct from an account or party identifier.
issuer_name|text|Named organization, government body or person issuing this document.
issuing_jurisdiction|text|Country, territory or legal jurisdiction stated for the document issuer.
issue_date|date|Date this document was issued; do not substitute upload or retrieval date.
expiry_date|date|Stated expiration date; null when the document has no stated expiry.
effective_date|date|Date the instrument or recorded change takes legal or operational effect as stated.
record_as_of_date|date|Date on which the document says its information or register is current.
period_start|date|Start of the reporting, statement, earnings or covered period.
period_end|date|End of the reporting, statement, earnings or covered period.
status_stated|text|Status explicitly stated by the source; not the institution's independent verification result.
references|[SourceReference]|References to other documents, filings or sources expressly cited in this artifact.
""", sensitivity="internal")
define("identity", """
person_name|text|Full name of the individual identified by this document, preserving name order and script.
given_names|text|Given or personal names separately stated in the identity document.
family_name|text|Family or surname separately stated in the identity document.
previous_names|texts|Previous names, aliases or alternative-script names expressly listed in the document.
date_of_birth|date|Birth date of the identified individual; retain partial or ambiguous source evidence.
place_of_birth|text|Town, region or country of birth exactly as stated, without nationality inference.
nationalities|texts|Citizenships or nationalities expressly stated; do not infer from residence or birthplace.
identity_number|identifier|Government or other identity identifier exactly as visible, including any masking.
identity_type|text|Identity credential type named by the source, rather than inferred legal acceptability.
residence_status|text|Residence, immigration or citizenship status explicitly granted or recorded.
entry_or_stay_conditions|text|Stated permitted duration, restrictions or conditions of residence or entry.
name_change_basis|text|Marriage, court order, deed or other basis expressly stated for a name change.
new_name|text|New legal name expressly established or recorded in a change-of-name instrument.
relationship_basis|text|Family, guardianship, sponsorship or other relationship expressly described.
death_date|date|Date of death stated in the death or estate documentation.
""", sensitivity="restricted")
define("address", """
subject_name|text|Name of the person, organization or arrangement to which the statement or evidence relates.
subject_address|Address|Address of the document subject with source-stated address role and effective dates.
registered_address|Address|Registered legal office address explicitly distinguished from operating premises.
operating_addresses|[Address]|Physical operating locations expressly listed; preserve registered-agent distinctions.
property_address|Address|Address of the property, leased premises or accommodation described.
occupancy_basis|text|Ownership, tenancy, licence, host, shelter or other stated basis of occupancy.
occupancy_start|date|Start of the occupancy or accommodation period stated in the evidence.
occupancy_end|date|End of the occupancy or accommodation period stated in the evidence.
service_address|Address|Location where the billed service is supplied, distinct from a correspondence address.
service_type|text|Utility, housing, communications or other type of service identified by the issuer.
""")
define("parties", """
parties|[Party]|All expressly identified parties with their distinct roles, identifiers and relevant dates.
representatives|[Party]|Persons expressly acting for another party, with capacity and represented entity preserved.
counterparties|[Party]|Named customers, suppliers, payers, payees or other counterparties with source-stated roles.
""")
define("legal", """
entity_name|text|Full legal name of the company, organization or other legal entity named by the source.
trading_names|texts|Trade, assumed, doing-business-as or registered business names explicitly listed.
entity_legal_form|text|Legal form expressly stated, such as company, partnership, association or statutory body.
registration_number|identifier|Identifier assigned to the entity by the named registration authority.
registration_authority|text|Registry or official authority maintaining the entity's legal registration.
formation_date|date|Date of incorporation, establishment or registration as expressly stated.
formation_jurisdiction|text|Jurisdiction under whose law the entity was formed or registered.
governing_law|text|Law or legal jurisdiction stated to govern the instrument or arrangement.
constitutional_purpose|text|Objects, purposes or powers expressly established by the governing instrument.
governance_rules|text|Stated decision-making, meeting, appointment and amendment rules.
parent_entity_name|text|Named parent, head office or predecessor entity; do not infer from a similar name.
change_type|text|Type of name, form, merger, continuation or other legal change recorded.
previous_entity_name|text|Legal name of the entity before the documented change.
filing_reference|identifier|Registry, court or other filing reference printed in the document.
insolvency_details|text|Insolvency, liquidation, administration or restoration details expressly recorded.
""", sensitivity="internal")
define("ownership", """
ownership_interests|[Ownership]|Each source-stated ownership edge, share class, interest basis and effective period.
control_rights|[Control]|Source-stated voting, veto, appointment, revocation or other control rights and conditions.
beneficial_owners_stated|[Party]|Persons the source declares to be beneficial owners; this is not an independently resolved UBO finding.
share_classes|texts|Classes of shares, membership interests or partnership interests expressly identified.
issued_capital|decimal|Stated issued capital amount; units and currency are captured separately.
capital_currency|text|Currency expressly associated with stated share or contributed capital.
total_units|decimal|Total shares, units or interests expressly stated for the specified class or register.
nominee_arrangements|text|Nominee or custodial capacity and underlying principal expressly disclosed.
listing_venue|text|Exchange or market where the source says securities are listed.
security_identifier|identifier|ISIN, ticker or other security identifier expressly printed with its context.
ownership_scope|text|Entities, classes and layers the ownership document expressly claims to cover.
""", sensitivity="restricted")
define("authority", """
resolution_text|text|Operative resolution authorizing the documented action, with conditions preserved.
authorized_actions|texts|Actions expressly permitted to the representative, attorney or signatory.
authority_limits|[AuthorityLimit]|Per-person action, amount, currency, signing-rule and temporal limits expressly stated.
signing_rule|text|Sole, joint, quorum or other signing rule expressly required by the mandate.
revocation_terms|text|Revocation, termination, delegation and continuing-validity provisions expressly stated.
signatures|[Signature]|Named signers, signing capacity, represented party and source-stated signing date or method.
meeting_date|date|Date of the meeting adopting the resolution or recording the appointments.
""")
define("employment", """
employer_name|text|Name of the employer or paying organization explicitly identified.
occupation|text|Occupation, profession, trade or job title explicitly described.
employment_start|date|Stated start date of employment, engagement or professional practice.
employment_end|date|Stated end date of employment, engagement or professional practice.
employment_status|text|Permanent, temporary, self-employed, retired or other status stated by the source.
income_frequency|text|Frequency and basis of the stated pay or income, such as monthly gross salary.
gross_income|decimal|Gross earnings expressly stated for the associated reporting period and currency.
net_income|decimal|Net earnings expressly stated for the associated reporting period and currency.
deductions|[FinancialLine]|Itemized tax, pension and other earnings deductions as printed.
professional_registration|identifier|Registration or practising identifier printed for the named professional.
education_or_support_details|text|Stated enrollment, scholarship, benefits, pension or sponsorship arrangement.
""", sensitivity="restricted")
define("financial", """
currency|text|Currency expressly stated for the associated amount; ambiguous symbols remain unresolved.
amount|decimal|Primary amount expressly stated, retaining its stated economic basis and currency association.
payment_date|date|Date of payment, disbursement, settlement or distribution expressly recorded.
payment_reference|identifier|Reference explicitly identifying the payment or settlement.
accounts|[Account]|Source-stated account holders, account identifiers, currencies and balances.
transactions|[TransactionRow]|Individual source rows with dates, direction, currency and counterparty retained.
financial_lines|[FinancialLine]|Reported financial statement or tax lines with period, currency and consolidation basis.
revenue|decimal|Revenue expressly reported for the stated period, currency and reporting scope.
net_profit|decimal|Net profit or loss expressly reported for the stated period and accounting basis.
total_assets|decimal|Total assets expressly reported at the stated reporting date.
total_liabilities|decimal|Total liabilities expressly reported at the stated reporting date.
net_assets|decimal|Net assets or equity expressly reported; do not derive absent totals during extraction.
auditor_name|text|Auditor or independent reporting accountant explicitly named.
audit_opinion|text|Opinion, qualification, emphasis or limitation expressly stated by the auditor.
accounting_basis|text|Accounting standard, audit status and consolidated or standalone scope as stated.
assets|[Asset]|Source-stated assets, owners, identifiers, locations, values and valuation dates.
distributions|[Distribution]|Source-stated dividends, gifts, inheritances, trust or other distributions with parties and amounts.
loan_terms|text|Principal, repayment, maturity, interest, security and conditions expressly stated in the agreement.
funding_conditions|text|Conditions, restrictions and availability of an investment, grant or funding commitment.
""", sensitivity="restricted")
define("wealth", """
source_of_funds_statement|text|Source's explanation of the economic origin of funds for a specified transaction or relationship.
source_of_wealth_statement|text|Source's explanation of how overall wealth accumulated over time, distinct from a transfer account.
wealth_chronology|text|Source-stated chronology of wealth creation, asset acquisition and realization events.
underlying_event|text|Sale, inheritance, gift, compensation or other event said to generate the funds.
asset_acquisition_basis|text|How, when and from whom the relevant asset or interest was originally acquired as stated.
proceeds_amount|decimal|Sale, redemption, settlement or other proceeds expressly stated, without inferred netting.
proceeds_currency|text|Currency expressly associated with the proceeds amount.
original_funding_statement|text|Explanation of funds originally used to acquire an investment or digital asset.
""", sensitivity="restricted")
define("tax", """
tax_residences|[TaxResidence]|Each explicitly declared tax residence, TIN and stated reason for an absent TIN.
tax_identifier|identifier|Tax identifier exactly as visible, retaining type, issuer context and any masking.
tax_form_type|text|Form type or certificate designation expressly printed, such as W-9 or W-8BEN-E.
form_revision|text|Revision date or edition printed on the supplied form; no current-version inference.
tax_year|text|Tax year or assessment period expressly identified.
tax_entity_classification|text|Entity classification explicitly selected for the relevant tax regime.
chapter3_status|text|Chapter 3 status explicitly selected on a US withholding certificate, when applicable.
chapter4_status|text|Chapter 4 or FATCA status explicitly selected, including any stated qualifying category.
giin|identifier|Global Intermediary Identification Number explicitly supplied; not a verified registration status.
us_person_declaration|text|Explicit declaration of US-person, citizenship or tax status and qualifications.
treaty_claim|text|Treaty country, article, rate and eligibility conditions expressly claimed.
controlling_persons_tax|[Party]|Controlling persons expressly identified for tax reporting, with role context preserved.
intermediary_capacity|text|Capacity in which an intermediary or flow-through entity signs or receives income.
withholding_statement|text|Allocation, withholding-pool and underlying-documentation statements expressly supplied.
tax_exemption_basis|text|Specific tax exemption or special status claimed and its stated basis.
certification_text|text|Certification, declaration, affirmation and change-in-circumstances undertaking as stated.
""", sensitivity="restricted")
define("business", """
business_activity|text|Nature of actual or planned business and operating model expressly described.
industry_codes|texts|Industry, merchant-category or activity codes explicitly supplied with their source context.
products_services|texts|Products and services expressly sold, delivered or requested.
business_websites|texts|Business website, application or marketplace URLs explicitly listed.
countries_of_operation|texts|Countries where operations are expressly stated to occur; distinct from incorporation or ownership.
relationship_purpose|text|Purpose and intended nature of the requested or existing financial relationship.
expected_flows|[ExpectedFlow]|Declared transaction volumes, amounts, currencies, countries and frequency with direction preserved.
cash_activity_statement|text|Explanation of expected cash receipts, payments and handling arrangements.
third_party_funds_statement|text|Whether and how the business receives or holds funds for others, as explicitly declared.
employee_count|integer|Employee headcount expressly reported for the stated scope and date.
business_plan|text|Business model, stage, market and operating plan expressly described.
licences|[Licence]|Stated licences or registrations, authority, scope, status and validity dates.
""", sensitivity="internal")
define("trust", """
trust_name|text|Name of the trust, estate or similar fiduciary arrangement as stated.
trust_type|text|Revocable, discretionary, testamentary or other trust type expressly stated.
trust_purpose|text|Purpose and objects expressly stated in the trust or fiduciary instrument.
trust_parties|[Party]|Settlors, trustees, protectors, appointors, enforcers and named beneficiaries with distinct roles.
beneficiary_classes|texts|Descriptions of beneficiary classes or objects of powers exactly as stated.
trust_powers|[Control]|Distribution, investment, appointment, revocation and other powers with holders and conditions.
trust_asset_schedule|[Asset]|Property and assets expressly settled, contributed or held by the arrangement.
distribution_terms|text|Entitlements, discretion, restrictions and distribution conditions expressly stated.
amendment_scope|text|Provisions or parties changed by an amendment, appointment, retirement or restatement.
""", sensitivity="restricted")
define("sector", """
regulator_name|text|Regulator or professional supervisory authority expressly named.
regulated_activities|texts|Activities the source explicitly states are licensed, supervised or authorized.
aml_controls_statement|text|Source-stated customer diligence, monitoring, reporting and governance controls.
sanctions_controls_statement|text|Source-stated sanctions screening, escalation and restriction controls.
assurance_scope|text|Scope, period, independence and limitations of the assurance or audit work as stated.
assurance_findings|[Finding]|Source-stated control deficiencies, conclusions and remediation findings.
questionnaire_answers|[QuestionAnswer]|Question-by-question answers retaining qualifications and original question identifiers.
agent_network|[Party]|Agents, distributors or delivery partners explicitly listed with role and location.
payment_flow_description|text|Source-stated movement of customer, merchant, settlement and safeguarded funds.
safeguarding_arrangements|text|Client-money, trust, segregation, safeguarding or custody arrangements expressly described.
fund_name|text|Name of the investment fund, scheme or sub-fund explicitly described.
fund_strategy|text|Investment strategy, asset classes and geographic scope expressly described.
fund_service_providers|[Party]|Manager, adviser, administrator, custodian, trustee and other providers with roles preserved.
redemption_terms|text|Subscription, redemption, lock-up and transfer terms expressly stated.
programmes|[Programme]|Charitable or nonprofit programs, locations, purposes, delivery partners and beneficiaries as stated.
donor_funding_statement|text|Sources, restrictions and delivery arrangements of donor, grant or charitable funds.
merchant_controls|text|Merchant underwriting, refunds, chargebacks, reserves and payout controls expressly described.
""", sensitivity="internal")
define("trade", """
contract_reference|identifier|Identifier of the relevant commercial, sale or services agreement.
invoice_number|identifier|Invoice identifier as issued by the named supplier.
purchase_order_number|identifier|Purchase-order identifier supplied by the ordering party.
shipment_reference|identifier|Shipment, consignment, transport or customs reference as printed.
line_items|[LineItem]|Individual goods, services or asset lines with quantity, unit, price and currency associations.
subtotal|decimal|Subtotal expressly stated before the document's identified adjustments.
tax_amount|decimal|Tax amount expressly stated for the invoice or transaction.
total_amount|decimal|Total amount expressly stated; no inferred reconciliation during extraction.
due_date|date|Contractual payment or performance due date expressly stated.
payment_terms|text|Payment conditions, milestones, credit period and settlement method as stated.
incoterms|text|Delivery or trade terms expressly stated, including named place and version if printed.
origin_country|text|Country of origin expressly stated for the identified goods.
destination_country|text|Destination country expressly stated for the shipment or transaction.
transport_route|text|Ports, places, transshipment points and routing expressly stated.
carrier_name|text|Carrier, freight forwarder or transport operator expressly identified.
vessel_or_flight|text|Vessel, voyage, aircraft or flight identifier expressly stated.
goods_description|text|Goods description, classification and stated end use without external inference.
end_use_statement|text|Declared end user, end use and restrictions stated in the certificate or authorization.
credit_or_guarantee_terms|text|Letter-of-credit, collection, bill-of-exchange or guarantee obligations and conditions as stated.
""", sensitivity="internal")
define("review", """
review_scope|text|Questions, subjects, time period and limitations of the review as stated.
findings|[Finding]|Findings explicitly written in the supplied assessment, with attributed status and evidence references.
decision_stated|text|Decision or recommendation explicitly recorded; not authorization by this extraction process.
decision_conditions|texts|Conditions, exceptions, restrictions or follow-up actions expressly attached to the decision.
review_date|date|Date the source says the review or assessment was performed.
next_review_date|date|Next review date explicitly specified by the source; do not calculate a cadence.
reviewer_name|text|Named analyst or reviewer attributed to the source assessment.
approval_records|[Signature]|Approvers, capacities, signing dates and represented authority expressly recorded.
risk_rating_stated|text|Risk tier explicitly recorded by the source; not a newly calculated or accepted risk classification.
pep_declaration|text|Explicit PEP or related-person declaration, including role, relationship and qualifications.
public_function|text|Public function, organization, country and tenure expressly described.
legal_case_reference|identifier|Court, regulator or investigation reference explicitly printed.
allegation_or_outcome|text|Allegation, charge, finding, judgment or disposition as attributed and dated by the source.
customer_explanation|text|Customer's explanation of a discrepancy, transaction, activity or event, retaining attribution.
exception_basis|text|Stated reason, scope, authority and expiry conditions of an exception.
closure_instruction|text|Express instruction to close or transfer the relationship and any conditions.
""", sensitivity="restricted")
define("digital", """
provider_name|text|Identity, credential, verification or analysis provider explicitly identified in the source record.
provider_request_id|identifier|Provider-issued correlation or request identifier explicitly supplied.
performed_at|datetime|Timestamp with explicit offset at which the source says the check or event occurred.
credential_type|text|Type, standard or scheme of digital credential explicitly identified.
credential_issuer|text|Named issuer of the electronic credential or signed assertion.
credential_subject|text|Subject name or identifier explicitly contained in the credential; issuer claims remain attributed.
assurance_level_stated|text|Assurance level or trust framework explicitly asserted by the source, without equivalence inference.
verification_checks|[Check]|Checks, provider-reported scores, scales, results, methods and limitations as supplied.
artifact_references|texts|Opaque references or hashes to supporting media or artifacts; no raw biometric templates or secrets.
consent_scope|text|Purpose, scope, basis and withdrawal terms recorded for an acknowledgment or consent event.
crypto_transactions|[CryptoTransaction]|Source-stated blockchain transactions with network, asset, addresses and acquisition context.
wallet_control_method|text|Method and result stated for demonstrating wallet control; never request private keys or seed phrases.
travel_rule_information|text|Originator, beneficiary and provider information supplied for the relevant transfer.
""", sensitivity="restricted")
define("certification", """
certifier_name|text|Name of the person or organization certifying, witnessing, notarizing or translating the artifact.
certifier_capacity|text|Professional capacity, registration, authority or qualification explicitly stated.
certification_date|date|Date the certification, notarization, legalization or translation was made.
certified_document_reference|identifier|Exact document, version or other reference the certification expressly covers.
certification_scope|text|What is certified, verified or translated, retaining limitations and qualifications.
source_language|text|Language explicitly identified for the source document.
target_language|text|Language explicitly identified for the translation.
original_seen_statement|text|Express statement about viewing an original, copy or in-person presentation.
""")

define("financial", """
amount_scale|text|Source-stated scale such as units, thousands or millions; do not silently multiply reported figures.
insurance_policy_number|identifier|Policy identifier explicitly linking the insured risk or payout to its insurance contract.
insurance_claim_number|identifier|Claim identifier explicitly linking the payout or settlement to a particular insurance claim.
coverage_description|text|Risk, property, insured event and coverage limitations explicitly described by the insurance source.
""", sensitivity="restricted")
define("tax", """
permanent_residence_address|Address|Permanent residence or registered address explicitly supplied in the tax form's designated field.
mailing_address|Address|Mailing address explicitly supplied, distinct from permanent residence or registered office.
us_tax_identifier|identifier|US taxpayer identifier exactly as supplied, preserving masking and printed type context.
foreign_tax_identifier|identifier|Foreign tax identifier exactly as supplied with the associated jurisdiction context.
disregarded_entity_name|text|Disregarded entity, branch or business name explicitly supplied as distinct from the named tax owner.
withholding_exemption_codes|texts|Exempt payee, FATCA or other withholding exemption codes explicitly supplied on the form.
backup_withholding_statement|text|Backup-withholding certification or exception explicitly affirmed or crossed out.
income_description|text|Income items expressly identified in the withholding certificate or allocation statement.
effectively_connected_claim|text|Statement that identified income is effectively connected with a US trade or business, including qualifications.
""", sensitivity="restricted")
define("review", """
risk_score_stated|decimal|Numeric risk score explicitly recorded by the source; not a newly computed or calibrated score.
risk_model_version|text|Risk model, methodology or policy version explicitly identified for the source assessment.
""", sensitivity="restricted")

# Explicit nested descriptions. Shared members keep a stable meaning in every
# object; object-specific context is supplied by the enclosing field definition.
MEMBER_DESCRIPTIONS = {
    "lines": "Address lines exactly as supplied, preserving their original order and script.",
    "locality": "Town, city or locality expressly stated for this address.",
    "region": "State, province or administrative region expressly stated for this address.",
    "postal_code": "Postal or ZIP code exactly as visible, preserving leading zeros.",
    "country": "Country label explicitly associated with this address in the source.",
    "address_role": "Source-stated role such as residential, registered, operating or correspondence.",
    "valid_from": "Start of the source-stated validity or occupancy interval.",
    "valid_to": "End of the source-stated validity or occupancy interval.",
    "name": "Name of the party or program explicitly identified in this source row.",
    "role": "Capacity expressly attributed to this party in this instrument or row.",
    "party_kind": "Natural person, legal entity or arrangement classification only when stated.",
    "identifier": "Identifier exactly as visible for this party, asset or credential; preserve masking.",
    "identifier_type": "Type or scheme expressly associated with the visible identifier.",
    "identifier_issuer": "Authority or organization explicitly issuing the identifier.",
    "address": "Address explicitly associated with this row's party, with its role retained.",
    "date_of_birth": "Date of birth expressly stated for this individual, preserving precision.",
    "jurisdiction": "Jurisdiction explicitly associated with this party, licence or tax-residence row.",
    "effective_from": "Start date expressly stated for this role, interest, authority or right.",
    "effective_to": "End date expressly stated for this role, interest, authority or right.",
    "owner_name": "Name of the stated owner, distinct from nominee principals or controllers.",
    "owned_entity_name": "Name of the entity whose interest is held in this source-stated edge.",
    "owner_identifier": "Visible identifier for the owner on this ownership edge, retaining issuer context.",
    "owned_entity_identifier": "Visible identifier for the entity owned on this ownership edge.",
    "interest_type": "Economic, capital, profit-sharing or other interest type expressly stated.",
    "share_class": "Class or series of shares, units or interests for this ownership row.",
    "units_held": "Number of shares or units expressly held on the stated basis; no derived values.",
    "total_units": "Source-stated denominator of shares or units for this class and basis.",
    "percentage": "Source-stated ownership percentage on a 0–100 scale; no indirect calculation.",
    "percentage_basis": "Issued, outstanding, diluted, economic or other denominator basis as stated.",
    "voting_percentage": "Voting percentage expressly stated, distinct from economic ownership.",
    "direct_or_indirect": "Direct or indirect interest designation only when explicitly stated.",
    "nominee_capacity": "Nominee, custodian or underlying-principal capacity expressly disclosed.",
    "controller_name": "Party expressly holding the described control right.",
    "controlled_party_name": "Party or arrangement over which the described right operates.",
    "right_type": "Voting, veto, appointment, revocation or other type of control expressly stated.",
    "right_description": "Operative description of the right, retaining qualifications and scope.",
    "conditions": "Conditions expressly limiting the operation or exercise of this right.",
    "signer_name": "Name of the attributed signer without inferring authenticity of the signature.",
    "capacity": "Representative, professional, fiduciary or other capacity expressly stated.",
    "signed_at": "Date expressly associated with this signature or affirmation.",
    "signature_text": "Printed signature attribution or notation; not a biometric signature template.",
    "signature_method": "Wet, electronic, witnessed or other method only when stated.",
    "represented_party": "Party expressly represented by this signer in this action.",
    "holder_name": "Account holder name as recorded, without inferred beneficial ownership.",
    "account_identifier": "Visible account number or identifier preserving masking and leading zeros.",
    "identifier_masked": "Whether the source explicitly displays a masked identifier.",
    "institution_name": "Financial institution name expressly associated with this account.",
    "institution_identifier": "Institution code or identifier exactly as printed with its scheme context.",
    "account_type": "Account category expressly stated in the source.",
    "currency": "Currency expressly associated with this particular row or amount.",
    "opening_balance": "Opening balance expressly stated for this account and reporting period.",
    "closing_balance": "Closing balance expressly stated for this account and reporting period.",
    "transaction_date": "Date explicitly attributed to the transaction rather than posting or value date.",
    "value_date": "Value date explicitly attributed to the transaction.",
    "reference": "Reference exactly linking this row to a transaction, distribution or source.",
    "description": "Description explicitly printed for this item, asset, transaction or program.",
    "amount": "Exact source-stated amount on this row; preserve sign, scale and currency association.",
    "direction": "Debit, credit, inbound or outbound direction only as explicitly represented.",
    "counterparty_name": "Name of the transaction counterparty as recorded by this source.",
    "counterparty_account": "Visible counterparty account identifier, preserving masking.",
    "running_balance": "Running balance explicitly printed after this transaction.",
    "line_number": "Printed line or item identifier, preserving nonnumeric labels.",
    "product_code": "Product, commodity or stock identifier explicitly printed with the item.",
    "quantity": "Source-stated quantity without inferred unit conversion.",
    "unit": "Unit of measure explicitly associated with the quantity.",
    "unit_price": "Unit price expressly associated with this item and currency.",
    "tax_identifier": "Visible tax identifier for this residence row, without reconstructing hidden digits.",
    "tin_absence_reason": "Reason expressly given for an absent TIN in this jurisdiction.",
    "asset_type": "Category of asset explicitly identified by the source.",
    "location": "Source-stated physical, registry or custody location of this asset.",
    "value": "Value expressly stated for this asset; not independently appraised or calculated.",
    "valuation_date": "Date to which this source-stated asset value relates.",
    "payer_name": "Party expressly making the distribution or payment.",
    "recipient_name": "Party expressly receiving or entitled to this distribution.",
    "distribution_basis": "Dividend, gift, inheritance or other stated economic basis of the distribution.",
    "payment_date": "Date expressly associated with the actual or scheduled payment, preserving source wording.",
    "licence_number": "Licence or registration identifier exactly as stated by its issuer.",
    "authority": "Issuing or supervisory authority explicitly named for the licence.",
    "scope": "Activities, territories or services expressly within the stated licence scope.",
    "status_stated": "Status claimed by the source, not this platform's verification result.",
    "issue_date": "Date the source says the licence or instrument was issued.",
    "expiry_date": "Stated expiration date; do not invent an expiry for perpetual instruments.",
    "subject_name": "Subject expressly identified for this finding or assessment.",
    "finding_text": "Finding or conclusion attributed to the source author, preserving qualifications.",
    "evidence_references": "Evidence or document references explicitly cited by the source finding.",
    "author_name": "Author explicitly attributed to this finding or assessment.",
    "finding_date": "Date expressly associated with this finding rather than ingestion time.",
    "question_id": "Question identifier exactly as used by the supplied questionnaire edition.",
    "question_text": "Question wording as supplied, retaining its scope and conditions.",
    "answer_text": "Explicit answer including yes, no, partial or explanatory text; absence remains null.",
    "qualifications": "Explanations, exceptions or limitations explicitly qualifying the answer.",
    "title": "Title of the referenced source or artifact as supplied.",
    "issuer": "Issuer or publisher expressly attributed to the referenced source.",
    "published_date": "Publication or issue date explicitly stated for the referenced source.",
    "url": "Source URL as supplied; it is data and must not be fetched automatically.",
    "purpose": "Stated purpose of the program or activity rather than an inferred charitable objective.",
    "locations": "Locations expressly within the stated program's delivery scope.",
    "delivery_partners": "Named organizations expressly delivering this program.",
    "beneficiary_description": "Named or class-based beneficiaries as expressly described, without inferred individuals.",
    "transaction_type": "Payment, cash, transfer or other transaction category explicitly declared.",
    "frequency": "Source-stated frequency and period associated with the expected count or amount.",
    "count": "Nonnegative whole-number transaction count explicitly declared for the stated period.",
    "countries": "Countries expressly associated with this flow, not the customer's entire geographic exposure.",
    "counterparty_types": "Categories of counterparties expressly associated with this flow.",
    "network": "Blockchain or payment network explicitly associated with this transaction.",
    "asset": "Digital asset symbol or designation explicitly recorded for this transaction.",
    "transaction_hash": "Transaction identifier exactly as supplied on the stated blockchain network.",
    "from_address": "Sending wallet address exactly as supplied; no inferred ownership.",
    "to_address": "Receiving wallet address exactly as supplied; no inferred ownership.",
    "timestamp": "Source timestamp with explicit timezone; an unknown offset remains unresolved.",
    "acquisition_basis": "Purchase, mining, staking, gift or other acquisition mechanism expressly stated.",
    "check_name": "Name of the verification or assessment check exactly as supplied.",
    "result_stated": "Provider-reported check result without conversion to platform verification status.",
    "score": "Provider-reported numeric score; retain scale and avoid cross-provider calibration assumptions.",
    "score_scale": "Range, direction and interpretation of the score only as expressly supplied.",
    "performed_at": "Explicit timestamp with offset at which the provider says this check occurred.",
    "provider_name": "Provider explicitly attributed to this particular check.",
    "method": "Method or technique expressly reported for the assessment.",
    "limitations": "Coverage, quality or methodological limitations explicitly stated by the provider.",
    "person_name": "Person expressly authorized by this authority-limit row.",
    "permitted_action": "Specific action this row explicitly authorizes or restricts.",
    "limit_amount": "Stated authority limit associated with this action and currency.",
    "joint_signing_rule": "Sole, joint or other co-signing rule expressly required for this authority.",
    "label": "Financial line label exactly as printed, preserving gross, net and subtotal distinctions.",
    "period_start": "Start date of the reporting interval explicitly associated with this financial line.",
    "period_end": "End date of the reporting interval explicitly associated with this financial line.",
    "comparative_or_current": "Current, prior-year, forecast or comparative column designation as printed.",
    "consolidation_basis": "Standalone, consolidated or other reporting scope only as expressly stated.",
    "scale": "Units, thousands, millions or other printed scaling associated with this financial line.",
}

# Conservative field-level classification for nested content. Consumers may
# narrow or raise classifications under their own admitted data policy, but a
# low-sensitivity parent must not conceal identifiers or financial data.
OBJECT_SENSITIVITY = {
    "Address": "personal", "Party": "restricted", "Ownership": "restricted", "Control": "restricted",
    "Signature": "personal", "Account": "restricted", "TransactionRow": "restricted", "LineItem": "internal",
    "TaxResidence": "restricted", "Asset": "restricted", "Distribution": "restricted", "Licence": "personal",
    "Finding": "restricted", "QuestionAnswer": "restricted", "SourceReference": "internal", "Programme": "restricted",
    "ExpectedFlow": "restricted", "CryptoTransaction": "restricted", "Check": "restricted",
    "AuthorityLimit": "restricted", "FinancialLine": "restricted",
}
for name, field in list(FIELDS.items()):
    levels = {"internal": 0, "personal": 1, "restricted": 2}
    shape = field.value_type.strip("[]")
    sensitivity = OBJECT_SENSITIVITY.get(shape, field.sensitivity)
    if name == "document_number":
        sensitivity = "restricted"
    if levels[sensitivity] > levels[field.sensitivity]:
        FIELDS[name] = field.model_copy(update={"sensitivity": sensitivity})

# Mappings are potential assertion destinations, never writes. Subject resolution,
# units, verification and record requirements belong to downstream governed services.
for name, target in {
    "person_name": ("Entity", "name", "Resolve the identified natural person and preserve source script."),
    "entity_name": ("Entity", "name", "Resolve the legal entity; do not merge by name alone."),
    "date_of_birth": ("Identity", "attributes.date_of_birth", "Require a complete, unambiguous date and resolved person."),
    "subject_address": ("Address", "lines", "Map structured components with subject and address-role resolution."),
    "registration_number": ("Registration", "registration_id", "Require authority and jurisdiction from the same admitted evidence."),
    "formation_jurisdiction": ("Registration", "jurisdiction", "Disambiguate formation from residence and operational exposure."),
    "registration_authority": ("Registration", "authority", "Resolve the issuing registry or competent authority."),
    "business_activity": ("Party", "profile.business_purpose", "Retain a customer declaration until independently verified."),
    "source_of_funds_statement": ("SourceOfFunds", "claim", "An attributed explanation; verified remains false until separate verification."),
    "source_of_wealth_statement": ("SourceOfWealth", "claim", "An attributed explanation; verified remains false until separate verification."),
    "ownership_interests": ("OwnershipInterest", "interest", "Resolve both ends, class and basis; convert percent to a fraction deterministically; preserve dates."),
    "control_rights": ("ControlRight", "basis", "Resolve controller and controlled entity; legal interpretation requires separate review."),
    "beneficial_owners_stated": ("BeneficialOwner", "entity_id", "Declaration only; resolve natural persons and apply the admitted ownership/control policy separately."),
}.items():
    object_type, field_path, condition = target
    FIELDS[name] = FIELDS[name].model_copy(update={"context_targets": (ContextTarget(
        object_type=object_type, field_path=field_path, condition=condition),)})

# A passport's number is its document number (ICAO 9303 "document number") and the identification
# number that customer identification records. A separate personal number printed on a passport is
# identity_number. On other document types document_number is a certificate, invoice or form number,
# so this target is scoped to passports.
FIELDS["document_number"] = FIELDS["document_number"].model_copy(update={"context_targets": (ContextTarget(
    object_type="IdentityIdentifier", field_path="value",
    condition="The passport number: identifier_type passport_number and issuer from the same passport's "
              "issuing_jurisdiction; resolve the holder first; verified stays false until separately verified.",
    document_types=("passport",)),)})
