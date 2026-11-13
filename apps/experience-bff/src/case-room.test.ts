import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {validateResponse} from '@ehf/ui-contracts/validate';
import {buildApp} from './app.js';
import {caseEvidence,caseFindings,roomEvents,roomStages} from './case-room.js';
import type {Upstream} from './upstream.js';

const item=(taskId:string|undefined,status:string,outcome?:string,agentId?:string)=>({work_item_id:`${taskId}-${status}`,status,constraints:taskId?{taskId,agentId}:{},outcome:outcome?{status:outcome}:undefined});

it('lists the stages in the domain order, pending where the case has no work, and hides nothing recorded',()=>{
  const stages=roomStages([
    item('task.identity_ownership','COMPLETED','NEEDS_REVIEW','agent.identity_ownership'),
    item('task.identity_ownership','WAITING_HUMAN'),
    item('task.intake_profile','COMPLETED','COMPLETED','agent.intake_profile'),
    item('task.document_intelligence','COMPLETED','COMPLETED','agent.document_intelligence'),
    item('task.periodic_review','RUNNING',undefined,'agent.periodic_review'),
    item(undefined,'RUNNING'),
  ],id=>id==='agent.periodic_review'?'Periodic review':undefined);
  expect(stages.map(stage=>[stage.taskId,stage.label,stage.status])).toEqual([
    ['task.intake_profile','Intake & profile','done'],
    ['task.identity_ownership','Identity & ownership','needs_review'],
    ['task.screening','Screening','pending'],
    ['task.risk_edd','Risk & EDD','pending'],
    ['task.qa_assurance','QA & assurance','pending'],
    ['task.decision_support','Decision','pending'],
    ['task.periodic_review','Periodic review','current'],
  ]);
  expect(stages.every(stage=>stage.agentId)).toBe(true);
});

it('never reads stopped, unfinished or evidence-short work as done',()=>{
  const status=(...items:ReturnType<typeof item>[])=>roomStages(items,undefined,[{taskId:'t',label:'T',agentId:'a'}])[0]!.status;
  expect(status(item('t','COMPLETED'),item('t','FAILED'))).toBe('blocked');
  expect(status(item('t','COMPLETED','NEEDS_EVIDENCE'))).toBe('needs_evidence');
  expect(status(item('t','COMPLETED','PARTIAL'))).toBe('needs_review');
  expect(status(item('t','COMPLETED'),item('t','RUNNING'))).toBe('current');
  expect(status(item('t','CANCELLED'))).toBe('current');
  expect(status(item('t','COMPLETED'),item('t','CANCELLED'))).toBe('done');
});

it('lists the latest events newest first and drops rows it cannot date or attribute',()=>{
  const actor={principalId:'svc',type:'SERVICE'};
  const rows=roomEvents([
    {caseSequence:1,eventType:'CaseCreated',occurredAt:'2026-11-08T10:00:00Z',actor},
    {caseSequence:2,eventType:'CaseStatusTransitioned',occurredAt:null,recordedAt:'2026-11-08T10:01:00Z',actor},
    {caseSequence:3,eventType:'Undated',occurredAt:null,recordedAt:null,actor},
  ]);
  expect(rows.map(row=>[row.sequence,row.summary])).toEqual([[2,'Case status transitioned'],[1,'Case created']]);
});

const digest='a'.repeat(64);
const snapshot={caseId:'case-test',tenantId:'tenant-verified',caseSequence:9,snapshotDigest:digest,planDigest:digest,
  policyAuthority:{policyId:'policy-test',policyVersion:'1.0.0',policySnapshotDigest:digest,policyBundleDigest:digest},
  data:{case:{caseType:'kyc_onboarding',jurisdiction:'US',status:'INVESTIGATING'},records:{},subjects:[],evidence:[],reviews:[],
    workItems:[{work_item_id:'w1',work_type:'intake',status:'COMPLETED',updated_at:'2026-11-08T10:00:00Z',constraints:{taskId:'task.intake_profile',agentId:'agent.intake_profile'},outcome:{status:'COMPLETED'}}]}};
