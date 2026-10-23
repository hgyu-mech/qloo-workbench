import {createServer} from 'node:http';
import {readFile,mkdir,stat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createD1} from '../test/d1-shim.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(resolve(root,'.local'),{recursive:true});
const file=resolve(root,'.local/preview.sqlite');let exists=true;
try{await stat(file);}catch(e){if(e.code==='ENOENT')exists=false;else throw e;}
const sql=exists?undefined:(await readFile(resolve(root,'src/auth-schema.sql'),'utf8'))+'\n'+(await readFile(resolve(root,'src/schema.sql'),'utf8'));
const DB=createD1({filename:file,schemaSql:sql});
const worker=(await import(pathToFileURL(resolve(root,'dist/server/index.js')).href)).default;
const env={DB,LOCAL_PREVIEW:'true',QLOO_ENABLE_LIVE:'false'};
const server=createServer(async(req,res)=>{
  try{
    const chunks=[];let bytes=0;
    for await(const part of req){bytes+=part.length;if(bytes>4096){res.writeHead(413);res.end('Request too large');return;}chunks.push(part);}
    const method=req.method,body=['GET','HEAD'].includes(method)?undefined:Buffer.concat(chunks);
    const request=new Request('http://127.0.0.1:6162'+req.url,{method,headers:req.headers,body});
    const result=await worker.fetch(request,env,{});
    const headers=Object.fromEntries(result.headers);
    if(result.headers.getSetCookie?.().length)headers['set-cookie']=result.headers.getSetCookie();
    res.writeHead(result.status,headers);res.end(Buffer.from(await result.arrayBuffer()));
  }catch{res.writeHead(500);res.end('Local preview error');}
});
server.listen(6162,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:6162/ (invented fixtures; live API disabled)'));
const stop=()=>server.close(()=>{DB.close();process.exit(0);});
process.once('SIGINT',stop);process.once('SIGTERM',stop);
