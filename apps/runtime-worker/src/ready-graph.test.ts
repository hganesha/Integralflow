import {it,expect} from 'vitest';
import {runReadyGraph} from './ready-graph.js';

it('actually overlaps independent branches and respects their join',async()=>{
  let active=0,peak=0;const completed=new Set<string>();
  await runReadyGraph({nodes:['root','left','right','join'],edges:[{from:'root',to:'left'},{from:'root',to:'right'},{from:'left',to:'join'},{from:'right',to:'join'}],maxConcurrency:2,
    execute:async id=>{
      if(id==='join')expect([...completed]).toEqual(expect.arrayContaining(['left','right']));
      active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;completed.add(id);return 'continue';
    }});
  expect(peak).toBe(2);
});
it('drains concurrent siblings before a human interrupt and never starts successors',async()=>{
  const seen:string[]=[];
  const state=await runReadyGraph({nodes:['human','slow','next'],edges:[{from:'human',to:'next'}],maxConcurrency:2,
    execute:async id=>{if(id==='slow')await new Promise(r=>setTimeout(r,10));seen.push(id);return id==='human'?'pause':'continue';}});
  expect(state).toBe('paused');expect(seen).toEqual(['human','slow']);
});
it('waits for siblings on failure and does not treat rejected work as successful',async()=>{
  let siblingFinished=false;
  await expect(runReadyGraph({nodes:['failure','sibling'],edges:[],maxConcurrency:2,execute:async id=>{
    if(id==='failure')throw new Error('rejected');await new Promise(r=>setTimeout(r,5));siblingFinished=true;return 'continue';
  }})).rejects.toThrow('rejected');
  expect(siblingFinished).toBe(true);
});