const events=[8,9].map(sequence=>({caseSequence:sequence,eventType:'WorkItemCompleted',occurredAt:'2026-11-08T10:00:00Z',actor:{principalId:'agent.intake_profile',type:'AGENT',roles:[]}}));
const catalog=JSON.parse(readFileSync(new URL('../../fincrime-host/docs/ui/contracts/fixtures/catalogs.json',import.meta.url),'utf8'));

async function room(roles:string[],eventStatus=200) {
  const upstream=vi.fn<Upstream>(async(_s,_m,path)=>path.includes('/events')?{status:eventStatus,body:eventStatus===200?{events,nextCursor:null}:{error:'x'}}:{status:200,body:path.startsWith('/v1/operations/human-work')?{items:[]}:snapshot});
  const app=buildApp({catalogSource:()=>catalog,principalResolver:{source:'local',resolve:async()=>({subjectId:'u',tenantId:'tenant-verified',actorType:'human',roles,source:'local'}) as never},upstream});
  try {
    const response=await app.inject('/api/v1/fincrime/cases/case-test/room');
    expect(response.statusCode,response.body).toBe(200);
    expect(validateResponse('getFincrimeCasesCaseIdRoom',200,response.json()).valid).toBe(true);
    return {body:response.json(),paths:upstream.mock.calls.map(call=>call[2])};
  }finally{await app.close();}
}

it('serves stages to every reader and recent events to callers who may read the event log',async()=>{
  const analyst=await room(['Case.Analyst']);
  expect(analyst.body.stages).toHaveLength(6);
  expect(analyst.body.stages[0]).toEqual({taskId:'task.intake_profile',label:'Intake & profile',agentId:'agent.intake_profile',status:'done'});
  expect(analyst.body.stages.slice(1).every((stage:{status:string})=>stage.status==='pending')).toBe(true);
  expect(analyst.body.recentEvents.map((event:{sequence:number})=>event.sequence)).toEqual([9,8]);
  expect(analyst.paths.find(path=>path.includes('/events'))).toContain('limit=6&after=3');
  expect(analyst.paths.some(path=>path.startsWith('/v1/operations/human-work'))).toBe(true);

  const holdOfficer=await room(['Legal.HoldOfficer']);
  expect(holdOfficer.body.stages).toHaveLength(6);
  expect(holdOfficer.body.recentEvents).toEqual([]);
  expect(holdOfficer.paths.some(path=>path.includes('/events')||path.startsWith('/v1/operations/human-work'))).toBe(false);
});

it('lets an analyst open claims and the decision desk, which read the event log',async()=>{
  const upstream=vi.fn<Upstream>(async(_s,_m,path)=>path.includes('/events')?{status:200,body:{events:[],nextCursor:null}}:{status:200,body:path.startsWith('/v1/operations/human-work')?{items:[]}:snapshot});
  const app=buildApp({catalogSource:()=>catalog,principalResolver:{source:'local',resolve:async()=>({subjectId:'u',tenantId:'tenant-verified',actorType:'human',roles:['Case.Analyst'],source:'local'}) as never},upstream});
  try {
    for(const [operation,path] of [['getFincrimeCasesCaseIdClaims','claims'],['getFincrimeCasesCaseIdDecision','decision']] as const) {
      const response=await app.inject(`/api/v1/fincrime/cases/case-test/${path}`);
      expect(response.statusCode,response.body).toBe(200);
      expect(validateResponse(operation,200,response.json()).valid).toBe(true);
    }
  }finally{await app.close();}
});

it('keeps the room up when the event log cannot be read',async()=>{
  const analyst=await room(['Case.Analyst'],503);
  expect(analyst.body.recentEvents).toEqual([]);
  expect(analyst.body.stages).toHaveLength(6);
});

const evidenceRow=(id:string,extra:object={})=>({evidence_id:id,evidence_type:'REGISTRY_EXTRACT',source:{type:'TOOL',dataset:'companies-registry',retrievedAt:'2026-11-08T09:00:00Z'},subject_refs:['acme'],
  raw_digest:'sha256:'+'b'.repeat(64),classification:'CONFIDENTIAL',scan_status:'POC_NOT_SCANNED',verification_status:'DIGEST_VERIFIED',created_by:{principalId:'agent.identity_ownership',type:'AGENT',roles:[]},created_at:'2026-11-08T09:00:01Z',...extra});

