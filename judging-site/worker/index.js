import { createWorkflow } from '../src/backend.mjs';
import { PAGE } from '../src/page.generated.mjs';
const EVENT_ORIGIN='https://hackathon.api.qloo.com',END=Date.parse('2026-11-06T04:45:00Z'),TTL=900000;
function token(bytes=24){return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');}
function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
function error(code,message=code){return {status:'error',error:{code,message}};}
async function unlockBucket(request,env,local,at){
  const candidate=local?null:request.headers.get('CF-Connecting-IP');
  const peer=/^[a-f0-9.:]{2,64}$/i.test(candidate||'')?candidate:'shared-no-edge-address';
  const windowStart=Math.floor(at/300000)*300000,encoder=new TextEncoder();
  const key=await crypto.subtle.importKey('raw',encoder.encode(env.JUDGE_PASSWORD),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const digest=await crypto.subtle.sign('HMAC',key,encoder.encode(env.QLOO_POLICY_ID+'|'+peer+'|'+windowStart));
  return {bucket:[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join(''),windowStart};
}
const FIXTURE_WINDOW=300000,FIXTURE_PEER_LIMIT=20,FIXTURE_GLOBAL_LIMIT=200,CLEANUP_LIMIT=25;
async function fixturePeerBucket(request,env,local,at){
  // A fixture-only local install needs no secret. Without a server-held key,
  // use a shared bucket instead of storing a guessable hash of a raw address.
  if(local||typeof env.JUDGE_PASSWORD!=='string'||env.JUDGE_PASSWORD.length<16)return 'fixture-peer:shared:'+Math.floor(at/FIXTURE_WINDOW);
  const namespaced={JUDGE_PASSWORD:env.JUDGE_PASSWORD,QLOO_POLICY_ID:'fixture-resource-v1'};
  return 'fixture-peer:'+(await unlockBucket(request,namespaced,false,at)).bucket;
}
async function fixtureAllowance(request,env,local,at){
  const windowStart=Math.floor(at/FIXTURE_WINDOW)*FIXTURE_WINDOW;
  const peer=await fixturePeerBucket(request,env,local,at);
  const previous=await env.DB.prepare('SELECT attempts FROM web_unlock_budget WHERE bucket=?').bind(peer).first();
  if(previous&&previous.attempts>=FIXTURE_PEER_LIMIT)return false;
  // Admit through one fixed global bucket BEFORE creating a per-peer row.
  // Unknown addresses cannot create an unbounded number of durable buckets.
  const reserve=(bucket,limit)=>env.DB.prepare('INSERT INTO web_unlock_budget (bucket,window_start,attempts) VALUES (?,?,1) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 WHERE attempts<? RETURNING attempts')
    .bind(bucket,windowStart,limit).first();
  if(!await reserve('fixture-global:'+windowStart,FIXTURE_GLOBAL_LIMIT))return false;
  return Boolean(await reserve(peer,FIXTURE_PEER_LIMIT));
}
async function cleanupExpired(env,at){
  // Delete at most 25 rows from each transient table per admitted fixture
  // request. Neither upstream attempt rows nor their policy are touched.
  const limit=CLEANUP_LIMIT,windowStart=Math.floor(at/FIXTURE_WINDOW)*FIXTURE_WINDOW;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM qloo_receipts WHERE receipt IN (SELECT receipt FROM qloo_receipts WHERE expires_at<=? OR session_id IN (SELECT session_id FROM qloo_sessions WHERE expires_at<=?) LIMIT ?)').bind(at,at,limit),
    env.DB.prepare('DELETE FROM qloo_resolutions WHERE resolution_id IN (SELECT resolution_id FROM qloo_resolutions WHERE (expires_at<=? OR session_id IN (SELECT session_id FROM qloo_sessions WHERE expires_at<=?)) AND NOT EXISTS (SELECT 1 FROM qloo_receipts r WHERE r.resolution_id=qloo_resolutions.resolution_id) LIMIT ?)').bind(at,at,limit),
    env.DB.prepare('DELETE FROM qloo_sessions WHERE session_id IN (SELECT session_id FROM qloo_sessions WHERE expires_at<=? AND NOT EXISTS (SELECT 1 FROM qloo_attempts a WHERE a.session_id=qloo_sessions.session_id) AND NOT EXISTS (SELECT 1 FROM qloo_resolutions r WHERE r.session_id=qloo_sessions.session_id) AND NOT EXISTS (SELECT 1 FROM qloo_receipts c WHERE c.session_id=qloo_sessions.session_id) LIMIT ?)').bind(at,limit),
    env.DB.prepare('DELETE FROM web_sessions WHERE id IN (SELECT id FROM web_sessions WHERE expires<=? LIMIT ?)').bind(at,limit),
    env.DB.prepare('DELETE FROM web_unlock_budget WHERE bucket IN (SELECT bucket FROM web_unlock_budget WHERE window_start<? LIMIT ?)').bind(windowStart-FIXTURE_WINDOW,limit),
  ]);
}
async function boundedBody(request){
  if(Number(request.headers.get('Content-Length'))>4096)throw Error('BODY_TOO_LARGE');
  if(!request.body)return '';
  const reader=request.body.getReader(),parts=[];let length=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;
    if(length>4096){await reader.cancel();throw Error('BODY_TOO_LARGE');}parts.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
function policyFor(env,at){
  const max=Number(env.QLOO_MAX_HTTP_ATTEMPTS),until=Date.parse(env.QLOO_VALID_UNTIL||''),id=env.QLOO_POLICY_ID||'';
  const valid=/^[A-Za-z0-9_-]{8,80}$/.test(id)&&Number.isInteger(max)&&max>0&&max<=256&&until>at&&until<=END
    &&env.QLOO_BASE_URL===EVENT_ORIGIN&&env.QLOO_TRUSTED_BASE_URL===EVENT_ORIGIN
    &&typeof env.QLOO_API_KEY==='string'&&/^[!-~]{10,1024}$/.test(env.QLOO_API_KEY)
    &&typeof env.JUDGE_PASSWORD==='string'&&env.JUDGE_PASSWORD.length>=16;
  return {id,enabled:env.QLOO_ENABLE_LIVE==='true'&&valid,
    validUntil:Number.isFinite(until)?new Date(until).toISOString():new Date(END).toISOString(),
    maxHttpAttempts:Number.isInteger(max)&&max>0&&max<=256?max:64};
}
export function createHandler({now=Date.now,fetchImpl=globalThis.fetch}={}){
  return async function handle(request,env){
    const url=new URL(request.url),at=now(),nonce=token(),local=env.LOCAL_PREVIEW==='true'&&url.hostname==='127.0.0.1';
    const cookieName=local?'qw_local':'__Host-qw';
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy':"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"};
    const reply=(body,status=200,extra={})=>new Response(JSON.stringify(body),{status,headers:{...headers,'Content-Type':'application/json; charset=utf-8',...extra}});
    const cookie=sid=>cookieName+'='+sid+'; Path=/; HttpOnly; SameSite=Strict; Max-Age=900'+(local?'':'; Secure');
    try{
      if(request.method==='GET'&&url.pathname==='/')return new Response(PAGE.replaceAll('__CSP_NONCE__',nonce),{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
      if(request.method==='GET'&&url.pathname==='/health')return reply({status:'ok',version:'qloo-workbench-web-1'});
      if(!url.pathname.startsWith('/api/'))return reply(error('NOT_FOUND'),404);
      if(!env.DB)return reply(error('STORAGE_UNAVAILABLE'),503);
      const found=(request.headers.get('Cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='));
      const sid=found?.slice(cookieName.length+1);
      const session=/^[a-f0-9]{32}$/.test(sid||'')?await env.DB.prepare('SELECT * FROM web_sessions WHERE id=?').bind(sid).first():null;
      const policy=policyFor(env,at),workflow=mode=>createWorkflow({db:env.DB,fetchImpl,apiKey:env.QLOO_API_KEY,now,mode,policy});
      const ready=async s=>({...await workflow(s.mode).readiness(s.id),csrf:s.csrf,authenticated:true,live_available:policy.enabled,session_expires_at:new Date(s.expires).toISOString()});
      if(request.method==='GET'&&url.pathname==='/api/readiness'){
        if(!session||session.expires<=at)return reply({status:'ok',authenticated:false,csrf:null,mode:'fixture',live_available:policy.enabled});
        return reply(await ready(session));
      }
      if(request.method!=='POST')return reply(error('METHOD_NOT_ALLOWED'),405,{'Allow':'GET, POST'});
      if(request.headers.get('Origin')!==url.origin)return reply(error('ORIGIN_REJECTED'),403);
      if(!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type')||''))return reply(error('JSON_REQUIRED'),415);
      let raw;try{raw=await boundedBody(request);}catch{return reply(error('BODY_TOO_LARGE'),413);}
      let body;try{body=JSON.parse(raw);}catch{return reply(error('INVALID_JSON'),400);}
      if(!body||typeof body!=='object'||Array.isArray(body))return reply(error('INVALID_INPUT'),400);
      const keys=allowed=>Object.keys(body).every(k=>allowed.includes(k));
      const fixtureGuard=async()=>{
        if(!await fixtureAllowance(request,env,local,at))return reply(error('FIXTURE_RATE_LIMIT','Fixture request limit reached (20 per connection bucket and 200 globally per five-minute window). Try again shortly.'),429,
          {'Retry-After':String(Math.max(1,Math.ceil(((Math.floor(at/FIXTURE_WINDOW)+1)*FIXTURE_WINDOW-at)/1000)))});
        await cleanupExpired(env,at);
        return null;
      };
      const newSession=async mode=>{
        const next={id:token(16),csrf:token(),mode,expires:at+TTL};
        await env.DB.prepare('INSERT INTO web_sessions (id,csrf,mode,expires) VALUES (?,?,?,?)').bind(next.id,next.csrf,next.mode,next.expires).run();
        return reply({status:'ok',csrf:next.csrf,readiness:await ready(next)},200,{'Set-Cookie':cookie(next.id)});
      };
      if(url.pathname==='/api/session'){
        if(!keys(['mode'])||body.mode!=='fixture')return reply(error('FIXTURE_SESSION_REQUIRED'),400);
        const limited=await fixtureGuard();if(limited)return limited;
        return await newSession('fixture');
      }
      if(!session)return reply(error('SESSION_REQUIRED','Start a new session.'),401);
      if(session.expires<=at)return reply(error('SESSION_EXPIRED','Your session expired. Start again.'),401);
      if(!equal(request.headers.get('X-CSRF-Token'),session.csrf))return reply(error('CSRF_REJECTED'),403);
      if(url.pathname==='/api/unlock'){
        if(!keys(['password'])||typeof body.password!=='string'||body.password.length>256)return reply(error('INVALID_INPUT'),400);
        if(session.locked_until>at)return reply(error('UNLOCK_RATE_LIMIT','Try again after five minutes.'),429);
        if(!policy.enabled)return reply(error('LIVE_NOT_ENABLED','Live access is not enabled or has closed.'),403);
        const bucket=await unlockBucket(request,env,local,at);
        await env.DB.prepare('DELETE FROM web_unlock_budget WHERE bucket IN (SELECT bucket FROM web_unlock_budget WHERE window_start<? LIMIT ?)').bind(bucket.windowStart-300000,CLEANUP_LIMIT).run();
        const attempt=await env.DB.prepare('INSERT INTO web_unlock_budget (bucket,window_start,attempts) VALUES (?,?,1) ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN attempts<26 THEN attempts+1 ELSE attempts END RETURNING attempts')
          .bind(bucket.bucket,bucket.windowStart).first();
        if(!attempt||attempt.attempts>25)return reply(error('UNLOCK_RATE_LIMIT','Too many access attempts. Try again in five minutes.'),429);
        if(!equal(body.password,env.JUDGE_PASSWORD)){
          await env.DB.prepare('UPDATE web_sessions SET attempts=attempts+1,locked_until=CASE WHEN attempts+1>=5 THEN ? ELSE 0 END WHERE id=?').bind(at+300000,session.id).run();
          return reply(error('ACCESS_CODE_INVALID','The access code did not match.'),403);
        }
        return await newSession('live');
      }
      if(session.mode==='fixture'&&['/api/resolve','/api/confirm','/api/recommend','/api/reset'].includes(url.pathname)){
        const limited=await fixtureGuard();if(limited)return limited;
      }
      const work=workflow(session.mode);let result;
      if(url.pathname==='/api/resolve'&&keys(['query']))result=await work.resolve(session.id,body.query);
      else if(url.pathname==='/api/confirm'&&keys(['resolution_id','tag_id']))result=await work.confirm(session.id,body.resolution_id,body.tag_id);
      else if(url.pathname==='/api/recommend'&&keys(['receipt','target_type','limit']))result=await work.recommend(session.id,body.receipt,body.target_type,body.limit);
      else if(url.pathname==='/api/reset'&&keys([])){await work.reset(session.id);return await newSession(session.mode);}
      else return reply(error('INVALID_ROUTE_OR_INPUT'),400);
      return reply({...result,csrf:session.csrf,readiness:await ready(session)});
    }catch{return reply(error('REQUEST_STOPPED','The request stopped safely. Start a new session before trying again.'),503);}
  };
}
export default {fetch:createHandler()};
