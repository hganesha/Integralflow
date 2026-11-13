import { expect, test } from "@playwright/test";
import { CASE, caseSequence, openAs } from "./work-support";

test("assigned KYB analyst requests a supplemental Recon brief from the case room", async ({ page }) => {
  await openAs(page, "cdd_analyst", "ownership_review", `/work/cases/${CASE}`);
  const recon = page.getByRole("region", { name: "Reconnaissance" });
  await expect(recon.getByText("Synthetic sources · Supplemental leads")).toBeVisible();
  const sequence = await caseSequence(page).innerText();
  await recon.getByRole("button", { name: "Request brief" }).click();
  await expect(recon.getByText("Possible issuer credit rating downgrade")).toBeVisible();
  await expect(recon.getByText(/Unverified.*Downgrade reported/)).toBeVisible();
  await expect(recon.getByText("Which issuer and rating did the agency change?")).toBeVisible();
  await expect(recon.getByRole("link", { name: "Fictional rating agency notice" })).toHaveAttribute("href", "https://ratings.example/rating-action");
  await expect(caseSequence(page)).toHaveText(sequence);
});
