import {createServer} from 'node:http';
import {createReadStream,existsSync,statSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {openStore} from './store.mjs';
const digest=v=>createHash('sha256').update(v).digest();
export function createApp({databasePath,username,password,distPath=resolve('dist'),seed=true}){
 if(!username||username.includes(':')||!password||password.length<8)throw new Error('请设置 APP_USERNAME 和至少 8 位的 APP_PASSWORD（用户名不能包含冒号）');
 const store=openStore(databasePath,{seed});
 const expected=digest(`${username}:${password}`);
 // 会话为无状态 HMAC 令牌「签发时间.过期时间.签名」，密钥由凭据派生：改密码即令全部旧会话失效。
 const SESSION_COOKIE='ci_session',SESSION_SECONDS=30*24*3600;
 const sessionKey=createHmac('sha256',expected).update('ci-notes-session-v1').digest();
 let revokedBefore=0; // 登出使既有令牌即时失效（内存水印，重启后重置）
 const sessionMac=payload=>createHmac('sha256',sessionKey).update(payload).digest('base64url');
 const issueToken=()=>{const issued=Math.max(Date.now(),revokedBefore+1),expiry=issued+SESSION_SECONDS*1000;return `${issued}.${expiry}.${sessionMac(`${issued}.${expiry}`)}`;};
 const validToken=token=>{
  if(typeof token!=='string')return false;
  const [issued,expiry,mac]=token.split('.'),i=Number(issued),e=Number(expiry);
  if(!Number.isSafeInteger(i)||!Number.isSafeInteger(e)||e<=Date.now()||i<=revokedBefore)return false;
  const want=sessionMac(`${issued}.${expiry}`);
  return mac.length===want.length&&timingSafeEqual(Buffer.from(mac),Buffer.from(want));
 };
 const cookieValue=(req,name)=>{const header=req.headers.cookie;if(!header)return null;for(const part of header.split(';')){const eq=part.indexOf('=');if(eq>=0&&part.slice(0,eq).trim()===name)return part.slice(eq+1).trim();}return null;};
 const crossSiteError=req=>{
  if(req.headers['sec-fetch-site']==='cross-site')return '不允许跨站写入';
  if(req.headers.origin){let origin;try{origin=new URL(req.headers.origin);}catch{return '无效的请求来源';}if(origin.host!==req.headers.host)return '不允许跨站写入';}
  return null;
 };
 const readJson=async(req,limit)=>{let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>limit)return{status:413,error:'内容过大'};chunks.push(c);}try{return{body:JSON.parse(Buffer.concat(chunks).toString('utf8'))};}catch{return{status:400,error:'JSON 格式不正确'};}};
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
 const server=createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/health'&&req.method==='GET'){try{store.db.prepare('SELECT 1').get();json(res,200,{ok:true});}catch{json(res,503,{ok:false});}return;}
  try{
   if(req.method==='POST'&&url.pathname==='/api/login'){
    const site=crossSiteError(req);if(site)return json(res,403,{error:site});
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))return json(res,415,{error:'只接受 JSON'});
    const {body,status,error}=await readJson(req,4096);if(status)return json(res,status,{error});
    const given=digest(`${String(body?.username??'')}:${String(body?.password??'')}`);
    if(given.length===expected.length&&timingSafeEqual(given,expected)){
     const attrs=[`${SESSION_COOKIE}=${issueToken()};HttpOnly;SameSite=Strict;Path=/;Max-Age=${SESSION_SECONDS}`];
     if(req.headers['x-forwarded-proto']==='https')attrs.push('Secure');
     res.setHeader('Set-Cookie',attrs.join(';'));return json(res,200,{ok:true});
    }
    await new Promise(r=>setTimeout(r,800)); // 失败固定延迟，增加在线爆破成本
    return json(res,401,{error:'用户名或密码不正确'});
   }
   if(req.method==='POST'&&url.pathname==='/api/logout'){res.setHeader('Set-Cookie',`${SESSION_COOKIE}=;HttpOnly;SameSite=Strict;Path=/;Max-Age=0`);revokedBefore=Date.now();return json(res,200,{ok:true});}
   if(url.pathname.startsWith('/api/')&&!validToken(cookieValue(req,SESSION_COOKIE)))return json(res,401,{error:'请登录词间'});
   if(req.method==='GET'&&url.pathname==='/api/notes')return json(res,200,store.list());
   if(req.method==='GET'&&url.pathname==='/api/export'){res.setHeader('Content-Disposition','attachment; filename="ci-notes-backup.json"');return json(res,200,store.export());}
   if(req.method==='POST'&&url.pathname==='/api/notes'){
    const site=crossSiteError(req);if(site)return json(res,403,{error:site});
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))return json(res,415,{error:'只接受 JSON'});
    const {body,status,error}=await readJson(req,220000);if(status)return json(res,status,{error});
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
