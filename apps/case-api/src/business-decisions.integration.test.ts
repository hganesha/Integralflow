import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { parse, stringify } from "yaml";
import { createKycCaseRequestSchema, stableDigest, computeReleaseManifestDigest, PROTECTED_BUSINESS_COMMANDS,
  executionWorkItemSchema, type HarnessPlanV2, type ReleaseManifest, type BusinessDecision } from "@ehf/contracts";
import { compileBusinessPolicy, closeBusinessPolicyEvaluators, diligenceDesignSchema, projectDiligenceDesign, summarizeDiligenceDecisions, type BusinessPolicySource } from "@ehf/policy-engine";
import { executePolicyGate, type GateEvaluationRequest } from "@ehf/runtime-core";
import { createCaseStore, createKycCase, submitBusinessCommand, getCanonicalCaseSnapshot, projectCanonicalCaseSnapshot,
  recordPolicySnapshotRead, applyEvaluatedBusinessDecision, dispatchBusinessEffect, getCaseView, verifyCaseLedger, recordBusinessHumanResponse, getStoredBusinessDecision, listBusinessDecisionReceipts, type CaseStore } from "@ehf/case-store";
import { createDatabase, createPolicyRevision, setPolicyRevisionCompiled, approvePolicyRevision, publishPolicyRevision,
  registerReleaseManifest, transitionRelease, revokeArtifactEntry, createExecutionWorkItem, requestHumanExecutionDecision,
  submitHumanWorkDecision, resumePolicyHumanWork, getExecutionWorkItem, listHumanWorkQueue, resolveHumanWorkConflict,
  createInstitutionCatalogRevision, approveInstitutionCatalogRevision, publishInstitutionCatalogRevision } from "@ehf/persistence";
import { evaluateStoredCaseGate } from "./policy-evaluator.js";

const databaseUrl=process.env.EHF_TEST_DATABASE_URL;
if(process.env.EHF_REQUIRE_POLICY_DB_TESTS==="1" && !databaseUrl) throw new Error("policy.database_conformance_required");
const d="a".repeat(64);
const human={actionIntents:{APPROVE:decided("APPROVED").actions,REJECT:decided("DECLINED").actions,RETURN:[]},roles:["Case.Reviewer"],quorum:2,independentOfProposer:true,allowedChoices:["APPROVE" as const,"REJECT" as const,"RETURN" as const],ttlSeconds:3600};
function decided(outcome:string): {state:"DECIDED";reasonCodes:string[];ruleIds:string[];gaps:[];humanRequirement:null;actions:Array<{kind:"case_command";commandType:"FinalizeDisposition";payload:{outcome:string;rationale:string}}>} {return ({state:"DECIDED" as const,reasonCodes:[outcome],ruleIds:[],gaps:[],humanRequirement:null,
  actions:[{kind:"case_command" as const,commandType:"FinalizeDisposition" as const,payload:{outcome,rationale:"Explicit installation test policy"}}]});}
const needsHuman={state:"NEEDS_HUMAN" as const,reasonCodes:["HUMAN_REQUIRED"],ruleIds:[],gaps:[],actions:[],humanRequirement:human};

