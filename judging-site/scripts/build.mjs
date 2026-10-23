import { readFile,writeFile,mkdir,copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve,dirname } from 'node:path';
import { createHash } from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>readFile(resolve(root,p),'utf8');
const [backend,page,entry,auth,schema]=await Promise.all([
  read('src/backend.mjs'),read('src/page.html'),read('worker/index.js'),read('src/auth-schema.sql'),read('src/schema.sql')]);
if(/^\s*import\s/m.test(backend))throw new Error('Worker backend must be self-contained; dependency bundling is not configured.');
const b=backend.replace(/^export\s+(?=(?:async\s+)?function|class|const|let)/gm,'');
if(/\bexport\s+(default|\{)/.test(b))throw new Error('Unexpected backend export style.');
const generated='export const PAGE = '+JSON.stringify(page)+';\n';
const compiled='// Qloo Workbench — generated from reviewed source.\nconst PAGE='+JSON.stringify(page)+';\n'
  +'const createWorkflow=(()=>{\n'+b+'\nreturn createWorkflow;})();\n'
  +entry.replace(/^import[^\n]+\n/gm,'');
const sql=(auth+'\n'+schema).replace(/;\s*(?=\S)/g,';\n--> statement-breakpoint\n');
const migration=resolve(root,'drizzle/0000_qloo_workbench.sql');
let old;try{old=await readFile(migration,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
if(old!==undefined&&old!==sql)throw new Error('Schema changed. Review the unapplied migration explicitly before rebuilding.');
await mkdir(resolve(root,'drizzle/meta'),{recursive:true});
await mkdir(resolve(root,'dist/server'),{recursive:true});
await mkdir(resolve(root,'dist/.openai'),{recursive:true});
await writeFile(resolve(root,'src/page.generated.mjs'),generated);
await writeFile(resolve(root,'dist/server/index.js'),compiled);
await copyFile(resolve(root,'.openai/hosting.json'),resolve(root,'dist/.openai/hosting.json'));
if(old===undefined)await writeFile(migration,sql);
await writeFile(resolve(root,'drizzle/meta/_journal.json'),JSON.stringify({version:'7',dialect:'sqlite',entries:[{idx:0,version:'6',when:1792754000000,tag:'0000_qloo_workbench',breakpoints:true}]},null,2)+'\n');
const sha=createHash('sha256').update(compiled).digest('hex');
console.log(JSON.stringify({built:true,sha256:sha,bytes:Buffer.byteLength(compiled),d1:true,installedDependencies:0}));
