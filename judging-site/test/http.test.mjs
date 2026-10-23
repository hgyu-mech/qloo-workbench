import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createD1} from './d1-shim.mjs';
import {createHandler} from '../worker/index.js';
const schema=readFileSync(new URL('../src/auth-schema.sql',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../src/schema.sql',import.meta.url),'utf8');
function setup(){
  const DB=createD1({schemaSql:schema}),time={at:Date.parse('2026-10-23T12:00:00Z')};let calls=0;
  let handle=createHandler({now:()=>time.at,fetchImpl:async()=>{calls++;throw Error('Unplanned network');}});
  const env={DB,LOCAL_PREVIEW:'true',QLOO_ENABLE_LIVE:'false'};
  const request=(path,{method='GET',body,cookie,csrf,origin='http://127.0.0.1',peer}={})=>handle(new Request('http://127.0.0.1'+path,{method,headers:{...(method==='POST'?{'Origin':origin,'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(peer?{'CF-Connecting-IP':peer}:{})},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})}),env);
  return {DB,time,env,request,calls:()=>calls,restart:()=>{handle=createHandler({now:()=>time.at,fetchImpl:async()=>{calls++;throw Error('Unplanned network');}});}};
}
async function start(s){const response=await s.request('/api/session',{method:'POST',body:{mode:'fixture'}});return {response,cookie:response.headers.get('set-cookie').split(';')[0],...await response.json()};}
test('public page has nonce CSP and no secret or credential input',async()=>{const s=setup();try{const r=await s.request('/');const html=await r.text();assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/script-src 'nonce-[a-f0-9]{48}'/);assert.ok(!html.includes('__CSP_NONCE__'));assert.ok(!html.includes('QLOO_API_KEY='));assert.equal(s.calls(),0);}finally{s.DB.close();}});
test('cross-origin session creation is rejected',async()=>{const s=setup();try{assert.equal((await s.request('/api/session',{method:'POST',body:{mode:'fixture'},origin:'https://other.invalid'})).status,403);assert.equal(s.calls(),0);}finally{s.DB.close();}});
test('fixture session uses HttpOnly cookie and csrf; missing csrf cannot resolve',async()=>{const s=setup();try{const a=await start(s);assert.match(a.response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);assert.match(a.csrf,/^[a-f0-9]{48}$/);assert.equal((await s.request('/api/resolve',{method:'POST',cookie:a.cookie,body:{query:'quiet'}})).status,403);const r=await s.request('/api/readiness',{cookie:a.cookie});assert.equal((await r.json()).authenticated,true);assert.equal(s.calls(),0);}finally{s.DB.close();}});
test('live session cannot be created from untrusted request body',async()=>{const s=setup();try{assert.equal((await s.request('/api/session',{method:'POST',body:{mode:'live'}})).status,400);const a=await start(s);assert.equal((await s.request('/api/unlock',{method:'POST',cookie:a.cookie,csrf:a.csrf,body:{password:'guess'}})).status,403);assert.equal(s.calls(),0);}finally{s.DB.close();}});
test('expired session fails and a new fixture session recovers',async()=>{const s=setup();try{const a=await start(s);s.time.at+=901000;const r=await s.request('/api/resolve',{method:'POST',cookie:a.cookie,csrf:a.csrf,body:{query:'quiet'}});assert.equal(r.status,401);assert.equal((await r.json()).error.code,'SESSION_EXPIRED');const b=await start(s);assert.notEqual(a.cookie,b.cookie);assert.equal(b.readiness.authenticated,true);assert.equal(s.calls(),0);}finally{s.DB.close();}});
test('malformed, oversized and extra-key requests stop before backend',async()=>{const s=setup();try{const a=await start(s);for(const body of ['{',JSON.stringify({query:'x'.repeat(5000)}),{query:'quiet',target:'wrong'}]){const r=await s.request('/api/resolve',{method:'POST',cookie:a.cookie,csrf:a.csrf,body});assert.ok(r.status>=400);}assert.equal(s.calls(),0);}finally{s.DB.close();}});
test('fixture resolve-confirm-recommend-replay runs with no upstream calls',async()=>{const s=setup();try{const a=await start(s),post=(path,body)=>s.request(path,{method:'POST',cookie:a.cookie,csrf:a.csrf,body}).then(r=>r.json());const found=await post('/api/resolve',{query:'quiet'});assert.equal(found.candidates.length,3);const chosen=await post('/api/confirm',{resolution_id:found.resolution_id,tag_id:found.candidates[0].id});assert.ok(chosen.receipt);const args={receipt:chosen.receipt,target_type:'movie',limit:3};const first=await post('/api/recommend',args),again=await post('/api/recommend',args);assert.equal((first.recommendations||first.shortlist).length,3);assert.equal(first.cached_receipt_replay,false);assert.equal(again.cached_receipt_replay,true);assert.equal(s.calls(),0);}finally{s.DB.close();}});
test('live unlock has a five-attempt wait and switches to an independent session',async()=>{const s=setup();try{
  Object.assign(s.env,{QLOO_ENABLE_LIVE:'true',QLOO_BASE_URL:'https://hackathon.api.qloo.com',QLOO_TRUSTED_BASE_URL:'https://hackathon.api.qloo.com',QLOO_POLICY_ID:'test-review-policy',QLOO_MAX_HTTP_ATTEMPTS:'64',QLOO_VALID_UNTIL:'2026-11-06T04:45:00Z',QLOO_API_KEY:'SYNTHETIC-QLOO-KEY',JUDGE_PASSWORD:'synthetic-judge-code-1234'});
  const a=await start(s),unlock=password=>s.request('/api/unlock',{method:'POST',cookie:a.cookie,csrf:a.csrf,body:{password}});
  for(let i=0;i<5;i++)assert.equal((await unlock('wrong')).status,403);
  assert.equal((await unlock(s.env.JUDGE_PASSWORD)).status,429);
  s.time.at+=300001;const unlocked=await unlock(s.env.JUDGE_PASSWORD),body=await unlocked.json();
  assert.equal(unlocked.status,200);assert.equal(body.readiness.mode,'live');assert.notEqual(unlocked.headers.get('set-cookie').split(';')[0],a.cookie);
  assert.equal(body.readiness.backend_calls,0);assert.equal(s.calls(),0);
}finally{s.DB.close();}});

test('fixture creation allowance survives new cookies and handler restart without creating more rows',async()=>{const s=setup();try{
  const first=await start(s);
  for(let i=1;i<20;i++)assert.equal((await s.request('/api/session',{method:'POST',body:{mode:'fixture'}})).status,200);
  const before=await s.DB.prepare('SELECT COUNT(*) AS count FROM web_sessions').first();
  s.restart();
  for(const [path,body] of [['/api/session',{mode:'fixture'}],['/api/reset',{}],['/api/resolve',{query:'quiet'}]]){
    const r=await s.request(path,{method:'POST',cookie:first.cookie,csrf:first.csrf,body});
    assert.equal(r.status,429);assert.equal((await r.json()).error.code,'FIXTURE_RATE_LIMIT');
    assert.match(r.headers.get('retry-after'),/^\d+$/);
  }
  assert.equal((await s.DB.prepare('SELECT COUNT(*) AS count FROM web_sessions').first()).count,before.count);
  s.time.at+=300001;
  assert.equal((await s.request('/api/session',{method:'POST',body:{mode:'fixture'}})).status,200);
  assert.equal(s.calls(),0);
}finally{s.DB.close();}});
test('new fixture cookies and resets do not restore the shared unlock allowance',async()=>{const s=setup();try{
  Object.assign(s.env,{QLOO_ENABLE_LIVE:'true',QLOO_BASE_URL:'https://hackathon.api.qloo.com',QLOO_TRUSTED_BASE_URL:'https://hackathon.api.qloo.com',QLOO_POLICY_ID:'test-review-policy',QLOO_MAX_HTTP_ATTEMPTS:'64',QLOO_VALID_UNTIL:'2026-11-06T04:45:00Z',QLOO_API_KEY:'SYNTHETIC-QLOO-KEY',JUDGE_PASSWORD:'synthetic-judge-code-1234'});
  for(let i=0;i<5;i++){const a=await start(s);for(let j=0;j<5;j++)assert.equal((await s.request('/api/unlock',{method:'POST',cookie:a.cookie,csrf:a.csrf,body:{password:'wrong'}})).status,403);}
  const b=await start(s),unlock=()=>s.request('/api/unlock',{method:'POST',cookie:b.cookie,csrf:b.csrf,body:{password:s.env.JUDGE_PASSWORD}});
  assert.equal((await unlock()).status,429);
  const rows=await s.DB.prepare('SELECT * FROM web_unlock_budget').all(),unlockRows=rows.results.filter(row=>/^[a-f0-9]{64}$/.test(row.bucket));assert.equal(unlockRows.length,1);assert.equal(unlockRows[0].attempts,26);
  s.time.at+=300001;assert.equal((await unlock()).status,200);assert.equal(s.calls(),0);
}finally{s.DB.close();}});

test('fixture resolve reservations are atomic for one cookie and do not grow more authority after denial',async()=>{const s=setup();try{
  const a=await start(s);
  const outcomes=await Promise.all(Array.from({length:20},()=>s.request('/api/resolve',{method:'POST',cookie:a.cookie,csrf:a.csrf,body:{query:'quiet'}})));
  assert.equal(outcomes.filter(r=>r.status===200).length,19);
  assert.equal(outcomes.filter(r=>r.status===429).length,1);
  assert.equal((await s.DB.prepare('SELECT COUNT(*) AS count FROM qloo_resolutions').first()).count,19);
  assert.equal((await s.request('/api/reset',{method:'POST',cookie:a.cookie,csrf:a.csrf,body:{}})).status,429);
  assert.equal((await s.DB.prepare('SELECT COUNT(*) AS count FROM web_sessions').first()).count,1);
  assert.equal(s.calls(),0);
}finally{s.DB.close();}});

test('global fixture admission is capped before new peer buckets and cannot be bypassed by rotating edge addresses',async()=>{const s=setup();try{
  Object.assign(s.env,{LOCAL_PREVIEW:'false',JUDGE_PASSWORD:'synthetic-resource-key-1234'});
  for(let i=0;i<200;i++)assert.equal((await s.request('/api/session',{method:'POST',peer:'203.0.113.'+(i+1),body:{mode:'fixture'}})).status,200);
  s.restart();
  assert.equal((await s.request('/api/session',{method:'POST',peer:'198.51.100.1',body:{mode:'fixture'}})).status,429);
  const rows=(await s.DB.prepare('SELECT bucket,attempts FROM web_unlock_budget').all()).results;
  assert.equal(rows.filter(row=>row.bucket.startsWith('fixture-global:')).length,1);
  assert.equal(rows.find(row=>row.bucket.startsWith('fixture-global:')).attempts,200);
  assert.equal(rows.filter(row=>row.bucket.startsWith('fixture-peer:')).length,200);
  assert.ok(rows.every(row=>!row.bucket.includes('203.0.113.')&&!row.bucket.includes('198.51.100.')));
  assert.equal((await s.DB.prepare('SELECT COUNT(*) AS count FROM web_sessions').first()).count,200);
  assert.equal(s.calls(),0);
}finally{s.DB.close();}});

test('bounded expiry cleanup removes transient caches but preserves active choices and the upstream ledger',async()=>{const s=setup();try{
  const a=await start(s),post=(path,body)=>s.request(path,{method:'POST',cookie:a.cookie,csrf:a.csrf,body}).then(r=>r.json());
  const found=await post('/api/resolve',{query:'quiet'}),chosen=await post('/api/confirm',{resolution_id:found.resolution_id,tag_id:found.candidates[0].id});
  await post('/api/recommend',{receipt:chosen.receipt,target_type:'movie',limit:3});
  const old=s.time.at-1,created=old-900000;
  for(let i=0;i<30;i++){
    const id=(i+1).toString(16).padStart(32,'0'),resolution='expired-resolution-'+i,receipt='expired-receipt-'+i;
    await s.DB.prepare('INSERT INTO web_sessions(id,csrf,mode,expires) VALUES(?,?,?,?)').bind(id,'synthetic-expired','fixture',old).run();
    await s.DB.prepare('INSERT INTO qloo_sessions(session_id,mode,expires_at,created_at) VALUES(?,?,?,?)').bind(id,'fixture',old,created).run();
    await s.DB.prepare('INSERT INTO qloo_resolutions(resolution_id,session_id,candidates_json,expires_at) VALUES(?,?,?,?)').bind(resolution,id,'[]',old).run();
    await s.DB.prepare('INSERT INTO qloo_receipts(receipt,session_id,resolution_id,tag_id,tag_name,expires_at,state,result_json) VALUES(?,?,?,?,?,?,?,?)').bind(receipt,id,resolution,'urn:tag:synthetic:expired','Synthetic expired fixture',old,'complete','{"synthetic":true}').run();
    await s.DB.prepare('INSERT INTO web_unlock_budget(bucket,window_start,attempts) VALUES(?,?,?)').bind('expired-rate-'+i,s.time.at-900000,1).run();
  }
  const live='e'.repeat(32);
  await s.DB.prepare('INSERT INTO qloo_sessions(session_id,mode,expires_at,created_at) VALUES(?,?,?,?)').bind(live,'live',old,created).run();
  await s.DB.prepare('INSERT INTO web_sessions(id,csrf,mode,expires) VALUES(?,?,?,?)').bind(live,'synthetic-live','live',old).run();
  await s.DB.prepare('INSERT INTO qloo_policies(policy_id,expires_at,max_http_attempts,used,created_at) VALUES(?,?,?,?,?)').bind('synthetic-preserved-policy',Date.parse('2026-11-06T04:45:00Z'),64,2,created).run();
  for(const [reservation,endpoint] of [['synthetic-reservation-tags','/v2/tags'],['synthetic-reservation-insights','/v2/insights']])await s.DB.prepare('INSERT INTO qloo_attempts(reservation_id,policy_id,session_id,endpoint,created_at,status) VALUES(?,?,?,?,?,?)').bind(reservation,'synthetic-preserved-policy',live,endpoint,created,200).run();
  const policiesBefore=JSON.stringify((await s.DB.prepare('SELECT * FROM qloo_policies').all()).results);
  const attemptsBefore=JSON.stringify((await s.DB.prepare('SELECT * FROM qloo_attempts ORDER BY reservation_id').all()).results);
  assert.equal((await post('/api/resolve',{query:'another quiet taste'})).status,'needs_confirmation');
  assert.equal((await s.DB.prepare('SELECT COUNT(*) AS count FROM qloo_receipts WHERE expires_at<=?').bind(s.time.at).first()).count,5);
  assert.equal((await s.DB.prepare('SELECT COUNT(*) AS count FROM qloo_resolutions WHERE expires_at<=?').bind(s.time.at).first()).count,5);
  assert.equal((await s.DB.prepare('SELECT COUNT(*) AS count FROM web_sessions WHERE expires<=?').bind(s.time.at).first()).count,6);
  assert.equal((await s.DB.prepare("SELECT COUNT(*) AS count FROM web_unlock_budget WHERE bucket LIKE 'expired-rate-%'").first()).count,5);
  assert.ok(await s.DB.prepare('SELECT session_id FROM qloo_sessions WHERE session_id=?').bind(live).first(),'ledger-referenced session is retained');
  assert.equal((await post('/api/recommend',{receipt:chosen.receipt,target_type:'movie',limit:3})).cached_receipt_replay,true);
  assert.equal(JSON.stringify((await s.DB.prepare('SELECT * FROM qloo_policies').all()).results),policiesBefore);
  assert.equal(JSON.stringify((await s.DB.prepare('SELECT * FROM qloo_attempts ORDER BY reservation_id').all()).results),attemptsBefore);
  assert.equal(s.calls(),0);
}finally{s.DB.close();}});
