"""Explicit document selections over the shared semantic field library.

Sibling document types share fields only when their evidence semantics agree.
Jurisdiction-specific acceptance, form editions and mandatory collection remain
separate policy overlays. A field contract does not claim legal sufficiency.
"""
from .fields import FIELDS
from .model import DocumentProfile

COVERAGE = {
    "01_identity": "Individual identity and personal particulars",
    "02_address": "Individual address and residence",
    "03_income": "Occupation, income and economic profile",
    "04_wealth": "Source of funds and source of wealth",
    "05_legal": "Business legal existence and constitution",
    "06_presence": "Business premises, operations and legitimacy",
    "07_ownership": "Ownership and beneficial ownership",
    "08_authority": "Control, management and authority to act",
    "09_financial": "Business financial position and funding",
    "10_structures": "Entity-specific legal structures",
    "11_trust": "Trusts and similar arrangements",
    "12_tax": "Tax residency and reporting status",
    "13_relationship": "Relationship purpose and expected activity",
    "14_sector": "Sector and institutional due diligence",
    "15_edd": "EDD, screening clarification and investigations",
    "16_transactions": "Transaction and trade evidence",
    "17_special": "Special individual circumstances",
    "18_digital": "Digital onboarding and verification evidence",
    "19_certification": "Certification, translation and authenticity",
    "20_refresh": "Periodic and event-driven review",
    "21_independent": "Independent evidence and institutional records",
}

PROFILES: dict[str, DocumentProfile] = {}
COMMON = "document_title document_number issuer_name issue_date"
DEFAULT_USES = ("onboarding", "periodic_review", "event_driven_review")


def add(identifier, title, family, fields, keys, *, coverage, notes, aliases=(),
        origins=("customer", "independent"), uses=DEFAULT_USES, kind="document"):
    selected = tuple(dict.fromkeys((COMMON + " " + fields).split()))
    key_fields = tuple(keys.split())
    if identifier in PROFILES or not set(selected) <= FIELDS.keys() or not set(key_fields) <= set(selected):
        raise ValueError(f"invalid profile {identifier}: {set(selected)-FIELDS.keys()}")
    if not set(coverage) <= COVERAGE.keys():
        raise ValueError(identifier)
    PROFILES[identifier] = DocumentProfile(
        id=identifier, display_name=title, family=family, coverage=tuple(coverage),
        field_names=selected, key_fields=key_fields, aliases=tuple(aliases),
        use_cases=tuple(uses), origins=tuple(origins), artifact_kind=kind, extraction_notes=notes)


def group(family, fields, keys, rows, *, coverage, notes, **kwargs):
    """Rows: id | display name | extra fields | extra key fields | additional note."""
    for line in rows.strip().splitlines():
        identifier, title, extra, extra_keys, note = (line.strip().split("|") + [""] * 5)[:5]
        add(identifier, title, family, fields + " " + extra, keys + " " + extra_keys,
            coverage=coverage, notes=notes + (" " + note if note else ""), **kwargs)


group("personal_identity",
      "person_name given_names family_name date_of_birth place_of_birth nationalities identity_number identity_type issuing_jurisdiction expiry_date signatures",
      "person_name identity_number", """
passport|Passport|previous_names||Keep MRZ and visual-zone discrepancies explicit; no inferred nationality or checksum validity. The passport number is document_number; identity_number holds only a separate personal or national number printed on the passport.
national_identity_card|National identity card|subject_address||Retain front/back evidence and the issuing scheme; acceptability is policy-specific.
driving_licence|Driving licence|subject_address||Separate driving entitlement from the identity and address assertions used for KYC.
government_photo_id|Other accepted government photo identification|||Record the exact credential type; this profile does not make all government IDs acceptable.
military_identity_card|Military identity card|||Extract only the fields within the admitted purpose and field scope.
voter_identity_card|Voter identity card|subject_address||Do not infer nationality or legal address from eligibility to vote.
refugee_travel_document|Refugee travel document|residence_status||Travel-document status is distinct from citizenship.
stateless_travel_document|Stateless-person travel document|residence_status||Do not populate a nationality from the issuing country.
government_travel_certificate|Government travel certificate|residence_status||Record the precise travel instrument and its stated restrictions.
""", coverage=("01_identity", "17_special", "20_refresh"),
      notes="Capture only visible particulars; preserve masking, original script and partial dates. No biometric measurements or identity verification are performed.")

group("residence_and_status", "person_name date_of_birth identity_number issuing_jurisdiction residence_status entry_or_stay_conditions effective_date expiry_date",
      "person_name residence_status", """
residence_permit|Residence permit|subject_address||
permanent_resident_card|Permanent-resident card|subject_address||
visa|Visa or entry permission|||Conditions are source-stated; do not decide a legal right to work or bank.
electronic_immigration_status|Electronic immigration-status confirmation|provider_name performed_at||Keep the status retrieval tied to its issuer and retrieval evidence.
refugee_status_letter|Refugee or asylum-status letter|parties||Preserve the distinction between an application and granted status.
citizenship_certificate|Citizenship or naturalization certificate|nationalities||Record the explicit citizenship grant without inferring current residence.
""", coverage=("01_identity", "17_special", "20_refresh"),
      notes="Status and validity depend on the particular instrument and law; no jurisdiction-wide acceptance is implied.")

group("civil_and_representative", "person_name date_of_birth parties issuing_jurisdiction registration_number relationship_basis effective_date signatures",
      "person_name", """
birth_certificate|Birth certificate|place_of_birth||Keep child and parent roles separate; this is supporting civil evidence.
family_register|Family or household register|subject_address||Each household member is a separate party, not an alias of the applicant.
marriage_certificate|Marriage certificate|new_name name_change_basis||Do not assume a marriage changes either party's legal name.
divorce_decree|Divorce decree|new_name name_change_basis distribution_terms||Separate marital status, name and financial orders.
name_change_instrument|Deed poll or official name-change certificate|previous_names new_name name_change_basis|new_name|Link old and new names only to the identified subject.
name_change_court_order|Court order changing a person's name|previous_names new_name legal_case_reference|new_name|
guardianship_order|Guardianship, conservatorship or parental-authority order|authorized_actions authority_limits expiry_date||Capture scope, subject and representative; do not infer unrestricted authority.
death_certificate|Death certificate|death_date place_of_birth|death_date|Date of death is distinct from registration and issue dates.
relationship_declaration|Family, sponsor or household relationship declaration|customer_explanation||A declaration is attributed evidence, not independent confirmation.
""", coverage=("01_identity", "17_special", "20_refresh"),
      notes="Extract each person's capacity and dates with source references; preserve restrictions in legal orders.")

group("address_evidence", "subject_name subject_address period_start period_end accounts",
      "subject_name subject_address", """
utility_bill|Utility bill|service_type service_address total_amount currency due_date||Service location may differ from the billing address.
telecom_bill|Fixed-line, cable or other communications bill|service_type service_address||Allowed service types are determined by the acceptance policy.
municipal_tax_bill|Municipal or property-tax bill|property_address tax_year||Ownership and residence are not interchangeable.
government_address_letter|Government address or residence letter|residence_status||
official_residence_certificate|Official residence certificate|effective_date expiry_date||
benefit_award_letter|Government benefit award or payment letter|education_or_support_details amount currency income_frequency||Benefits award and actual payment are separate assertions.
education_accommodation_letter|University enrollment or accommodation letter|education_or_support_details occupancy_start occupancy_end||
employer_accommodation_letter|Employer accommodation letter|employer_name occupancy_start occupancy_end||
shelter_or_support_letter|Shelter, care-home or support-agency confirmation|occupancy_basis occupancy_start occupancy_end parties||Support alternatives are policy-specific; do not infer a permanent address.
host_address_declaration|Host or landlord address declaration|parties relationship_basis occupancy_basis||Host identity and corroborating evidence are separate requirements.
""", coverage=("02_address", "17_special", "20_refresh"),
      notes="Dates are source dates, not freshness decisions. A correspondence address does not prove physical residence.")

