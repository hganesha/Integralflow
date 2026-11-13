import { test, expect } from "@playwright/test";
import Fastify from "fastify";
import { registerPolicyAuthoringRoutes } from "../../apps/control-api/src/policy-authoring.js";
import { closeBusinessPolicyEvaluators } from "../../packages/policy-engine/src/business-policy.js";
import { signInAs, expectAccessible } from "./support";

// The shell uses its contract mock for identity/navigation. Policy requests cross an
// actual HTTP authoring server and real OPA; no policy result is stubbed.
test("installation policy sample: browser → HTTP API → real OPA → rendered decision",async({page})=>{
  const server=Fastify();
  const actions:string[]=[];
  const receipts:string[]=[];
  server.addHook("onRequest",async(request,reply)=>{
    const origin=request.headers.origin;
    if(origin && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)){
      reply.header("access-control-allow-origin",origin);
      reply.header("access-control-allow-credentials","true");
      reply.header("access-control-allow-headers",request.headers["access-control-request-headers"]??"content-type,x-csrf-token,idempotency-key");
      reply.header("access-control-allow-methods","GET,POST,OPTIONS");
    }
  });
  server.options("/*",async(_request,reply)=>reply.code(204).send());
  server.addHook("onSend",async(request,_reply,payload)=>{
    if(request.url.endsWith("/evaluate") && typeof payload==="string"){
      const body=JSON.parse(payload);if(body.receiptDigest)receipts.push(body.receiptDigest);
    }
    return payload;
  });
  registerPolicyAuthoringRoutes(server,{opaVersion:"1.9.0",authorize:async(_request,action)=>{actions.push(action);}});
  const origin=await server.listen({host:"127.0.0.1",port:0});
  try {
    await page.addInitScript((apiOrigin)=>{
      const original=window.fetch.bind(window);
      window.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
        const requested=input instanceof Request?input:new Request(new URL(String(input),location.href),init);
        const url=new URL(requested.url);
        if(url.pathname.startsWith("/api/v1/authoring/policies") && !url.pathname.includes("/workspaces/")){
          const path=url.pathname==="/api/v1/authoring/policies"?"/v1/authoring/policies/templates/kyc":url.pathname.slice(4);
          return original(new Request(apiOrigin+path+url.search,{method:requested.method,headers:requested.headers,body:["GET","HEAD"].includes(requested.method)?undefined:await requested.clone().text(),credentials:"include",mode:"cors",duplex:"half"} as RequestInit));
        }
        return original(input,init);
      };
    },origin);
    await signInAs(page,"agent_architect","/studio/policies");
    await expect(page.getByLabel("Policy",{exact:true})).toHaveValue("kyc-agentic");
    await page.getByRole("button",{name:"Simulate",exact:true}).click();
    await expect(page.getByRole("heading",{name:"Test the policy (what-if)"})).toBeFocused();
    // The diligence gate: an individual's deposit is an SDD cell, applied as CDD because SDD is not adopted.
    await expect(page.getByLabel("Gate",{exact:true})).toHaveValue("diligence-level");
    const outcome=page.getByRole("region",{name:"What-if outcome"});
    await page.getByRole("checkbox",{name:"Card"}).uncheck();
    await page.getByRole("checkbox",{name:"Payments"}).uncheck();
    await page.getByRole("button",{name:"Run what-if",exact:true}).click();
    await expect(outcome.getByText("CDD",{exact:true}).first()).toBeVisible();
    await expect(outcome).toContainText("Base for Individual with deposit: SDD");
    await expect(outcome).toContainText("Simplified due diligence is not permitted: CDD");
    await page.getByRole("checkbox",{name:"Politically exposed person"}).check();
    await page.getByRole("button",{name:"Run what-if",exact:true}).click();
    await expect(outcome).toContainText("Politically exposed person: EDD");
    await expect(outcome).toContainText("EVD-SOURCE-OF-FUNDS");
    await page.getByRole("button",{name:"Run what-if",exact:true}).click();
    await expect.poll(()=>receipts.length).toBe(3);
    expect(receipts[1]).toBe(receipts[2]);
    // An authored gate still reads as rules: the SYNTHETIC intake rules need a banking relationship.
    await page.getByLabel("Gate",{exact:true}).selectOption({label:"Intake ready"});
    await page.getByRole("button",{name:"Run what-if",exact:true}).click();
    await expect(outcome.getByText("Needs more evidence",{exact:true})).toBeVisible();
    await expect(outcome).toContainText("No rule matched, so the gate's default applies.");
    await expect(outcome).toContainText("BANKING_RELATIONSHIP_MISSING");
    await expect.poll(()=>receipts.length).toBe(4);
    expect(actions).toEqual(expect.arrayContaining(["draft.read","draft.compile","draft.evaluate"]));
    await expectAccessible(page);
    await page.screenshot({path:test.info().outputPath("policy-what-if-browser.png"),fullPage:true});
    await page.getByRole("tab",{name:"Approvals",exact:true}).click();
    await page.getByRole("button",{name:"Compile candidate",exact:true}).click();
    await expect(page.getByRole("heading",{name:/^Open release blockers \(\d+\)$/})).toBeVisible();
    await page.getByRole("tab",{name:"Advanced",exact:true}).click();
    await page.getByRole("radio",{name:"Test corpus",exact:true}).click();
    const runner=page.getByRole("region",{name:"Policy sample simulation"});
    await expect(runner.getByRole("heading",{name:"Test a sample"})).toBeVisible();
    await runner.getByLabel("Sample facts (JSON)").fill("invalid");
    await runner.getByRole("button",{name:"Evaluate sample"}).click();
    await expect(runner.getByRole("alert")).toBeVisible();
    expect(receipts).toHaveLength(4);
  }finally{await server.close();await closeBusinessPolicyEvaluators();}
});