it('lists registered evidence with what cites it and the document it holds, and drops rows it cannot date',()=>{
  const items=caseEvidence({
    evidence:[evidenceRow('ev-1'),evidenceRow('ev-2',{evidence_type:'DOCUMENT',source:{type:'UPLOAD',retrievedAt:'2026-11-08T09:05:00Z'}}),evidenceRow('ev-3',{created_at:null})],
    claims:[{claim_id:'c-1',evidence_refs:['ev-1']}],facts:[{fact_id:'f-1',evidence_refs:['ev-1','ev-2']}],contradictions:[{contradiction_id:'cf-1',evidence_refs:[]}],
  },[{documentId:'doc-9',evidenceId:'ev-2'}]);
  expect(items.map(item=>item.evidenceId)).toEqual(['ev-1','ev-2']);
  expect(items[0]).toMatchObject({evidenceType:'REGISTRY_EXTRACT',citedBy:['c-1','f-1'],documentId:null,integrity:'DIGEST_VERIFIED',source:{type:'TOOL',dataset:'companies-registry',sourceEffectiveAt:null}});
  expect(items[1]).toMatchObject({citedBy:['f-1'],documentId:'doc-9',source:{type:'UPLOAD',dataset:null}});
});

it('serves the case evidence list to case roles and refuses a role without evidence.read',async()=>{
  const withEvidence={...snapshot,data:{...snapshot.data,evidence:[evidenceRow('ev-1')],claims:[{claim_id:'c-1',evidence_refs:['ev-1']}]}};
  const serve=async(roles:string[])=>{
    const upstream=vi.fn<Upstream>(async()=>({status:200,body:withEvidence}));
    const app=buildApp({catalogSource:()=>catalog,principalResolver:{source:'local',resolve:async()=>({subjectId:'u',tenantId:'tenant-verified',actorType:'human',roles,source:'local'}) as never},upstream});
    try{return await app.inject('/api/v1/fincrime/cases/case-test/evidence');}finally{await app.close();}
  };
  const analyst=await serve(['Case.Analyst']);
  expect(analyst.statusCode,analyst.body).toBe(200);
  expect(validateResponse('getFincrimeCasesCaseIdEvidence',200,analyst.json()).valid).toBe(true);
  expect(analyst.json().items).toMatchObject([{evidenceId:'ev-1',citedBy:['c-1']}]);
  expect((await serve(['Legal.HoldOfficer'])).statusCode).toBe(403);
});

const agent={principalId:'agent.identity_ownership',type:'AGENT',roles:[]};
const reviewer={principalId:'s.varga',type:'HUMAN',roles:[]};
const registry={
  contradictions:[
    {contradiction_id:'cf-1',object_refs:['bram','acme'],description:'Declaration and register disagree on Bram Okoro',materiality:'HIGH',detection_method:'reconciliation',status:'OPEN',created_by:agent,created_at:'2026-11-08T09:00:00Z',updated_at:'2026-11-08T09:00:00Z'},
    {contradiction_id:'cf-2',object_refs:['alice'],description:'Two addresses',materiality:'LOW',detection_method:'reconciliation',status:'RESOLVED',resolution:{rationale:'Register is authoritative.'},created_by:agent,created_at:'2026-11-08T09:01:00Z',updated_at:'2026-11-08T10:00:00Z'},
  ],
  findings:[
    {finding_id:'f-1',finding_type:'SCREENING',subject_ref:'bram',reason:'Possible sanctions match',policy_relevance:'sanctions',status:'ACTIVE',evidence_refs:['ev-1'],created_by:agent,created_at:'2026-11-08T09:02:00Z'},
    {finding_id:'f-2',finding_type:'SCREENING',subject_ref:'chen',reason:'Possible PEP match',status:'ACTIVE',evidence_refs:[],created_by:agent,created_at:'2026-11-08T09:03:00Z'},
    {finding_id:'f-3',finding_type:'SCREENING',reason:'Undated',status:'ACTIVE',created_by:agent,created_at:null},
  ],
  reviews:[
    {review_id:'r-2',review_type:'FINDING_DISPOSITION',outcome:'FALSE_MATCH',object_ref:'f-2',rationale:'Different date of birth.',reviewer,created_at:'2026-11-08T11:00:00Z'},
    {review_id:'r-1',review_type:'SEMANTIC_QA',outcome:'PASS',object_ref:'rec-1',rationale:'ok',reviewer,created_at:'2026-11-08T10:30:00Z'},
    {review_id:'r-3',review_type:'FINDING_DISPOSITION',outcome:'CONFIRMED',object_ref:'cf-2',rationale:'Checked the register.',reviewer,created_at:'2026-11-08T10:30:00Z'},
  ],
};