group("property_and_occupancy", "subject_name property_address parties occupancy_basis occupancy_start occupancy_end signatures",
      "property_address parties", """
residential_lease|Residential tenancy or lease agreement|amount currency payment_terms||A signed lease alone does not prove current occupancy.
commercial_lease|Commercial lease or premises licence|entity_name operating_addresses amount currency payment_terms||
property_title|Property title, deed or land-register extract|assets registration_number registration_authority||Capture title holder, interest and property identifiers separately.
serviced_office_agreement|Serviced-office or coworking agreement|entity_name service_type||Separate mail service from actual operating occupancy.
registered_agent_agreement|Registered-agent agreement|entity_name registered_address authorized_actions||A registered agent address is not automatically an operating location.
""", coverage=("02_address", "06_presence", "16_transactions", "20_refresh"),
      notes="Retain property, owner, tenant and service-provider roles; title, lease and actual use are different evidence claims.")

group("bank_and_account_evidence", "subject_name subject_address period_start period_end accounts transactions",
      "subject_name accounts", """
bank_statement|Bank or credit-union statement||||
credit_card_statement|Credit-card statement|total_amount due_date currency||Distinguish outstanding balance from income or wealth.
mortgage_statement|Mortgage statement|property_address loan_terms||A mortgage statement is not an ownership or occupancy verification.
savings_history|Savings-account history|source_of_funds_statement source_of_wealth_statement||The transfer account is not necessarily the underlying economic source.
bank_reference_letter|Banking reference or account confirmation|status_stated||Record only what the issuing bank confirms.
merchant_settlement_statement|Merchant settlement statement|entity_name amount currency payment_reference||Gross sales, fees and net payout must remain distinguishable in source rows.
""", coverage=("02_address", "04_wealth", "09_financial", "16_transactions", "21_independent"),
      notes="Preserve account masking and holder names. Do not reconstruct hidden identifiers, classify unexplained transfers as salary, or calculate wealth.")

group("employment_and_support", "person_name employer_name occupation employment_status employment_start employment_end subject_address signatures",
      "person_name employer_name", """
employment_contract|Employment contract|gross_income currency income_frequency||Contractual pay is not proof of actual receipt.
employer_confirmation|Employment or salary confirmation letter|gross_income currency income_frequency||
professional_practising_certificate|Professional registration or practising certificate|professional_registration issuing_jurisdiction expiry_date regulated_activities||Licence validity requires a separate issuer check.
education_enrollment_letter|Education enrollment letter|education_or_support_details period_start period_end||
sponsor_support_declaration|Sponsor or family-support declaration|parties relationship_basis source_of_funds_statement amount currency||The sponsor is distinct from the supported applicant.
""", coverage=("03_income", "14_sector", "17_special"),
      notes="Keep the individual and paying/supporting organization separate; occupation and income are source assertions.")

group("earnings_and_benefits", "person_name employer_name period_start period_end gross_income net_income currency income_frequency deductions accounts",
      "person_name", """
payslip|Payslip or payroll earnings statement|occupation||
annual_earnings_statement|Annual earnings statement|tax_year tax_identifier||
pension_statement|Pension or retirement-benefit statement|education_or_support_details assets amount||Separate accumulated pension assets, income and withdrawal entitlement.
pension_award_letter|Pension award or lump-sum confirmation|education_or_support_details amount payment_date||
scholarship_award|Scholarship or student-grant award|education_or_support_details amount funding_conditions||
""", coverage=("03_income", "04_wealth", "17_special"),
      notes="Retain gross/net labels, period and currency; absent income does not become zero.")

group("entity_formation", "entity_name entity_legal_form registration_number registration_authority formation_date formation_jurisdiction registered_address status_stated",
      "entity_name registration_number", """
certificate_of_incorporation|Certificate of incorporation or formation||||
business_registration_certificate|Business registration certificate|trading_names expiry_date||
trade_name_registration|Trade-name or assumed-name registration|trading_names|trading_names|
company_registry_extract|Company or commercial-register extract|parties ownership_interests record_as_of_date operating_addresses||Only extract the scope this registry report actually contains.
certificate_of_good_standing|Certificate of good standing or legal existence|record_as_of_date expiry_date||Good standing does not establish current ownership or active trading.
branch_registration|Branch, foreign-company or representative-office registration|parent_entity_name authorized_actions||A branch and its parent retain distinct legal/operating roles.
charity_registration|Charity or nonprofit registration|constitutional_purpose regulator_name||
cooperative_registration|Cooperative or mutual registration|constitutional_purpose||
association_registration|Association, society or club registration|constitutional_purpose||
""", coverage=("05_legal", "06_presence", "10_structures", "20_refresh", "21_independent"),
      notes="Formation, current status and business activity are separate assertions; do not infer one from the other.")

group("constitutional_and_governance", "entity_name entity_legal_form governing_law constitutional_purpose governance_rules parties control_rights effective_date signatures",
      "entity_name", """
articles_of_association|Memorandum, articles or organizational constitution|share_classes issued_capital capital_currency||
corporate_bylaws|Corporate bylaws or charter||||
llc_operating_agreement|LLC operating or member agreement|ownership_interests distributions||
partnership_agreement|Partnership deed or agreement|ownership_interests distributions authorized_actions||Differentiate capital, profit-sharing and voting interests.
limited_partnership_agreement|Limited-partnership agreement|ownership_interests authority_limits||Preserve general-partner and limited-partner capacities.
llp_agreement|Limited-liability partnership agreement|ownership_interests authorized_actions||
joint_venture_agreement|Joint-venture agreement|ownership_interests business_activity funding_conditions||
association_constitution|Association, society, club or cooperative rules|authorized_actions||
foundation_charter|Foundation charter, statutes or bylaws|trust_parties distribution_terms||Map founder, council and protector equivalents by the stated roles.
government_enabling_instrument|Enabling legislation or public-body establishment instrument|authorized_actions||Record statutory powers as stated; legal interpretation is separate.
pension_scheme_rules|Pension-scheme deed and rules|trust_parties beneficiary_classes distribution_terms||
""", coverage=("05_legal", "07_ownership", "08_authority", "10_structures", "11_trust"),
      notes="Long legal instruments need clause-level spans and page continuation handling. Preserve qualifications, schedules and amendments.")

group("entity_changes", "entity_name registration_number registration_authority previous_entity_name change_type effective_date parties filing_reference status_stated",
      "entity_name change_type", """
company_name_change_certificate|Company change-of-name certificate||||
entity_conversion_certificate|Entity conversion or continuation certificate|entity_legal_form formation_jurisdiction||
redomiciliation_document|Re-domiciliation or migration instrument|formation_jurisdiction governing_law||
merger_or_demerger_document|Merger, demerger or reorganization document|parent_entity_name ownership_interests||Retain predecessor and successor entities separately.
insolvency_order|Insolvency, liquidation or administration order|insolvency_details authorized_actions authority_limits||
liquidator_appointment|Administrator or liquidator appointment|insolvency_details authorized_actions authority_limits||
dissolution_or_restoration_certificate|Dissolution or restoration certificate|insolvency_details||
""", coverage=("05_legal", "08_authority", "10_structures", "20_refresh"),
      notes="An amendment affects only its stated scope and effective period; do not silently overwrite earlier legal evidence.")

