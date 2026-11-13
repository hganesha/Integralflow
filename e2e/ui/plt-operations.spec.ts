import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, mock, signInAs } from "./support";
import { businessDecisionSchema, stableDigest } from "../../packages/contracts/src/index.js";

// PLT-09…12 acceptance (BUILD-SPEC v2 §10): cases, human work, releases, health, and the
// TrustedDecisionSheet that carries every consequential action.

const RULES_KEY = "ehf-e2e:rules";

type Rule =
  | { kind: "respond"; method: string; path: string; status: number; body: unknown; remaining?: number }
  | { kind: "addActions"; method: string; path: string; actions: string[] }
  | { kind: "removeActions"; method: string; path: string; actions: string[] }
  | { kind: "patchItems"; method: string; path: string; set: Record<string, unknown> }
  | { kind: "appendItems"; method: string; path: string; items: Array<Record<string, unknown>>; filters: Record<string, string> };

/**
 * The mock answers inside a service worker, which page.route can't see. This wraps the page's
 * fetch before the app loads (the client captures it at start-up) so a test can inject a
 * response, decorate one, and read what the app sent. Rules live in sessionStorage so they
 * survive the reloads signInAs makes.
 */
async function installOverrides(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    const w = window as unknown as { __ehfRequests: Array<{ method: string; path: string; body: unknown }> };
    w.__ehfRequests = [];
    const original = window.fetch.bind(window);
    const load = (): Array<Record<string, any>> => JSON.parse(sessionStorage.getItem(key) ?? "[]");
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url, location.href);
      if (url.pathname.startsWith("/api/v1/")) {
        let body: unknown = null;
        if (request.method !== "GET") body = await request.clone().json().catch(() => null);
        w.__ehfRequests.push({ method: request.method, path: url.pathname, body });
      }
      const rules = load();
      const index = rules.findIndex((rule) => rule.method === request.method && new RegExp(rule.path).test(url.pathname) && rule.remaining !== 0);
      if (index < 0) return original(request);
      const rule = rules[index]!;
      if (typeof rule.remaining === "number") {
        rule.remaining -= 1;
        sessionStorage.setItem(key, JSON.stringify(rules));
      }
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "x-correlation-id": "e2e-override" } });
      if (rule.kind === "respond") return json(rule.body, rule.status);
      const response = await original(request);
      if (response.status !== 200) return response;
      const data = await response.json();
      if (rule.kind === "addActions") data.actions = [...new Set([...data.actions, ...rule.actions])];
      if (rule.kind === "removeActions") data.actions = data.actions.filter((action: string) => !rule.actions.includes(action));
      if (rule.kind === "patchItems") data.items = data.items.map((item: Record<string, unknown>) => ({ ...item, ...rule.set }));
      if (rule.kind === "appendItems") {
        const extra = (rule.items as Array<Record<string, unknown>>).filter((item) => Object.entries(rule.filters as Record<string, string>)
          .every(([param, field]) => !url.searchParams.get(param) || item[field] === url.searchParams.get(param)));
        data.items = [...extra, ...data.items];
      }
      return json(data);
    };
  }, RULES_KEY);
}

async function addRule(page: Page, rule: Rule): Promise<void> {
  await page.evaluate(({ key, rule }) => {
    const rules = JSON.parse(sessionStorage.getItem(key) ?? "[]");
    rules.push(rule);
    sessionStorage.setItem(key, JSON.stringify(rules));
  }, { key: RULES_KEY, rule });
}

async function sent(page: Page, method: string, pattern: RegExp): Promise<Array<{ body: any }>> {
  const requests = await page.evaluate(() => (window as unknown as { __ehfRequests: Array<{ method: string; path: string; body: unknown }> }).__ehfRequests);
  return requests.filter((request) => request.method === method && pattern.test(request.path));
}

/** An out-of-band mutation, as another operator's tab would make it. */
async function apiPost(page: Page, path: string, body: unknown): Promise<number> {
  return page.evaluate(async ({ path, body }) => {
    const session = await (await fetch("/api/v1/session")).json();
    const response = await fetch(`/api${path}`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken }, body: JSON.stringify(body) });
    return response.status;
  }, { path, body });
}

async function useScenario(page: Page, scenario: string, path: string): Promise<void> {
  await mock(page, "PUT", "/mock/scenario", { scenario });
  await page.goto(path);
  await expect(page.getByRole("link", { name: "IntegralFlow home" })).toBeVisible();
}

/**
 * The onboarding decision belongs to the FinCrime module, so PLT-10 shows its labels and
 * reason codes (§8.5) rather than the neutral Approve · Reject · Return.
 */