it('lists contradictions and findings under their stored ids with what was recorded against them',()=>{
  const items=caseFindings(registry);
  expect(items.map(item=>[item.findingId,item.kind,item.state,item.severity])).toEqual([
    ['cf-1','contradiction','open','HIGH'],['cf-2','contradiction','resolved','LOW'],['f-1','finding','open','sanctions'],['f-2','finding','dispositioned',null],
  ]);
  expect(items[0]).toMatchObject({subjectRefs:['bram','acme'],dispositions:[],raisedBy:agent});
  // A contradiction's history: its resolution and any review of it, oldest first; no actor is invented for the resolution.
  expect(items[1]!.dispositions).toEqual([
    {id:'cf-2:resolution',source:'resolution',outcome:'RESOLVED',rationale:'Register is authoritative.',by:null,at:'2026-11-08T10:00:00.000Z'},
    {id:'r-3',source:'review',outcome:'CONFIRMED',rationale:'Checked the register.',by:reviewer,at:'2026-11-08T10:30:00.000Z'},
  ]);
  // A finding is dispositioned only by a review of that finding; a review of something else does not count.
  expect(items[2]).toMatchObject({findingType:'SCREENING',evidenceIds:['ev-1'],dispositions:[]});
  expect(items[3]!.dispositions).toMatchObject([{id:'r-2',outcome:'FALSE_MATCH',by:reviewer}]);
});

it('says where each finding is dispositioned, and allows it here only for an open non-screening finding and a reviewer',()=>{
  const data={...registry,findings:[...registry.findings,{finding_id:'f-9',finding_type:'DOCUMENT_VALIDITY',reason:'Statement is out of date',status:'ACTIVE',evidence_refs:[],created_by:agent,created_at:'2026-11-08T09:04:00Z'}]};
  const allowed=(canReview:boolean)=>Object.fromEntries(caseFindings(data,canReview).map(item=>[item.findingId,item.disposition.allowed]));
  expect(allowed(true)).toEqual({'cf-1':false,'cf-2':false,'f-1':false,'f-2':false,'f-9':true});
  expect(allowed(false)['f-9']).toBe(false);
  const reason=(id:string)=>caseFindings(data,true).find(item=>item.findingId===id)!.disposition.reason;
  expect(reason('cf-1')).toContain('resolving');
  expect(reason('f-1')).toContain('screening workspace');
  expect(reason('f-2')).toContain('already');
  expect(caseFindings(data,false).find(item=>item.findingId==='f-9')!.disposition.reason).toContain('case.review');
});