group("ownership_records", "entity_name registration_number record_as_of_date ownership_interests share_classes total_units ownership_scope signatures",
      "entity_name ownership_interests", """
shareholder_register|Shareholder or member register|control_rights||Register ownership is distinct from ultimate beneficial ownership.
capitalization_table|Capitalization table|issued_capital capital_currency||Distinguish issued, outstanding and fully diluted bases as stated.
share_certificate|Share or membership-interest certificate|document_number||A certificate alone does not establish a complete current register.
partnership_interest_schedule|Partnership-interest or capital schedule|distributions||Do not equate profit share with voting or capital share.
ownership_structure_chart|Ownership or group structure chart|control_rights beneficial_owners_stated||Record each edge and layer; avoid flattening an indirect interest into a direct edge.
beneficial_ownership_declaration|Beneficial ownership certification or declaration|beneficial_owners_stated control_rights||The declared UBO list requires separate policy evaluation and corroboration.
beneficial_ownership_registry_extract|Beneficial ownership register extract|beneficial_owners_stated registration_authority||The register's scope and date limit its evidential coverage.
annual_return|Annual return or confirmation statement|parties registered_address||
substantial_shareholder_disclosure|Substantial shareholder disclosure|listing_venue security_identifier control_rights||
custodian_holding_statement|Custodian or depositary holding confirmation|nominee_arrangements accounts||Legal holder and underlying principal must remain distinct.
bearer_interest_custody_confirmation|Bearer-interest custody or immobilization confirmation|nominee_arrangements parties||Do not treat custody as proof that no undisclosed controller exists.
""", coverage=("07_ownership", "08_authority", "10_structures", "20_refresh", "21_independent"),
      notes="Capture source percentages and their denominators without calculating indirect holdings, inferring missing owners or applying a universal UBO threshold.")

group("ownership_transactions_and_control", "entity_name parties ownership_interests control_rights effective_date governing_law signatures",
      "parties", """
share_transfer_instrument|Share or membership-interest transfer instrument|amount currency payment_date||Capture transferor, transferee and completion conditions.
share_subscription_agreement|Share subscription or allotment agreement|amount currency funding_conditions||A commitment and a completed allotment are different events.
shareholder_agreement|Shareholder or voting agreement|share_classes||Preserve appointment, veto, reserved matters and agreement conditions.
nominee_declaration|Nominee declaration or declaration of trust|nominee_arrangements|nominee_arrangements|Identify legal holder and disclosed underlying principal separately.
nominee_agreement|Nominee or custody agreement|nominee_arrangements authorized_actions||
business_acquisition_agreement|Business or share purchase agreement|assets proceeds_amount proceeds_currency funding_conditions||Executed, conditional and completed transactions must remain distinguishable.
""", coverage=("04_wealth", "07_ownership", "08_authority", "09_financial", "20_refresh"),
      notes="Extract operative conditions and dates with clause-level evidence; no independent legal determination or fact promotion.")

group("management_and_authority", "entity_name parties representatives authorized_actions authority_limits signing_rule effective_date expiry_date signatures",
      "entity_name parties", """
certificate_of_incumbency|Certificate of incumbency or secretary's certificate|record_as_of_date||
director_officer_register|Director or officer register|record_as_of_date||
officeholder_list|Officeholder, committee or council-member list|record_as_of_date||
appointment_instrument|Director, officer or representative appointment|revocation_terms||
board_resolution|Board or governing-body resolution|resolution_text meeting_date||
partner_resolution|Partner or member resolution|resolution_text meeting_date||
meeting_minutes|Board, AGM or governing-body minutes|resolution_text meeting_date||Record adopted resolutions separately from discussion or proposals.
account_mandate|Account mandate or authorized-signatory list|accounts revocation_terms||Preserve account and action scope and joint-signing conditions.
delegated_authority_letter|Delegated-authority or agency letter|revocation_terms||
power_of_attorney|Power of attorney|revocation_terms governing_law relationship_basis||The grantor, attorney, scope and any restrictions are distinct.
agency_agreement|Agency or representation agreement|revocation_terms governing_law payment_terms||
authority_non_revocation_confirmation|Continuing-authority or non-revocation confirmation|revocation_terms record_as_of_date||Record the confirming person's capacity and statement date.
specimen_signature_card|Specimen signature card|accounts||Capture the fact and attribution of a specimen; do not perform signature authentication.
""", coverage=("08_authority", "10_structures", "17_special", "20_refresh"),
      notes="Authority to open, operate, borrow, delegate and close are separate permissions; do not infer unrestricted authority.")

group("financial_reporting", "entity_name period_start period_end currency accounting_basis financial_lines revenue net_profit total_assets total_liabilities net_assets auditor_name audit_opinion",
      "entity_name period_end", """
audited_financial_statements|Audited financial statements|references||Audit opinion, entity scope and consolidated/standalone basis must be retained.
unaudited_financial_statements|Unaudited financial statements|||Do not assign audited status without an explicit auditor report.
management_accounts|Management or interim accounts||||
annual_report|Annual report|parties ownership_interests business_activity listing_venue||Distinguish narrative claims from audited financial sections.
cash_flow_statement|Cash-flow statement||||
financial_projections|Financial projections or forecast|business_plan funding_conditions||Forecasts are not historical results.
sales_ledger|Sales or receivables ledger|transactions counterparties||Keep ledger rows and period coverage; no fabricated completeness claim.
payroll_summary|Payroll or employee summary|employee_count deductions||Collect person-level data only within the admitted purpose and scope.
""", coverage=("03_income", "04_wealth", "09_financial", "14_sector", "21_independent"),
      notes="Retain units and scaling (for example thousands), currency, periods, audit status and scope. Do not calculate absent figures or interpret profitability as legitimate provenance.")

group("funding_and_distributions", "parties amount currency payment_date payment_reference accounts underlying_event funding_conditions signatures",
      "parties", """
loan_agreement|Loan or credit facility agreement|loan_terms governing_law||Agreement, drawdown and receipt of funds are separate evidence.
loan_disbursement_confirmation|Loan drawdown or disbursement confirmation|loan_terms||
shareholder_or_intercompany_loan|Shareholder or intercompany loan|entity_name loan_terms governing_law||
parent_funding_commitment|Parent-company funding commitment|entity_name source_of_funds_statement||Commitment does not prove funds were received.
capital_contribution_record|Capital contribution record|entity_name ownership_interests||
investment_funding_agreement|Investment or fundraising agreement|entity_name ownership_interests||
grant_award|Grant, subsidy or funding award|donor_funding_statement programmes||Preserve award conditions and recipient restrictions.
dividend_voucher|Dividend voucher or distribution statement|entity_name distributions ownership_interests||
dividend_resolution|Dividend or distribution resolution|entity_name distributions resolution_text||Authorization and actual payment are distinct.
gift_deed|Gift deed or donor declaration|relationship_basis source_of_funds_statement||Donor identity and donor economic source require separate evidence.
insurance_payout_confirmation|Insurance claim settlement or payout confirmation|assets||A payout letter and proof of receipt are separate.
compensation_settlement|Compensation or legal-settlement agreement|legal_case_reference proceeds_amount proceeds_currency||Preserve conditions, payer and recipient attribution.
prize_award_confirmation|Prize or award payment confirmation|source_of_funds_statement||
""", coverage=("04_wealth", "09_financial", "16_transactions"),
      notes="Preserve economic basis and party roles; a transfer path alone does not establish the underlying source of funds.")

