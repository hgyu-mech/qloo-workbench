import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,copyFileSync,mkdtempSync,appendFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
test('schema mismatch cannot change an existing built artifact',()=>{
  const local=resolve(root,'.local');mkdirSync(local,{recursive:true});
  const isolated=mkdtempSync(join(local,'build-failure-'));
  for(const relative of ['package.json','scripts/build.mjs','src/backend.mjs','src/page.html','src/auth-schema.sql','src/schema.sql','worker/index.js','.openai/hosting.json']){
    const out=resolve(isolated,relative);mkdirSync(dirname(out),{recursive:true});copyFileSync(resolve(root,relative),out);
  }
  let result=spawnSync(process.execPath,['scripts/build.mjs'],{cwd:isolated,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const files=['dist/server/index.js','dist/.openai/hosting.json','src/page.generated.mjs','drizzle/0000_qloo_workbench.sql'];
  const before=files.map(p=>readFileSync(resolve(isolated,p)));
  appendFileSync(resolve(isolated,'src/schema.sql'),'\nCREATE TABLE changed_schema (id TEXT);\n');
  result=spawnSync(process.execPath,['scripts/build.mjs'],{cwd:isolated,encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,/Schema changed/);
  files.forEach((p,i)=>assert.deepEqual(readFileSync(resolve(isolated,p)),before[i],p));
});
