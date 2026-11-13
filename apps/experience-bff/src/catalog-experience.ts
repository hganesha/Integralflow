import { contextCatalogViews, type ContextCatalogSource, type CatalogSnapshot } from '@ehf/fincrime-views';
import { actionsForRoles } from '@ehf/identity';
import { canReadCatalog, type Schemas } from '@ehf/ui-contracts';
import { validateResponse } from '@ehf/ui-contracts/validate';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { sessionAccess } from './session.js';
import { delegatedHeaders, errorResponse } from './relay.js';
import { UpstreamError, type Upstream } from './upstream.js';

/** Source definitions and access coverage only. Publication and work are deliberately
 * marked unobserved until a release/run can be associated with this exact catalog. */
export function agentCatalogViews(source: ContextCatalogSource, snapshot: CatalogSnapshot) {
  const views = contextCatalogViews(source);
  const summaries: Schemas['SkillSummary'][] = source.skills.map(({value: skill}) => ({
    skill_id: String(skill.id), version: String(skill.semver??skill.version), business_outcome: String(skill.business_outcome),
    domain: snapshot.entries.find(e => e.kind === 'skills' && e.id === skill.id)?.group ?? 'Other',
    execution_mode: typeof skill.execution_mode === 'string' ? skill.execution_mode : null,
    effects: Array.isArray(skill.effects) ? skill.effects as string[] : typeof skill.effects === "string" ? [skill.effects] : [],
    context_object_types: [...new Set(views.requirements.filter(r => r.skill_id === skill.id).map(r => r.object_type))],
    agent_ids: views.catalog.agents.filter(a => Object.hasOwn(a.execution.allowed_skills, String(skill.id))).map(a => a.id),
    task_ids: views.catalog.tasks.filter(t => t.steps.some(s => s.skill_id === skill.id)).map(t => t.id),
  }));
  const cards: Schemas['AgentCard'][] = views.catalog.agents.map(agent => {
    const cells = views.readiness.cells.filter(c => c.agentId === agent.id && c.subscribed);
    return { agent, readiness: cells.some(c => c.status === 'gaps') ? 'gaps' : 'ready',
      contextReadiness: cells.map(c => ({productId:c.productId,status:c.status})),
      activeWork:{running:0,waitingHuman:0,failed:0}, runtimeObserved:false,
      publication:{catalogDigest:source.catalogDigest,planDigest:null,release:null} };
  });
  const atlas: Schemas['AgentAtlas'] = {catalogDigest:source.catalogDigest,sourceRelease:source.sourceRelease,agents:cards,
    counts:{agents:cards.length,tasks:views.catalog.tasks.length,skills:summaries.length,contextProducts:views.products.length}};
  const detail = (id:string): Schemas['AgentDetail'] | null => {
    const card = cards.find(c => c.agent.id === id); if(!card)return null;
    return {card,tasks:views.catalog.tasks.filter(t => card.agent.task_ids.includes(t.id)),
      skills:summaries.filter(s => s.agent_ids.includes(id)),contextProducts:views.products.filter(p => card.agent.context_products.includes(p.id)),
      ceilings:{context_fields:card.agent.execution.context_fields??{},policy_fields:card.agent.execution.policy_fields??[]}};
  };
  const task = (id:string): Schemas['TaskComposition'] | null => {
    const task=views.catalog.tasks.find(t=>t.id===id);if(!task)return null;
    const steps=task.steps.map(step=>{
      const skill=summaries.find(s=>s.skill_id===step.skill_id);
      if(!skill)throw new UpstreamError(502,'catalog.skill_reference_missing');
      const criterion=task.completion_criteria.find(c=>c.step_id===step.id);
      return {id:step.id,skill,dependencies:step.dependencies??[],parallelGroup:null,requiresHumanDecision:criterion?.requires_human_decision??false,
        acceptedStatuses:criterion?.accepted_statuses??[],requiredPayloadFields:criterion?.required_payload_fields??[]};
    });
    const ids=new Set(steps.map(s=>s.id));
    return {task,steps,edges:steps.flatMap(s=>s.dependencies.map(from=>({from,to:s.id}))),validation:[
      {check:'Skill references',outcome:'PASS',detail:'Every step resolves to a skill in this verified catalog.'},
      {check:'Dependency references',outcome:steps.every(s=>s.dependencies.every(id=>ids.has(id)))?'PASS':'FAIL',detail:'Checks references without changing execution order.'},
      {check:'Runtime qualification',outcome:'UNKNOWN',detail:'Source composition does not establish runtime availability.'},
    ]};
  };
  return {...views,summaries,atlas,detail,task};
}