group("asset_realization_and_investment", "parties assets accounts proceeds_amount proceeds_currency payment_date payment_reference underlying_event",
      "parties", """
asset_sale_agreement|Asset sale agreement|contract_reference funding_conditions signatures||
property_sale_agreement|Property sale or purchase agreement|property_address contract_reference funding_conditions signatures||
completion_statement|Property, business or asset completion statement|property_address financial_lines||Gross consideration, fees and net proceeds must remain distinguishable.
broker_trade_confirmation|Broker trade confirmation or contract note|security_identifier amount currency||
investment_redemption_confirmation|Fund or investment redemption confirmation|fund_name security_identifier||
investment_portfolio_statement|Investment portfolio or custody statement|period_start period_end financial_lines||A balance alone does not establish acquisition origin.
asset_valuation_report|Asset valuation or appraisal report|assurance_scope||Valuation is distinct from ownership and realized proceeds.
rental_income_statement|Rental income or property-manager statement|property_address period_start period_end transactions||
""", coverage=("03_income", "04_wealth", "09_financial", "16_transactions"),
      notes="Identify seller, buyer, holder and beneficial recipient separately; retain source-stated acquisition and settlement information.")

group("estate", "person_name death_date parties legal_case_reference governing_law assets distributions authorized_actions authority_limits signatures",
      "person_name parties", """
will|Will or testamentary instrument|distribution_terms||A will alone does not prove that a grant is effective or assets have been distributed.
grant_of_probate|Grant of probate|effective_date||
letters_of_administration|Letters of administration|effective_date||
estate_distribution_statement|Estate distribution or inheritance statement|payment_date accounts proceeds_amount proceeds_currency||
""", coverage=("04_wealth", "08_authority", "10_structures", "17_special"),
      notes="Decedent, executor/administrator and beneficiary are distinct parties; restrictions and jurisdiction remain explicit.")

group("trust_and_fiduciary", "trust_name trust_type trust_purpose governing_law effective_date trust_parties beneficiary_classes trust_powers distribution_terms signatures",
      "trust_name trust_parties", """
trust_deed|Trust deed or constituting instrument|trust_asset_schedule||Capture settlor, trustee, protector and other roles without collapsing them into one owner.
trust_amendment|Trust amendment, supplemental deed or restatement|amendment_scope||Record which prior instrument and clauses are changed.
trust_registration|Trust registration certificate or extract|registration_number registration_authority record_as_of_date||
trustee_appointment_deed|Trustee appointment, retirement or replacement deed|amendment_scope revocation_terms||Preserve outgoing and incoming roles and effective dates.
protector_appointment|Protector, appointor or enforcer appointment|amendment_scope revocation_terms||
beneficiary_schedule|Beneficiary or beneficiary-class schedule|record_as_of_date||A class description is not an inferred list of individuals.
letter_of_wishes|Letter of wishes|references||Do not assume wishes are legally binding powers or entitlements.
trust_asset_schedule|Trust settlement or asset-contribution schedule|trust_asset_schedule source_of_funds_statement||
trust_accounts|Trust accounts or financial statements|period_start period_end financial_lines accounts currency||
trust_distribution_statement|Trust distribution statement|distributions accounts payment_date||
trustee_resolution|Trustee resolution or account mandate|resolution_text authorized_actions authority_limits accounts meeting_date||
""", coverage=("04_wealth", "07_ownership", "08_authority", "10_structures", "11_trust", "20_refresh"),
      notes="Preserve the arrangement's stated roles, powers, classes and amendments; applicability and beneficial-owner resolution require separate policy and legal evaluation.")

group("tax_self_certification", "subject_name subject_address tax_residences tax_identifier certification_text signatures form_revision",
      "subject_name tax_residences", """
individual_tax_self_certification|Individual tax-residency self-certification|date_of_birth us_person_declaration||
entity_tax_self_certification|Entity tax-residency self-certification|entity_name tax_entity_classification giin controlling_persons_tax||
controlling_person_tax_self_certification|Controlling-person tax-residency self-certification|date_of_birth controlling_persons_tax relationship_basis||Tax controlling-person capacity must remain distinct from AML UBO findings.
tax_residence_certificate|Tax residence certificate|tax_year issuing_jurisdiction expiry_date||
missing_tin_explanation|Missing-TIN or tax-status discrepancy explanation|customer_explanation||Preserve each jurisdiction and its stated absence reason.
""", coverage=("12_tax", "20_refresh"),
      notes="Tax residence is not inferred from nationality, mailing address or incorporation. Form acceptability and reasonableness checks are separate policies.")

group("us_tax_forms", "subject_name entity_name subject_address tax_form_type form_revision tax_identifier tax_entity_classification certification_text signatures",
      "subject_name tax_form_type", """
w9|US Form W-9|us_person_declaration tax_exemption_basis||Capture checked classifications and exemptions without inferring US status.
w8ben|US Form W-8BEN|tax_residences date_of_birth treaty_claim||An individual withholding certificate, not the entity version.
w8bene|US Form W-8BEN-E|tax_residences chapter3_status chapter4_status giin treaty_claim controlling_persons_tax||Use the supplied edition; capture applicable selected parts with clause references.
w8imy|US Form W-8IMY|chapter3_status chapter4_status giin intermediary_capacity withholding_statement references||Underlying withholding statements and owner documents are distinct linked artifacts.
w8eci|US Form W-8ECI|tax_residences business_activity tax_exemption_basis||Capture the explicitly identified income and effectively-connected claim.
w8exp|US Form W-8EXP|chapter3_status chapter4_status giin tax_exemption_basis||Preserve the claimed government, organization or exemption capacity.
withholding_allocation_statement|Withholding or intermediary allocation statement|withholding_statement parties distributions references||Allocation rows and referenced certificates must stay linked.
""", coverage=("12_tax", "20_refresh"),
      notes="This jurisdiction-specific document identity is supported without baking US policy into the neutral catalog. These are semantic fields, not an edition-specific box-complete IRS form implementation.")

group("tax_registration_and_returns", "subject_name entity_name subject_address tax_identifier registration_authority tax_year period_start period_end tax_entity_classification financial_lines currency",
      "subject_name tax_identifier", """
tax_registration_certificate|Tax registration or identifier confirmation|effective_date expiry_date||
personal_tax_return|Individual income-tax return|gross_income net_income assets||A filed return and a draft or self-prepared return are distinct source states.
corporate_tax_return|Corporate tax return|revenue net_profit total_assets total_liabilities||
tax_assessment|Tax assessment or authority notification|status_stated amount||
vat_gst_return|VAT, GST or sales-tax filing|revenue amount||Preserve tax-period and tax-base distinctions.
tax_exemption_certificate|Tax-exemption determination or certificate|tax_exemption_basis expiry_date||
""", coverage=("01_identity", "03_income", "09_financial", "12_tax", "20_refresh"),
      notes="Keep full and masked identifiers distinct; extraction does not verify filing, residence or tax compliance.")

