import type { Schemas } from "@ehf/ui-contracts";
import type { CaseScope } from "./case-scope-model";

/**
 * The applicant part of the new-case sheet (C2 application intake): what the applicant declared,
 * turned into the ApplicationSubmission the BFF maps to case subjects and canonical records. Pure
 * functions over the contract; the fields live in create-case.tsx. Filling in the customer's name
 * makes the case an application; leaving it empty keeps the scope-only path.
 */

export type ApplicationSubmission = Schemas["ApplicationSubmission"];
export type ApplicationIntake = Schemas["ApplicationIntake"];
type CustomerType = CaseScope["customerType"];
type RelatedParty = NonNullable<ApplicationSubmission["relatedParties"]>[number];

export type Exposure = "" | "yes" | "no" | "unknown";
export type PartyRow = {
  key: string; name: string; kind: "individual" | "company"; roles: string[]; ownershipPercent: string;
  relationToCustomer: string; politicallyExposed: Exposure; pepPosition: string;
};
export type ActivityRow = { currency: string; monthlyInflow: string; monthlyOutflow: string; counterpartyCountries: string };
/** An attached file: its bytes as base64, its document field catalog type, and whom it is about ("" = the customer, else a party key). */
export type DocumentRow = { key: string; filename: string; mediaType: string; contentBase64: string; size: number; documentType: string; about: string };
export type ApplicantForm = {
  name: string;
  dateOfBirth: string; nationality: string; politicallyExposed: Exposure; pepPosition: string;
  legalForm: string; registrationNumber: string; registrationJurisdiction: string; registrationAuthority: string;
  identifierType: string; identifierIssuer: string; identifierValue: string;
  addressLine: string; locality: string; postalCode: string; addressCountry: string;
  parties: PartyRow[];
  /** Expected activity per requested product. */
  activity: Record<string, ActivityRow>;
  documents: DocumentRow[];
  sourceOfFunds: string;
};

export const LEGAL_FORMS: Record<Exclude<CustomerType, "individual">, string[]> = {
  corporate: ["corporation", "llc", "limited_partnership", "general_partnership", "sole_proprietor", "foundation", "association", "charity", "fund", "pension", "government"],
  trust: ["ordinary_trust", "statutory_trust"],
};
export const IDENTIFIER_TYPES: Record<CustomerType, string[]> = {
  individual: ["passport", "national_id", "drivers_licence", "tax_id"],
  corporate: ["lei", "tax_id", "vat_number"],
  trust: ["tax_id", "lei"],
};
export const PARTY_ROLES: Record<Exclude<CustomerType, "individual">, string[]> = {
  corporate: ["beneficial_owner", "director", "control_person", "signatory"],
  trust: ["trustee", "settlor", "beneficiary", "protector"],
};
export const RELATIONS = ["spouse", "partner", "parent", "child", "sibling", "other_family", "close_associate"];
export const EXPOSURE_LABEL: Record<Exposure, string> = { "": "Not declared", no: "No", yes: "Yes", unknown: "Unknown" };
/** One uploaded document's limit, as the contract bounds it. */
export const DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;
export const DOCUMENT_MAX_COUNT = 5;
/** "beneficial_owner" → "Beneficial owner". */
export const LABEL = (value: string) => { const text = value.replaceAll("_", " "); return text[0]!.toUpperCase() + text.slice(1); };

const COUNTRY = /^[A-Z]{2}$/;
const AMOUNT = /^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,2})?$/;
const PERCENT = /^(?:100(?:\.0{1,4})?|[1-9]?[0-9](?:\.[0-9]{1,4})?)$/;
const DOCUMENT_TYPE = /^[a-z][a-z0-9_]{0,79}$/;

export function emptyApplicant(): ApplicantForm {
  return {
    name: "", dateOfBirth: "", nationality: "", politicallyExposed: "", pepPosition: "",
    legalForm: "", registrationNumber: "", registrationJurisdiction: "", registrationAuthority: "",
    identifierType: "", identifierIssuer: "", identifierValue: "", addressLine: "", locality: "", postalCode: "", addressCountry: "",
    parties: [], activity: {}, documents: [], sourceOfFunds: "",
  };
}

