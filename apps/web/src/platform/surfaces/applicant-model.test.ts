import { describe, expect, it } from "vitest";
import {
  applicantMissing, applicantStarted, applicationOf, blankActivity, emptyApplicant, intakeSummary, newDocument, newParty, type ApplicantForm, type PartyRow,
} from "./applicant-model";
import type { CaseScope } from "./case-scope-model";

const BUSINESS: CaseScope = { customerType: "corporate", trigger: "onboarding", dueDiligence: "standard", jurisdiction: "GB", products: ["deposit", "payments"] };
const PERSON: CaseScope = { customerType: "individual", trigger: "onboarding", dueDiligence: "standard", jurisdiction: "US", products: ["deposit"] };
const OPTIONS = { externalRef: " APP-1 ", classification: "confidential", harnessPlanDigest: "e".repeat(64) };
const form = (patch: Partial<ApplicantForm>): ApplicantForm => ({ ...emptyApplicant(), ...patch });
const party = (name: string, roles: string[], patch: Partial<PartyRow> = {}): PartyRow => ({ ...newParty("corporate"), name, roles, ...patch });
const relative = (name: string, relationToCustomer: string, patch: Partial<PartyRow> = {}): PartyRow => ({ ...newParty("individual"), name, relationToCustomer, ...patch });
const COMPANY = { name: "Acme", legalForm: "corporation", registrationNumber: "1", registrationJurisdiction: "GB" };
const DANA = { name: "Dana", dateOfBirth: "1990-06-30", nationality: "US" };

describe("applicant form", () => {
  it("is not an application until the customer is named", () => {
    expect(applicantStarted(emptyApplicant())).toBe(false);
    expect(applicantMissing(form({ registrationNumber: "1" }), "corporate", ["deposit"])).toBeNull();
    expect(applicantStarted(form({ name: "  Acme  " }))).toBe(true);
  });

  it("says what a person, a business and a trust still need", () => {
    expect(applicantMissing(form({ name: "Dana" }), "individual", ["deposit"])).toBe("Enter the applicant's date of birth.");
    expect(applicantMissing(form({ ...DANA, nationality: "usa" }), "individual", ["deposit"])).toMatch(/nationality/);
    expect(applicantMissing(form(DANA), "individual", ["deposit"])).toBeNull();
    expect(applicantMissing(form({ name: "Acme" }), "corporate", ["deposit"])).toBe("Choose the legal form.");
    expect(applicantMissing(form({ name: "Acme", legalForm: "corporation" }), "corporate", ["deposit"])).toBe("Enter the registration number.");
    expect(applicantMissing(form({ ...COMPANY, registrationJurisdiction: "" }), "corporate", ["deposit"])).toMatch(/registration jurisdiction/);
    expect(applicantMissing(form({ name: "Willow Trust", parties: [party("Bob", ["settlor"])] }), "trust", ["deposit"])).toBe("Add the trust's trustee.");
    expect(applicantMissing(form({ name: "Willow Trust", parties: [party("Ann", ["trustee", "beneficiary"])] }), "trust", ["deposit"])).toBeNull();
  });

  it("needs each relative's relationship, and each business party's role", () => {
    expect(applicantMissing(form({ ...DANA, parties: [relative("Kim", "")] }), "individual", ["deposit"])).toMatch(/relates to the customer/);
    expect(applicantMissing(form({ ...DANA, parties: [relative("Kim", "sibling", { politicallyExposed: "yes" })] }), "individual", ["deposit"])).toBeNull();
    expect(applicantMissing(form({ ...COMPANY, parties: [party("A", [])] }), "corporate", ["deposit"])).toMatch(/at least one role/);
  });

  it("checks identifiers, addresses, ownership, activity per product and documents", () => {
    const gap = (patch: Partial<ApplicantForm>) => applicantMissing(form({ ...COMPANY, ...patch }), "corporate", ["deposit", "payments"]);
    const row = (patch: Partial<ReturnType<typeof blankActivity>>) => ({ ...blankActivity(), ...patch });
    expect(gap({ identifierType: "lei" })).toMatch(/identifier/);
    expect(gap({ addressLine: "1 High St" })).toMatch(/address/);
    expect(gap({ parties: [party("", ["director"])] })).toMatch(/Name every related party/);
    expect(gap({ parties: [party("A", ["beneficial_owner"], { ownershipPercent: "60%" })] })).toMatch(/percentage/);
    expect(gap({ parties: [party("A", ["beneficial_owner"], { ownershipPercent: "60" }), party("B", ["beneficial_owner"], { ownershipPercent: "40.5" })] })).toMatch(/more than 100%/);
    expect(gap({ activity: { payments: row({ monthlyInflow: "1000" }) } })).toBe("Enter the payments activity's currency as a three-letter code.");
    expect(gap({ activity: { deposit: row({ currency: "GBP", monthlyInflow: "1,000" }) } })).toMatch(/numbers/);
    expect(gap({ activity: { deposit: row({ currency: "GBP", counterpartyCountries: "GB, Ireland" }) } })).toMatch(/counterparty/);
    // A row for a product no longer requested is ignored.
    expect(gap({ activity: { lending: row({ monthlyInflow: "x" }) } })).toBeNull();
    const document = newDocument({ name: "c.txt", type: "text/plain", size: 10 }, "Y2VydA==");
    expect(gap({ documents: [document] })).toMatch(/document type/);
    expect(gap({ documents: [{ ...document, documentType: "certificate_of_incorporation", size: 5 * 1024 * 1024 }] })).toMatch(/larger than 4 MB/);
    expect(gap({ documents: [{ ...document, documentType: "a" }, { ...document, key: "other", documentType: "a" }] })).toMatch(/twice/);
    expect(gap({ documents: [{ ...document, documentType: "certificate_of_incorporation" }], activity: { deposit: row({ currency: "GBP", monthlyInflow: "1000.50", counterpartyCountries: "GB, IE" }) } })).toBeNull();
  });
});