const ONBOARDING = {
  Approve: { label: "Approve onboarding", reason: "kyc.onboarding.approve" },
  Reject: { label: "Decline onboarding", reason: "kyc.onboarding.decline" },
} as const;

/** Fill the decision form and attest; the trusted commit stays the caller's click. */
async function fillDecision(page: Page, decision: "Approve" | "Reject") {
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText(/You are deciding on the case as of sequence/)).toBeVisible();
  await sheet.getByRole("radio", { name: ONBOARDING[decision].label }).click();
  await sheet.getByLabel("Reason code").selectOption(ONBOARDING[decision].reason);
  await sheet.getByLabel(/Rationale/).fill(`${decision} after reviewing the ownership chain, screening results and risk factors.`);
  await sheet.getByRole("checkbox", { name: /I reviewed the evidence/ }).check();
  return sheet;
}

test.beforeEach(async ({ page }) => {
  await installOverrides(page);
});

test("policy human work shows original input and exact intents, then records a bound response",async({page})=>{
  // A contract fixture exercises the UI; real OPA/PostgreSQL authority is covered by
  // business-decisions.integration.test.ts rather than simulated by this mock queue.
  const digest="a".repeat(64),input={facts:{fixture:"original reviewed input"}};
  const unsigned={apiVersion:"harness.factory/business-decision-v2",decisionId:"policy-human-fixture",tenantId:"tenant_demo",caseId:"KYB-1042",
    planDigest:digest,releaseDigest:digest,caseSequence:10,snapshotDigest:digest,dependencyDigest:digest,selectedInputDigest:digest,
    effectivePolicySetDigest:digest,policyBundleDigest:digest,inputProfile:"canonical.onboarding.v2",gateId:"disposition",purpose:"CDD_ONBOARDING",
    subjectIds:[],proposerPrincipalIds:["agent.proposer"],scope:{jurisdiction:"GB",institution:"bank.synthetic",products:["deposit"],customerType:"corporate"},
    evaluatedAt:"2026-11-09T12:00:00Z",knowledgeCutoff:"2026-11-09T12:00:00Z",expiresAt:"2026-11-09T12:01:00Z",inputDigest:stableDigest(input),
    evaluator:{kind:"OPA",version:"1.9.0"},result:{state:"NEEDS_HUMAN",reasonCodes:["REVIEW"],ruleIds:["human"],actions:[],gaps:[],
      humanRequirement:{roles:["Case.Reviewer"],quorum:3,independentOfProposer:true,allowedChoices:["APPROVE","RETURN"],ttlSeconds:3600,
        actionIntents:{APPROVE:[{kind:"case_command",commandType:"FinalizeDisposition",payload:{outcome:"APPROVED",rationale:"Reviewed intent"}}],RETURN:[]}}}};
  const decision=businessDecisionSchema.parse({...unsigned,receiptDigest:stableDigest(unsigned)});
  const requestDigest=stableDigest({decisionId:decision.decisionId,inputDigest:decision.inputDigest,requirement:decision.result.humanRequirement});
  await signInAs(page,"compliance_officer","/platform/human-work");
  await addRule(page,{kind:"patchItems",method:"GET",path:"/api/v1/operations/human-work(?:\\?|$)",set:{policyDecision:decision,policyRequestDigest:requestDigest,policyResponsesAvailable:true,requiredApprovals:3}});
  await addRule(page,{kind:"respond",method:"GET",path:"/business-decisions/policy-human-fixture$",status:200,body:{decision,requestDigest,input,responses:[]}});
  await addRule(page,{kind:"respond",method:"POST",path:"/human-work/wi_decision/decisions$",status:201,body:{
    tenantId:"tenant_demo",caseId:"KYB-1042",workItemId:"wi_decision",decisionId:"fixture-response",principalId:"s.varga",
    decision:"APPROVE",reasonCode:ONBOARDING.Approve.reason,rationale:"Contract fixture response",evidenceRefs:[],decidedAt:"2026-11-09T12:00:01Z"}});
  await useScenario(page,"decision_pending","/platform/human-work?item=wi_decision");
  const card=page.getByRole("complementary",{name:/Authorize onboarding decision/});
  await expect(card.getByText("0 of 3 required")).toBeVisible();
  await card.getByRole("button",{name:"Decide",exact:true}).click();
  const sheet=page.getByRole("dialog");
  await expect(sheet.getByText("original reviewed input",{exact:false})).toBeVisible();
  await expect(sheet.getByText("Reviewed intent",{exact:false})).toBeVisible();
  await expect(sheet.getByRole("radio",{name:"Decline onboarding"})).toHaveCount(0);
  await expect(sheet.getByRole("radio",{name:/^Return/})).toBeVisible();
  await sheet.getByLabel("Reason code").selectOption(ONBOARDING.Approve.reason);
  await sheet.getByLabel(/Rationale/).fill("Reviewed the original input and the proposed policy action.");
  await sheet.getByRole("checkbox",{name:/I reviewed the evidence/}).check();
  await expectAccessible(page);
  await sheet.getByRole("button",{name:"Decide",exact:true}).click();
  await expect(sheet.getByText("Response recorded. The policy gate evaluates the responses before any business action is applied.").first()).toBeVisible();
  const requests=await sent(page,"POST",/\/decisions$/);
  expect(requests.at(-1)?.body).toMatchObject({inputDigest:decision.inputDigest,requestDigest,basis:{caseSequence:decision.caseSequence,snapshotDigest:decision.snapshotDigest}});
  expect(requests.at(-1)?.body).not.toHaveProperty("principalId");
});