it('records a reviewer disposition as a RecordReview against the finding, and refuses everything else',async()=>{
  const data={...snapshot.data,...registry,evidence:[evidenceRow('ev-1')],findings:[...registry.findings,{finding_id:'f-9',finding_type:'DOCUMENT_VALIDITY',reason:'Statement is out of date',status:'ACTIVE',evidence_refs:['ev-1'],created_by:agent,created_at:'2026-11-08T09:04:00Z'}]};
  const body={outcome:'NOT_SUBSTANTIATED',rationale:'The statement is within the accepted window.',viewedEvidenceIds:['ev-1'],expectedCaseSequence:9,idempotencyKey:'k-1'};
  const post=async(roles:string[],findingId:string,payload:object,csrf=true)=>{
    // The case store refuses a command on a stale sequence that it holds no receipt for.
    const upstream=vi.fn<Upstream>(async(_s,method,_path,_p,command:any)=>method==='POST'?command.preconditions.caseSequence===snapshot.caseSequence?{status:200,body:{outcome:'ACCEPTED',commandId:'cmd_1',caseSequence:10,eventIds:[],reasonCode:null}}:{status:409,body:{error:'command.case_sequence_conflict'}}:{status:200,body:{...snapshot,data}});
    const app=buildApp({catalogSource:()=>catalog,principalResolver:{source:'local',resolve:async()=>({subjectId:'s.varga',tenantId:'tenant-verified',actorType:'human',roles,source:'local'}) as never},upstream});
    try{
      const session=await app.inject('/api/v1/session');
      const token=session.json().csrfToken;const cookie=session.headers['set-cookie'];
      const response=await app.inject({method:'POST',url:`/api/v1/fincrime/cases/case-test/findings/${findingId}/dispositions`,payload,headers:{origin:'http://localhost:80',cookie:String(cookie).split(';')[0]!,...(csrf?{'x-csrf-token':token}:{})}});
      return {response,commands:upstream.mock.calls.filter(call=>call[1]==='POST').map(call=>call[4] as any)};
    }finally{await app.close();}
  };
  const accepted=await post(['Case.Reviewer'],'f-9',body);
  expect(accepted.response.statusCode,accepted.response.body).toBe(200);
  expect(accepted.commands).toHaveLength(1);
  expect(accepted.commands[0]).toMatchObject({commandType:'RecordReview',preconditions:{caseSequence:9},actor:{type:'HUMAN',principalId:'s.varga'},
    payload:{reviewType:'FINDING_DISPOSITION',outcome:'NOT_SUBSTANTIATED',objectRef:'f-9',rationale:body.rationale,viewedEvidenceRefs:['ev-1']}});

  const refused=async(roles:string[],findingId:string,payload:object,status:number,error:string,csrf=true)=>{
    const result=await post(roles,findingId,payload,csrf);
    expect(result.response.statusCode,result.response.body).toBe(status);
    expect(result.response.json().error).toBe(error);
    expect(result.commands).toHaveLength(0);
  };
  await refused(['Case.Analyst'],'f-9',body,403,'authorization.role_missing');
  await refused(['Case.Reviewer'],'f-9',body,403,'csrf.invalid',false);
  await refused(['Case.Reviewer'],'cf-1',body,409,'finding.disposition_not_allowed');
  await refused(['Case.Reviewer'],'f-1',body,409,'finding.disposition_not_allowed');
  await refused(['Case.Reviewer'],'f-2',body,409,'finding.disposition_not_allowed');
  await refused(['Case.Reviewer'],'missing',body,404,'finding.not_found');
  await refused(['Case.Reviewer'],'f-9',{...body,rationale:''},400,'finding.disposition_invalid');
  await refused(['Case.Reviewer'],'f-9',{...body,outcome:'APPROVED'},400,'finding.disposition_invalid');
  await refused(['Case.Reviewer'],'f-9',{...body,viewedEvidenceIds:['ev-elsewhere']},409,'finding.evidence_not_on_case');
  // A stale disposition goes to the case store as sent, so a replay can be answered from its receipt; a new one is refused.
  const stale=await post(['Case.Reviewer'],'f-9',{...body,expectedCaseSequence:8});
  expect(stale.response.statusCode).toBe(409);expect(stale.response.json().error).toBe('case.sequence_conflict');
  expect(stale.commands.map(command=>command.preconditions)).toEqual([{caseSequence:8}]);
});

it('serves the findings registry to case readers',async()=>{
  const withFindings={...snapshot,data:{...snapshot.data,...registry}};
  const upstream=vi.fn<Upstream>(async()=>({status:200,body:withFindings}));
  const app=buildApp({catalogSource:()=>catalog,principalResolver:{source:'local',resolve:async()=>({subjectId:'u',tenantId:'tenant-verified',actorType:'human',roles:['Case.Analyst'],source:'local'}) as never},upstream});
  try{
    const response=await app.inject('/api/v1/fincrime/cases/case-test/findings');
    expect(response.statusCode,response.body).toBe(200);
    expect(validateResponse('getFincrimeCasesCaseIdFindings',200,response.json()).valid).toBe(true);
    expect(response.json().items).toHaveLength(4);
  }finally{await app.close();}
});

