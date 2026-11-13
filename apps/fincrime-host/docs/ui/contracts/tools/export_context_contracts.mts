import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from '../../../../../../packages/contracts/node_modules/zod/index.js';
import { saveContextDefinitionSchema, contextSampleRequestSchema, contextCaseBindingSaveSchema, contextPullRequestSchema } from '../../../../../../packages/contracts/src/context-setup.ts';
import { saveContextRefreshScheduleSchema } from "../../../../../../packages/contracts/src/context-refresh.ts";
import { documentSearchScopeSchema, documentSearchRequestSchema, documentCitationRequestSchema } from "../../../../../../packages/contracts/src/document-search.ts";
import { contextSourceJsonSchemas } from "../../../../../../packages/contracts/src/context-sources.ts";
// One schema root preserves recursive expression refs without duplicating the ontology.
const root=z.object({caseBinding:contextCaseBindingSaveSchema,pull:contextPullRequestSchema,save:saveContextDefinitionSchema,sample:contextSampleRequestSchema,refresh:saveContextRefreshScheduleSchema,documentScope:documentSearchScopeSchema,documentSearch:documentSearchRequestSchema,documentCitation:documentCitationRequestSchema}).strict();
const schema=z.toJSONSchema(root,{target:'draft-2020-12',unrepresentable:'any',io:'input'});
const output=fileURLToPath(new URL('../upstream/context-sources.schema.json',import.meta.url));
const text=JSON.stringify(schema,null,2)+'\n';
if(process.argv.includes('--check')){if(readFileSync(output,'utf8')!==text)throw new Error('Context source contracts are stale. Run the context contract exporter.');}
else writeFileSync(output,text);
// Product-source connections are a separate contract family. Keep their client schemas
// derived from the same server validators rather than maintaining a second provider enum.
const productOutput=fileURLToPath(new URL('../context-sources.schema.json',import.meta.url));
const productText=JSON.stringify({$schema:'https://json-schema.org/draft-07/schema#',$defs:contextSourceJsonSchemas()},null,2)+'\n';
if(process.argv.includes('--check')){if(readFileSync(productOutput,'utf8')!==productText)throw new Error('Product source contracts are stale. Run the context contract exporter.');}
else writeFileSync(productOutput,productText);