// ---- PLT-09 · Cases -----------------------------------------------------------------------

test("PLT-09 AC1: create case chooses its policy jurisdiction by scope and shows the selected process and pack", async ({ page }) => {
  await signInAs(page, "cdd_analyst", "/platform/cases");
  await expect(page.getByRole("heading", { name: "Cases", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "KYB-1042" })).toBeVisible();
  await page.getByRole("button", { name: "New case" }).click();
  const sheet = page.getByRole("dialog", { name: "New case" });
  // The jurisdiction is chosen from the policy pack layers, no longer fixed to US.
  const jurisdiction = sheet.getByLabel("Policy jurisdiction");
  await expect(jurisdiction).toHaveValue("");
  await expect(jurisdiction).not.toHaveAttribute("readonly");
  await expect(jurisdiction.locator("option:not([value=''])")).toHaveText(["AU", "DE · no policy pack layer", "GB", "US"]);
  await expect(sheet.getByText("The jurisdiction whose policy pack governs this case.")).toBeVisible();
  // The case type follows the customer type: KYC for a person, KYB for a company or a trust.
  await expect(sheet.getByLabel("Case type")).toHaveValue("Customer onboarding (KYC)");
  await expect(sheet.getByLabel("Case type")).toHaveAttribute("readonly", "");
  await expect(sheet.getByText("Choose the policy jurisdiction.")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Create case" })).toBeDisabled();
  await expectAccessible(page);
  // This persona can't read plans (plan.read): the scope selects the plan.
  await expect(sheet.getByLabel("Plan digest")).toHaveCount(0);
  await jurisdiction.selectOption("US");
  await sheet.getByRole("checkbox", { name: "card", exact: true }).check();
  await expect(sheet.getByTestId("case-plan-selection")).toContainText("Agentic KYC: individual onboarding · policy.pack.us.bank-synthetic.personal-banking");
  await sheet.getByLabel("External reference").fill("ACME-ONBOARD-7");
  await sheet.getByRole("button", { name: "Create case" }).click();
  await expect(page).toHaveURL(/\/platform\/cases\/KYB-2001$/);
  await expect(page.getByText("ACME-ONBOARD-7")).toBeVisible();
  await expect(page.getByText("US", { exact: true })).toBeVisible();
  const created = await sent(page, "POST", /^\/api\/v1\/cases$/);
  expect(created).toHaveLength(1);
  expect(created[0]!.body).not.toHaveProperty("actor");
  expect(created[0]!.body).not.toHaveProperty("policyAuthority");
  expect(created[0]!.body).toMatchObject({ caseType: "kyc_onboarding", harnessPlanDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    scope: { customerType: "individual", trigger: "onboarding", dueDiligence: "standard", jurisdiction: "US", products: ["card"] } });
});

test("PLT-09 AC2: ledger verify shows checked events, head digest and failedSequence when broken", async ({ page }) => {
  await signInAs(page, "ops_manager", "/platform/cases/KYB-1042");
  await page.getByRole("button", { name: "Verify ledger" }).click();
  const result = page.getByRole("status", { name: "Verification result" });
  await expect(result.getByText("Verified — the hash chain is intact")).toBeVisible();
  await expect(result.getByText("Checked events")).toBeVisible();
  await expect(result.getByText("Head digest")).toBeVisible();
  await expect(result.getByText("Failed sequence")).toHaveCount(0);

  await addRule(page, { kind: "respond", method: "POST", path: "ledger:verify$", status: 200, body: { verified: false, checkedEvents: 9, headDigest: "b".repeat(64), failedSequence: 6 } });
  await page.getByRole("button", { name: "Verify ledger" }).click();
  await expect(result.getByText("Verification failed — the hash chain is broken")).toBeVisible();
  await expect(result.getByRole("definition").filter({ hasText: /^9$/ })).toBeVisible();
  await expect(result.getByText("Failed sequence")).toBeVisible();
  await expect(result.getByRole("definition").filter({ hasText: /^6$/ })).toBeVisible();
  await expect(result.getByText(/Events from sequence 6 onwards/)).toBeVisible();
  await expectAccessible(page);
});

test("PLT-09 AC3: Open in Workspace links the FinCrime room; exports are content-addressed", async ({ page }) => {
  await signInAs(page, "ops_manager", "/platform/cases/KYB-1042");
  await expect(page.getByRole("link", { name: "Open in Workspace" })).toHaveAttribute("href", "/work/cases/KYB-1042");
  await page.getByRole("button", { name: "Create export" }).click();
  await expect(page.getByText(/Export ready at sequence/)).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download JSON" }).click();
  expect((await download).suggestedFilename()).toMatch(/^KYB-1042-audit-[a-f0-9]{12}\.json$/);
});

// ---- PLT-10 · Human work ------------------------------------------------------------------

test("PLT-10 dual control: compliance officer approves (S3), a distinct second approver completes it (S4)", async ({ page }) => {
  await signInAs(page, "compliance_officer", "/platform/human-work");
  await useScenario(page, "decision_pending", "/platform/human-work?item=wi_decision");
  const card = page.getByRole("complementary", { name: /Authorize onboarding decision/ });
  await expect(card.getByText("0 of 2 required")).toBeVisible();
  await card.getByRole("button", { name: "Decide", exact: true }).click();
  const sheet = await fillDecision(page, "Approve");
  await expect(sheet.getByText("Platform-verified action · not agent-composed")).toBeVisible();
  await expectAccessible(page);
  await sheet.getByRole("button", { name: "Decide", exact: true }).click();
  await expect(sheet.getByText("Recorded. 1 of 2 approvals — waiting for more required responses.").first()).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(card.getByRole("button", { name: "Decide", exact: true })).toBeDisabled();
  await expect(card.getByText("You decided this item. A second, different approver is required.")).toBeVisible();

  await signInAs(page, "second_approver", "/platform/human-work");
  await useScenario(page, "second_approval", "/platform/human-work?item=wi_decision");
  await card.getByRole("button", { name: "Decide", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Claim to decide" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Claim to decide" })).toHaveCount(0);
  const second = await fillDecision(page, "Approve");
  await second.getByRole("button", { name: "Decide", exact: true }).click();
  await expect(second.getByText("Recorded. This item is complete.").first()).toBeVisible();
  const decisions = await sent(page, "POST", /\/decisions$/);
  expect(decisions.at(-1)!.body).toMatchObject({ decision: "APPROVE", basis: { caseSequence: expect.any(Number), snapshotDigest: expect.stringMatching(/[a-f0-9]{64}/) } });
  expect(decisions.at(-1)!.body).not.toHaveProperty("principalId");
});