group("business_operations", "entity_name business_activity products_services countries_of_operation operating_addresses counterparties business_websites",
      "entity_name business_activity", """
business_profile|Business profile or operating-model questionnaire|industry_codes employee_count parties||
business_plan|Business plan or startup operating plan|business_plan funding_conditions financial_lines||Planned operations and forecasts are not observed activity.
product_catalog|Product catalog or business brochure|industry_codes line_items||
website_capture|Business website or marketplace capture|record_as_of_date references||A webpage claim is not authoritative proof of legal existence or a licence.
customer_supplier_list|Major customer or supplier list|expected_flows||Maintain role and claimed scope for every counterparty.
facility_operating_record|Warehouse, facility or operational-capacity record|assets employee_count||
group_treasury_policy|Group treasury or cash-pooling policy|parties payment_flow_description third_party_funds_statement||
""", coverage=("06_presence", "09_financial", "13_relationship", "14_sector"),
      notes="Statements are attributed to the business or publisher; verify material claims through separate evidence.")

group("relationship_and_application", "subject_name entity_name parties relationship_purpose products_services expected_flows countries_of_operation source_of_funds_statement signatures",
      "subject_name relationship_purpose", """
individual_account_application|Individual account application|person_name date_of_birth subject_address occupation cash_activity_statement||
business_account_application|Business account application|business_activity ownership_interests beneficial_owners_stated third_party_funds_statement||
kyc_cdd_questionnaire|KYC or CDD questionnaire|person_name date_of_birth subject_address occupation business_activity beneficial_owners_stated pep_declaration||Applicant declarations and institution review fields must remain separately attributed.
expected_activity_declaration|Expected-activity or transaction-profile declaration|cash_activity_statement third_party_funds_statement||Preserve direction, transaction count, amount, period and currency associations.
initial_funding_declaration|Initial deposit or funding declaration|amount currency accounts underlying_event||
third_party_funds_declaration|Client-money or third-party-funds declaration|third_party_funds_statement safeguarding_arrangements||
trust_account_application|Trust or fiduciary account-opening package|trust_name trust_type trust_parties beneficiary_classes trust_powers amount currency||This package can refer to constituent deeds and mandates rather than replacing them.
merchant_onboarding_application|Merchant onboarding application|business_activity industry_codes business_websites merchant_controls payment_flow_description||
product_service_agreement|Product or financial-service agreement|payment_terms authorized_actions authority_limits||
""", coverage=("03_income", "07_ownership", "11_trust", "13_relationship", "14_sector", "20_refresh"),
      notes="Declared expected activity is distinct from actual activity and verified financial capacity. No automatic risk or acceptance decision.")

group("commercial_and_trade", "parties contract_reference invoice_number purchase_order_number line_items currency subtotal tax_amount total_amount due_date payment_terms signatures",
      "parties", """
commercial_contract|Customer, supplier or services contract|business_activity funding_conditions||
commercial_invoice|Commercial invoice|shipment_reference incoterms||Every amount retains its line and currency; do not infer a transaction was completed.
purchase_order|Purchase order|incoterms goods_description||An order is not a delivery or payment.
statement_of_account|Supplier or customer statement of account|period_start period_end transactions accounts||
delivery_confirmation|Delivery note or proof of delivery|shipment_reference goods_description payment_date||
escrow_agreement|Escrow agreement|accounts safeguarding_arrangements authorized_actions funding_conditions||Distinguish legal account holder, depositor and entitled beneficiary.
client_money_agreement|Client-money, collection or payment-processing agreement|accounts safeguarding_arrangements payment_flow_description third_party_funds_statement||
intercompany_cash_pool_agreement|Intercompany treasury or cash-pooling agreement|accounts payment_flow_description loan_terms||
""", coverage=("06_presence", "09_financial", "13_relationship", "16_transactions"),
      notes="Preserve contract, invoice, purchase-order, delivery and settlement distinctions; connect documents by explicit references rather than similar names.")

group("shipping_and_trade_finance", "parties shipment_reference goods_description line_items origin_country destination_country transport_route carrier_name vessel_or_flight incoterms references",
      "shipment_reference parties", """
bill_of_lading|Bill of lading|payment_terms||Shipper, consignee, notify party and carrier are distinct roles.
air_waybill|Air waybill||||
packing_list|Packing list||||
customs_declaration|Customs declaration|registration_authority amount currency||
certificate_of_origin|Certificate of origin|issuer_name||
import_export_permit|Import or export permit|licences end_use_statement expiry_date||Capture authorized scope and conditions; no sanctions clearance is implied.
end_user_certificate|End-user or end-use certificate|end_use_statement|end_use_statement|
letter_of_credit|Letter of credit|amount currency expiry_date credit_or_guarantee_terms||Applicant, beneficiary, issuing and advising banks remain distinct.
documentary_collection_instruction|Documentary collection instructions|amount currency credit_or_guarantee_terms||
bill_of_exchange|Bill of exchange|amount currency due_date credit_or_guarantee_terms signatures||
trade_guarantee|Guarantee or standby letter of credit|amount currency expiry_date credit_or_guarantee_terms||
freight_agreement|Freight or transport agreement|contract_reference payment_terms||
cargo_insurance_certificate|Cargo insurance certificate|amount currency expiry_date credit_or_guarantee_terms||
goods_inspection_certificate|Goods inspection or quality certificate|assurance_scope verification_checks||
""", coverage=("14_sector", "16_transactions", "15_edd"),
      notes="A document may not contain a shipment number; null stays explicit. Commodity codes, units, routes and party capacities require source grounding.")

group("sector_licensing", "entity_name registration_number licences regulator_name regulated_activities operating_addresses parties status_stated expiry_date",
      "entity_name licences", """
trade_operating_licence|Trade, establishment or municipal operating licence||||
banking_licence|Banking licence or supervisory authorization||||
money_services_registration|Money-services or remittance registration||||
payment_institution_authorization|Payment institution or e-money authorization||||
vasp_registration|Virtual-asset service provider registration or licence||||
investment_firm_authorization|Investment manager or broker authorization||||
insurance_authorization|Insurance business or intermediary authorization||||
gambling_licence|Gambling or gaming operating licence||||
precious_metals_dealer_licence|Precious-metals or stones dealer registration||||
regulated_goods_permit|Regulated-goods business or sector permit|goods_description end_use_statement||
professional_firm_registration|Professional firm or real-estate business registration|professional_registration||
""", coverage=("06_presence", "10_structures", "14_sector", "20_refresh", "21_independent"),
      notes="Record licence status as stated. Issuer verification, permitted services, territory and continuing validity require separate checks.")