let sequence = 0;
const nextKey = (prefix: string) => `${prefix}-${(sequence += 1)}`;
/** A new related party: a business's owner, a trust's trustee, or a person's relative (whose relation is chosen). */
export function newParty(customerType: CustomerType): PartyRow {
  return { key: nextKey("party"), name: "", kind: "individual", roles: customerType === "individual" ? [] : [customerType === "trust" ? "trustee" : "beneficial_owner"],
    ownershipPercent: "", relationToCustomer: "", politicallyExposed: "", pepPosition: "" };
}
export function newDocument(file: { name: string; type: string; size: number }, contentBase64: string): DocumentRow {
  return { key: nextKey("document"), filename: file.name, mediaType: file.type.toLowerCase() || "application/octet-stream", contentBase64, size: file.size, documentType: "", about: "" };
}
export const blankActivity = (): ActivityRow => ({ currency: "", monthlyInflow: "", monthlyOutflow: "", counterpartyCountries: "" });

/** The applicant counts once the customer is named; until then the case is opened by its scope alone. */
export const applicantStarted = (form: ApplicantForm) => form.name.trim().length > 0;

const t = (value: string) => value.trim();
const countries = (value: string) => [...new Set(value.split(/[\s,]+/).map((item) => item.trim().toUpperCase()).filter(Boolean))];
/** Ownership in 1/10000 percent units, exactly. */
const units = (value: string) => { const [whole, fraction = ""] = value.split("."); return Number(whole) * 10_000 + Number(fraction.padEnd(4, "0")); };
const activityFilled = (row: ActivityRow | undefined) => Boolean(row && [row.currency, row.monthlyInflow, row.monthlyOutflow, row.counterpartyCountries].some((value) => t(value)));

/** What the applicant still needs, or null when it can be submitted. */
export function applicantMissing(form: ApplicantForm, customerType: CustomerType, products: readonly string[]): string | null {
  if (!applicantStarted(form)) return null;
  const individual = customerType === "individual";
  if (individual) {
    if (!form.dateOfBirth) return "Enter the applicant's date of birth.";
    if (!COUNTRY.test(t(form.nationality))) return "Enter the applicant's nationality as a two-letter country code.";
  } else {
    if (!form.legalForm && customerType === "corporate") return "Choose the legal form.";
    if (customerType === "corporate" && !t(form.registrationNumber)) return "Enter the registration number.";
    if ((customerType === "corporate" || t(form.registrationNumber)) && !COUNTRY.test(t(form.registrationJurisdiction))) return "Enter the registration jurisdiction as a two-letter country code.";
  }
  const identifier = [form.identifierType, t(form.identifierIssuer), t(form.identifierValue)];
  if (identifier.some(Boolean) && !identifier.every(Boolean)) return "Complete the identifier: its type, issuer and value.";
  const address = [t(form.addressLine), t(form.locality), t(form.postalCode), t(form.addressCountry)];
  if (address.some(Boolean) && (!address[0] || !COUNTRY.test(address[3]!))) return "Complete the address: a street line and a two-letter country code.";
  if (form.parties.some((party) => !t(party.name))) return "Name every related party, or remove it.";
  if (individual) {
    if (form.parties.some((party) => !party.relationToCustomer)) return "Choose how each related person relates to the customer.";
  } else {
    if (form.parties.some((party) => !party.roles.length)) return "Give every related party at least one role.";
    if (form.parties.some((party) => t(party.ownershipPercent) && !PERCENT.test(t(party.ownershipPercent)))) return "Enter ownership as a percentage from 0 to 100.";
    if (form.parties.reduce((sum, party) => sum + (t(party.ownershipPercent) ? units(t(party.ownershipPercent)) : 0), 0) > 100 * 10_000) return "Ownership of the related parties adds up to more than 100%.";
    if (customerType === "trust" && !form.parties.some((party) => party.roles.includes("trustee"))) return "Add the trust's trustee.";
  }
  for (const product of products) {
    const row = form.activity[product];
    if (!activityFilled(row)) continue;
    if (!/^[A-Z]{3}$/.test(t(row!.currency))) return `Enter the ${LABEL(product).toLowerCase()} activity's currency as a three-letter code.`;
    if ([row!.monthlyInflow, row!.monthlyOutflow].some((value) => t(value) && !AMOUNT.test(t(value)))) return "Enter monthly amounts as numbers, e.g. 25000 or 2500.50.";
    if (countries(row!.counterpartyCountries).some((value) => !COUNTRY.test(value))) return "Enter counterparty countries as two-letter codes, e.g. GB, IE.";
  }
  if (form.documents.length > DOCUMENT_MAX_COUNT) return `Attach at most ${DOCUMENT_MAX_COUNT} documents.`;
  if (form.documents.some((document) => document.size > DOCUMENT_MAX_BYTES)) return "A document is larger than 4 MB. Attach a smaller file.";
  if (form.documents.some((document) => !DOCUMENT_TYPE.test(t(document.documentType)))) return "Choose a document type for every document, e.g. certificate_of_incorporation.";
  if (new Set(form.documents.map((document) => document.contentBase64)).size !== form.documents.length) return "The same file is attached twice. Remove one.";
  return null;
}