test("PLT-10 AC1: a conflict is resolved by an operator who did not decide; deciders see it disabled", async ({ page }) => {
  await signInAs(page, "second_approver", "/platform/human-work");
  await useScenario(page, "second_approval", "/platform/human-work?item=wi_decision");
  const card = page.getByRole("complementary", { name: /Authorize onboarding decision/ });
  await card.getByRole("button", { name: "Decide", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Claim to decide" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Claim to decide" })).toHaveCount(0);
  const sheet = await fillDecision(page, "Reject");
  await sheet.getByRole("button", { name: "Decide", exact: true }).click();
  await expect(sheet.getByText(/Recorded\. Reviewers disagree/).first()).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).last().click();
  // A reviewer can't resolve: no human_work.resolve.
  await expect(card.getByRole("button", { name: "Resolve conflict" })).toHaveCount(0);
  await expect(page.getByRole("cell", { name: "Conflict" })).toBeVisible();

  // Persona switch in place keeps the mock's store (no reload).
  await mock(page, "PUT", "/mock/session", { personaId: "ops_manager" });
  await expect(page.getByRole("banner").getByText("A. Ruiz", { exact: true }).first()).toBeVisible();
  await card.getByRole("button", { name: "Resolve conflict" }).click();
  const resolve = page.getByRole("dialog", { name: "Resolve conflicting decisions" });
  await resolve.getByRole("radio", { name: "Reject" }).click();
  await resolve.getByLabel("Reason code").fill("risk.unresolved");
  await resolve.getByLabel(/Rationale/).fill("Ownership above 25% remains unverified; the rejection stands.");
  await resolve.getByRole("checkbox", { name: /I did not decide this item/ }).check();
  await expectAccessible(page);
  await resolve.getByRole("button", { name: "Resolve" }).click();
  await expect(resolve.getByText("Resolved. The process continues with your outcome.").first()).toBeVisible();
  const resolutions = await sent(page, "POST", /\/resolve$/);
  expect(resolutions).toHaveLength(1);
  expect(resolutions[0]!.body).toMatchObject({ caseId: "KYB-1042", decision: "REJECT", resolutionId: expect.stringMatching(/^resolution_/) });
});