group("institutional_controls", "entity_name parties regulator_name regulated_activities aml_controls_statement sanctions_controls_statement assurance_scope questionnaire_answers signatures",
      "entity_name", """
correspondent_due_diligence_questionnaire|Wolfsberg correspondent banking due-diligence questionnaire (CBDDQ)|form_revision countries_of_operation agent_network||Retain exact questionnaire version and question IDs; a completed questionnaire is not a passed assessment.
financial_crime_compliance_questionnaire|Wolfsberg financial-crime compliance questionnaire (FCCQ)|form_revision countries_of_operation||Keep FCCQ identity distinct from the correspondent-banking questionnaire.
aml_program_document|AML or financial-crime compliance program|payment_flow_description||
sanctions_policy|Sanctions policy and control description||||
independent_aml_assurance|Independent AML audit or assurance report|assurance_findings period_start period_end auditor_name||Preserve assurance limitations and management responses.
monitoring_control_description|Transaction monitoring and escalation control description|verification_checks||
agent_network_schedule|Agent or distributor network schedule|agent_network countries_of_operation||
fund_flow_diagram|Payment, settlement or safeguarding flow diagram|payment_flow_description accounts safeguarding_arrangements||Record each described flow and party role; diagram arrows require evidence references.
custody_safeguarding_agreement|Custody, safeguarding or client-asset agreement|safeguarding_arrangements accounts authorized_actions||
merchant_underwriting_policy|Merchant underwriting, refund and payout policy|merchant_controls payment_flow_description||
travel_rule_controls|Virtual-asset travel-rule control description|travel_rule_information verification_checks||
""", coverage=("13_relationship", "14_sector", "15_edd", "21_independent"),
      notes="Extract reported controls and results, not a compliance certification. Provider qualification and institution acceptance remain separate.")

group("funds_and_nonprofits", "entity_name parties governing_law signatures references",
      "entity_name", """
fund_prospectus|Fund prospectus or offering memorandum|fund_name fund_strategy redemption_terms fund_service_providers funding_conditions||
fund_constituting_agreement|Fund, scheme or sub-fund constituting agreement|fund_name fund_strategy fund_service_providers control_rights ownership_interests||
fund_provider_appointment|Fund manager, administrator or custodian appointment|fund_name fund_service_providers authorized_actions revocation_terms||
investor_subscription_record|Investor subscription or investor register|fund_name ownership_interests accounts amount currency||Subscription commitment is distinct from paid-in capital and current holdings.
nonprofit_program_description|Charity or nonprofit program description|programmes donor_funding_statement countries_of_operation||
donor_or_grant_agreement|Donor or charitable grant agreement|programmes donor_funding_statement amount currency funding_conditions||
charitable_disbursement_record|Charitable disbursement or delivery-partner record|programmes distributions accounts payment_date||
""", coverage=("04_wealth", "07_ownership", "10_structures", "14_sector"),
      notes="Legal vehicle, manager, investor, donor, delivery partner and beneficiary are distinct roles; do not substitute one for another.")

group("wealth_and_edd_declarations", "subject_name parties source_of_funds_statement source_of_wealth_statement wealth_chronology assets accounts references signatures",
      "subject_name", """
source_of_funds_declaration|Source-of-funds declaration|amount currency underlying_event||
source_of_wealth_declaration|Source-of-wealth declaration|asset_acquisition_basis||
wealth_chronology|Wealth chronology or economic-background statement|asset_acquisition_basis||
pep_declaration|PEP, family-member or close-associate declaration|pep_declaration public_function relationship_basis||A negative declaration is not a completed PEP screening result.
public_office_appointment|Public-office appointment or official role record|public_function effective_date expiry_date||
asset_declaration|Public or customer asset declaration|tax_year||
customer_transaction_explanation|Customer transaction or discrepancy explanation|customer_explanation transactions underlying_event||
ownership_legal_explanation|Ownership or control legal explanation|ownership_interests control_rights assurance_scope||Retain author's qualification and scope; interpretation is not an independently verified fact.
""", coverage=("04_wealth", "07_ownership", "15_edd", "20_refresh"),
      notes="Keep declarations and explanations attributed. Material claims require corroboration according to admitted policy.")

group("legal_and_regulatory_context", "subject_name entity_name parties legal_case_reference allegation_or_outcome effective_date references",
      "parties allegation_or_outcome", """
court_judgment|Court judgment or case disposition|authorized_actions distributions||Preserve allegation, charge and final disposition distinctions.
regulatory_notice|Regulatory notice, order or enforcement disposition|regulator_name authorized_actions decision_conditions||
sanctions_licence|Sanctions licence, exemption or authorization|licences authorized_actions authority_limits expiry_date decision_conditions||The exact parties, activities, dates and conditions limit its scope.
adverse_media_article|Adverse-media article or source capture|record_as_of_date||Publisher allegation is not a judicial finding.
litigation_status_confirmation|Lawyer or court case-status confirmation|assurance_scope status_stated||
""", coverage=("15_edd", "21_independent", "20_refresh"),
      notes="Record author, source date, named subjects and attributed procedural status; do not infer guilt or legal clearance.")

group("digital_and_verification", "provider_name provider_request_id performed_at subject_name verification_checks artifact_references references",
      "provider_name verification_checks", """
identity_verification_report|Identity-provider verification report|identity_type identity_number||
document_authenticity_report|Document authenticity or tampering assessment|certified_document_reference assurance_scope||Provider confidence is not certainty of authenticity.
issuer_verification_response|Issuer or registry verification response|registration_number identity_number certified_document_reference status_stated||Record exact query scope and source response.
face_match_assessment|Face-match assessment|credential_subject||Reference assessment artifacts, not biometric templates.
liveness_assessment|Liveness or presentation-attack assessment|credential_subject||Result and score are provider assertions with method and limitations.
video_identification_record|Video-identification session record|credential_subject representatives||Reference the governed media artifact; no invented session transcript.
nfc_chip_verification|Identity-document NFC/chip verification result|identity_number||Keep chip, signature and visual-zone checks distinct.
contact_verification_record|Email or phone verification record|credential_subject||Contact possession does not establish legal identity.
device_session_risk_assessment|Device or session risk assessment|credential_subject||Collect only admitted signals; a risk score is not an identity fact.
electronic_signature_audit|Electronic-signature audit or certificate|signatures credential_issuer certified_document_reference||Technical signing evidence does not independently establish business authority.
""", coverage=("18_digital", "19_certification", "21_independent"),
      notes="Assessment results are attributed evidence. Source documents must be normalized to admitted text or structured source pages before span validation.",
      kind="media_assessment", origins=("independent", "institution"))

group("digital_credentials", "credential_type credential_issuer credential_subject assurance_level_stated issue_date expiry_date references verification_checks",
      "credential_issuer credential_subject", """
electronic_identity_credential|Electronic identity credential or signed assertion|person_name date_of_birth identity_number||Cryptographic and issuer-trust validation are separate operations.
consent_acknowledgment_record|Consent or acknowledgment record|subject_name consent_scope performed_at signatures||Do not infer consent from use of a service or possession of an artifact.
""", coverage=("18_digital", "21_independent"),
      notes="Only explicit credential claims or recorded acknowledgment fields; retain issuer, scope, dates and assessment limitations.",
      kind="credential", origins=("customer", "independent", "institution"))

group("digital_asset_provenance", "subject_name parties accounts crypto_transactions assets original_funding_statement asset_acquisition_basis source_of_funds_statement references",
      "subject_name", """
crypto_exchange_statement|Digital-asset exchange account or trading statement|period_start period_end transactions||Fiat and digital asset amounts retain their own currencies and networks.
crypto_acquisition_history|Digital-asset acquisition, mining or staking history|wealth_chronology||Capture the stated acquisition mechanism; do not infer legitimacy from transaction hashes.
wallet_control_attestation|Wallet-control demonstration or attestation|wallet_control_method verification_checks||Never request or store private keys or seed phrases.
virtual_asset_transfer_record|Virtual-asset transfer or travel-rule record|travel_rule_information payment_reference||Possession, transaction origin and underlying economic source are different claims.
""", coverage=("04_wealth", "14_sector", "16_transactions"),
      notes="Blockchain identifiers and exchange statements require network and account attribution; external tracing and proof validation are separate capabilities.")

