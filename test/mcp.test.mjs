import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.mjs';

/**
 * /mcp 端点集成测试：Streamable HTTP JSON-RPC 传输 + 密钥鉴权 + 工具调用。
 *
 * 工具数说明：brief 汇总行写「正好 32 个」，但其工具表实有 33 行，且表下注记
 * delete_imagery 同 delete_allusion 模式、Task 计划「规格差异说明」亦确认两者均为
 * MCP 工具（imagery / allusions 两族对称应为 8+8）。故按表逐字实现 34 个工具，
 * 本文件断言 34。
 */

const USERNAME='admin',PASSWORD='test-password-long';
const PING={jsonrpc:'2.0',id:1,method:'ping'};

async function startApp(){
  const dir=mkdtempSync(join(tmpdir(),'ci-mcp-'));
  const app=createApp({dbPath:join(dir,'test.sqlite'),username:USERNAME,password:PASSWORD});
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const close=async()=>{
    await new Promise(r=>app.server.close(r));
    app.store.close();
    rmSync(dir,{recursive:true,force:true});
  };
  return {app,base,close};
}

/** 登录并创建一枚 MCP 密钥，返回明文与 record */
async function newKey(base){
  const login=await fetch(`${base}/api/login`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:USERNAME,password:PASSWORD}),
  });
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const created=await fetch(`${base}/api/mcp-keys`,{
    method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},
    body:JSON.stringify({name:'mcp-test'}),
  });
  const {key,record}=await created.json();
  return {key,record,cookie};
}

/** 发一次 JSON-RPC POST（默认 x-cinotes-key 头） */
function rpc(base,key,method,params,extra={}){
  const headers={'Content-Type':'application/json',...extra};
  if(key)headers['x-cinotes-key']=key;
  return fetch(`${base}/mcp`,{
    method:'POST',headers,
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),
  });
}

async function rpcJson(base,key,method,params,extra={}){
  const res=await rpc(base,key,method,params,extra);
  assert.equal(res.status,200);
  return res.json();
}

/** tools/call 助手：返回 result（断言无 JSON-RPC 层错误） */
async function call(base,key,name,arguments_,extra={}){
  const body=await rpcJson(base,key,'tools/call',{name,arguments:arguments_},extra);
  assert.equal(body.error,undefined);
  return body.result;
}
const toolText=result=>result.content[0].text;
/** 列表返回文本：跳过「共 N …」条数标题行后解析 JSON 正文 */
const listJson=text=>JSON.parse(text.slice(text.indexOf('\n')+1));
/** 从「…，ID：xxx」样式返回文本中取 ID */
const idFrom=text=>{
  const m=text.match(/ID：(\S+)$/);
  assert.ok(m,`返回文本缺少 ID：${text}`);
  return m[1];
};

// 1. 鉴权：无密钥 401/-32001、伪密钥 401 带诊断（不回显完整密钥）、
//    Bearer 头可用、JWT 形态跳过、touchMcpKey 刷新、撤销后 401
test('鉴权：无密钥 401、伪密钥带诊断、Bearer 可用、JWT 跳过、撤销后 401',async()=>{
  const {base,close}=await startApp();
  try{
    const none=await rpc(base,null,'ping');
    assert.equal(none.status,401);
    const noneBody=await none.json();
    assert.equal(noneBody.error.code,-32001);
    assert.equal(noneBody.error.message,'未提供有效密钥');

    const {key,record,cookie}=await newKey(base);

    const fake='cin_'+'0'.repeat(64);
    const fakeRes=await rpc(base,fake,'ping');
    assert.equal(fakeRes.status,401);
    const fakeText=await fakeRes.text();
    const fakeBody=JSON.parse(fakeText);
    assert.equal(fakeBody.error.code,-32001);
    assert.deepEqual(fakeBody.error.data,{keyLen:fake.length,keyHead:fake.slice(0,6),keyTail:fake.slice(-4)});
    assert.ok(!fakeText.includes(fake)); // 不回显完整密钥

    const bearer=await rpc(base,null,'ping',undefined,{Authorization:`Bearer ${key}`});
    assert.equal(bearer.status,200);
    assert.deepEqual((await bearer.json()).result,{});

    const jwt=await rpc(base,null,'ping',undefined,{Authorization:'Bearer eyJhbGciOiJFUzI1NiJ9.e30.sig'});
    assert.equal(jwt.status,401);

    const ok=await rpc(base,key,'ping');
    assert.equal(ok.status,200);
    const keys=await (await fetch(`${base}/api/mcp-keys`,{headers:{Cookie:cookie}})).json();
    assert.ok(keys.find(r=>r.id===record.id).lastUsedAt); // 命中后 touchMcpKey

    await fetch(`${base}/api/mcp-keys/${record.id}/revoke`,{method:'POST',headers:{Cookie:cookie}});
    assert.equal((await rpc(base,key,'ping')).status,401);
  }finally{await close();}
});