test("PLT-10 AC1: resolve is disabled for a principal who decided (\"You decided this item\")", async ({ page }) => {
  await signInAs(page, "compliance_officer", "/platform/human-work");
  // s.varga decided in S4; grant the resolve hint client-side so the disabled path is visible.
  await addRule(page, { kind: "addActions", method: "GET", path: "^/api/v1/session$", actions: ["human_work.resolve"] });
  await addRule(page, { kind: "patchItems", method: "GET", path: "^/api/v1/operations/human-work$", set: { decisions: [
    { caseId: "KYB-1042", decidedAt: "2026-11-08T10:00:00Z", decision: "APPROVE", decisionId: "decision_a", evidenceRefs: [], principalId: "s.varga", rationale: "Approve.", reasonCode: "evidence.sufficient", tenantId: "tenant_demo", workItemId: "wi_decision" },
    { caseId: "KYB-1042", decidedAt: "2026-11-08T10:05:00Z", decision: "REJECT", decisionId: "decision_b", evidenceRefs: [], principalId: "h.adeyemi", rationale: "Reject.", reasonCode: "risk.unresolved", tenantId: "tenant_demo", workItemId: "wi_decision" },
  ] } });
  await useScenario(page, "second_approval", "/platform/human-work?item=wi_decision");
  const card = page.getByRole("complementary", { name: /Authorize onboarding decision/ });
  await expect(card.getByRole("button", { name: "Resolve conflict" })).toBeDisabled();
  await expect(card.getByText("You decided this item, so someone who did not decide must resolve it.")).toBeVisible();
});

test("PLT-10 AC2: overdue and escalated show glyph and text", async ({ page }) => {
  await signInAs(page, "ops_manager", "/platform/human-work");
  await addRule(page, { kind: "patchItems", method: "GET", path: "^/api/v1/operations/human-work$", set: { overdue: true, escalated: true } });
  await page.reload();
  const row = page.getByRole("table", { name: "Human work queue" }).getByRole("row").nth(1);
  await expect(row.getByText("Overdue")).toBeVisible();
  await expect(row.getByText("Escalated")).toBeVisible();
  await expect(row.locator("svg")).not.toHaveCount(0);
  await expectAccessible(page);
});

test("PLT-10: a retried decision reuses its decisionId after a 503", async ({ page }) => {
  await signInAs(page, "compliance_officer", "/platform/human-work");
  await addRule(page, { kind: "respond", method: "POST", path: "/decisions$", status: 503, remaining: 1, body: { error: "bff.upstream_unavailable", message: "control-api is unavailable.", retryable: true, correlationId: "e2e-503" } });
  await useScenario(page, "decision_pending", "/platform/human-work?item=wi_decision");
  await page.getByRole("complementary", { name: /Authorize onboarding decision/ }).getByRole("button", { name: "Decide", exact: true }).click();
  const sheet = await fillDecision(page, "Approve");
  await sheet.getByRole("button", { name: "Decide", exact: true }).click();
  await expect(sheet.getByText("A service is unavailable right now.").first()).toBeVisible();
  await expect(sheet.getByText(/Recorded/)).toHaveCount(0);
  await sheet.getByRole("button", { name: "Decide", exact: true }).click();
  await expect(sheet.getByText(/^Recorded\./).first()).toBeVisible();
  const attempts = await sent(page, "POST", /\/decisions$/);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]!.body.decisionId).toBe(attempts[0]!.body.decisionId);
});

// ---- PLT-11 · Releases --------------------------------------------------------------------

