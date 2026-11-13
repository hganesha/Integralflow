import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectAccessible, signInAs } from "./support";

// PLT-09 · C2 application intake: the new-case sheet's Applicant section turns a submitted
// application into a populated case (POST /v1/applications; ui-mock maps it with @ehf/contracts
// mapApplicationSubmission, as the BFF does).

const EXPECTED_COMPANY_RECORDS = 20;

async function openNewCase(page: Page): Promise<Locator> {
  await signInAs(page, "cdd_analyst", "/platform/cases");
  await expect(page.getByRole("heading", { name: "Cases", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "New case" }).click();
  const sheet = page.getByRole("dialog", { name: "New case" });
  await expect(sheet.getByLabel("Customer type", { exact: true })).toHaveValue("individual");
  return sheet;
}

test("a GB company's application with two owners and a certificate opens a KYB case with its records and document", async ({ page }) => {
  const sheet = await openNewCase(page);
  await sheet.getByLabel("Customer type", { exact: true }).selectOption("corporate");
  await sheet.getByLabel("Policy jurisdiction").selectOption("GB");
  await sheet.getByRole("checkbox", { name: "deposit", exact: true }).check();
  await sheet.getByRole("checkbox", { name: "payments", exact: true }).check();
  await expect(sheet.getByTestId("case-plan-selection")).toContainText("policy.pack.gb.bank-synthetic.business-banking");

  const applicant = sheet.getByTestId("applicant");
  await applicant.getByLabel("Customer name").fill("Thistle Fabrication Ltd");
  // Until the business's legal form and registration are given, the application cannot be submitted.
  await expect(sheet.getByText("Choose the legal form.")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Create case from application" })).toBeDisabled();
  await applicant.getByLabel("Legal form").selectOption("corporation");
  await applicant.getByLabel("Registration number").fill("SC401042");
  await applicant.getByLabel("Registration jurisdiction").fill("gb");
  await expect(applicant.getByLabel("Registration jurisdiction")).toHaveValue("GB");
  await applicant.getByLabel("Identifier type").selectOption("lei");
  await applicant.getByLabel("Identifier issuer").fill("GLEIF");
  await applicant.getByLabel("Identifier value").fill("5493001KJTIIGC8Y1R12");
  await applicant.getByLabel("Address line").fill("Unit 4, Mill Lane");
  await applicant.getByLabel("Town or city").fill("Sheffield");
  await applicant.getByLabel("Address country").fill("GB");

  // Two owners, added from the keyboard.
  await applicant.getByRole("button", { name: "Add related party" }).focus();
  await page.keyboard.press("Enter");
  await applicant.getByLabel("Party 1 name").fill("Gareth Thistle");
  // A party may hold several roles: owner and director.
  const roles = applicant.getByRole("group", { name: "Party 1 roles" });
  await expect(roles.getByRole("checkbox", { name: "Beneficial owner" })).toBeChecked();
  await roles.getByRole("checkbox", { name: "Director" }).focus();
  await page.keyboard.press("Space");
  await expect(roles.getByRole("checkbox", { name: "Director" })).toBeChecked();
  await applicant.getByLabel("Party 1 ownership %").fill("60");
  await applicant.getByLabel("Party 1 politically exposed").selectOption("no");
  // The second owner is a company.
  await applicant.getByRole("button", { name: "Add related party" }).click();
  await applicant.getByLabel("Party 2 name").fill("Thistle Holdings Ltd");
  await applicant.getByLabel("Party 2 kind").selectOption("company");
  await expect(applicant.getByLabel("Party 2 politically exposed")).toHaveCount(0);
  await applicant.getByLabel("Party 2 ownership %").fill("40");

  // Expected activity, one row per requested product.
  await applicant.getByLabel("Deposit currency").fill("GBP");
  await applicant.getByLabel("Deposit monthly inflow").fill("310000");
  await applicant.getByLabel("Deposit monthly outflow").fill("295000");
  await applicant.getByLabel("Deposit counterparty countries").fill("GB, IE");
  await applicant.getByLabel("Payments currency").fill("EUR");
  await applicant.getByLabel("Payments monthly outflow").fill("14500");
  await applicant.getByLabel("Declared source of funds").fill("Revenue from fabrication contracts");

  // The certificate of incorporation, typed from the document field catalog.
  await applicant.getByLabel("Attach documents").setInputFiles({ name: "certificate.txt", mimeType: "text/plain",
    buffer: Buffer.from("CERTIFICATE OF INCORPORATION\nCompany name: Thistle Fabrication Ltd\nCompany number: SC401042\n") });
  await expect(sheet.getByText("Choose a document type for every document, e.g. certificate_of_incorporation.")).toBeVisible();
  await applicant.getByLabel("certificate.txt document type").fill("certificate_of_incorporation");
  await expect(applicant.getByLabel("certificate.txt is about")).toHaveValue("");
  await sheet.getByLabel("External reference").fill("APP-GB-THISTLE");
  await expectAccessible(page);

  await sheet.getByRole("button", { name: "Create case from application" }).click();
  const done = sheet.getByTestId("application-intake");
  await expect(done).toContainText("Case created from the application.");
  await expect(done).toContainText("KYB-2001");
  await expect(done).toContainText("Business onboarding (KYB)");
  // Entity ×3, Identity (Gareth), IdentityIdentifier ×2 (LEI, registration number), Address, Registration, Party,
  // Product ×2, ExpectedActivity ×2, BankingRelationship, OwnershipInterest ×2, OfficerRole (director), SourceOfFunds,
  // DocumentVersion, Application.
  await expect(sheet.getByTestId("application-documents")).toHaveText("1 uploaded · 0 extraction runs started · not started: document.extraction_plan_not_configured");
  await expect(sheet.getByTestId("application-records")).toHaveText(`${EXPECTED_COMPANY_RECORDS} records recorded`);
  await expect(done).toContainText("policy.pack.gb.bank-synthetic.business-banking");
  await expectAccessible(page);

  await sheet.getByRole("button", { name: "Open case" }).click();
  await expect(page).toHaveURL(/\/platform\/cases\/KYB-2001$/);
  await expect(page.getByText("APP-GB-THISTLE").first()).toBeVisible();
});

test("an individual who declares a politically exposed sibling opens a KYC case with a PEPRelationship", async ({ page }) => {
  const sheet = await openNewCase(page);
  await sheet.getByLabel("Policy jurisdiction").selectOption("US");
  await sheet.getByRole("checkbox", { name: "deposit", exact: true }).check();
  await expect(sheet.getByTestId("case-plan-selection")).toContainText("policy.pack.us.bank-synthetic.personal-banking");
  const applicant = sheet.getByTestId("applicant");
  await applicant.getByLabel("Customer name").fill("Dana Reyes");
  await applicant.getByLabel("Date of birth").fill("1990-06-30");
  await applicant.getByLabel("Nationality").fill("US");
  await applicant.getByLabel("Customer politically exposed").selectOption("no");
  await expect(applicant.getByLabel("Customer political position")).toHaveCount(0);

  await applicant.getByRole("button", { name: "Add relative or associate" }).click();
  await applicant.getByLabel("Party 1 name").fill("Kim Reyes");
  await expect(sheet.getByText("Choose how each related person relates to the customer.")).toBeVisible();
  await expect(applicant.getByRole("group", { name: "Party 1 roles" })).toHaveCount(0);
  await applicant.getByLabel("Party 1 relationship").selectOption("sibling");
  await applicant.getByLabel("Party 1 politically exposed").selectOption("yes");
  await applicant.getByLabel("Party 1 political position").fill("Ambassador");
  await expectAccessible(page);

  await sheet.getByRole("button", { name: "Create case from application" }).click();
  const done = sheet.getByTestId("application-intake");
  await expect(done).toContainText("Customer onboarding (KYC)");
  // Entity ×2, Identity ×2, Party, Product, BankingRelationship, PEPRelationship, Application.
  await expect(sheet.getByTestId("application-records")).toHaveText("9 records recorded");
  await expect(done).toContainText("· 2 subjects ·");
});

test("a refused application keeps the selection's reason and creates nothing", async ({ page }) => {
  const sheet = await openNewCase(page);
  await sheet.getByLabel("Customer type", { exact: true }).selectOption("trust");
  await sheet.getByLabel("Policy jurisdiction").selectOption("GB");
  await sheet.getByRole("checkbox", { name: "deposit", exact: true }).check();
  // No released process covers trust onboarding in the mock catalogue.
  await expect(sheet.getByTestId("case-plan-refusal")).toContainText("case.plan_no_plan");
  const applicant = sheet.getByTestId("applicant");
  await applicant.getByLabel("Customer name").fill("Willow Trust");
  await expect(sheet.getByText("Add the trust's trustee.")).toBeVisible();
  await applicant.getByRole("button", { name: "Add related party" }).click();
  await applicant.getByLabel("Party 1 name").fill("Ann Trustee");
  await expect(applicant.getByRole("group", { name: "Party 1 roles" }).getByRole("checkbox", { name: "Trustee" })).toBeChecked();
  await expect(sheet.getByText("Add the trust's trustee.")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Create case from application" })).toBeDisabled();
  await expectAccessible(page);
});