describe.skipIf(!databaseUrl)("released business decisions in real OPA and PostgreSQL",()=>{
  let admin:ReturnType<typeof createDatabase>;
  let store:CaseStore;
  const suffix=randomUUID().replaceAll("-","").slice(0,10);
  const caseLogin=`policy_case_${suffix}`; const controlLogin=`policy_execution_${suffix}`;
  beforeAll(async()=>{
    admin=createDatabase(databaseUrl);
    for(const [login,role] of [[caseLogin,"ehf_svc_case_api"],[controlLogin,"ehf_svc_case_execution"]]) {
      await admin.query(`create role ${login} login password 'isolated-policy-test' nosuperuser nobypassrls`);
      await admin.query(`grant ${role} to ${login}`);
    }
    const url=(name:string)=>{const u=new URL(databaseUrl!);u.username=name;u.password="isolated-policy-test";return u.toString();};
    store=createCaseStore({connectionString:url(caseLogin)});
    store.executionDb=createDatabase(url(controlLogin));
  });
  afterAll(async()=>{
    await store?.db.end();await store?.executionDb?.end();await closeBusinessPolicyEvaluators();
    for(const login of [caseLogin,controlLogin])await admin.query(`drop role if exists ${login}`);
    await admin.end();
  });

  async function fixture(mode:"approve"|"decline"|"human"="approve", options:{candidate?:boolean;failAction?:boolean;external?:boolean;jurisdiction?:"US"|"GB";customerType?:"individual"|"corporate";alteredHumanIntent?:boolean;adoptionVersion?:string;collect?:boolean;diligence?:boolean;approval?:boolean;
    /** A synthetic securities firm's case: its products, the customer's roles in them, and whether its catalog is published. */
    securities?:{products:Array<Record<string,unknown>>;roles?:Array<{productId:string;role:string}>;publishCatalog?:boolean};
    /** The bank's products replaced (e.g. an offering instead of a product type), with the bank's catalog published. */
    bankProducts?:Array<Record<string,unknown>>;
    /** The relationship's recorded risk tier, and whether the assessed-risk rule is on. */
    riskTier?:string;assessedRiskRule?:boolean;
    /** The bank customer's roles in its products (by product id). */
    bankRoles?:Array<{productId:string;role:string}>;
    /** A second rule that also needs one senior reviewer (approvals by several roles). */
    seniorApproval?:boolean}={}) {
    const tenantId=`business_${randomUUID()}`;
    const hero=options.customerType==="corporate"?"H04":"H01";
    const relationship=readFileSync(new URL("../../../fixtures/context-corpus/parties/"+hero+"/records.jsonl",import.meta.url),"utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l)).find(r=>r.object_type==="BankingRelationship");
    relationship.data.policyJurisdiction=options.jurisdiction??"US";
    const publishCatalog=async(institutionId:string)=>{
      const seed=JSON.parse(readFileSync(new URL("../../../artifacts/products/institutions.json",import.meta.url),"utf8")).catalogs.find((entry:{institution:{id:string}})=>entry.institution.id===institutionId);
      const draft=await createInstitutionCatalogRevision(admin,{tenantId,actor:"catalog-author",catalog:seed,expectedRevision:0,reason:"Seed",problems:[]});
      await approveInstitutionCatalogRevision(admin,{tenantId,actor:"catalog-approver",institutionId,revision:draft.revision,reason:"Reviewed",problems:[]});
      await publishInstitutionCatalogRevision(admin,{tenantId,actor:"catalog-approver",institutionId,revision:draft.revision,reason:"Go live"});
    };
    if(options.riskTier) relationship.data.riskTier=options.riskTier;
    // The set serves today's product types whatever the case names.
    const bankTypes=relationship.data.products.map((p:{productType:string})=>p.productType);
    if(options.bankProducts) { relationship.data.products=options.bankProducts; await publishCatalog("bank.synthetic"); }
    if(options.bankRoles) relationship.data.productRoles=options.bankRoles.map(role=>({entityId:relationship.data.customerEntityId,...role}));
    if(options.securities) {
      relationship.data.institutionId="securities.synthetic";
      relationship.data.entities=relationship.data.entities.map((entity:{entityId:string})=>entity.entityId===relationship.data.customerEntityId?{...entity,legalForm:"fund"}:entity);
      relationship.data.products=options.securities.products;
      if(options.securities.roles) relationship.data.productRoles=options.securities.roles.map(role=>({entityId:relationship.data.customerEntityId,...role}));
      if(options.securities.publishCatalog!==false) await publishCatalog("securities.synthetic");
    }
    // A securities set serves taxonomy nodes; a bank set today's product types.
    const products=options.securities?["BRK","CUS","WLT"]:bankTypes;

    const source:BusinessPolicySource={apiVersion:"harness.factory/business-policy-v2",kind:"BusinessPolicy",
      metadata:{id:"policy.installation.test",version:"2.0.0",owner:"owner"},decisionTtlSeconds:60,
      policySets:[{id:"installation.test",version:"2.0.0",status:options.candidate?"CANDIDATE":"APPROVED",packPin:{id:"pack.test",digest:d},
        scope:{jurisdiction:options.jurisdiction??"US",institution:options.securities?"securities.synthetic":"bank.synthetic",products,customerTypes:[options.customerType??"individual"],purposes:["CDD_ONBOARDING"]},
        modules:[{id:"test.rules",version:"2",digest:d}],configuration:{automaticApproval:mode==="approve",automaticDecline:mode==="decline",
          ...(options.diligence?{mandatory_overlays:[],simplified_due_diligence_permitted:false,diligence_floors:{}}:{})}}],
      gates:{disposition:{inputProfile:"canonical.onboarding.v2",rules:[
        {id:"conflict",when:{path:"/facts/humanReview/conflict",op:"eq",value:true},result:needsHuman},
        {id:"human-approve",when:{path:"/facts/humanReview/counts/APPROVE",op:"gte",valueFrom:"/facts/humanReview/requirement/quorum"},result:{...decided("APPROVED"),humanIntent:{decisionId:"$input/facts/humanReview/decisionId",choice:"APPROVE"}}},
        {id:"human-decline",when:{path:"/facts/humanReview/counts/REJECT",op:"gte",valueFrom:"/facts/humanReview/requirement/quorum"},result:{...decided("DECLINED"),humanIntent:{decisionId:"$input/facts/humanReview/decisionId",choice:"REJECT"}}},
        {id:"automatic-approve",when:{path:"/configuration/automaticApproval",op:"eq",value:true},result:decided("APPROVED")},
        {id:"automatic-decline",when:{path:"/configuration/automaticDecline",op:"eq",value:true},result:decided("DECLINED")},
      ],otherwise:needsHuman}}};
    // The taxonomy's legacy mapping lets a canonical product (a debit card) fall under today's type (card).
    const legacy=JSON.parse(readFileSync(new URL("../../../artifacts/products/taxonomy.json",import.meta.url),"utf8")).legacy as Record<string,string>;
    if(options.diligence) source.diligence=projectDiligenceDesign(diligenceDesignSchema.parse(parse(readFileSync(new URL(`../../../domains/policy/diligence/${options.securities?"securities":"bank"}-synthetic.yaml`,import.meta.url),"utf8"))),source.policySets,legacy);
    // A decision-ready gate that reads the diligence decision's screening types.
    if(options.diligence) source.gates["decision-ready"]={inputProfile:"canonical.onboarding.v2",rules:[
      {id:"adverse-media-screening",when:{path:"/facts/diligence/screeningTypes",op:"contains",value:"adverse_media"},result:needsHuman}],otherwise:needsHuman};
    if(options.assessedRiskRule) source.diligence!.overlays.find(overlay=>overlay.id==="overlay.assessed-high-risk")!.enabled=true;
    // A rule that always fires and requires two reviewers' approval, enforced at disposition.
    if(options.approval) source.diligence!.overlays.push({id:"overlay.review-everyone",label:"Review every relationship",enabled:true,requires:["/scope/customerType"],
      when:{path:"/scope/customerType",op:"present"},effect:{requireApproval:{role:"Case.Reviewer",quorum:2,reason:"Two reviewers approve every relationship."}}});
    if(options.seniorApproval) source.diligence!.overlays.push({id:"overlay.senior-sign-off",label:"Senior sign-off",enabled:true,requires:["/scope/customerType"],
      when:{path:"/scope/customerType",op:"present"},effect:{requireApproval:{role:"KYC.SeniorReviewer",quorum:1,reason:"A senior reviewer signs off every relationship."}}});
    if(options.failAction) source.gates.disposition!.rules[3]!.result.actions.push({kind:"case_command",commandType:"AcceptClaimAsFact",payload:{claimId:"missing",acceptancePolicyRef:"test"}});
    if(options.external) source.gates.disposition!.rules[3]!.result.actions=[{kind:"external_action",action:"regulatory.filing.submit",payload:{reportId:"fixture-filing"}}];
    if(options.adoptionVersion) source.gates.disposition!.rules[3]!.result.actions=[{kind:"adopt_assessment",objectType:"BankingRelationship",objectId:"relationship",versionId:options.adoptionVersion,interpretation:"product.eligibility",value:"READY"}];
    if(options.collect) source.gates.disposition!.rules[3]!.result={state:"NEEDS_EVIDENCE",reasonCodes:["IDENTITY_REQUIRED"],ruleIds:[],humanRequirement:null,
      gaps:[{code:"IDENTITY_REQUIRED",path:"/facts/identity",subjectId:null}],actions:[{kind:"case_command",commandType:"ProposeWorkItem",payload:{workItemId:"collect-identity",workType:"COLLECT_IDENTITY"}}]};
    if(options.alteredHumanIntent) source.gates.disposition!.rules[1]!.result.actions=decided("DECLINED").actions;
    const compiled=compileBusinessPolicy(source,{opaVersion:"1.9.0"});
    const plan=JSON.parse(readFileSync(new URL("../../../artifacts/"+(options.customerType==="corporate"?"kyb-agentic":"kyc-agentic")+".plan.json",import.meta.url),"utf8")) as HarnessPlanV2;
    plan.policyBundles=[{policyId:compiled.manifest.policyId,bundleDigest:compiled.manifest.bundleDigest}];
    const node=plan.graph.nodes.find(n=>n.id===(options.diligence?"diligence-level":"pack-disposition"))!;for(const gate of plan.graph.nodes.filter(n=>n.kind==="gate")) gate.config.policyRef=compiled.manifest.policyId;
    const {planDigest:_old,planId:_id,...content}=plan;plan.planDigest=stableDigest(content);plan.planId=`plan_${plan.planDigest}`;
    await admin.query("insert into harness_control.plans(plan_digest,plan_id,name,domain,version,plan,tenant_id) values($1,$2,'policy-test','kyc','2',$3::jsonb,$4)",[plan.planDigest,plan.planId,JSON.stringify(plan),tenantId]);
    const files={"policy.yaml":stringify(source)};
    const revision=await createPolicyRevision(admin,{tenantId,workspaceId:"test",files,actor:"author"});
    await setPolicyRevisionCompiled(admin,{tenantId,workspaceId:"test",revision:revision.revision,actor:"author",bundle:compiled.manifest,releaseBlockers:compiled.releaseBlockers});
    if(!options.candidate) {
      await approvePolicyRevision(admin,{tenantId,workspaceId:"test",revision:revision.revision,actor:"approver"});
      await publishPolicyRevision(admin,{tenantId,workspaceId:"test",revision:revision.revision,actor:"publisher"});
    }
    const manifest:ReleaseManifest={apiVersion:"harness.factory/release-manifest-v1",kind:"ReleaseManifest",releaseId:"test",manifestDigest:d,
      planDigest:plan.planDigest,packageDigest:d,policyBundleDigests:[compiled.manifest.bundleDigest],schemaSetDigest:d,agentDigests:[],skillDigests:[],capabilityDigests:[],modelProfileDigests:[],
      executionProfileDigest:d,compilerDigest:d,runtimeDigest:d,dependencyManifestDigest:plan.dependencyManifestDigest,evaluationAttestationDigest:d,provenanceDigest:d,
      scope:{environment:"development",tenants:[tenantId],regions:[options.jurisdiction??"US"],cohort:"test"},createdAt:new Date().toISOString()};
    manifest.manifestDigest=computeReleaseManifestDigest(manifest);
    await registerReleaseManifest(admin,{tenantId,actor:"release-author",manifest});
    if(!options.candidate) {
      await transitionRelease(admin,{tenantId,releaseId:"test",actor:"release-approver",expectedRevision:0,to:"approved",reasonCode:"test"});
      await transitionRelease(admin,{tenantId,releaseId:"test",actor:"release-approver",expectedRevision:1,to:"active",reasonCode:"test"});
    }
    const created=await createKycCase(store,createKycCaseRequestSchema.parse({tenantId,caseType:options.customerType==="corporate"?"kyb_onboarding":"kyc_onboarding",schemaVersion:options.customerType==="corporate"?"kyb.case.v1":"kyc.case.v1",jurisdiction:options.jurisdiction??"US",policySnapshotDigest:d,harnessPlanDigest:plan.planDigest,
      policyAuthority:{policyId:"pack.test",policyVersion:"1",policyBundleDigest:d,dependencyDigest:plan.dependencyManifestDigest},actor:{type:"HUMAN",principalId:"requester",roles:[]}}),randomUUID());
    const caseId=created.case.caseId;

    await submitBusinessCommand(store,{commandId:randomUUID(),commandType:"RecordCanonicalRecords",commandVersion:"v1",tenantId,caseId,
      actor:{type:"INTEGRATION",principalId:"fixture",roles:[]},authority:{planDigest:plan.planDigest,policySnapshotDigest:d,permissionEnvelopeDigest:d},
      payload:{records:[{object_type:"BankingRelationship",object_id:"relationship",version_id:"v1",data:relationship.data,observed_at:new Date().toISOString(),
        source_refs:[],provenance:{method:"connector_normalizer"},classification:"CONFIDENTIAL",purposes:["CDD_ONBOARDING"],synthetic:true}]},
      preconditions:{caseSequence:1},idempotencyKey:randomUUID()});
    const runId=`run_${randomUUID()}`;
    await admin.query("insert into harness_runtime.runs(run_id,idempotency_key,plan_digest,status,input,attempt,fencing_epoch,lease_expires_at,tenant_id,request_digest) values($1,$1,$2,'running',$3,1,1,now()+interval '5 minutes',$4,'test')",[runId,plan.planDigest,{caseId},tenantId]);
    const execution={tenant_id:tenantId,case_id:caseId,run_id:runId,plan_digest:plan.planDigest,attempt:1,fencing_epoch:1};
    const authority={execution,plan,files,manifest:compiled.manifest,releaseDigest:manifest.manifestDigest,productionReady:!options.candidate};
    async function evaluate(transformRequest?:(request:GateEvaluationRequest)=>GateEvaluationRequest,nodeId=node.id) {
      const gateNode=plan.graph.nodes.find(n=>n.id===nodeId)!;
      const selectors=gateNode.contextSelectorIds.map(id=>plan.contextSelectors.find(s=>s.id===id)!);
      const snapshot=await getCanonicalCaseSnapshot(store,tenantId,caseId,"CDD_ONBOARDING");
      const projected=await recordPolicySnapshotRead(store,projectCanonicalCaseSnapshot(snapshot!,selectors,plan.contextClassificationPolicies),gateNode.id,"CDD_ONBOARDING");
      return await executePolicyGate(plan,gateNode.id,projected,request=>evaluateStoredCaseGate({store,request:transformRequest?transformRequest(request):request,tenantId,authority})) as BusinessDecision;
    }
    return {tenantId,caseId,plan,authority,compiled,evaluate};
  }

  it.each([["approve","APPROVED"],["decline","DECLINED"]] as const)("applies installation %s without a fabricated human actor",async(mode,outcome)=>{
    const f=await fixture(mode);const decision=await f.evaluate();
    expect(decision.result.actions[0]).toMatchObject({payload:{outcome}});
    const view=await getCaseView(store,f.tenantId,f.caseId);expect(view?.case.status).toBe(outcome);
    expect(await verifyCaseLedger(store,f.tenantId,f.caseId)).toMatchObject({valid:true});
    const client=await store.db.connect();try{await client.query("begin");await client.query("select set_config('app.tenant_id',$1,true)",[f.tenantId]);
      const rows=await client.query("select authorized_actor from case_core.case_final_dispositions where tenant_id=$1 and case_id=$2",[f.tenantId,f.caseId]);
      expect(rows.rows[0].authorized_actor).toMatchObject({type:"SYSTEM",principalId:"policy-engine"});
    }finally{await client.query("rollback");client.release();}
  });
  it("refuses a policy-authorized approval while a material contradiction is open, but not a decline",async()=>{
    for(const [mode,blocked] of [["approve",true],["decline",false]] as const){
      const f=await fixture(mode);
      await submitBusinessCommand(store,{commandId:randomUUID(),commandType:"RaiseContradiction",commandVersion:"v1",tenantId:f.tenantId,caseId:f.caseId,
        actor:{type:"INTEGRATION",principalId:"fixture",roles:[]},authority:{planDigest:f.plan.planDigest,policySnapshotDigest:d,permissionEnvelopeDigest:d},
        payload:{objectRefs:["record:a","record:b"],description:"The two sources disagree on the date of birth.",materiality:"MATERIAL",detectionMethod:"fixture"},
        preconditions:{caseSequence:2},idempotencyKey:randomUUID()});
      if(blocked) await expect(f.evaluate()).rejects.toThrow("disposition.material_contradiction_open");
      else expect((await f.evaluate()).result.actions[0]).toMatchObject({payload:{outcome:"DECLINED"}});
    }
  });
  it("rejects every direct protected command before any gate has executed",async()=>{
    const f=await fixture();
    for(const commandType of PROTECTED_BUSINESS_COMMANDS)await expect(submitBusinessCommand(store,{commandId:randomUUID(),commandType,commandVersion:"v2",tenantId:f.tenantId,caseId:f.caseId,
      actor:{type:"HUMAN",principalId:"senior",roles:["KYC.SeniorReviewer"]},authority:{planDigest:f.plan.planDigest,policySnapshotDigest:d,permissionEnvelopeDigest:d},
      payload:{},preconditions:{caseSequence:2},idempotencyKey:randomUUID()})).rejects.toThrow("policy.action_grant_required");
  });
  it("commits human observations and requires fresh OPA authority for the effect",async()=>{
    const f=await fixture("human");const decision=await f.evaluate();expect(decision.result.state).toBe("NEEDS_HUMAN");
    const loaded=await getStoredBusinessDecision(store,f.tenantId,f.caseId,decision.decisionId);
    const respond=(name:string,roles=["Case.Reviewer"])=>recordBusinessHumanResponse(store,{tenantId:f.tenantId,caseId:f.caseId,decisionId:decision.decisionId,
      actor:{type:"HUMAN",principalId:name,roles},choice:{responseId:name,inputDigest:decision.inputDigest,requestDigest:loaded!.requestDigest,choice:"APPROVE",rationale:"Reviewed the original basis"}});
    await expect(respond("unauthorized",[])).rejects.toThrow("policy.human_role_required");
    expect(await respond("reviewer-a")).toMatchObject({readyForEvaluation:false});
    expect(await respond("reviewer-a")).toMatchObject({replayed:true});
    expect(await respond("reviewer-b")).toMatchObject({readyForEvaluation:true});
    expect((await getCaseView(store,f.tenantId,f.caseId))?.case.status).toBe("INTAKE");
    expect((await f.evaluate()).result).toMatchObject({state:"DECIDED",ruleIds:["human-approve"]});
    expect((await getCaseView(store,f.tenantId,f.caseId))?.case.status).toBe("APPROVED");
  });
  it("rolls the receipt, disposition, consumption and ledger back when a later action fails",async()=>{
    const f=await fixture("approve",{failAction:true});await expect(f.evaluate()).rejects.toThrow();
    const view=await getCaseView(store,f.tenantId,f.caseId);expect(view?.case).toMatchObject({status:"INTAKE",caseSequence:2});
    const rows=await admin.query("select count(*)::int n from case_core.business_decisions where tenant_id=$1",[f.tenantId]);expect(rows.rows[0].n).toBe(0);
  });
  it("refuses candidate authority and revoked bundles even when OPA would approve",async()=>{
    const candidate=await fixture("approve",{candidate:true});await expect(candidate.evaluate()).rejects.toThrow("policy.candidate_authority_forbidden");
    const f=await fixture();await revokeArtifactEntry(admin,{tenantId:f.tenantId,kind:"policy-bundle",digest:f.compiled.manifest.bundleDigest,actor:"security",reasonCode:"test"});
    await expect(f.evaluate()).rejects.toThrow("policy.released_authority_required");
    expect((await getCaseView(store,f.tenantId,f.caseId))?.case.caseSequence).toBe(2);
  });
  it.each([["US","individual"],["GB","individual"],["US","corporate"],["GB","corporate"]] as const)("enforces %s %s case scope through the shared gate",async(jurisdiction,customerType)=>{
    const f=await fixture("approve",{jurisdiction,customerType});
    expect((await f.evaluate()).scope).toMatchObject({jurisdiction,customerType});
    expect((await getCaseView(store,f.tenantId,f.caseId))?.case.status).toBe("APPROVED");
  });
  it.each([["individual","individual","CDD"],["corporate","company","CDD"]] as const)("derives a %s customer's diligence level in the released bundle and lists it for monitoring",async(customerType,partyType,level)=>{
    const f=await fixture("approve",{diligence:true,customerType});
    const decision=await f.evaluate();
    expect(decision.gateId).toBe("diligence-level");
    expect(decision.scope.legalForm).toBeTruthy();
    expect(decision.result).toMatchObject({state:"DECIDED",reasonCodes:[`DILIGENCE_LEVEL_${level}`],actions:[],outputs:{diligence:{level,partyType}}});
    // A level is a finding for later steps, not a disposition: the case does not move.
    expect((await getCaseView(store,f.tenantId,f.caseId))?.case.status).toBe("INTAKE");
    const listed=await listBusinessDecisionReceipts(store,f.tenantId,{gateId:"diligence-level"});
    expect(listed.receipts.map(receipt=>receipt.decisionId)).toEqual([decision.decisionId]);
    expect(summarizeDiligenceDecisions(listed.receipts,["SDD","CDD","EDD"])).toMatchObject({total:1,decided:1,byLevel:{[level]:1}});
    expect((await listBusinessDecisionReceipts(store,`other_${f.tenantId}`,{gateId:"diligence-level"})).receipts).toEqual([]);
    expect((await listBusinessDecisionReceipts(store,f.tenantId,{gateId:"diligence-level",customerTypes:[customerType]})).receipts).toHaveLength(1);
    expect((await listBusinessDecisionReceipts(store,f.tenantId,{gateId:"diligence-level",customerTypes:[customerType==="individual"?"corporate":"individual"]})).receipts).toEqual([]);
  });
  it("holds an automatic disposition for the approvals a diligence rule requires, and lets it through once people approve",async()=>{
    const f=await fixture("approve",{diligence:true,approval:true});
    // Before any diligence decision the approvals are unknown: the disposition stops rather than decides.
    expect((await f.evaluate(undefined,"pack-disposition")).result).toMatchObject({state:"UNRESOLVED",reasonCodes:["DILIGENCE_DECISION_MISSING"],actions:[]});
    const level=await f.evaluate();
    expect(level.result.outputs?.diligence.approvals).toEqual([{ruleId:"overlay.review-everyone",role:"Case.Reviewer",quorum:2,reason:"Two reviewers approve every relationship."}]);
    // The installation would approve automatically; the rule's approval turns that into a request for two reviewers.
    const held=await f.evaluate(undefined,"pack-disposition");
    expect(held.result).toMatchObject({state:"NEEDS_HUMAN",reasonCodes:["DILIGENCE_APPROVAL_REQUIRED"],actions:[],
      ruleIds:["automatic-approve","overlay.review-everyone"],humanRequirement:{roles:["Case.Reviewer"],quorum:2,actionIntents:{APPROVE:decided("APPROVED").actions}}});
    expect((await getCaseView(store,f.tenantId,f.caseId))?.case.status).toBe("INTAKE");
    const loaded=await getStoredBusinessDecision(store,f.tenantId,f.caseId,held.decisionId);
    for(const principalId of ["reviewer-a","reviewer-b"])await recordBusinessHumanResponse(store,{tenantId:f.tenantId,caseId:f.caseId,decisionId:held.decisionId,
      actor:{type:"HUMAN",principalId,roles:["Case.Reviewer"]},choice:{responseId:principalId,inputDigest:held.inputDigest,requestDigest:loaded!.requestDigest,choice:"APPROVE",rationale:"Reviewed the relationship"}});
    // The authored rule records the people's intent; the approved actions are exactly those they reviewed.
    const approved=await f.evaluate(undefined,"pack-disposition");
    expect(approved.result).toMatchObject({state:"DECIDED",ruleIds:["human-approve","overlay.review-everyone"],actions:decided("APPROVED").actions,humanIntent:{choice:"APPROVE"}});
    expect((await getCaseView(store,f.tenantId,f.caseId))?.case.status).toBe("APPROVED");
  });
  it("needs each approval role's own quorum: two reviewers and a senior reviewer, distinct people",async()=>{
    const f=await fixture("approve",{diligence:true,approval:true,seniorApproval:true});
    await f.evaluate();
    const held=await f.evaluate(undefined,"pack-disposition");
    expect(held.result).toMatchObject({state:"NEEDS_HUMAN",humanRequirement:{roles:["Case.Reviewer","KYC.SeniorReviewer"],quorum:3,roleQuorums:{"Case.Reviewer":2,"KYC.SeniorReviewer":1}}});
    const loaded=await getStoredBusinessDecision(store,f.tenantId,f.caseId,held.decisionId);
    const respond=(principalId:string,roles:string[])=>recordBusinessHumanResponse(store,{tenantId:f.tenantId,caseId:f.caseId,decisionId:held.decisionId,
      actor:{type:"HUMAN",principalId,roles},choice:{responseId:principalId,inputDigest:held.inputDigest,requestDigest:loaded!.requestDigest,choice:"APPROVE",rationale:"Reviewed"}});
    // A senior reviewer who is also a reviewer fills one slot only: three reviewers are not the panel.
    expect(await respond("reviewer-a",["Case.Reviewer"])).toMatchObject({readyForEvaluation:false});
    expect(await respond("dual-role",["Case.Reviewer","KYC.SeniorReviewer"])).toMatchObject({readyForEvaluation:false});
    expect(await respond("reviewer-b",["Case.Reviewer"])).toMatchObject({readyForEvaluation:true});
    const approved=await f.evaluate(undefined,"pack-disposition");
    expect(approved.result).toMatchObject({state:"DECIDED",humanIntent:{choice:"APPROVE"},ruleIds:expect.arrayContaining(["overlay.review-everyone","overlay.senior-sign-off"])});
    expect((await getCaseView(store,f.tenantId,f.caseId))?.case.status).toBe("APPROVED");
  });
  it("decides a securities case: offerings resolve through the published catalog and the gate takes the taxonomy's columns",async()=>{
    const product=(productId:string,ref:Record<string,string>)=>({productId,...ref,currencies:["USD"],countries:["US"],channels:["digital"],expectedActivity:null});
    const f=await fixture("approve",{diligence:true,customerType:"corporate",securities:{
      products:[product("p-prime",{offeringId:"prime-brokerage"}),product("p-custody",{canonicalProductId:"CUS.SAFEKEEPING.INSTITUTIONAL_CUSTODY"}),product("p-wealth",{offeringId:"managed-portfolios"})],
      // The fund is an underlying investor in the managed portfolio, not its customer: that product carries its own requirements.
      roles:[{productId:"p-wealth",role:"UNDERLYING_INVESTOR"}]}});
    const decision=await f.evaluate();
    expect(decision.scope).toMatchObject({institution:"securities.synthetic",customerType:"corporate",legalForm:"fund",products:["BRK.PRIME.INSTITUTIONAL","CUS.SAFEKEEPING.INSTITUTIONAL_CUSTODY"],
      relatedProducts:[{product:"WLT.WEALTH_MANAGEMENT.DISCRETIONARY",role:"UNDERLYING_INVESTOR"}]});
    expect(decision.result).toMatchObject({state:"DECIDED",ruleIds:["diligence.cell.fund.BRK.PRIME","diligence.cell.fund.CUS"],outputs:{diligence:{level:"CDD",partyType:"fund"}}});
    // The underlying investor's own requirements join the customer's, attributed to the role.
    const diligence=decision.result.outputs!.diligence;
    expect(diligence.requirements).toContain("EVD-SOURCE-OF-FUNDS");
    expect(diligence.requirementSources).toContainEqual({requirement:"EVD-SOURCE-OF-FUNDS",from:["diligence.role.UNDERLYING_INVESTOR"]});
    expect(diligence.screeningTypes).toEqual(["pep","sanctions"]);
  });
  it("stops a case naming a role the institution has no requirements for",async()=>{
    const product=(productId:string,ref:Record<string,string>)=>({productId,...ref,currencies:["USD"],countries:["US"],channels:["digital"],expectedActivity:null});
    const f=await fixture("approve",{diligence:true,customerType:"corporate",securities:{products:[product("p-prime",{offeringId:"prime-brokerage"}),product("p-other",{offeringId:"cash-brokerage"})],
      roles:[{productId:"p-other",role:"COUNTERPARTY"}]}});
    // The securities design lists counterparties; the bank's lists only authorised users.
    expect((await f.evaluate()).result.state).toBe("DECIDED");
    const bank=(role:string)=>fixture("approve",{diligence:true,bankRoles:[{productId:"h01.product.card",role}]});
    const counterparty=await (await bank("COUNTERPARTY")).evaluate();
    expect(counterparty.scope).toMatchObject({products:["deposit"],relatedProducts:[{product:"card",role:"COUNTERPARTY"}]});
    expect(counterparty.result).toMatchObject({state:"UNRESOLVED",gaps:[{code:"DILIGENCE_ROLE_REQUIREMENTS_MISSING",path:"/scope/relatedProducts/card",subjectId:null}]});
    expect((await (await bank("AUTHORIZED_USER")).evaluate()).result.state).toBe("DECIDED");
  });
  it("decides a bank debit-card offering under the card column, through the published catalog",async()=>{
    const product=(productId:string,ref:Record<string,string>)=>({productId,...ref,currencies:["USD"],countries:["US"],channels:["online"],expectedActivity:null});
    const f=await fixture("approve",{diligence:true,bankProducts:[product("p-deposit",{productType:"deposit"}),product("p-debit",{offeringId:"debit-card"})]});
    const decision=await f.evaluate();
    expect(decision.scope.products).toEqual(["PAY.CARDS.DEBIT","deposit"]);
    expect(decision.result).toMatchObject({state:"DECIDED",outputs:{diligence:{level:"CDD",partyType:"individual"}}});
    expect(decision.result.ruleIds).toContain("diligence.cell.individual.card");
  });
  it("reads the relationship's risk tier as the assessed risk, and leaves an unknown tier unknown",async()=>{
    const high=await fixture("approve",{diligence:true,riskTier:"HIGH",assessedRiskRule:true});
    expect((await high.evaluate()).result).toMatchObject({state:"DECIDED",outputs:{diligence:{level:"EDD"}}});
    expect((await high.evaluate()).result.ruleIds).toContain("overlay.assessed-high-risk");
    const low=await fixture("approve",{diligence:true,riskTier:"LOW",assessedRiskRule:true});
    expect((await low.evaluate()).result).toMatchObject({state:"DECIDED",outputs:{diligence:{level:"CDD"}}});
    const unknown=await fixture("approve",{diligence:true,riskTier:"UNKNOWN",assessedRiskRule:true});
    expect((await unknown.evaluate()).result).toMatchObject({state:"UNRESOLVED",gaps:[{code:"DILIGENCE_INPUT_MISSING",path:"/facts/assessedRisk/tier",subjectId:null}]});
  });
  it("gives every later gate the diligence decision: level, requirements and screening types",async()=>{
    const f=await fixture("approve",{diligence:true});
    // Before the diligence gate decides, the fact is absent.
    const before=await f.evaluate(undefined,"pack-decision-ready");
    expect((await admin.query("select input from case_core.business_decisions where tenant_id=$1 and decision_id=$2",[f.tenantId,before.decisionId])).rows[0].input.facts.diligence).toBeUndefined();
    const level=await f.evaluate();
    const after=await f.evaluate(undefined,"pack-decision-ready");
    const input=(await admin.query("select input from case_core.business_decisions where tenant_id=$1 and decision_id=$2",[f.tenantId,after.decisionId])).rows[0].input;
    expect(input.facts.diligence).toMatchObject({decisionId:level.decisionId,level:"CDD",requirements:level.result.outputs!.diligence.requirements,screeningTypes:["pep","sanctions"],approvals:[]});
  });
  it("stops a securities case whose offering does not resolve, rather than defaulting it",async()=>{
    const product=(productId:string,ref:Record<string,string>)=>({productId,...ref,currencies:["USD"],countries:["US"],channels:["digital"],expectedActivity:null});
    const unknown=await fixture("approve",{diligence:true,customerType:"corporate",securities:{products:[product("p-1",{offeringId:"no-such-offering"})]}});
    await expect(unknown.evaluate()).rejects.toThrow("policy.product_unresolved:p-1");
    // Without a published catalog the institution's offerings cannot resolve either.
    const unpublished=await fixture("approve",{diligence:true,customerType:"corporate",securities:{products:[product("p-1",{offeringId:"prime-brokerage"})],publishCatalog:false}});
    await expect(unpublished.evaluate()).rejects.toThrow("policy.product_unresolved:p-1");
  });
  it("replays consumption without another effect, and refuses a caller importing the grant",async()=>{
    const f=await fixture();const decision=await f.evaluate();
    const input=(await admin.query("select input from case_core.business_decisions where tenant_id=$1 and decision_id=$2",[f.tenantId,decision.decisionId])).rows[0].input;
    expect(await applyEvaluatedBusinessDecision(store,decision,f.authority.execution,input)).toMatchObject({replayed:true});
    const grant={apiVersion:"harness.factory/business-action-grant-v2" as const,decisionId:decision.decisionId,decisionDigest:decision.receiptDigest,actionIndex:0,actionDigest:stableDigest(decision.result.actions[0])};
    await expect(submitBusinessCommand(store,{commandId:randomUUID(),commandType:"FinalizeDisposition",commandVersion:"v2",tenantId:f.tenantId,caseId:f.caseId,
      actor:{type:"HUMAN",principalId:"reviewer",roles:["KYC.SeniorReviewer"]},authority:{planDigest:f.plan.planDigest,policySnapshotDigest:d,permissionEnvelopeDigest:d,businessActionGrant:grant},
      payload:{outcome:"DECLINED"},preconditions:{caseSequence:4},idempotencyKey:randomUUID()})).rejects.toThrow("policy.grant_import_forbidden");
    expect((await admin.query("select count(*)::int n from case_core.case_final_dispositions where tenant_id=$1",[f.tenantId])).rows[0].n).toBe(1);
  });
  it("adopts only the exact canonical version in the evaluated profile",async()=>{
    const f=await fixture("approve",{adoptionVersion:"v1"});await f.evaluate();
    const snapshot=await getCanonicalCaseSnapshot(store,f.tenantId,f.caseId,"CDD_ONBOARDING");
    expect(snapshot?.data.adoptedAssessments).toMatchObject([{object_type:"BankingRelationship",object_id:"relationship",version_id:"v1",interpretation:"product.eligibility",value:"READY"}]);
    expect((await getCaseView(store,f.tenantId,f.caseId))?.case.status).toBe("INTAKE");
    const invalid=await fixture("approve",{adoptionVersion:"unseen-version"});
    await expect(invalid.evaluate()).rejects.toThrow("policy.adoption_outside_input_profile");
    expect((await getCaseView(store,invalid.tenantId,invalid.caseId))?.case.caseSequence).toBe(2);
  });
  it("allows policy-directed evidence work without approving or declining incomplete data",async()=>{
    const f=await fixture("approve",{collect:true});expect((await f.evaluate()).result.state).toBe("NEEDS_EVIDENCE");
    const snapshot=await getCanonicalCaseSnapshot(store,f.tenantId,f.caseId,"CDD_ONBOARDING");
    expect(snapshot?.data.workItems).toMatchObject([{work_item_id:"collect-identity",work_type:"COLLECT_IDENTITY",status:"OPEN"}]);
    expect((await getCaseView(store,f.tenantId,f.caseId))?.case.status).toBe("INTAKE");
  });
  it("serializes concurrent decisions on one case",async()=>{
    const f=await fixture();const attempts=await Promise.allSettled([f.evaluate(),f.evaluate()]);
    const completed=attempts.filter(result=>result.status==="fulfilled");expect(completed.length).toBeGreaterThanOrEqual(1);
    if(completed.length===2)expect(completed[0]!.value.decisionId).toBe(completed[1]!.value.decisionId);
    expect((await admin.query("select count(*)::int n from case_core.business_decisions where tenant_id=$1",[f.tenantId])).rows[0].n).toBe(1);
  });
  it("never sends an external effect before checking its current released authority",async()=>{
    const f=await fixture("approve",{external:true});const decision=await f.evaluate();let calls=0;
    const request={tenantId:f.tenantId,caseId:f.caseId,decisionId:decision.decisionId,actionIndex:0,adapters:{"regulatory.filing.submit":async(input:{idempotencyKey:string})=>{
      calls++;expect(input.idempotencyKey).toMatch(/^effect_[a-f0-9]{64}$/);return {status:"DELIVERED" as const,providerReceipt:{id:"provider-receipt"}};}}};
    const concurrent=await Promise.all([dispatchBusinessEffect(store,request),dispatchBusinessEffect(store,request)]);
    expect(concurrent).toEqual(expect.arrayContaining([expect.objectContaining({status:"DELIVERED"})]));
    expect(await dispatchBusinessEffect(store,request)).toMatchObject({status:"DELIVERED",replayed:true});expect(calls).toBe(1);
    const revoked=await fixture("approve",{external:true});const next=await revoked.evaluate();
    await revokeArtifactEntry(admin,{tenantId:revoked.tenantId,kind:"policy-bundle",digest:revoked.compiled.manifest.bundleDigest,actor:"security",reasonCode:"test"});
    expect(await dispatchBusinessEffect(store,{...request,tenantId:revoked.tenantId,caseId:revoked.caseId,decisionId:next.decisionId})).toMatchObject({status:"CANCELLED"});expect(calls).toBe(1);
  });
  it("parks ambiguous external delivery for reconciliation instead of blindly retrying",async()=>{
    const f=await fixture("approve",{external:true});const decision=await f.evaluate();let calls=0;
    const input={tenantId:f.tenantId,caseId:f.caseId,decisionId:decision.decisionId,actionIndex:0,adapters:{"regulatory.filing.submit":async()=>{calls++;throw new Error("ambiguous provider timeout");}}};
    expect(await dispatchBusinessEffect(store,input)).toMatchObject({status:"RECONCILIATION"});
    expect(await dispatchBusinessEffect(store,input)).toMatchObject({status:"RECONCILIATION",replayed:true});expect(calls).toBe(1);
  });
  it("binds a post-human effect to the exact actions the people reviewed",async()=>{
    const f=await fixture("human",{alteredHumanIntent:true});const decision=await f.evaluate();const view=await getStoredBusinessDecision(store,f.tenantId,f.caseId,decision.decisionId);
    for(const principalId of ["one","two"])await recordBusinessHumanResponse(store,{tenantId:f.tenantId,caseId:f.caseId,decisionId:decision.decisionId,
      actor:{type:"HUMAN",principalId,roles:["Case.Reviewer"]},choice:{responseId:principalId,inputDigest:decision.inputDigest,requestDigest:view!.requestDigest,choice:"APPROVE",rationale:"Reviewed approval intent"}});
    await expect(f.evaluate()).rejects.toThrow("policy.human_action_intent_mismatch");
    expect((await getCaseView(store,f.tenantId,f.caseId))?.case.status).toBe("INTAKE");
  });

  it("requires a server-issued snapshot read and cannot move its clock to hide newer evidence",async()=>{
    const f=await fixture();
    await expect(f.evaluate(request=>{const {readReceiptId:_proof,...snapshot}=request.snapshot;return {...request,snapshot};})).rejects.toThrow("policy.snapshot_read_proof_required");
    await expect(f.evaluate(request=>({...request,snapshot:{...request.snapshot,capturedAt:new Date(Date.now()-1000).toISOString()}}))).rejects.toThrow("policy.snapshot_read_proof_invalid");
    expect((await getCaseView(store,f.tenantId,f.caseId))?.case.caseSequence).toBe(2);
  });

  it("parks the gate with its authored requirement and re-arms it instead of completing from a human choice",async()=>{
    const f=await fixture("human"),decision=await f.evaluate(),now=new Date().toISOString(),workItemId="work_"+randomUUID();
    const actor={type:"SYSTEM" as const,principalId:"runtime-worker",roles:[]};
    await createExecutionWorkItem(admin,executionWorkItemSchema.parse({apiVersion:"harness.factory/execution-work-item-v1",kind:"ExecutionWorkItem",
      tenantId:f.tenantId,caseId:f.caseId,workItemId,workType:"gate",capabilityId:null,assuranceClass:"HIGH",revision:0,caseSequenceBasis:2,
      planDigest:f.plan.planDigest,policyContextRef:"test",schemaVersion:"work.v1",objective:"Policy disposition",subjectRefs:[],requiredOutputs:[],
      constraints:{runId:f.authority.execution.run_id,nodeId:"pack-disposition"},dependencyIds:[],dependencyDigest:stableDigest([]),invalidationPolicy:"BLOCK",
      status:"RUNNING",reasonCode:"running",priority:1,readyAt:null,deadlineAt:null,terminalAt:null,dispatch:{generation:0,queue:"policy",publishedAt:null,brokerMessageId:null},
      lease:{executionId:"gate-execution",owner:"worker",fencingEpoch:1,attemptNumber:1,leaseUntil:new Date(Date.now()+300000).toISOString()},
      limits:{maxAttempts:2,maxReworkCycles:1,maxDurationMs:60000,maxCostUsd:1,maxModelCalls:1,maxCapabilityCalls:1},result:null,createdBy:actor,transitionSequence:0,traceId:null,createdAt:now,updatedAt:now}));
    await requestHumanExecutionDecision(admin,{tenantId:f.tenantId,workItemId,executionId:"gate-execution",fencingEpoch:1,actor,policyDecision:decision});
    const queue=await listHumanWorkQueue(admin,f.tenantId,{caseId:f.caseId});expect(queue[0]).toMatchObject({requiredApprovals:2,policyDecision:{decisionId:decision.decisionId}});
    const legacy={decisionId:randomUUID(),tenantId:f.tenantId,caseId:f.caseId,workItemId,principalId:"operator",decision:"APPROVE",reasonCode:"test",rationale:"test",evidenceRefs:[],decidedAt:now};
    await expect(submitHumanWorkDecision(admin,legacy)).rejects.toThrow("policy.post_human_gate_required");
    await expect(resolveHumanWorkConflict(admin,legacy)).rejects.toThrow("policy.post_human_gate_required");
    await admin.query("update harness_runtime.runs set status='manual_review' where tenant_id=$1 and run_id=$2",[f.tenantId,f.authority.execution.run_id]);
    await resumePolicyHumanWork(admin,{tenantId:f.tenantId,workItemId,decisionId:decision.decisionId,actor:{type:"HUMAN",principalId:"reviewer",roles:["Case.Reviewer"]}});
    expect((await getExecutionWorkItem(admin,f.tenantId,workItemId))?.status).toBe("READY");
    expect((await admin.query("select status from harness_runtime.runs where run_id=$1",[f.authority.execution.run_id])).rows[0].status).toBe("queued");
    expect((await getCaseView(store,f.tenantId,f.caseId))?.case.status).toBe("INTAKE");
  });

});