test("PLT-11 AC1: ops_manager is offered allowed next states × actions and deprecates in the trusted sheet", async ({ page }) => {
  await signInAs(page, "ops_manager", "/studio/published");
  await expect(page.getByRole("button", { name: "Revoke rel_fincrime_1_1_0" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve rel_fincrime_1_1_0" })).toHaveCount(0);
  await page.getByRole("button", { name: "Deprecate rel_fincrime_1_0_0" }).click();
  const sheet = page.getByRole("dialog", { name: "Deprecate rel_fincrime_1_0_0" });
  await expect(sheet.getByText("Platform-verified action · not agent-composed")).toBeVisible();
  await expect(sheet.getByLabel("Expected revision")).toHaveValue("3");
  const commit = sheet.getByRole("button", { name: "Deprecate" });
  await expect(commit).toBeDisabled();
  await sheet.getByRole("checkbox", { name: /I reviewed this release/ }).check();
  await expectAccessible(page);
  await commit.click();
  await expect(sheet.getByText("Recorded. rel_fincrime_1_0_0 is deprecated at revision 4.").first()).toBeVisible();
  const [request] = await sent(page, "POST", /\/releases\/rel_fincrime_1_0_0\/transition$/);
  expect(request!.body).toEqual({ to: "deprecated", expectedRevision: 3, reasonCode: "release.operator_decision" });
  await sheet.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(page.getByRole("row").filter({ hasText: "rel_fincrime_1_0_0" }).getByText("Deprecated")).toBeVisible();
});

test("PLT-11 B: harness approver approves the candidate, ops_manager activates it", async ({ page }) => {
  await signInAs(page, "harness_approver", "/studio/published");
  await page.getByRole("button", { name: "Approve rel_fincrime_1_1_0" }).click();
  let sheet = page.getByRole("dialog", { name: "Approve rel_fincrime_1_1_0" });
  await sheet.getByRole("checkbox", { name: /I reviewed this release/ }).check();
  await sheet.getByRole("button", { name: "Approve" }).click();
  await expect(sheet.getByText(/is approved at revision 2/).first()).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).last().click();

  await mock(page, "PUT", "/mock/session", { personaId: "ops_manager" });
  await page.getByRole("button", { name: "Activate rel_fincrime_1_1_0" }).click();
  sheet = page.getByRole("dialog", { name: "Activate rel_fincrime_1_1_0" });
  await sheet.getByRole("checkbox", { name: /I reviewed this release/ }).check();
  await sheet.getByRole("button", { name: "Activate" }).click();
  await expect(sheet.getByText(/is active at revision 3/).first()).toBeVisible();
});

test("PLT-11 AC2: a stale revision returns 409, shows conflict copy and refreshes", async ({ page }) => {
  await signInAs(page, "ops_manager", "/studio/published");
  await page.getByRole("button", { name: "Deprecate rel_fincrime_1_0_0" }).click();
  const sheet = page.getByRole("dialog", { name: "Deprecate rel_fincrime_1_0_0" });
  await sheet.getByRole("checkbox", { name: /I reviewed this release/ }).check();
  // Another operator deprecates it first.
  expect(await apiPost(page, "/v1/releases/rel_fincrime_1_0_0/transition", { to: "deprecated", expectedRevision: 3, reasonCode: "release.operator_decision" })).toBe(200);
  await sheet.getByRole("button", { name: "Deprecate" }).click();
  await expect(sheet.getByText("This release changed since you opened it")).toBeVisible();
  await expect(sheet.getByText(/It is now deprecated at revision 4/)).toBeVisible();
  await expect(sheet.getByText("Deprecate is no longer available from deprecated. Close and choose again.")).toBeVisible();
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("row").filter({ hasText: "rel_fincrime_1_0_0" }).getByText("Deprecated")).toBeVisible();
});

test("PLT-11 AC3: an invalid manifest signature is shown verbatim (422 release.signature_invalid)", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/published");
  await page.getByRole("button", { name: "Register manifest" }).click();
  const sheet = page.getByRole("dialog", { name: "Register a release manifest" });
  await sheet.getByLabel("Manifest (JSON)").fill(JSON.stringify({ releaseId: "rel_test", manifestDigest: "c".repeat(64), signature: { algorithm: "ES256", keyId: "ehf-release", keyVersion: "7", signedAt: "2026-11-08T10:00:00Z", value: "tampered" } }));
  await sheet.getByRole("button", { name: "Register" }).click();
  await expect(sheet.getByText("The manifest signature does not verify against key ehf-release (version 7).")).toBeVisible();
  await expect(sheet.getByText("release.signature_invalid")).toBeVisible();
  await expectAccessible(page);
});

// ---- PLT-12 · Health ----------------------------------------------------------------------

