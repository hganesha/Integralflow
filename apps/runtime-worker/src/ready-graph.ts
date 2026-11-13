/** Bounded ready-node execution. Only committed predecessor completion unlocks a successor. */
export async function runReadyGraph(input:{nodes:readonly string[];edges:ReadonlyArray<{from:string;to:string}>;maxConcurrency:number;
  execute:(nodeId:string)=>Promise<'continue'|'pause'>}):Promise<'complete'|'paused'> {
  if(!Number.isInteger(input.maxConcurrency) || input.maxConcurrency<1 || input.maxConcurrency>1000) throw new Error('workflow.concurrency_invalid');
  const pending=new Set(input.nodes),completed=new Set<string>();
  while(pending.size) {
    const ready=[...pending].filter(id=>input.edges.filter(e=>e.to===id).every(e=>completed.has(e.from))).slice(0,input.maxConcurrency);
    if(!ready.length) throw new Error('workflow.graph_not_acyclic');
    const settled=await Promise.allSettled(ready.map(input.execute));
    // Drain the batch before suspending; no detached node may commit after run finalization.
    const rejected=settled.find(s=>s.status==='rejected');
    if(rejected?.status==='rejected') throw rejected.reason;
    if(settled.some(s=>s.status==='fulfilled' && s.value==='pause')) return 'paused';
    for(const id of ready){pending.delete(id);completed.add(id);}
  }
  return 'complete';
}