const stored={caseId:'case-test',teamId:'kyb-onboarding',teamName:'KYB onboarding',assignees:['r.okafor'],reason:'Onboarding intake',assignedBy:{principalId:'m.castillo',type:'HUMAN',roles:[]},assignedAt:'2026-11-08T03:01:00.000Z'};
const assignmentApp=(roles:string[],assignmentStatus=200)=>{
  const upstream=vi.fn<Upstream>(async(_s,method,path,_p,command:any)=>{
    if(method==='POST')return command.preconditions.caseSequence===snapshot.caseSequence?{status:200,body:{outcome:'ACCEPTED',commandId:'cmd_1',caseSequence:10,eventIds:[],reasonCode:null}}:{status:409,body:{error:'command.case_sequence_conflict'}};
    if(path.endsWith('/assignment'))return {status:assignmentStatus,body:assignmentStatus===200?{assignment:stored}:{error:'x'}};
    if(path.startsWith('/v1/case-teams'))return {status:200,body:{teams:[{teamId:'kyb-onboarding',name:'KYB onboarding',members:['r.okafor','d.patel'],updatedAt:'2026-11-08T03:00:00Z'}]}};
    if(path.startsWith('/v1/operations/human-work'))return {status:200,body:{items:[]}};
    return {status:200,body:snapshot};
  });
  const app=buildApp({catalogSource:()=>catalog,principalResolver:{source:'local',resolve:async()=>({subjectId:'m.castillo',tenantId:'tenant-verified',actorType:'human',roles,source:'local'}) as never},upstream});
  return {app,upstream};
};

it('shows the case assignment in the room, and still serves the room when it cannot be read',async()=>{
  const ok=assignmentApp(['Case.Analyst']);
  try{
    const room=await ok.app.inject('/api/v1/fincrime/cases/case-test/room');
    expect(room.statusCode,room.body).toBe(200);
    expect(validateResponse('getFincrimeCasesCaseIdRoom',200,room.json()).valid).toBe(true);
    expect(room.json().assignment).toEqual({team:{teamId:'kyb-onboarding',name:'KYB onboarding'},assignees:['r.okafor'],reason:'Onboarding intake',assignedBy:stored.assignedBy,assignedAt:stored.assignedAt});
    const teams=await ok.app.inject('/api/v1/fincrime/teams');
    expect(teams.statusCode,teams.body).toBe(200);
    expect(validateResponse('getFincrimeTeams',200,teams.json()).valid).toBe(true);
    expect(teams.json().teams).toEqual([{teamId:'kyb-onboarding',name:'KYB onboarding',members:['r.okafor','d.patel']}]);
  }finally{await ok.app.close();}
  const failing=assignmentApp(['Case.Analyst'],503);
  try{
    const room=await failing.app.inject('/api/v1/fincrime/cases/case-test/room');
    expect(room.statusCode,room.body).toBe(200);
    expect(room.json().assignment).toBeNull();
  }finally{await failing.app.close();}
});

it('lets a case manager assign through AssignCase, and refuses analysts and reviewers',async()=>{
  const body={teamId:'kyb-onboarding',assignees:['d.patel'],reason:'Rebalancing the queue.',expectedCaseSequence:9,idempotencyKey:'a-1'};
  const post=async(roles:string[],payload:object)=>{
    const {app,upstream}=assignmentApp(roles);
    try{
      const session=await app.inject('/api/v1/session');
      const response=await app.inject({method:'POST',url:'/api/v1/fincrime/cases/case-test/assignment',payload,headers:{origin:'http://localhost:80',cookie:String(session.headers['set-cookie']).split(';')[0]!,'x-csrf-token':session.json().csrfToken}});
      return {response,commands:upstream.mock.calls.filter(call=>call[1]==='POST').map(call=>call[4] as any)};
    }finally{await app.close();}
  };
  const accepted=await post(['Case.Manager'],body);
  expect(accepted.response.statusCode,accepted.response.body).toBe(200);
  expect(accepted.commands).toHaveLength(1);
  expect(accepted.commands[0]).toMatchObject({commandType:'AssignCase',preconditions:{caseSequence:9},actor:{type:'HUMAN',principalId:'m.castillo'},payload:{teamId:'kyb-onboarding',assignees:['d.patel'],reason:'Rebalancing the queue.'}});
  for(const roles of [['Case.Analyst'],['Case.Reviewer'],['Case.Analyst','Case.Reviewer']]) {
    const refused=await post(roles,body);
    expect(refused.response.statusCode).toBe(403);
    expect(refused.commands).toHaveLength(0);
  }
  const invalid=await post(['Case.Manager'],{...body,reason:''});
  expect(invalid.response.statusCode).toBe(400);
  expect(invalid.commands).toHaveLength(0);
  const stale=await post(['Case.Manager'],{...body,expectedCaseSequence:8});
  expect(stale.response.statusCode).toBe(409);
  expect(stale.response.json().error).toBe('case.sequence_conflict');
  expect(stale.commands.map(command=>command.preconditions)).toEqual([{caseSequence:8}]);
});