describe("application submission", () => {
  it("builds a GB company's application: a person and a company with several roles, activity per product, a document about an owner", () => {
    const gareth = party("Gareth Thistle", ["beneficial_owner", "director"], { ownershipPercent: "60", politicallyExposed: "yes", pepPosition: "Councillor" });
    const holdco = party("Thistle Holdings Ltd", ["beneficial_owner"], { kind: "company", ownershipPercent: "40", politicallyExposed: "no" });
    const body = applicationOf(form({
      name: " Thistle Fabrication Ltd ", legalForm: "corporation", registrationNumber: "SC401042", registrationJurisdiction: "GB", registrationAuthority: "Companies House",
      identifierType: "lei", identifierIssuer: "GLEIF", identifierValue: "5493001KJTIIGC8Y1R12",
      addressLine: "Unit 4, Mill Lane", locality: "Sheffield", addressCountry: "GB",
      parties: [gareth, holdco],
      activity: { deposit: { currency: "GBP", monthlyInflow: "310000", monthlyOutflow: "", counterpartyCountries: "" }, payments: { currency: "EUR", monthlyInflow: "", monthlyOutflow: "14500", counterpartyCountries: "de, fr de" } },
      documents: [{ ...newDocument({ name: "passport.pdf", type: "application/pdf", size: 4 }, "JVBERg=="), documentType: "passport", about: gareth.key }],
      sourceOfFunds: "Revenue", dateOfBirth: "1980-01-01", nationality: "GB", politicallyExposed: "yes",
    }), BUSINESS, OPTIONS);
    expect(body).toEqual({
      scope: BUSINESS, channel: "relationship_manager", classification: "confidential", harnessPlanDigest: "e".repeat(64), externalRef: "APP-1", sourceOfFunds: "Revenue",
      customer: { name: "Thistle Fabrication Ltd", legalForm: "corporation", registrationNumber: "SC401042", registrationJurisdiction: "GB", registrationAuthority: "Companies House",
        identifiers: [{ type: "lei", issuer: "GLEIF", value: "5493001KJTIIGC8Y1R12" }], addresses: [{ lines: ["Unit 4, Mill Lane"], locality: "Sheffield", country: "GB" }] },
      relatedParties: [
        { name: "Gareth Thistle", kind: "individual", roles: ["beneficial_owner", "director"], ownershipPercent: "60", politicallyExposed: "yes", pepPosition: "Councillor" },
        { name: "Thistle Holdings Ltd", kind: "company", roles: ["beneficial_owner"], ownershipPercent: "40" },
      ],
      expectedActivity: [
        { product: "deposit", currency: "GBP", monthlyInflow: "310000", counterpartyCountries: [] },
        { product: "payments", currency: "EUR", monthlyOutflow: "14500", counterpartyCountries: ["DE", "FR"] },
      ],
      documents: [{ documentType: "passport", filename: "passport.pdf", mediaType: "application/pdf", contentBase64: "JVBERg==", relatedParty: 0 }],
    });
  });

  it("sends a person's relatives with their relationship and declared exposure, and the customer's own", () => {
    const body = applicationOf(form({ ...DANA, politicallyExposed: "no", pepPosition: "ignored", legalForm: "corporation",
      parties: [relative("Kim Reyes", "sibling", { politicallyExposed: "yes", pepPosition: "Ambassador", roles: ["director"], ownershipPercent: "10" })] }), PERSON, { ...OPTIONS, externalRef: "" });
    expect(body.customer).toEqual({ name: "Dana", dateOfBirth: "1990-06-30", nationality: "US", politicallyExposed: "no" });
    expect(body.relatedParties).toEqual([{ name: "Kim Reyes", kind: "individual", relationToCustomer: "sibling", politicallyExposed: "yes", pepPosition: "Ambassador" }]);
    expect(body).not.toHaveProperty("externalRef");
    expect(body).not.toHaveProperty("expectedActivity");
    expect(body).not.toHaveProperty("documents");
  });

  it("summarizes a created application", () => {
    const intake = { caseId: "KYB-2001", caseType: "kyb_onboarding" as const, planDigest: "e".repeat(64), pack: { id: "p", scope: { jurisdiction: "GB", institution: "bank", products: [], customerTypes: [] } }, subjectsAdded: 3, documentsUploaded: 1, recordsRecorded: 19, documentRuns: [] };
    expect(intakeSummary(intake)).toBe("KYB-2001 · 3 subjects · 1 document · 19 records");
    expect(intakeSummary({ ...intake, documentsUploaded: 0, subjectsAdded: 1 })).toBe("KYB-2001 · 1 subject · 19 records");
  });
});