group("certification_and_translation", "certifier_name certifier_capacity certification_date certified_document_reference certification_scope signatures references",
      "certifier_name certified_document_reference", """
certified_true_copy|Certified true-copy statement|original_seen_statement||
notarial_certificate|Notarial certificate or acknowledgment|issuing_jurisdiction original_seen_statement||
apostille|Apostille or legalization certificate|issuing_jurisdiction registration_authority||Authentication scope does not establish truth of every underlying claim.
consular_legalization|Consular legalization certificate|issuing_jurisdiction original_seen_statement||
certified_translation|Certified translation and translator declaration|source_language target_language original_seen_statement||Translation lineage points to the exact source version and spans.
professional_certification_letter|Lawyer, accountant or company-secretary certification letter|assurance_scope original_seen_statement||
original_seen_record|Original-seen or in-person document-check record|original_seen_statement performed_at||
""", coverage=("19_certification", "21_independent"),
      notes="Certification is a linked attachment, not a replacement for the original; scope, qualifications and exact covered document remain explicit.")

group("institutional_assessments", "subject_name entity_name review_scope review_date reviewer_name findings references signatures",
      "subject_name review_scope", """
site_visit_report|Site-visit or premises-verification report|operating_addresses assets business_activity||Separate observations, customer statements and analyst conclusions.
customer_interview_record|Customer interview or clarification record|customer_explanation parties||
screening_report|Sanctions, PEP or watchlist screening report|verification_checks pep_declaration public_function||Keep the screened scope, source versions and match status; no disposition inference.
screening_disposition_record|Screening match-disposition record|decision_stated decision_conditions approval_records||Recorded disposition does not constitute a fresh approval.
credit_or_business_intelligence_report|Credit or commercial business-intelligence report|financial_lines assurance_scope status_stated||Creditworthiness and lawful source of funds are distinct assessments.
edd_report|Enhanced due-diligence report|source_of_funds_statement source_of_wealth_statement risk_rating_stated decision_conditions||
risk_assessment_record|Customer risk-assessment record|risk_rating_stated decision_stated decision_conditions||Extract a prior assessment, not a newly accepted risk tier.
decision_package|Customer decision or approval package|decision_stated decision_conditions approval_records||Authority and segregation-of-duties checks remain outside extraction.
policy_exception_record|Policy exception or waiver record|exception_basis expiry_date approval_records||A document claiming an exception is not an authorized exception by itself.
qa_review_record|QA or independent-review record|assurance_scope assurance_findings decision_stated||Reviewer independence is checked separately by the workflow.
periodic_review_record|Periodic or trigger-based review record|next_review_date risk_rating_stated decision_stated||Review cadence is supplied by policy, not inferred from customer risk words.
account_closure_instruction|Account closure or transfer instruction|closure_instruction accounts representatives authority_limits||Destination-account and signatory authority require separate verification.
verification_audit_trace|Verification execution, lineage or audit record|verification_checks artifact_references provider_request_id||Event timestamps and hashes are source assertions until host integrity checks succeed.
""", coverage=("15_edd", "20_refresh", "21_independent"),
      notes="Institution-generated records can be evidence of prior work but are not customer submissions. Extracted findings and decisions never authorize a new action.",
      kind="structured_record", origins=("institution", "independent"))

# Search aliases are explicit and unambiguous; they do not merge distinct legal forms.
for identifier, aliases in {
    "national_identity_card": ("national_id",), "driving_licence": ("drivers_license", "driving_license"),
    "certificate_of_incorporation": ("certificate_of_formation",),
    "shareholder_register": ("register_of_members", "member_register"),
    "ownership_structure_chart": ("group_structure_chart", "ownership_chart"),
    "beneficial_ownership_declaration": ("ubo_declaration",),
    "commercial_invoice": ("invoice",), "company_registry_extract": ("commercial_register_extract",),
    "capitalization_table": ("cap_table",), "payslip": ("pay_stub",),
    "trust_deed": ("trust_instrument",), "power_of_attorney": ("poa",),
    "correspondent_due_diligence_questionnaire": ("cbddq",),
    "financial_crime_compliance_questionnaire": ("fccq",),
}.items():
    PROFILES[identifier] = PROFILES[identifier].model_copy(update={"aliases": aliases})

# Tax form addresses and identifiers are distinct printed fields, not a generic
# subject address or a silently selected national identifier.
for identifier, profile in list(PROFILES.items()):
    if profile.family == "us_tax_forms":
        PROFILES[identifier] = profile.model_copy(update={"field_names": tuple(dict.fromkeys(
            profile.field_names + tuple("permanent_residence_address mailing_address us_tax_identifier foreign_tax_identifier income_description".split())))})

# Document-specific additions preserve meaningful distinctions beyond family fields.
for identifier, extra_fields in {
    **{k: "amount_scale" for k, p in PROFILES.items() if p.family == "financial_reporting"},
    "insurance_payout_confirmation": "insurance_policy_number insurance_claim_number coverage_description",
    "cargo_insurance_certificate": "insurance_policy_number coverage_description",
    "w9": "disregarded_entity_name withholding_exemption_codes backup_withholding_statement",
    "w8bene": "disregarded_entity_name withholding_exemption_codes",
    "w8imy": "disregarded_entity_name withholding_exemption_codes",
    "w8eci": "effectively_connected_claim",
    "risk_assessment_record": "risk_score_stated risk_model_version",
}.items():
    profile = PROFILES[identifier]
    PROFILES[identifier] = profile.model_copy(update={"field_names": tuple(dict.fromkeys(
        profile.field_names + tuple(extra_fields.split())))})

# These records identify an institution or student, not an employer. Avoid a
# misleading family-wide completeness requirement on an irrelevant field.
for identifier in ("education_enrollment_letter", "sponsor_support_declaration"):
    profile = PROFILES[identifier]
    PROFILES[identifier] = profile.model_copy(update={"key_fields": ("person_name",)})

add("insurance_policy_schedule", "Insurance policy schedule or certificate of cover", "insurance_evidence",
    "parties insurance_policy_number coverage_description amount currency effective_date expiry_date signatures",
    "parties insurance_policy_number", coverage=("04_wealth", "14_sector", "16_transactions"),
    notes="Preserve insurer, insured, beneficiary and intermediary roles. A policy does not establish a payout or actual receipt of proceeds.",
    aliases=("professional_indemnity_certificate", "certificate_of_insurance"))
add("premises_photo_assessment", "Premises photograph or visual assessment record", "physical_evidence",
    "subject_name entity_name operating_addresses performed_at verification_checks artifact_references findings",
    "subject_name artifact_references", coverage=("06_presence", "18_digital", "21_independent"),
    notes="This contract describes an attributed assessment linked to governed image artifacts; it does not perform image interpretation or infer a verified location.",
    kind="media_assessment", origins=("customer", "independent", "institution"))
add("identity_image_capture_record", "Identity-document image capture record", "physical_evidence",
    "subject_name identity_type identity_number artifact_references performed_at verification_checks",
    "artifact_references", coverage=("01_identity", "18_digital", "21_independent"),
    notes="Reference front/back or passport-page artifacts and provider quality checks; the catalog does not decode images, collect biometric templates or establish identity.",
    kind="media_assessment", origins=("customer", "independent", "institution"))

