import {createServer} from 'node:http';
import {createReadStream,existsSync,statSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {createStore} from './store.mjs';
import {StoreError} from './core/errors.mjs';
import {handleMcp} from './mcp.mjs';

const digest=v=>createHash('sha256').update(v).digest();

// body 体积上限：普通写入 220KB / 登录 4KB / 导入 8MB / MCP 4MB
const WRITE_LIMIT=220000,LOGIN_LIMIT=4096,IMPORT_LIMIT=8*1024*1024,MCP_LIMIT=4*1024*1024;

/**
 * HTTP 应用：安全头 + HMAC 会话 + REST API（store facade）+ 静态服务。
 * 错误契约：StoreError.code → NOT_FOUND:404 / INVALID:400 / CONFLICT:409（附 current）/
 * 其他 → 400；响应统一为 {error:{code,message,current?}}；
 * 非 StoreError 的意外异常 → 500 {error:{code:'INTERNAL',message:'服务器内部错误'}}，不泄露堆栈。
 */
export function createApp({dbPath,dataDir,username,password,sessionSecret,distPath=resolve('dist'),seed=true}){
 if(!username||username.includes(':')||!password||password.length<8)throw new Error('请设置 APP_USERNAME 和至少 8 位的 APP_PASSWORD（用户名不能包含冒号）');
 const store=createStore(dbPath,{seed,dataDir});
 const expected=digest(`${username}:${password}`);
 // 会话为无状态 HMAC 令牌「签发时间.过期时间.签名」：显式 sessionSecret 优先作密钥，
 // 否则由凭据派生（改密码即令全部旧会话失效）。
 const SESSION_COOKIE='ci_session',SESSION_SECONDS=30*24*3600;
 const sessionKey=sessionSecret?digest(`ci-notes-session-v1:${sessionSecret}`):createHmac('sha256',expected).update('ci-notes-session-v1').digest();
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
 const readRaw=async(req,limit)=>{let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>limit)return{status:413,error:'内容过大'};chunks.push(c);}return{body:Buffer.concat(chunks).toString('utf8')};};
 const readJson=async(req,limit)=>{const r=await readRaw(req,limit);if(r.status)return r;try{return{body:JSON.parse(r.body)};}catch{return{status:400,error:'JSON 格式不正确'};}};
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
 // StoreError → HTTP 状态与 {error:{code,message,current?}} 响应体
 const fail=(res,e)=>{
  const status=e.code==='NOT_FOUND'?404:e.code==='CONFLICT'?409:400;
  const error={code:e.code,message:e.message};
  if(e.code==='CONFLICT'&&e.current!==undefined)error.current=e.current;
  return json(res,status,{error});
 };
 // PUT body 约定：{...(payload 字段), baseRevision, force?} —— 拆出并发控制字段后透传 store；
 // force 仅在 body.force===true 时传递（前端冲突三选一「保留我的」才发 force）
 const casArgs=body=>{
  const {baseRevision,force,...patch}=body;
  const opts={baseRevision};
  if(force===true)opts.force=true;
  return [patch,opts];
 };
 // 布尔查询参数：'true'/'1' → true，其余原样透传
 const withBool=(q,key)=>q[key]===undefined?q:{...q,[key]:q[key]==='true'||q[key]==='1'};

 /**
  * /api 路由表：按序正则匹配，:id 取捕获组。
  * handler 签名 (res, params, body, query)；limit 为 JSON body 体积上限。
  * compare 等固定路径段必须排在 :id 通配之前。
  */
 const routes=[
  /* ---------------- 词作 ---------------- */
  {method:'GET',pattern:/^\/api\/works$/,handler:(res,_p,_b,q)=>json(res,200,store.listWorks(q))},
  {method:'POST',pattern:/^\/api\/works$/,limit:WRITE_LIMIT,handler:(res,_p,b)=>json(res,201,store.createWork(b))},
  {method:'GET',pattern:/^\/api\/works\/([^/]+)$/,handler:(res,[id])=>json(res,200,store.getWork(id))},
  {method:'PUT',pattern:/^\/api\/works\/([^/]+)$/,limit:WRITE_LIMIT,handler:(res,[id],b)=>json(res,200,store.updateWork(id,...casArgs(b)))},
  {method:'DELETE',pattern:/^\/api\/works\/([^/]+)$/,handler:(res,[id])=>{store.trashWork(id);return json(res,200,{trashed:true});}},

  /* ---------------- 札记与版本 ---------------- */
  {method:'GET',pattern:/^\/api\/notes$/,handler:(res,_p,_b,q)=>json(res,200,store.listNotes(q))},
  {method:'POST',pattern:/^\/api\/notes$/,limit:WRITE_LIMIT,handler:(res,_p,b)=>json(res,201,store.createNote(b))},
  {method:'GET',pattern:/^\/api\/notes\/([^/]+)$/,handler:(res,[id])=>json(res,200,store.getNote(id))},
  // saveNote 透传：正常 {note,revision,createdDraft:false}；protected → {createdDraft:true,note,draft}
  {method:'PUT',pattern:/^\/api\/notes\/([^/]+)$/,limit:WRITE_LIMIT,handler:(res,[id],b)=>json(res,200,store.saveNote(id,...casArgs(b)))},
  {method:'DELETE',pattern:/^\/api\/notes\/([^/]+)$/,handler:(res,[id])=>{store.trashNote(id);return json(res,200,{trashed:true});}},
  {method:'GET',pattern:/^\/api\/notes\/([^/]+)\/revisions$/,handler:(res,[id])=>json(res,200,store.listRevisions(id))},
  {method:'GET',pattern:/^\/api\/notes\/([^/]+)\/revisions\/compare$/,handler:(res,[id],_b,q)=>json(res,200,store.compareRevisions(id,q.a,q.b))},
  {method:'POST',pattern:/^\/api\/notes\/([^/]+)\/revisions\/([^/]+)\/restore$/,handler:(res,[id,rid])=>json(res,201,store.restoreRevision(id,rid))},
  {method:'POST',pattern:/^\/api\/notes\/([^/]+)\/unprotect$/,handler:(res,[id])=>json(res,200,store.unprotectNote(id))},

  /* ---------------- 词作对照 ---------------- */
  {method:'GET',pattern:/^\/api\/comparisons$/,handler:res=>json(res,200,store.listComparisons())},
  // save 兼创建：body 带 id 视为整体覆盖（200），否则新建（201）
  {method:'POST',pattern:/^\/api\/comparisons$/,limit:WRITE_LIMIT,handler:(res,_p,b)=>json(res,b&&b.id?200:201,store.saveComparison(b))},
  {method:'GET',pattern:/^\/api\/comparisons\/([^/]+)$/,handler:(res,[id])=>json(res,200,store.getComparison(id))},
  {method:'PUT',pattern:/^\/api\/comparisons\/([^/]+)$/,limit:WRITE_LIMIT,handler:(res,[id],b)=>json(res,200,store.saveComparison({...b,id}))},
  {method:'DELETE',pattern:/^\/api\/comparisons\/([^/]+)$/,handler:(res,[id])=>json(res,200,store.deleteComparison(id))},

  /* ---------------- 意象库 ---------------- */
  {method:'GET',pattern:/^\/api\/imagery$/,handler:(res,_p,_b,q)=>json(res,200,store.listImagery(withBool(q,'includeMerged')))},
  {method:'POST',pattern:/^\/api\/imagery$/,limit:WRITE_LIMIT,handler:(res,_p,b)=>json(res,201,store.createImagery(b))},
  {method:'GET',pattern:/^\/api\/imagery\/compare$/,handler:(res,_p,_b,q)=>json(res,200,store.compareImagery(q.a,q.b))},
  {method:'GET',pattern:/^\/api\/imagery\/([^/]+)$/,handler:(res,[id],_b,q)=>json(res,200,store.getImagery(id,q))},
  {method:'PUT',pattern:/^\/api\/imagery\/([^/]+)$/,limit:WRITE_LIMIT,handler:(res,[id],b)=>json(res,200,store.updateImagery(id,...casArgs(b)))},
  {method:'DELETE',pattern:/^\/api\/imagery\/([^/]+)$/,handler:(res,[id])=>json(res,200,store.deleteImagery(id))},
  {method:'POST',pattern:/^\/api\/imagery\/([^/]+)\/merge$/,limit:WRITE_LIMIT,handler:(res,[id],b)=>{
   const intoId=String((b&&b.intoId)??'').trim();
   if(!intoId)throw new StoreError('INVALID','缺少 intoId');
   return json(res,200,store.mergeImagery(id,intoId));
  }},
  {method:'GET',pattern:/^\/api\/imagery\/([^/]+)\/impact$/,handler:(res,[id])=>json(res,200,store.imageryImpact(id))},

  /* ---------------- 意象使用记录 ---------------- */
  {method:'GET',pattern:/^\/api\/imagery-uses$/,handler:(res,_p,_b,q)=>json(res,200,store.listImageryUses(q))},
  {method:'POST',pattern:/^\/api\/imagery-uses$/,limit:WRITE_LIMIT,handler:(res,_p,b)=>json(res,201,store.createImageryUse(b))},
  {method:'PUT',pattern:/^\/api\/imagery-uses\/([^/]+)$/,limit:WRITE_LIMIT,handler:(res,[id],b)=>json(res,200,store.updateImageryUse(id,...casArgs(b)))},
  {method:'DELETE',pattern:/^\/api\/imagery-uses\/([^/]+)$/,handler:(res,[id])=>json(res,200,store.deleteImageryUse(id))},

  /* ---------------- 典故库（与意象对称，表达作用字段为 interpretation） ---------------- */
  {method:'GET',pattern:/^\/api\/allusions$/,handler:(res,_p,_b,q)=>json(res,200,store.listAllusions(withBool(q,'includeMerged')))},
  {method:'POST',pattern:/^\/api\/allusions$/,limit:WRITE_LIMIT,handler:(res,_p,b)=>json(res,201,store.createAllusion(b))},
  {method:'GET',pattern:/^\/api\/allusions\/compare$/,handler:(res,_p,_b,q)=>json(res,200,store.compareAllusions(q.a,q.b))},
  {method:'GET',pattern:/^\/api\/allusions\/([^/]+)$/,handler:(res,[id],_b,q)=>json(res,200,store.getAllusion(id,q))},
  {method:'PUT',pattern:/^\/api\/allusions\/([^/]+)$/,limit:WRITE_LIMIT,handler:(res,[id],b)=>json(res,200,store.updateAllusion(id,...casArgs(b)))},
  {method:'DELETE',pattern:/^\/api\/allusions\/([^/]+)$/,handler:(res,[id])=>json(res,200,store.deleteAllusion(id))},
  {method:'POST',pattern:/^\/api\/allusions\/([^/]+)\/merge$/,limit:WRITE_LIMIT,handler:(res,[id],b)=>{
   const intoId=String((b&&b.intoId)??'').trim();
   if(!intoId)throw new StoreError('INVALID','缺少 intoId');
   return json(res,200,store.mergeAllusion(id,intoId));
  }},
  {method:'GET',pattern:/^\/api\/allusions\/([^/]+)\/impact$/,handler:(res,[id])=>json(res,200,store.allusionImpact(id))},

  /* ---------------- 典故使用记录 ---------------- */
  {method:'GET',pattern:/^\/api\/allusion-uses$/,handler:(res,_p,_b,q)=>json(res,200,store.listAllusionUses(q))},
  {method:'POST',pattern:/^\/api\/allusion-uses$/,limit:WRITE_LIMIT,handler:(res,_p,b)=>json(res,201,store.createAllusionUse(b))},
  {method:'PUT',pattern:/^\/api\/allusion-uses\/([^/]+)$/,limit:WRITE_LIMIT,handler:(res,[id],b)=>json(res,200,store.updateAllusionUse(id,...casArgs(b)))},
  {method:'DELETE',pattern:/^\/api\/allusion-uses\/([^/]+)$/,handler:(res,[id])=>json(res,200,store.deleteAllusionUse(id))},

  /* ---------------- 聚合 / 搜索 / 统计 ---------------- */
  {method:'GET',pattern:/^\/api\/home$/,handler:res=>json(res,200,store.getHome())},
  {method:'GET',pattern:/^\/api\/search$/,handler:(res,_p,_b,q)=>json(res,200,store.globalSearch(q.q))},
  {method:'GET',pattern:/^\/api\/stats$/,handler:res=>json(res,200,store.getStats())},

  /* ---------------- 备份与导入 ---------------- */
  {method:'GET',pattern:/^\/api\/export$/,handler:res=>{
   res.setHeader('Content-Disposition','attachment; filename="ci-notes-backup.json"');
   return json(res,200,store.buildBackup());
  }},
  {method:'POST',pattern:/^\/api\/import$/,limit:IMPORT_LIMIT,handler:(res,_p,b)=>{
   if(b&&b.mode==='preflight')return json(res,200,store.preflightImport(b.backup));
   if(b&&b.mode==='merge')return json(res,200,store.mergeImport(b.backup));
   throw new StoreError('INVALID','mode 必须是 preflight 或 merge');
  }},

  /* ---------------- 回收站 ---------------- */
  {method:'GET',pattern:/^\/api\/trash$/,handler:res=>json(res,200,store.listTrash())},
  {method:'POST',pattern:/^\/api\/trash\/([^/]+)\/restore$/,handler:(res,[id])=>json(res,200,store.restoreTrash(id))},
  {method:'DELETE',pattern:/^\/api\/trash\/([^/]+)$/,handler:(res,[id])=>json(res,200,store.purgeTrash(id))},

  /* ---------------- MCP 密钥 ---------------- */
  {method:'GET',pattern:/^\/api\/mcp-keys$/,handler:res=>json(res,200,store.listMcpKeys())},
  {method:'POST',pattern:/^\/api\/mcp-keys$/,limit:WRITE_LIMIT,handler:(res,_p,b)=>{
   const name=String((b&&b.name)??'').trim();
   if(!name)throw new StoreError('INVALID','密钥名称不能为空');
   return json(res,201,store.createMcpKey(name)); // {key, record}，明文仅此一次
  }},
  {method:'POST',pattern:/^\/api\/mcp-keys\/([^/]+)\/revoke$/,handler:(res,[id])=>{store.revokeMcpKey(id);return json(res,200,{ok:true});}},
  {method:'POST',pattern:/^\/api\/mcp-keys\/([^/]+)\/enable$/,handler:(res,[id])=>{store.enableMcpKey(id);return json(res,200,{ok:true});}},
 ];

 const server=createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  const url=new URL(req.url,'http://localhost');
  try{
   if(url.pathname==='/api/health'&&req.method==='GET'){try{store.getStats();json(res,200,{ok:true});}catch{json(res,503,{ok:false});}return;}
   if(req.method==='POST'&&url.pathname==='/api/login'){
    const site=crossSiteError(req);if(site)return json(res,403,{error:{code:'FORBIDDEN',message:site}});
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))return json(res,415,{error:{code:'UNSUPPORTED_MEDIA_TYPE',message:'只接受 JSON'}});
    const {body,status,error}=await readJson(req,LOGIN_LIMIT);if(status)return json(res,status,{error:{code:status===413?'TOO_LARGE':'INVALID',message:error}});
    const given=digest(`${String(body?.username??'')}:${String(body?.password??'')}`);
    if(given.length===expected.length&&timingSafeEqual(given,expected)){
     const attrs=[`${SESSION_COOKIE}=${issueToken()};HttpOnly;SameSite=Strict;Path=/;Max-Age=${SESSION_SECONDS}`];
     if(req.headers['x-forwarded-proto']==='https')attrs.push('Secure');
     res.setHeader('Set-Cookie',attrs.join(';'));return json(res,200,{ok:true});
    }
    await new Promise(r=>setTimeout(r,800)); // 失败固定延迟，增加在线爆破成本
    return json(res,401,{error:{code:'UNAUTHORIZED',message:'用户名或密码不正确'}});
   }
   if(req.method==='POST'&&url.pathname==='/api/logout'){res.setHeader('Set-Cookie',`${SESSION_COOKIE}=;HttpOnly;SameSite=Strict;Path=/;Max-Age=0`);revokedBefore=Date.now();return json(res,200,{ok:true});}
   if(url.pathname.startsWith('/api/')){
    if(!validToken(cookieValue(req,SESSION_COOKIE)))return json(res,401,{error:{code:'UNAUTHORIZED',message:'请登录词间'}});
    // 顺序匹配：path 命中而 method 不中 → 405，否则 404
    let pathMatched=false,route=null,params=null;
    for(const r of routes){
     const m=r.pattern.exec(url.pathname);
     if(!m)continue;
     pathMatched=true;
     if(r.method!==req.method)continue;
     route=r;params=m.slice(1);break;
    }
    if(!route)return json(res,pathMatched?405:404,{error:{code:pathMatched?'METHOD_NOT_ALLOWED':'NOT_FOUND',message:pathMatched?'不支持的请求方法':'接口不存在'}});
    if(req.method!=='GET'&&req.method!=='HEAD'){
     const site=crossSiteError(req);
     if(site)return json(res,403,{error:{code:'FORBIDDEN',message:site}});
    }
    let body;
    if(route.limit!==undefined){
     if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))return json(res,415,{error:{code:'UNSUPPORTED_MEDIA_TYPE',message:'只接受 JSON'}});
     const parsed=await readJson(req,route.limit);
     if(parsed.status)return json(res,parsed.status,{error:{code:parsed.status===413?'TOO_LARGE':'INVALID',message:parsed.error}});
     body=parsed.body;
    }
    return route.handler(res,params,body,Object.fromEntries(url.searchParams));
   }
   // MCP 端点：不走会话守卫，密钥鉴权与传输防护在 mcp.mjs 内部
   if(url.pathname==='/mcp'){
    let raw;
    if(req.method==='POST'){
     const parsed=await readRaw(req,MCP_LIMIT);
     if(parsed.status)return json(res,parsed.status,{error:{code:parsed.status===413?'TOO_LARGE':'INVALID',message:parsed.error}});
     raw=parsed.body;
    }
    return handleMcp(req,res,store,raw);
   }
   if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'不支持的请求方法'});
   let relative;
   try{relative=decodeURIComponent(url.pathname).replace(/^\/+/, '');}catch{return json(res,400,{error:'URL 编码非法'});}
   const path=resolve(distPath,relative||'index.html');
   if(!path.startsWith(resolve(distPath)+'/'))return json(res,403,{error:'禁止访问'});
   if(!existsSync(path)||!statSync(path).isFile())return json(res,404,{error:'页面不存在'});
   const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2','.webp':'image/webp'};
   res.setHeader('Content-Type',types[extname(path)]??'application/octet-stream');
   if(req.method==='HEAD')return res.end();
   createReadStream(path).on('error',()=>res.destroy()).pipe(res);
  }catch(e){
   if(e instanceof StoreError)return fail(res,e);
   console.error('Request failed:',e.message);
   if(!res.headersSent)json(res,500,{error:{code:'INTERNAL',message:'服务器内部错误'}});else res.destroy();
  }
 });
 return {server,store};
}