test("PLT-12 AC2: gateway decisions filter by run and decision; denials link to the run", async ({ page }) => {
  await signInAs(page, "ops_manager", "/platform/system?tab=gateway");
  await addRule(page, { kind: "appendItems", method: "GET", path: "^/api/v1/gateway/decisions$", filters: { runId: "runId", decision: "decision" }, items: [{
    adapterBindingId: null, attempt: 1, capabilityId: "media.search", decision: "denied", effect: "read", envelopeDigest: "d".repeat(64), fencingEpoch: 1,
    idempotencyKey: "rcpt-denied-1", latencyMs: 3, nodeId: "adverse_media", occurredAt: "2026-11-07T09:13:00Z", reasonCode: "authority.capability_out_of_scope",
    receiptId: "rcpt_denied_1", requestDigest: "e".repeat(64), resultDigest: null, resultStatus: null, runId: "run_denied_1", spanId: null, traceId: null,
  }] });
  await page.reload();
  const table = page.getByRole("table", { name: "Gateway decisions" });
  await expect(table.getByText("Denied", { exact: true })).toBeVisible();
  await expect(table.getByText("Allowed", { exact: true })).toBeVisible();
  await page.getByLabel("Decision", { exact: true }).selectOption("denied");
  await expect(page).toHaveURL(/decision=denied/);
  await expect(table.getByText("Allowed", { exact: true })).toHaveCount(0);
  await expect(table.getByRole("link", { name: /Open run run_denied_1/ })).toHaveAttribute("href", "/platform/runs/run_denied_1");
  await page.getByLabel("Decision", { exact: true }).selectOption("");
  await page.getByLabel("Run", { exact: true }).fill("run_denied_1");
  await expect(page).toHaveURL(/run=run_denied_1/);
  await expect(table.getByText("Allowed", { exact: true })).toHaveCount(0);
  await expect(table.getByText("Denied", { exact: true })).toBeVisible();
  await expectAccessible(page);
});

