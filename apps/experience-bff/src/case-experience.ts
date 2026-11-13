import {caseDocuments,caseDocumentDetail,documentCitationPreview} from '@ehf/fincrime-views';
import {actionsForRoles} from '@ehf/identity';
import {validateResponse,validatorFor} from '@ehf/ui-contracts/validate';
import type {FastifyInstance} from 'fastify';
import type {sessionAccess} from './session.js';
import {caseSummary} from './platform-experience.js';
import {completeCaseCommand,delegatedHeaders,errorResponse,submitCaseCommand} from './relay.js';
import {UpstreamError,type Upstream} from './upstream.js';
import {documentRecords} from './experience-read.js';
import {loadCatalogSnapshot} from './catalogs.js';
import {ROOM_EVENTS,caseEvidence,caseFindings,roomEvents,roomStages} from './case-room.js';
import type {CatalogSnapshot} from '@ehf/fincrime-views';
type Row=Record<string,any>;
export function registerCaseExperience(app:FastifyInstance,access:ReturnType<typeof sessionAccess>,upstream:Upstream,env:NodeJS.ProcessEnv,loadCatalog:()=>CatalogSnapshot=loadCatalogSnapshot) {
  const routes=[
    ['GET','getFincrimeWork','/v1/fincrime/work','human_work.read'],
    ['GET','getCasesCaseId','/v1/cases/:caseId','case.read'],
    ['GET','getFincrimeCasesCaseIdClaims','/v1/fincrime/cases/:caseId/claims','case.read'],
    ['GET','getFincrimeCasesCaseIdDecision','/v1/fincrime/cases/:caseId/decision','case.read'],
    ['GET','getFincrimeCasesCaseIdRoom','/v1/fincrime/cases/:caseId/room','case.read'],
    ['GET','getFincrimeTeams','/v1/fincrime/teams','case.read'],
    ['POST','postFincrimeCasesCaseIdAssignment','/v1/fincrime/cases/:caseId/assignment','case.assign'],
    ['GET','getFincrimeCasesCaseIdEvidence','/v1/fincrime/cases/:caseId/evidence','evidence.read'],
    ['GET','getFincrimeCasesCaseIdFindings','/v1/fincrime/cases/:caseId/findings','case.read'],
    ['GET','getFincrimeCasesCaseIdDocuments','/v1/fincrime/cases/:caseId/documents','case.read'],
    ['POST','postFincrimeCasesCaseIdDocuments','/v1/fincrime/cases/:caseId/documents','evidence.write'],
    ['GET','getFincrimeCasesCaseIdDocumentsDocumentId','/v1/fincrime/cases/:caseId/documents/:documentId','case.read'],
    ['GET','getFincrimeCasesCaseIdDocumentsDocumentIdCitations','/v1/fincrime/cases/:caseId/documents/:documentId/citations','evidence.read'],
    ['GET','getFincrimeCasesCaseIdDocumentsDocumentIdContent','/v1/fincrime/cases/:caseId/documents/:documentId/content','evidence.read'],
    ['POST','postFincrimeCasesCaseIdDocumentsDocumentIdReviews','/v1/fincrime/cases/:caseId/documents/:documentId/reviews','case.review'],
    ['POST','postFincrimeCasesCaseIdFindingsFindingIdDispositions','/v1/fincrime/cases/:caseId/findings/:findingId/dispositions','case.review'],
    ['POST','postFincrimeCasesCaseIdCommandsPreview','/v1/fincrime/cases/:caseId/commands:preview','case.write'],
  ] as const;
  for(const [method,operation,path,action] of routes)app.route({method,url:'/api'+path.replace(/(?<!\/):/g,'::'),bodyLimit:16*1024*1024,handler:async(request,reply)=>{
    reply.header('cache-control','no-store').header('x-correlation-id',request.id);
    try {
      const principal=await access.resolver.resolve(request);const actions=actionsForRoles(principal.roles);
      if(principal.actorType!=='human'||!actions.has(action))throw new UpstreamError(403,'authorization.role_missing');
      if(method!=='GET'&&!access.csrf(request))throw new UpstreamError(403,'csrf.invalid');
      const headers=delegatedHeaders(request,access,env);
      const call=async(service:Parameters<Upstream>[0],path:string,method='GET',input?:unknown)=>{
        const result=await upstream(service,method,path,principal,input,headers);
        if(result.status>=400)throw new UpstreamError(result.status,result.body?.error??'bff.upstream_unavailable');
        return result;
      };
      const {caseId,documentId,findingId}=request.params as Record<string,string>;
      const input=request.body as Row;
      const citationPreview=operation==='getFincrimeCasesCaseIdDocumentsDocumentIdCitations';
      const documentRead=citationPreview||operation==='getFincrimeCasesCaseIdDocumentsDocumentId'||operation==='getFincrimeCasesCaseIdDocumentsDocumentIdContent';
      const version=documentRead?(request.query as Row).version:undefined;
      if(citationPreview||version!==undefined) {
        if(typeof version!=='string'||!/^(sha256:)?[a-f0-9]{64}$/.test(version))throw new UpstreamError(400,'document.version_invalid');
        if(!actions.has('evidence.read'))throw new UpstreamError(403,'authorization.action_denied');
        reply.header('cache-control','private, no-store');
      }
      // A person's command on this case, answered with its receipt; a replay returns the original one.
      const submit=async(command:Row,s:Row)=>{
        const result=await submitCaseCommand(upstream,principal,headers,command,caseId!,s);
        if(result.status>=400)throw new UpstreamError(result.status,result.body?.error??'bff.upstream_unavailable');
        return result.body;
      };
      const snapshot=async(id:string)=>{
        const result=await call('case-api',`/v2/cases/${encodeURIComponent(id)}/snapshot`);
        if(result.body.caseId!==id||result.body.tenantId!==principal.tenantId)throw new UpstreamError(403,'case.authority_mismatch');
        return result.body;
      };
      const subject=(s:Row)=>{
        const raw=s.data.subjects?.[0];
        return {subjectId:raw?.subject_id??'',name:raw?.display_name??s.data.case.externalRef??s.caseId,kind:raw?.subject_type??'Not recorded',identifiers:raw?.identifiers?Object.values(raw.identifiers).map(String):[]};
      };
      // A case's current assignment in the contract's shape. Assignment is shown, never required:
      // if it cannot be read the case and the queue still load, without it.
      const assignmentView=(a:Row|null|undefined)=>a?{team:{teamId:a.teamId,name:a.teamName},assignees:a.assignees??[],reason:a.reason,assignedBy:a.assignedBy,assignedAt:a.assignedAt}:null;
      const assignmentOf=async(id:string)=>{
        const result=await upstream('case-api','GET',`/v1/cases/${encodeURIComponent(id)}/assignment`,principal,undefined,headers).catch(()=>null);
        return result&&result.status<400?assignmentView(result.body?.assignment):undefined;
      };
      let body:any;let status=200;
      if(operation==='getFincrimeWork') {
        const queue=(await call('control-api','/v1/operations/human-work')).body.items as Row[];
        const snapshots=new Map<string,Row>();
        const caseIds=[...new Set<string>(queue.map(q=>q.workItem.caseId))];
        await Promise.all(caseIds.map(async id=>snapshots.set(id,await snapshot(id))));
        // The queue is scoped by standing (case-access-model.md step 2): a person sees work on cases
        // they are named on, whose team they are in, or that have no assignment yet; someone who
        // oversees case work (case.assign) sees all of it. If standing cannot be established the
        // queue fails rather than showing everything. A case API without the assignment routes
        // (404) has no assignments, so every case is unassigned.
        const assigned=new Map<string,Row>();
        const oversees=actions.has('case.assign');
        const memberOf=new Set<string>();
        if(caseIds.length) {
          const listed=await upstream('case-api','GET',`/v1/case-assignments?caseIds=${caseIds.map(encodeURIComponent).join(',')}`,principal,undefined,headers).catch(()=>null);
          if(!listed||(listed.status>=400&&listed.status!==404))throw new UpstreamError(502,'assignment.unavailable');
          if(listed.status<400)for(const a of (listed.body?.assignments??[]) as Row[])assigned.set(a.caseId,a);
          if(!oversees&&assigned.size) {
            const teams=await upstream('case-api','GET','/v1/case-teams',principal,undefined,headers).catch(()=>null);
            if(!teams||teams.status>=400)throw new UpstreamError(502,'assignment.unavailable');
            for(const team of (teams.body?.teams??[]) as Row[])if((team.members??[]).includes(principal.subjectId))memberOf.add(team.teamId);
          }
        }
        const standingOf=(id:string):'assigned'|'team'|'unassigned'|'oversight'|null=>{
          if(oversees)return 'oversight';
          const a=assigned.get(id);
          if(!a)return 'unassigned';
          if((a.assignees??[]).includes(principal.subjectId))return 'assigned';
          return memberOf.has(a.teamId)?'team':null;
        };
        const items=queue.flatMap(q=>{
          const work=q.workItem,s=snapshots.get(work.caseId)!;const c=work.constraints??{};
          const standing=standingOf(work.caseId);
          if(!standing)return [];
          const mine=q.assignedTo.includes(principal.subjectId);const group=q.escalated||work.status==='BLOCKED'?'escalated_or_blocked':q.overdue?'approaching_deadline':mine||!q.assignedTo.length?'needs_action':'waiting_on_others';
          return [{workItemId:work.workItemId,caseId:work.caseId,caseStatus:s.data.case.status,subject:{name:subject(s).name,kind:subject(s).kind},objective:work.objective,
            agentId:c.agentId??null,taskId:c.taskId??null,stepId:c.stepId??null,gate:c.gate??null,workStatus:work.status,
            claim:{assignedTo:q.assignedTo,mine,claimable:actions.has('human_work.claim')&&!q.assignedTo.length},requiredApprovals:q.requiredApprovals,decisionsSoFar:q.decisions.length,
            overdue:q.overdue,escalated:q.escalated,deadlineAt:work.deadlineAt??null,priority:work.priority??0,group,route:`/work/cases/${encodeURIComponent(work.caseId)}`,assignment:assignmentView(assigned.get(work.caseId)),standing}];
        });
        const labels:Record<string,string>={needs_action:'Needs your action',prepared_by_agents:'Prepared by agents',waiting_on_others:'Waiting on others',approaching_deadline:'Approaching deadline',escalated_or_blocked:'Escalated or blocked'};
        body={generatedAt:new Date().toISOString(),kpis:[{key:'open',label:'Open human work',value:items.length,emphasis:'none'}],groups:Object.entries(labels).map(([group,label])=>({group,label,items:items.filter(i=>i.group===group)})),scope:oversees?'all':'standing'};
      } else if(operation==='getFincrimeTeams') {
        const teams=(await call('case-api','/v1/case-teams')).body.teams as Row[];
        body={teams:teams.map(t=>({teamId:t.teamId,name:t.name,members:t.members??[]}))};
      } else if(operation==='postFincrimeCasesCaseIdDocuments') {
        const result=await call('case-api',`/v1/cases/${encodeURIComponent(caseId!)}/documents`,'POST',input);
        // The case API answers a replay of this upload's key with the first registration (200, not
        // created); the person gets the original result back either way, as the contract's 201.
        body={...result.body.document,evidenceId:result.body.evidence.evidenceId??result.body.evidence.evidence_id};status=201;
      } else {
        const s=await snapshot(caseId!);
        if(['getCasesCaseId','getFincrimeCasesCaseIdClaims','getFincrimeCasesCaseIdDecision'].includes(operation)) {
          const events:Row[]=[];let after='0';const seen=new Set<string>();
          do {const result=(await call('case-api',`/v1/cases/${encodeURIComponent(caseId!)}/events?limit=200&after=${encodeURIComponent(after)}`)).body;events.push(...result.events);if(!result.nextCursor)break;after=String(result.nextCursor);if(seen.has(after))throw new UpstreamError(502,'pagination.cursor_repeated');seen.add(after);}while(true);
          const sourceEvent=(id:string)=>events.find(e=>Object.values(e.payload??{}).includes(id));
          const d=s.data;
          if(operation==='getFincrimeCasesCaseIdClaims') {
            const rows=[...[['claims','claim','claim_id','claim'],['facts','fact','fact_id','fact'],['assumptions','assumption','assumption_id','assumption'],['contradictions','contradiction','contradiction_id','finding'],['findings','screening_finding','finding_id','finding']].flatMap(([table,kind,key,epistemic])=>(d[table!]??[]).map((row:Row)=>{
              const id=row[key!];const event=sourceEvent(id);
              return {id,kind,epistemic,subjectRef:row.subject_ref??null,field:row.predicate??null,value:row.value===undefined?row.proposition??row.description??row.reason??null:typeof row.value==='string'?row.value:JSON.stringify(row.value),status:row.status,
                evidenceIds:row.evidence_refs??[],sourceCommandId:event?.commandRef??null,caseSequence:event?.caseSequence??null,recordedBy:row.asserted_by??row.created_by,acceptedBy:kind==='fact'?row.created_by:null};
            }))];
            const kind=(request.query as Row).kind;body={caseSequence:s.caseSequence,items:rows.filter(row=>!kind||row.kind===kind)};
          } else if(operation==='getFincrimeCasesCaseIdDecision') {
            const queue=actions.has('human_work.read')?(await call('control-api',`/v1/operations/human-work?caseId=${encodeURIComponent(caseId!)}`)).body.items as Row[]:[];
            const humanWork=queue.find(q=>q.workItem.constraints?.gate==='decision.consequential'||q.workItem.constraints?.taskId==='task.decision_support')??null;
            const recommendation=(d.decisionRecommendations??[]).at(-1);
            const event=recommendation?sourceEvent(recommendation.recommendation_id):null;
            if(recommendation&&!event)throw new UpstreamError(409,'case.recommendation_provenance_unavailable');
            const assigned=humanWork?.assignedTo.includes(principal.subjectId)??false;
            const prior=humanWork?.decisions??[];
            body={caseId,status:d.case.status,basis:{caseSequence:s.caseSequence,snapshotDigest:s.snapshotDigest},recommendation:recommendation?{disposition:recommendation.outcome,rationale:recommendation.rationale,agentId:recommendation.created_by.principalId,commandId:event!.commandRef}:null,
              gates:(d.gateResults??[]).map((g:Row)=>({gateId:g.gate_id??g.gate_result_id,result:g.decision,at:g.created_at})),policyEvaluation:null,
              qa:(d.reviews??[]).filter((r:Row)=>r.review_type==='SEMANTIC_QA').map((r:Row)=>({check:r.review_type,outcome:r.outcome==='ERROR'?'UNKNOWN':r.outcome,by:r.reviewer})),risk:null,humanWork,
              requirements:{requiredApprovals:humanWork?.requiredApprovals??0,decided:prior,youMay:{claim:Boolean(humanWork&&actions.has('human_work.claim')&&!assigned),decide:Boolean(humanWork&&assigned&&actions.has('human_work.decide')&&!prior.some((r:Row)=>r.principalId===principal.subjectId)),resolve:Boolean(humanWork&&actions.has('human_work.resolve')&&!prior.some((r:Row)=>r.principalId===principal.subjectId))},reasonIfNot:!humanWork?'No consequential decision is awaiting human review.':!assigned?'Claim this work item before deciding.':null,options:[]},
              limitations:[{kind:'other',text:'This desk shows recorded recommendations, gates and human work. Canonical risk records and control-level policy evaluations are not projected here.'}]};
          } else {
            const ledger=(await call('case-api',`/v1/cases/${encodeURIComponent(caseId!)}/ledger:verify`,'POST',{})).body;
            const categories=['subjects','claims','facts','findings','assumptions','contradictions','workItems','evidence'];
            const nodes=categories.flatMap(category=>(d[category]??[]).map((row:Row)=>{const key=Object.keys(row).find(k=>k.endsWith('_id')&&!['tenant_id','case_id'].includes(k));const id=String(row[key??'id']);return {id,label:row.display_name??row.predicate??row.reason??row.proposition??row.description??row.work_type??id,subtitle:category,category,status:row.status??'Recorded',data:row};}));
            body={generatedAt:s.capturedAt,viewSchema:'case.operational-view.v2',etag:`"${caseId}:${s.caseSequence}"`,case:caseSummary(d.case),counts:Object.fromEntries(categories.map(c=>[c,d[c]?.length??0])),graph:{nodes,edges:[],categories},executionRefs:d.executionRefs??[],
              activities:events.map(e=>({eventId:e.eventId,sequence:e.caseSequence,eventType:e.eventType,occurredAt:e.occurredAt,actorLabel:e.actor.principalId,evidenceRefs:e.evidenceRefs,eventDigest:e.eventDigest,previousEventDigest:e.previousEventDigest,payload:e.payload,authority:e.authority})),
              ledger:{eventCount:events.length,latestSequence:events.at(-1)?.caseSequence??0,headDigest:ledger.headDigest??null,valid:ledger.valid,checkedEvents:ledger.checkedEvents,failedSequence:ledger.failedSequence??null}};
          }
        } else if(operation==='getFincrimeCasesCaseIdRoom') {
          const queue=actions.has('human_work.read')?(await call('control-api',`/v1/operations/human-work?caseId=${encodeURIComponent(caseId!)}`)).body.items:[];
          const d=s.data;const c=d.case;
          // Agent names label the stages; a missing catalog only costs the label.
          const titles=new Map<string,string>();
          try{for(const entry of loadCatalog().entries)if(entry.kind==='agents')titles.set(entry.id,entry.title);}catch{/* labels fall back to the task id */}
          // The event log needs event.read (GAP-075). Without it, or if the read fails, the room carries no events rather than failing.
          let recent:Row[]=[];
          if(actions.has('event.read')) {
            const page=await upstream('case-api','GET',`/v1/cases/${encodeURIComponent(caseId!)}/events?limit=${ROOM_EVENTS}&after=${Math.max(0,s.caseSequence-ROOM_EVENTS)}`,principal,undefined,headers).catch(()=>null);
            if(page&&page.status<400&&Array.isArray(page.body?.events))recent=page.body.events;
          }
          body={caseId,caseType:c.caseType,jurisdiction:c.jurisdiction,status:c.status,caseSequence:s.caseSequence,snapshotDigest:s.snapshotDigest,planDigest:s.planDigest,policyAuthority:s.policyAuthority,subject:subject(s),
            stages:roomStages(d.workItems??[],id=>titles.get(id)),workItems:(d.workItems??[]).map((w:Row)=>({workItemId:w.work_item_id,objective:w.objective??w.work_type,status:w.status,agentId:w.constraints?.agentId??null,taskId:w.constraints?.taskId??null,stepId:w.constraints?.stepId??null,skillStatus:w.outcome?.status??null,updatedAt:w.updated_at})),humanWork:queue,
            counts:{claims:d.claims?.length??0,facts:d.facts?.length??0,openContradictions:(d.contradictions??[]).filter((c:Row)=>c.status==='OPEN').length,assumptions:d.assumptions?.length??0,evidence:d.evidence?.length??0,screeningFindings:(d.findings??[]).filter((f:Row)=>f.finding_type==='SCREENING').length},
            lenses:[{lens:'ownership',label:'Ownership & control',badge:null,available:true},{lens:'documents',label:'Documents',badge:null,available:true},{lens:'screening',label:'Screening',badge:null,available:true},{lens:'decision',label:'Decision',badge:null,available:true}],recentEvents:roomEvents(recent),assignment:(await assignmentOf(caseId!))??null,synthetic:Object.values(d.records??{}).flat().some((r:any)=>r.synthetic===true)};
        } else if(operation==='postFincrimeCasesCaseIdAssignment') {
          // Who works the case, as an AssignCase command against the sequence the manager is looking at.
          // The case API holds the rules: the team exists and every named person is a member of it.
          if(!validatorFor('CaseAssignmentRequest')(input))throw new UpstreamError(400,'assignment.request_invalid');
          body=await submit({commandType:'AssignCase',commandVersion:'1.0.0',payload:{teamId:input.teamId,assignees:input.assignees,reason:input.reason},preconditions:{caseSequence:input.expectedCaseSequence},idempotencyKey:input.idempotencyKey},s);
        } else if(operation==='getFincrimeCasesCaseIdEvidence') {
          const documents=caseDocuments(caseId!,documentRecords(s),{},{caseSequence:s.caseSequence,reviews:s.data.reviews??[],evidence:s.data.evidence??[]}).documents;
          body={caseSequence:s.caseSequence,items:caseEvidence(s.data,documents)};
        } else if(operation==='getFincrimeCasesCaseIdFindings') {
          body={caseSequence:s.caseSequence,items:caseFindings(s.data,actions.has('case.review'))};
        } else if(operation==='postFincrimeCasesCaseIdFindingsFindingIdDispositions') {
          // A reviewer's conclusion on a recorded finding, as a RecordReview against the finding's id.
          // Never a generic command relay: the finding, its state and the evidence cited are checked here.
          if(!validatorFor('FindingDispositionRequest')(input))throw new UpstreamError(400,'finding.disposition_invalid');
          const finding=caseFindings(s.data,true).find(item=>item.findingId===findingId);
          if(!finding)throw new UpstreamError(404,'finding.not_found');
          if(!finding.disposition.allowed)throw new UpstreamError(409,'finding.disposition_not_allowed');
          const onFile=new Set((s.data.evidence??[]).map((row:Row)=>row.evidence_id));
          if(input.viewedEvidenceIds.some((id:string)=>!onFile.has(id)))throw new UpstreamError(409,'finding.evidence_not_on_case');
          body=await submit({commandType:'RecordReview',commandVersion:'1.0.0',payload:{reviewType:'FINDING_DISPOSITION',outcome:input.outcome,objectRef:findingId,rationale:input.rationale,viewedEvidenceRefs:input.viewedEvidenceIds},preconditions:{caseSequence:input.expectedCaseSequence},idempotencyKey:input.idempotencyKey},s);
        } else if(operation==='postFincrimeCasesCaseIdCommandsPreview') {
          const command=completeCaseCommand(input,caseId!,s,principal);
          body={command,diff:Object.entries(input.payload??{}).map(([key,value])=>({path:'payload.'+key,before:null,after:typeof value==='string'?value:JSON.stringify(value)})),
            effects:[{kind:'audit',description:'If accepted, this command appends an event to the case ledger.'}],warnings:['Preview does not execute or guarantee acceptance of the command.'],basis:{caseSequence:s.caseSequence,snapshotDigest:s.snapshotDigest}};
        } else {
          const records=documentRecords(s);
          const context={caseSequence:s.caseSequence,reviews:s.data.reviews??[],evidence:s.data.evidence??[],workItems:s.data.workItems??[]};
          if(operation==='getFincrimeCasesCaseIdDocuments')body=caseDocuments(caseId!,records,{},context);
          else {
            const detail=caseDocumentDetail(documentId!,records,{},context,version);
            if(!detail)throw new UpstreamError(404,version?'document.version_unavailable':'document.not_found');
            if(citationPreview)body=documentCitationPreview(detail);
            else if(operation==='getFincrimeCasesCaseIdDocumentsDocumentId')body=detail;
            else if(operation==='getFincrimeCasesCaseIdDocumentsDocumentIdContent') {
              if(!detail.document.evidenceId)throw new UpstreamError(404,'document.source_not_available');
              const original=(await call('case-api',`/v1/evidence/${encodeURIComponent(detail.document.evidenceId)}/content`)).body;
              if(original.caseId!==caseId||original.rawDigest.replace(/^sha256:/,'')!==detail.document.documentVersion.replace(/^sha256:/,''))throw new UpstreamError(409,'document.version_conflict');
              body={filename:detail.document.filename??documentId,mediaType:original.mediaType,contentBase64:original.contentBase64,documentVersion:detail.document.documentVersion};
            } else {
              if(input.documentVersion!==detail.document.documentVersion)throw new UpstreamError(409,'document.version_conflict');
              body=await submit({commandType:'RecordReview',commandVersion:'1.0.0',payload:{reviewType:'DOCUMENT_EXTRACTION',outcome:input.entries.every((e:Row)=>e.outcome==='CHECKED')?'CHECKED':input.entries.some((e:Row)=>e.outcome==='CORRECTED')?'CORRECTED':'REVIEWED',objectRef:documentId,rationale:input.rationale,documentReview:{documentId,documentVersion:input.documentVersion,entries:input.entries,...(input.resolvedWorkItems?.length?{resolvedWorkItems:input.resolvedWorkItems}:{})}},preconditions:{caseSequence:input.expectedCaseSequence},idempotencyKey:input.idempotencyKey},s);
            }
          }
        }
      }
      if(!validateResponse(operation,status,body).valid)throw new UpstreamError(502,'bff.upstream_contract_invalid');
      return reply.code(status).send(body);
    }catch(error){const failure=errorResponse(error,request);return reply.code(failure.status).send(failure.body);}
  }});
}