// 2. 协议方法：initialize、tools/list（34 个 + readOnlyHint + 关键描述）、
//    ping、resources/prompts 空表、未知方法 -32601、未知工具 -32602
test('协议：initialize、tools/list 34 个、ping、未知方法/工具',async()=>{
  const {base,close}=await startApp();
  try{
    const {key}=await newKey(base);
    const init=await rpcJson(base,key,'initialize',{protocolVersion:'2025-06-18'});
    assert.equal(init.result.serverInfo.name,'ci-notes');
    assert.equal(init.result.serverInfo.title,'词间笔记');
    assert.equal(init.result.protocolVersion,'2025-06-18');
    assert.ok(init.result.capabilities.tools);
    assert.match(init.result.instructions,/不要代写/);
    assert.match(init.result.instructions,/不要自己挑一个覆盖/);

    const tools=(await rpcJson(base,key,'tools/list')).result.tools;
    assert.equal(tools.length,34);
    const names=tools.map(t=>t.name);
    for(const n of ['list_works','get_work','create_work','update_work','delete_work',
      'list_notes','get_note','create_note','update_note','delete_note',
      'list_revisions','compare_revisions','restore_revision',
      'list_comparisons','save_comparison',
      'list_imagery','get_imagery','create_imagery','update_imagery','delete_imagery',
      'link_imagery','list_imagery_of','compare_imagery',
      'list_allusions','get_allusion','create_allusion','update_allusion','delete_allusion',
      'link_allusion','list_allusions_of','compare_allusions',
      'search','get_stats','export_backup']){
      assert.ok(names.includes(n),`缺少工具 ${n}`);
    }
    const byName=Object.fromEntries(tools.map(t=>[t.name,t]));
    for(const t of tools){
      assert.equal(t.inputSchema.type,'object');
      assert.equal(typeof t.annotations.readOnlyHint,'boolean');
    }
    for(const n of ['list_works','get_work','compare_revisions','compare_imagery','compare_allusions',
      'search','get_stats','export_backup']){
      assert.equal(byName[n].annotations.readOnlyHint,true,n);
    }
    for(const n of ['create_work','update_work','delete_work','update_note','restore_revision',
      'save_comparison','link_allusion','delete_allusion']){
      assert.equal(byName[n].annotations.readOnlyHint,false,n);
    }
    assert.match(byName.create_note.description,/不要代写/);
    assert.match(byName.create_imagery.description,/不要给意象定死含义/);
    assert.match(byName.create_allusion.description,/通用解释/);
    assert.match(byName.create_allusion.description,/link_allusion/);

    assert.deepEqual((await rpcJson(base,key,'ping')).result,{});
    assert.deepEqual((await rpcJson(base,key,'resources/list')).result,{resources:[]});
    assert.deepEqual((await rpcJson(base,key,'prompts/list')).result,{prompts:[]});
    assert.equal((await rpcJson(base,key,'no/such/method')).error.code,-32601);
    assert.equal((await rpcJson(base,key,'tools/call',{name:'nope',arguments:{}})).error.code,-32602);
  }finally{await close();}
});