export function registerCatalogExperience(app:FastifyInstance,access:ReturnType<typeof sessionAccess>,upstream:Upstream,env:NodeJS.ProcessEnv,loadSnapshot:()=>CatalogSnapshot) {
  const routes = [
    ['getFincrimeAgents','/v1/fincrime/agents'],['getFincrimeAgentsAgentId','/v1/fincrime/agents/:agentId'],
    ['getFincrimeTasksTaskId','/v1/fincrime/tasks/:taskId'],['getFincrimeSkills','/v1/fincrime/skills'],
    ['getFincrimeSkillsSkillId','/v1/fincrime/skills/:skillId'],['getSearch','/v1/search'],
  ] as const;
  for(const [operation,path] of routes)app.get('/api'+path,async(request,reply)=>{
    reply.header('cache-control','private, no-cache').header('x-correlation-id',request.id);
    try {
      const principal=await access.resolver.resolve(request);
      const actions=[...actionsForRoles(principal.roles)];
      if(principal.actorType!=='human'||operation!=='getSearch'&&!actions.includes('draft.read'))throw new UpstreamError(403,'authorization.role_missing');
      const snapshot=loadSnapshot();
      const params=request.params as Record<string,string>;
      const query=request.query as Record<string,string>;
      let body:unknown;
      if(operation==='getSearch') {
        const q=(query.q??'').trim();if(q.length>200)throw new UpstreamError(400,'search.query_too_long');
        const kinds = {agents:'agent',skills:'skill',context:'context_product','external-capabilities':'external_capability',policies:'policy',documents:'document_type',products:'product'} as const;
        const groups: Schemas['SearchResults']['groups'] = [];
        if(q)for(const [kind,label] of Object.entries(kinds)) {
          const entries=snapshot.entries.filter(e=>e.kind===kind&&canReadCatalog(actions,e.kind)&&[e.title,e.id,e.description,e.group].join(' ').toLowerCase().includes(q.toLowerCase())).slice(0,30);
          if(entries.length)groups.push({kind:label,items:entries.map(e=>({id:e.id,title:e.title,subtitle:e.group+' · '+(e.entryType==='binding'?'Provider binding':e.entryType==='field'?'Field':'Definition'),route:`/catalogs/${e.kind}/${encodeURIComponent(e.id)}${e.entryType==='binding'?'?inventory=binding':e.entryType==='field'?'?inventory=field':''}`}))});
        }
        // Search only sources authorized for this caller; upstream outages remain visible.
        for(const [action,service,path,keys,kind,route] of [
          ['case.read','case-api','/v1/cases?limit=100',['cases','items'],'case','/work/cases/'],
          ['plan.read','control-api','/v1/plan-records?limit=100',['records','items'],'plan','/platform/plans/'],
          ['draft.read','control-api','/v1/authoring/drafts',['drafts','items'],'draft','/platform/drafts/'],
        ] as const)if(q&&actions.includes(action)) {
          const result=await upstream(service,'GET',path,principal,undefined,delegatedHeaders(request,access,env));
          if(result.status>=400)throw new UpstreamError(result.status,'search.source_unavailable');
          const rows=(result.body[keys[0]]??result.body[keys[1]]??[]) as Record<string,any>[];
          const matches=rows.filter(row=>JSON.stringify(row).toLowerCase().includes(q.toLowerCase())).slice(0,20);
          if(matches.length)groups.push({kind,items:matches.map(row=>{const id=row.caseId??row.planDigest??row.draftId??row.id;return {id,title:row.name??row.metadata?.name??row.externalRef??id,subtitle:row.status??null,route:route+encodeURIComponent(id)};})});
        }
        body={query:q,groups};
      } else {
        const result=await upstream('control-api','GET','/v1/context/catalog',principal,undefined,delegatedHeaders(request,access,env));
        if(result.status!==200)throw new UpstreamError(result.status>=400?result.status:502,'catalog.source_unavailable');
        const views=agentCatalogViews(result.body, snapshot);
        if(operation==='getFincrimeAgents')body=views.atlas;
        else if(operation==='getFincrimeAgentsAgentId')body=views.detail(params.agentId!);
        else if(operation==='getFincrimeTasksTaskId')body=views.task(params.taskId!);
        else if(operation==='getFincrimeSkillsSkillId') {
          const summary=views.summaries.find(s=>s.skill_id===params.skillId);
          body=summary?{summary,manifest:result.body.skills.find((s:any)=>s.value.id===params.skillId)?.value,fieldRequirements:views.requirements.filter(r=>r.skill_id===params.skillId)}:null;
        } else {
          const items=views.summaries.filter(s=>(!query.domain||s.domain===query.domain)&&(!query.q||`${s.skill_id} ${s.business_outcome}`.toLowerCase().includes(query.q.toLowerCase()))).sort((a,b)=>a.domain.localeCompare(b.domain)||a.skill_id.localeCompare(b.skill_id));
          const offset=Number(query.cursor??0);const limit=Math.min(100,Math.max(1,Number(query.limit??30)));
          if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit))throw new UpstreamError(400,'request.invalid');
          body={items:items.slice(offset,offset+limit),nextCursor:offset+limit<items.length?String(offset+limit):null,generatedAt:new Date().toISOString()};
        }
      }
      if(!body)throw new UpstreamError(404,'resource.not_found');
      if(!validateResponse(operation,200,body).valid)throw new UpstreamError(502,'bff.upstream_contract_invalid');
      const etag='"'+createHash('sha256').update(JSON.stringify(body)).digest('hex')+'"';
      reply.header('etag',etag);if(request.headers['if-none-match']===etag)return reply.code(304).send();
      return body;
    }catch(error){const failure=errorResponse(error,request);return reply.code(failure.status).send(failure.body);}
  });
}