test("PLT-12 AC1: without runtime.admission.write, stop admission is disabled and says why (GAP-050)", async ({ page }) => {
  await signInAs(page, "ops_manager", "/platform/system?tab=runtime");
  // An operator holds runtime.admission.write; a session without it sees why the control is disabled.
  await addRule(page, { kind: "removeActions", method: "GET", path: "^/api/v1/session$", actions: ["runtime.admission.write"] });
  await page.reload();
  await expect(page.getByText(/Runtime admission needs runtime\.admission\.write/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop admission…" })).toBeDisabled();
  await page.getByRole("tab", { name: "Services" }).click();
  // Connections is the default tab; any other tab is named in the URL.
  await expect(page).toHaveURL(/tab=services/);
  await expect(page.getByRole("table", { name: "Service readiness" })).toBeVisible();
});

test("PLT-12 AC1: stop admission asks for drain|cancel in the trusted sheet and reports the cancelled count", async ({ page }) => {
  await signInAs(page, "ops_manager", "/platform/system?tab=runtime");
  await addRule(page, { kind: "addActions", method: "GET", path: "^/api/v1/session$", actions: ["runtime.admission.write"] });
  await addRule(page, { kind: "respond", method: "GET", path: "^/api/v1/admin/runtime$", status: 200, body: { state: "running", activeRunPolicy: null, changedAt: "2026-11-08T09:00:00Z" } });
  await addRule(page, { kind: "respond", method: "POST", path: "^/api/v1/admin/runtime$", status: 200, body: { state: "stopped", activeRunPolicy: "cancel", changedAt: "2026-11-08T12:00:00Z", cancelledRuns: 2 } });
  await page.reload();
  await expect(page.getByText("Running · new runs are admitted")).toBeVisible();
  await page.getByRole("button", { name: "Stop admission…" }).click();
  const sheet = page.getByRole("dialog", { name: "Stop runtime admission" });
  await expect(sheet.getByText("Platform-verified action · not agent-composed")).toBeVisible();
  await sheet.getByRole("radio", { name: "Cancel" }).click();
  await expect(sheet.getByText(/Runs already admitted are sent a cancellation request/)).toBeVisible();
  await sheet.getByLabel("Reason").fill("Provider outage: hold new runs");
  await sheet.getByRole("checkbox", { name: /new runs will be refused/ }).check();
  await expectAccessible(page);
  await sheet.getByRole("button", { name: "Stop admission" }).click();
  await expect(sheet.getByText("Admission stopped. Cancellation requested for 2 active runs.").first()).toBeVisible();
  const [request] = await sent(page, "POST", /\/admin\/runtime$/);
  expect(request!.body).toMatchObject({ operation: "stop", activeRunPolicy: "cancel", reason: "Provider outage: hold new runs" });
});

test("PLT-12: unknown worker metrics stay visible as unreported", async ({ page }) => {
  await signInAs(page, "ops_manager", "/platform/system?tab=services");
  const view = await page.evaluate(async () => (await fetch("/api/v1/system")).json());
  view.queueWorkState.activeWorkers = null;
  await addRule(page, { kind: "respond", method: "GET", path: "^/api/v1/system$", status: 200, body: view });
  await page.reload();
  const workers = page.getByText("Healthy worker replicas", { exact: true }).locator("..");
  await expect(workers.getByText("Not reported", { exact: true })).toBeVisible();
  await expect(workers.getByText("0", { exact: true })).toHaveCount(0);
  await expectAccessible(page);
});

test("PLT-11: revocation addresses one registry artifact instead of a nonexistent signing key", async ({ page }) => {
  await signInAs(page, "ops_manager", "/studio/published");
  await page.getByRole("button", { name: "Revoke an artifact…" }).click();
  const sheet = page.getByRole("dialog", { name: "Revoke artifact", exact: true });
  const digest = "a".repeat(64);
  await sheet.getByLabel("Artifact kind").selectOption("policy-bundle");
  await sheet.getByLabel("Artifact digest").fill(digest);
  await sheet.getByLabel("Reason code (required)").fill("policy.withdrawn");
  await expectAccessible(page);
  await sheet.getByRole("button", { name: "Revoke artifact", exact: true }).click();
  await expect(page.getByText(`Artifact ${digest} revoked.`, { exact: true })).toBeVisible();
  const requests = await sent(page, "POST", new RegExp(`/registry/artifacts/policy-bundle/${digest}/revoke$`));
  expect(requests[0]!.body).toEqual({ reasonCode: "policy.withdrawn" });
});

// ---- Release activation (phase H) ----------------------------------------------------------

test("PLT-11 activation: a release scheduled for next year leaves the current one in effect", async ({ page }) => {
  await signInAs(page, "harness_approver", "/studio/published");
  await page.getByRole("button", { name: "Approve rel_fincrime_1_1_0" }).click();
  let sheet = page.getByRole("dialog", { name: "Approve rel_fincrime_1_1_0" });
  await sheet.getByRole("checkbox", { name: /I reviewed this release/ }).check();
  await sheet.getByRole("button", { name: "Approve" }).click();
  await expect(sheet.getByText(/is approved at revision 2/).first()).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).last().click();

  await mock(page, "PUT", "/mock/session", { personaId: "ops_manager" });
  await page.getByRole("button", { name: "Activate rel_fincrime_1_1_0" }).click();
  sheet = page.getByRole("dialog", { name: "Activate rel_fincrime_1_1_0" });
  await sheet.getByLabel("Takes effect (UTC)").fill(`${new Date().getUTCFullYear() + 1}-01-15T09:00`);
  await sheet.getByRole("checkbox", { name: /I reviewed this release/ }).check();
  await sheet.getByRole("button", { name: "Activate" }).click();
  await expect(sheet.getByText(/is active at revision 3/).first()).toBeVisible();
  const request = (await sent(page, "POST", /\/releases\/rel_fincrime_1_1_0\/transition$/)).at(-1);
  expect(request!.body).toMatchObject({ to: "active", effectiveFrom: `${new Date().getUTCFullYear() + 1}-01-15T09:00:00.000Z` });
  await sheet.getByRole("button", { name: "Close", exact: true }).last().click();
  const activation = page.getByRole("region", { name: "release activation" });
  await expect(activation).toContainText("Scheduled");
  await expect(activation.getByRole("table", { name: "Release activation history" })).toContainText("Scheduled rel_fincrime_1_1_0");
  await expectAccessible(page);
});

test("PLT-11 activation: activating supersedes the release in effect, and rollback puts the earlier one back", async ({ page }) => {
  await signInAs(page, "harness_approver", "/studio/published");
  await page.getByRole("button", { name: "Approve rel_fincrime_1_1_0" }).click();
  let sheet = page.getByRole("dialog", { name: "Approve rel_fincrime_1_1_0" });
  await sheet.getByRole("checkbox", { name: /I reviewed this release/ }).check();
  await sheet.getByRole("button", { name: "Approve" }).click();
  await expect(sheet.getByText(/is approved at revision 2/).first()).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).last().click();
  await mock(page, "PUT", "/mock/session", { personaId: "ops_manager" });
  await page.getByRole("button", { name: "Activate rel_fincrime_1_1_0" }).click();
  sheet = page.getByRole("dialog", { name: "Activate rel_fincrime_1_1_0" });
  await sheet.getByRole("checkbox", { name: /I reviewed this release/ }).check();
  await sheet.getByRole("button", { name: "Activate" }).click();
  await expect(sheet.getByText(/is active at revision 3/).first()).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).last().click();

  await page.getByLabel("Roll back to").selectOption("rel_fincrime_1_0_0");
  await page.getByLabel("Why roll back").fill("The new release fails a smoke test");
  await page.getByRole("button", { name: "Roll back" }).click();
  await expect(page.getByText("Rolled back. The other active releases of the process are deprecated.")).toBeVisible();
  const [request] = await sent(page, "POST", /\/releases\/rel_fincrime_1_0_0\/rollback$/);
  expect(request!.body).toEqual({ reason: "The new release fails a smoke test" });
  await expect(page.getByRole("table", { name: "Release activation history" })).toContainText("Rolled back to rel_fincrime_1_0_0");
  await expect(page.getByRole("row").filter({ hasText: "rel_fincrime_1_1_0" }).getByText("Deprecated")).toBeVisible();
  await expectAccessible(page);
});
