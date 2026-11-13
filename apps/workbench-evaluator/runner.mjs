import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const {config,input}=JSON.parse(await readFile('/evaluation/input.json','utf8'));
console.log=(...args)=>process.stderr.write(args.map(String).join(' ')+'\n');
try {
  const [path,name='run']=config.entrypoint.split(':');
  const mod=await import(pathToFileURL('/evaluation/source/'+path).href);
  const actual=await mod[name](input);
  process.stdout.write(JSON.stringify({actual}));
}catch(error){process.stdout.write(JSON.stringify({error:'workbench.source_test_failed:'+error.name}));}