// 3. 传输防护：协议版本头 400、Origin 不一致 403（一致放行）、坏 JSON -32700、
//    413 上限、GET 406/SSE 心跳、DELETE 204、POST SSE 单消息响应
test('传输：版本头 400、Origin 403、坏 JSON 400、413、GET SSE、DELETE 204、POST SSE',async()=>{
  const {base,close}=await startApp();
  try{
    const {key}=await newKey(base);
    const origin=new URL(base).origin;

    assert.equal((await rpc(base,key,'ping',undefined,{'MCP-Protocol-Version':'1999-01-01'})).status,400);
    assert.equal((await rpc(base,key,'ping',undefined,{Origin:'https://evil.example'})).status,403);
    assert.equal((await rpc(base,key,'ping',undefined,{Origin:origin})).status,200);

    const bad=await fetch(`${base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json','x-cinotes-key':key},body:'{oops'});
    assert.equal(bad.status,400);
    assert.equal((await bad.json()).error.code,-32700);

    const big=await rpc(base,key,'ping',{pad:'x'.repeat(4*1024*1024)});
    assert.equal(big.status,413);

    assert.equal((await fetch(`${base}/mcp`,{headers:{'x-cinotes-key':key}})).status,406);
    const ac=new AbortController();
    const kill=setTimeout(()=>ac.abort(),3000);
    const sse=await fetch(`${base}/mcp`,{headers:{'x-cinotes-key':key,'Accept':'text/event-stream'},signal:ac.signal});
    assert.equal(sse.status,200);
    assert.match(sse.headers.get('content-type'),/text\/event-stream/);
    const reader=sse.body.getReader();
    const first=await reader.read();
    assert.equal(Buffer.from(first.value).toString(),': ci-notes MCP 已连接\n\n');
    await reader.cancel();
    clearTimeout(kill);

    const del=await fetch(`${base}/mcp`,{method:'DELETE',headers:{'x-cinotes-key':key}});
    assert.equal(del.status,204);

    const ssePost=await fetch(`${base}/mcp`,{
      method:'POST',
      headers:{'Content-Type':'application/json','x-cinotes-key':key,'Accept':'text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:7,method:'ping'}),
    });
    assert.equal(ssePost.status,200);
    assert.match(ssePost.headers.get('content-type'),/text\/event-stream/);
    const raw=await ssePost.text();
    assert.match(raw,/^event: message\ndata: /);
    assert.match(raw,/\n\n$/);
    assert.deepEqual(JSON.parse(raw.replace(/^event: message\ndata: /,'').trim()),{jsonrpc:'2.0',id:7,result:{}});
  }finally{await close();}
});

// 4. works 往返：create → list/get 可见 → 过期 baseRevision → isError + CONFLICT 文案
test('works：create/list/get 往返、update 冲突 isError 含「不要自己挑一个覆盖」',async()=>{
  const {base,close}=await startApp();
  try{
    const {key}=await newKey(base);
    const created=await call(base,key,'create_work',{title:'雨霖铃',content:'寒蝉凄切',author:'柳永'});
    const id=idFrom(toolText(created));
    assert.match(toolText(created),/已录入词作《雨霖铃》/);

    const list=toolText(await call(base,key,'list_works',{q:'寒蝉'}));
    assert.match(list,/共 1 首词作/);
    assert.match(list,/雨霖铃/);

    const got=JSON.parse(toolText(await call(base,key,'get_work',{id})));
    assert.equal(got.work.content,'寒蝉凄切');
    assert.equal(got.work.revision,1);

    const conflict=await call(base,key,'update_work',{id,title:'并发稿',baseRevision:99});
    assert.equal(conflict.isError,true);
    const cText=toolText(conflict);
    assert.match(cText,/CONFLICT/);
    assert.match(cText,/把两版都读给用户听，由用户决定，不要自己挑一个覆盖/);
    assert.match(cText,/"title": "雨霖铃"/); // current JSON

    const ok=await call(base,key,'update_work',{id,title:'雨霖铃·改',baseRevision:1});
    assert.match(toolText(ok),/已更新词作《雨霖铃·改》/);
  }finally{await close();}
});

// 5. notes：create_note → 保存 → 定稿后 update_note 派生草稿（返回文本含新旧稿说明）
test('notes：创建保存、定稿后 update_note 返回「原稿未动，新草稿 id=…」',async()=>{
  const {base,close}=await startApp();
  try{
    const {key}=await newKey(base);
    const noteId=idFrom(toolText(await call(base,key,'create_note',{title:'读词笔记',content:'初读感受'})));

    assert.match(toolText(await call(base,key,'update_note',{id:noteId,content:'修改后的感受',baseRevision:1})),/已保存札记/);
    assert.match(toolText(await call(base,key,'update_note',{id:noteId,writingStatus:'final',baseRevision:2})),/已保存札记/);

    const derived=toolText(await call(base,key,'update_note',{id:noteId,content:'在定稿上继续写',baseRevision:3}));
    assert.match(derived,/原稿未动/);
    assert.match(derived,/新草稿 id=n_/);
    assert.ok(derived.includes(`（原稿 ID：${noteId}）`));

    const got=JSON.parse(toolText(await call(base,key,'get_note',{id:noteId})));
    assert.equal(got.note.content,'修改后的感受'); // 原稿逐字保留
    assert.equal(got.note.writingStatus,'final');
  }finally{await close();}
});

// 6. allusions：create → link（interpretation）→ list_allusions_of → compare_allusions
test('allusions：link_allusion + list_allusions_of + compare_allusions 往返',async()=>{
  const {base,close}=await startApp();
  try{
    const {key}=await newKey(base);
    const wa=idFrom(toolText(await call(base,key,'create_work',{title:'锦瑟',content:'庄生晓梦迷蝴蝶'})));
    const wb=idFrom(toolText(await call(base,key,'create_work',{title:'古风',content:'梦蝶无端'})));
    const alId=idFrom(toolText(await call(base,key,'create_allusion',{name:'庄周梦蝶',source:'庄子·齐物论',original:'昔者庄周梦为胡蝶'})));

    assert.match(toolText(await call(base,key,'link_allusion',{
      allusionId:alId,targetType:'work',targetId:wa,
      quote:'庄生晓梦迷蝴蝶',interpretation:'物我两忘',understanding:'迷惘人生如梦',
    })),/已记录这处典故用法/);
    await call(base,key,'link_allusion',{allusionId:alId,targetType:'work',targetId:wb,interpretation:'浮生若梦'});

    const uses=listJson(toolText(await call(base,key,'list_allusions_of',{targetType:'work',targetId:wa})));
    assert.equal(uses.length,1);
    assert.equal(uses[0].interpretation,'物我两忘');

    const cmp=JSON.parse(toolText(await call(base,key,'compare_allusions',{workAId:wa,workBId:wb})));
    assert.equal(cmp.shared.length,1);
    assert.equal(cmp.shared[0].allusion.name,'庄周梦蝶');
    assert.equal(cmp.onlyB.length,0);
  }finally{await close();}
});

// 7. imagery：link_imagery 的 function → payload fn、update_imagery 文案、
//    delete_imagery 先 impact 拼计数再删除、删除后 get 为 NOT_FOUND
test('imagery：function→fn 映射、update 文案、delete_imagery impact 提示',async()=>{
  const {base,close}=await startApp();
  try{
    const {key}=await newKey(base);
    const imId=idFrom(toolText(await call(base,key,'create_imagery',{name:'月'})));
    const wa=idFrom(toolText(await call(base,key,'create_work',{title:'水调歌头',content:'明月几时有'})));
    const wb=idFrom(toolText(await call(base,key,'create_work',{title:'静夜思',content:'床前明月光'})));

    assert.match(toolText(await call(base,key,'link_imagery',{
      imageryId:imId,targetType:'work',targetId:wa,quote:'明月几时有',function:'寄托思念',
    })),/已记录这处意象用法/);

    const uses=listJson(toolText(await call(base,key,'list_imagery_of',{targetType:'work',targetId:wa})));
    assert.equal(uses.length,1);
    assert.equal(uses[0].fn,'寄托思念'); // function 入参落到 payload fn

    const detail=JSON.parse(toolText(await call(base,key,'get_imagery',{id:imId})));
    assert.equal(detail.imagery.name,'月');
    assert.equal(detail.uses.length,1);

    const cmp=JSON.parse(toolText(await call(base,key,'compare_imagery',{workAId:wa,workBId:wb})));
    assert.equal(cmp.shared.length,0);
    assert.equal(cmp.onlyA[0].imagery.name,'月');

    assert.match(toolText(await call(base,key,'update_imagery',{id:imId,baseRevision:1,description:'思念的载体'})),/作品里的具体解读未受影响/);

    const del=toolText(await call(base,key,'delete_imagery',{id:imId}));
    assert.match(del,/删除了 1 条使用记录/);
    assert.match(del,/作品 1 首/);

    const gone=await call(base,key,'get_imagery',{id:imId});
    assert.equal(gone.isError,true);
    assert.match(toolText(gone),/NOT_FOUND/);
  }finally{await close();}
});

// 8. export_backup 返回文本 JSON.parse 后 format==='ci-notes-backup'；
//    delete_allusion 先 impact 拼计数再删除
test('export_backup 格式与 delete_allusion impact 提示',async()=>{
  const {base,close}=await startApp();
  try{
    const {key}=await newKey(base);
    const wa=idFrom(toolText(await call(base,key,'create_work',{title:'锦瑟',content:'庄生晓梦迷蝴蝶'})));
    const alId=idFrom(toolText(await call(base,key,'create_allusion',{name:'庄周梦蝶',source:'庄子·齐物论'})));
    await call(base,key,'link_allusion',{allusionId:alId,targetType:'work',targetId:wa,interpretation:'物我两忘'});

    const backup=JSON.parse(toolText(await call(base,key,'export_backup')));
    assert.equal(backup.format,'ci-notes-backup');
    assert.ok(backup.data.works.some(w=>w.title==='锦瑟')); // 种子库之外新建的词作已入备份
    assert.ok(backup.data.allusions.some(x=>x.id===alId));
    assert.equal(backup.counts.allusionUses,1);

    const del=toolText(await call(base,key,'delete_allusion',{id:alId}));
    assert.match(del,/删除了 1 条使用记录/);
    const gone=await call(base,key,'get_allusion',{id:alId});
    assert.equal(gone.isError,true);
    assert.match(toolText(gone),/NOT_FOUND/);
  }finally{await close();}
});