it('scopes the work queue by standing: named, team, unassigned; a manager sees all; and it fails closed',async()=>{
  const work=(caseId:string)=>({workItem:{workItemId:`wi-${caseId}`,caseId,objective:'Review',status:'WAITING_HUMAN',constraints:{},priority:0},assignedTo:[],requiredApprovals:1,decisions:[],overdue:false,escalated:false});
  const assignments=[
    {caseId:'case-named',teamId:'other',teamName:'Other',assignees:['me'],reason:'r',assignedBy:{principalId:'m',type:'HUMAN',roles:[]},assignedAt:'2026-11-08T03:01:00.000Z'},
    {caseId:'case-team',teamId:'mine',teamName:'Mine',assignees:[],reason:'r',assignedBy:{principalId:'m',type:'HUMAN',roles:[]},assignedAt:'2026-11-08T03:01:00.000Z'},
    {caseId:'case-elsewhere',teamId:'other',teamName:'Other',assignees:['someone'],reason:'r',assignedBy:{principalId:'m',type:'HUMAN',roles:[]},assignedAt:'2026-11-08T03:01:00.000Z'},
  ];
  const queue=async(roles:string[],assignmentStatus=200)=>{
    const upstream=vi.fn<Upstream>(async(_s,_m,path)=>{
      if(path.startsWith('/v1/operations/human-work'))return {status:200,body:{items:['case-named','case-team','case-elsewhere','case-open'].map(work)}};
      if(path.startsWith('/v1/case-assignments'))return {status:assignmentStatus,body:assignmentStatus===200?{assignments}:{error:'x'}};
      if(path.startsWith('/v1/case-teams'))return {status:200,body:{teams:[{teamId:'mine',name:'Mine',members:['me']},{teamId:'other',name:'Other',members:['someone']}]}};
      const id=decodeURIComponent(path.split('/')[3]!);
      return {status:200,body:{...snapshot,caseId:id}};
    });
    const app=buildApp({catalogSource:()=>catalog,principalResolver:{source:'local',resolve:async()=>({subjectId:'me',tenantId:'tenant-verified',actorType:'human',roles,source:'local'}) as never},upstream});
    try{return await app.inject('/api/v1/fincrime/work');}finally{await app.close();}
  };
  const mine=await queue(['Case.Analyst','Case.Reviewer']);
  expect(mine.statusCode,mine.body).toBe(200);
  expect(validateResponse('getFincrimeWork',200,mine.json()).valid).toBe(true);
  const standing=(body:any)=>Object.fromEntries(body.groups.flatMap((group:any)=>group.items).map((item:any)=>[item.caseId,item.standing]));
  expect(standing(mine.json())).toEqual({'case-named':'assigned','case-team':'team','case-open':'unassigned'});
  expect(mine.json().scope).toBe('standing');

  const manager=await queue(['Case.Manager']);
  expect(standing(manager.json())).toEqual({'case-named':'oversight','case-team':'oversight','case-elsewhere':'oversight','case-open':'oversight'});
  expect(manager.json().scope).toBe('all');

  // Standing that cannot be read is an error, never "show everything".
  expect((await queue(['Case.Analyst','Case.Reviewer'],503)).statusCode).toBe(502);
  // A case API that predates assignment has none: every case is unassigned and stays visible.
  expect(Object.keys(standing((await queue(['Case.Analyst','Case.Reviewer'],404)).json()))).toHaveLength(4);
});