/** The submission for a complete applicant (applicantMissing is null). Only the customer type's fields are sent. */
export function applicationOf(form: ApplicantForm, scope: CaseScope, options: { externalRef: string; classification: string; harnessPlanDigest: string }): ApplicationSubmission {
  const individual = scope.customerType === "individual";
  const exposure = (value: Exposure, position: string) => value ? { politicallyExposed: value, ...(value === "yes" && t(position) ? { pepPosition: t(position) } : {}) } : {};
  const customer: ApplicationSubmission["customer"] = { name: t(form.name) };
  if (individual) {
    Object.assign(customer, { dateOfBirth: form.dateOfBirth, nationality: t(form.nationality) }, exposure(form.politicallyExposed, form.pepPosition));
  } else {
    if (form.legalForm) customer.legalForm = form.legalForm as NonNullable<ApplicationSubmission["customer"]["legalForm"]>;
    if (t(form.registrationNumber)) customer.registrationNumber = t(form.registrationNumber);
    if (t(form.registrationJurisdiction)) customer.registrationJurisdiction = t(form.registrationJurisdiction);
    if (t(form.registrationAuthority)) customer.registrationAuthority = t(form.registrationAuthority);
  }
  if (form.identifierType && t(form.identifierValue)) customer.identifiers = [{ type: form.identifierType, issuer: t(form.identifierIssuer), value: t(form.identifierValue) }];
  if (t(form.addressLine)) {
    customer.addresses = [{ lines: [t(form.addressLine)], country: t(form.addressCountry),
      ...(t(form.locality) ? { locality: t(form.locality) } : {}), ...(t(form.postalCode) ? { postalCode: t(form.postalCode) } : {}) }];
  }
  const body: ApplicationSubmission = {
    scope, customer, channel: "relationship_manager", classification: options.classification as ApplicationSubmission["classification"],
    harnessPlanDigest: options.harnessPlanDigest,
    ...(t(options.externalRef) ? { externalRef: t(options.externalRef) } : {}),
    ...(t(form.sourceOfFunds) ? { sourceOfFunds: t(form.sourceOfFunds) } : {}),
  };
  if (form.parties.length) {
    body.relatedParties = form.parties.map((party): RelatedParty => {
      const person = individual || party.kind === "individual";
      return {
        name: t(party.name), kind: person ? "individual" : "company",
        ...(individual ? { relationToCustomer: party.relationToCustomer as NonNullable<RelatedParty["relationToCustomer"]> }
          : { roles: party.roles as RelatedParty["roles"], ...(t(party.ownershipPercent) ? { ownershipPercent: t(party.ownershipPercent) } : {}) }),
        ...(person ? exposure(party.politicallyExposed, party.pepPosition) : {}),
      };
    });
  }
  const activity = scope.products.filter((product) => activityFilled(form.activity[product])).map((product) => {
    const row = form.activity[product]!;
    return { product, currency: t(row.currency), ...(t(row.monthlyInflow) ? { monthlyInflow: t(row.monthlyInflow) } : {}),
      ...(t(row.monthlyOutflow) ? { monthlyOutflow: t(row.monthlyOutflow) } : {}), counterpartyCountries: countries(row.counterpartyCountries) };
  });
  if (activity.length) body.expectedActivity = activity;
  if (form.documents.length) {
    body.documents = form.documents.map((document) => {
      const party = form.parties.findIndex((row) => row.key === document.about);
      return { documentType: t(document.documentType), filename: document.filename, mediaType: document.mediaType, contentBase64: document.contentBase64, ...(party >= 0 ? { relatedParty: party } : {}) };
    });
  }
  return body;
}

/** One line for a created application: "KYB-2001 · 3 subjects · 1 document · 17 records". */
export function intakeSummary(intake: ApplicationIntake): string {
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  return [intake.caseId, plural(intake.subjectsAdded, "subject"), ...(intake.documentsUploaded ? [plural(intake.documentsUploaded, "document")] : []), plural(intake.recordsRecorded, "record")].join(" · ");
}

/** A file's bytes as base64 (FileReader data URL without its prefix). */
export function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