# Candidate packages and event-driven selections are discovery aids only. They
# reference document types rather than reintroducing per-entity field copies.
ENTITY_PACKS = {
    "individual": ("passport", "national_identity_card", "individual_account_application", "individual_tax_self_certification"),
    "sole_proprietor": ("trade_name_registration", "business_registration_certificate", "passport", "tax_registration_certificate"),
    "private_company": ("certificate_of_incorporation", "articles_of_association", "shareholder_register", "board_resolution"),
    "llc": ("certificate_of_incorporation", "llc_operating_agreement", "shareholder_register", "account_mandate"),
    "general_partnership": ("partnership_agreement", "partnership_interest_schedule", "partner_resolution"),
    "limited_partnership": ("limited_partnership_agreement", "partnership_interest_schedule", "account_mandate"),
    "llp": ("business_registration_certificate", "llp_agreement", "partner_resolution"),
    "listed_company": ("company_registry_extract", "annual_report", "substantial_shareholder_disclosure", "board_resolution"),
    "foreign_branch": ("branch_registration", "company_registry_extract", "delegated_authority_letter"),
    "joint_venture": ("joint_venture_agreement", "ownership_structure_chart", "account_mandate"),
    "spv_or_holding_company": ("certificate_of_incorporation", "ownership_structure_chart", "business_profile", "initial_funding_declaration"),
    "cooperative_or_mutual": ("cooperative_registration", "association_constitution", "officeholder_list", "meeting_minutes"),
    "association_club_society": ("association_registration", "association_constitution", "officeholder_list", "meeting_minutes"),
    "charity_or_nonprofit": ("charity_registration", "association_constitution", "nonprofit_program_description", "donor_or_grant_agreement"),
    "foundation": ("foundation_charter", "officeholder_list", "ownership_structure_chart"),
    "government_or_public_body": ("government_enabling_instrument", "appointment_instrument", "account_mandate"),
    "estate": ("death_certificate", "grant_of_probate", "letters_of_administration", "estate_distribution_statement"),
    "trust": ("trust_deed", "trustee_appointment_deed", "beneficiary_schedule", "trustee_resolution"),
    "pension_arrangement": ("pension_scheme_rules", "trustee_appointment_deed", "trust_accounts"),
    "investment_fund": ("fund_prospectus", "fund_constituting_agreement", "fund_provider_appointment", "investor_subscription_record"),
}

REVIEW_EVENTS = {
    "identity_expiry": ("passport", "national_identity_card", "residence_permit"),
    "address_change": ("utility_bill", "bank_statement", "official_residence_certificate"),
    "person_name_change": ("name_change_instrument", "name_change_court_order", "passport"),
    "entity_name_or_form_change": ("company_name_change_certificate", "entity_conversion_certificate", "company_registry_extract"),
    "ownership_change": ("shareholder_register", "share_transfer_instrument", "ownership_structure_chart", "beneficial_ownership_declaration"),
    "authority_change": ("appointment_instrument", "account_mandate", "board_resolution"),
    "trust_party_change": ("trust_amendment", "trustee_appointment_deed", "protector_appointment", "beneficiary_schedule"),
    "business_activity_change": ("business_profile", "trade_operating_licence", "expected_activity_declaration"),
    "new_product_or_geography": ("product_service_agreement", "expected_activity_declaration", "business_profile"),
    "tax_circumstances_change": ("individual_tax_self_certification", "entity_tax_self_certification", "controlling_person_tax_self_certification"),
    "risk_or_screening_trigger": ("screening_report", "customer_transaction_explanation", "source_of_funds_declaration", "edd_report"),
    "periodic_review": ("periodic_review_record", "company_registry_extract", "expected_activity_declaration"),
    "account_closure_or_estate": ("account_closure_instruction", "account_mandate", "death_certificate", "grant_of_probate"),
}

# Document-specific review anchors. These are important extracted evidence,
# rather than claims that every issuer prints every field or every policy needs it.
for identifier, keys in {
    "passport": "person_name document_number date_of_birth expiry_date",
    "national_identity_card": "person_name identity_number date_of_birth",
    "driving_licence": "person_name identity_number expiry_date",
    "birth_certificate": "person_name date_of_birth parties",
    "certificate_of_incorporation": "entity_name registration_number formation_date formation_jurisdiction",
    "certificate_of_good_standing": "entity_name status_stated record_as_of_date",
    "branch_registration": "entity_name registration_number parent_entity_name",
    "ownership_structure_chart": "entity_name ownership_interests ownership_scope",
    "beneficial_ownership_declaration": "entity_name beneficial_owners_stated ownership_interests signatures",
    "beneficial_ownership_registry_extract": "entity_name beneficial_owners_stated record_as_of_date",
    "shareholder_agreement": "entity_name parties control_rights",
    "nominee_declaration": "parties nominee_arrangements",
    "board_resolution": "entity_name resolution_text authorized_actions signatures",
    "account_mandate": "entity_name parties accounts signing_rule signatures",
    "power_of_attorney": "parties authorized_actions signatures",
    "payslip": "person_name employer_name period_end gross_income currency",
    "employment_contract": "person_name employer_name occupation signatures",
    "audited_financial_statements": "entity_name period_end currency accounting_basis audit_opinion",
    "loan_agreement": "parties amount currency loan_terms signatures",
    "gift_deed": "parties amount currency relationship_basis signatures",
    "grant_of_probate": "person_name parties legal_case_reference authorized_actions",
    "trust_deed": "trust_name trust_parties governing_law trust_powers",
    "trustee_appointment_deed": "trust_name trust_parties effective_date amendment_scope",
    "trust_distribution_statement": "trust_name distributions payment_date",
    "w8bene": "subject_name tax_form_type chapter3_status chapter4_status signatures",
    "w8imy": "subject_name tax_form_type intermediary_capacity withholding_statement signatures",
    "w8eci": "subject_name tax_form_type income_description effectively_connected_claim signatures",
    "commercial_invoice": "invoice_number parties total_amount currency",
    "purchase_order": "purchase_order_number parties line_items",
    "commercial_contract": "parties contract_reference payment_terms signatures",
    "bill_of_lading": "shipment_reference parties goods_description transport_route",
    "letter_of_credit": "parties amount currency expiry_date credit_or_guarantee_terms",
    "insurance_payout_confirmation": "parties insurance_policy_number insurance_claim_number amount currency payment_date",
    "fund_prospectus": "entity_name fund_name fund_strategy fund_service_providers",
    "source_of_funds_declaration": "subject_name source_of_funds_statement amount currency",
    "source_of_wealth_declaration": "subject_name source_of_wealth_statement wealth_chronology",
    "pep_declaration": "subject_name pep_declaration",
    "customer_transaction_explanation": "subject_name customer_explanation transactions",
    "risk_assessment_record": "subject_name review_scope risk_rating_stated risk_model_version review_date",
    "decision_package": "subject_name decision_stated decision_conditions approval_records",
    "account_closure_instruction": "subject_name closure_instruction accounts representatives",
    "certified_translation": "certifier_name certified_document_reference source_language target_language certification_scope",
}.items():
    PROFILES[identifier] = PROFILES[identifier].model_copy(update={"key_fields": tuple(keys.split())})

for _field in FIELDS.values():
    for _target in _field.context_targets:
        for _type in _target.document_types:
            if _type not in PROFILES or _field.name not in PROFILES[_type].field_names:
                raise ValueError(f"context target of {_field.name} names {_type}, which lacks the field")
