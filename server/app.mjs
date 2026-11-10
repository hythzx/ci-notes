import {createServer} from 'node:http';
import {createReadStream,existsSync,statSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {createHash,timingSafeEqual} from 'node:crypto';
import {openStore} from './store.mjs';
const digest=v=>createHash('sha256').update(v).digest();
export function createApp({databasePath,username,password,distPath=resolve('dist'),seed=true}){
 if(!username||username.includes(':')||!password||password.length<12)throw new Error('请设置 APP_USERNAME 和至少 12 位的 APP_PASSWORD（用户名不能包含冒号）');
 const store=openStore(databasePath,{seed});
 const expected=digest(`${username}:${password}`);
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
 const server=createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/health'&&req.method==='GET'){try{store.db.prepare('SELECT 1').get();json(res,200,{ok:true});}catch{json(res,503,{ok:false});}return;}
  const auth=req.headers.authorization??'';
  if(!auth.startsWith('Basic ')||!timingSafeEqual(expected,digest(Buffer.from(auth.slice(6),'base64').toString('utf8')))){
   res.setHeader('WWW-Authenticate','Basic realm="Ci Notes", charset="UTF-8"');json(res,401,{error:'请登录词间'});return;
  }
  try{
   if(req.method==='GET'&&url.pathname==='/api/notes')return json(res,200,store.list());
   if(req.method==='GET'&&url.pathname==='/api/export'){res.setHeader('Content-Disposition','attachment; filename="ci-notes-backup.json"');return json(res,200,store.export());}
   if(req.method==='POST'&&url.pathname==='/api/notes'){
    if(req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'不允许跨站写入'});
    if(req.headers.origin){let origin;try{origin=new URL(req.headers.origin);}catch{return json(res,403,{error:'无效的请求来源'});}if(origin.host!==req.headers.host)return json(res,403,{error:'不允许跨站写入'});}
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))return json(res,415,{error:'只接受 JSON'});
    let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>220000){json(res,413,{error:'内容过大'});return;}chunks.push(c);}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return json(res,400,{error:'JSON 格式不正确'});}
    try{return json(res,201,store.save(body,body.expectedSeq));}catch(e){return json(res,e.status??400,{error:e.message});}
   }
   if(url.pathname.startsWith('/api/'))return json(res,404,{error:'接口不存在'});
   if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'不支持的请求方法'});
   const relative=decodeURIComponent(url.pathname).replace(/^\/+/, '');
   const path=resolve(distPath,relative||'index.html');
   if(!path.startsWith(resolve(distPath)+'/'))return json(res,403,{error:'禁止访问'});
   if(!existsSync(path)||!statSync(path).isFile())return json(res,404,{error:'页面不存在'});
   const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2'};
   res.setHeader('Content-Type',types[extname(path)]??'application/octet-stream');
   if(req.method==='HEAD')return res.end();
   createReadStream(path).on('error',()=>res.destroy()).pipe(res);
  }catch(e){console.error('Request failed:',e.message);if(!res.headersSent)json(res,500,{error:'服务暂不可用，未保存的文字请保留'});else res.destroy();}
 });
 return {server,store};
}
