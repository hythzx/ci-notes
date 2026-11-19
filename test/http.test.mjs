import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.mjs';

/**
 * REST API 全集的 HTTP 集成测试（替换旧 app.test.mjs）。
 * 约定：每个用例独立临时库 + 随机端口；登录取 Cookie 后携带 Cookie 调用。
 * 错误契约：{error:{code,message,current?}}；CONFLICT 409 附 current。
 */

const USERNAME='admin',PASSWORD='test-password-long';

async function startApp(){
  const dir=mkdtempSync(join(tmpdir(),'ci-http-'));
  // 自建 dist fixture：测试不依赖 vite 构建产物（CI 中 npm test 先于 npm run build，无 dist/）
  const dist=join(dir,'dist');
  mkdirSync(dist,{recursive:true});
  writeFileSync(join(dist,'index.html'),'<html>test-shell</html>');
  const app=createApp({dbPath:join(dir,'test.sqlite'),username:USERNAME,password:PASSWORD,distPath:dist});
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

/** 登录并返回 Cookie（沿用旧测试的 Set-Cookie 断言模式） */
async function loginCookie(base){
  const res=await fetch(`${base}/api/login`,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:USERNAME,password:PASSWORD}),
  });
  assert.equal(res.status,200);
  return res.headers.get('set-cookie').split(';')[0];
}

/** 已登录请求助手：body 传对象时自动 JSON 序列化 */
function apiOf(base,cookie){
  return (path,{method='GET',body,headers={}}={})=>{
    const h={Cookie:cookie,...headers};
    if(body!==undefined)h['Content-Type']='application/json';
    return fetch(base+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  };
}

// 1. health 公开、API 需登录、错密码 401
test('health 200；未登录 API 401；错密码 401',async()=>{
  const {base,close}=await startApp();
  try{
    const health=await fetch(`${base}/api/health`);
    assert.equal(health.status,200);
    assert.deepEqual(await health.json(),{ok:true});
    assert.equal((await fetch(`${base}/api/works`)).status,401);
    assert.equal((await fetch(`${base}/api/notes`)).status,401);
    const bad=await fetch(`${base}/api/login`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username:USERNAME,password:'wrong-password-long'}),
    });
    assert.equal(bad.status,401);
  }finally{await close();}
});

// 2. works：创建 → 列表含之 → baseRevision 过期 409 附 current.title → force 覆盖成功
test('works：创建、列表、CAS 409 附 current、force 覆盖',async()=>{
  const {base,close}=await startApp();
  try{
    const api=apiOf(base,await loginCookie(base));
    const created=await api('/api/works',{method:'POST',body:{title:'雨霖铃',content:'寒蝉凄切',author:'柳永'}});
    assert.equal(created.status,201);
    const work=await created.json();
    assert.ok(work.id);
    assert.equal(work.revision,1);
    const list=await api('/api/works');
    assert.equal(list.status,200);
    assert.ok((await list.json()).some((w)=>w.id===work.id));

    // 正常推进到 revision 2
    const up1=await api(`/api/works/${work.id}`,{method:'PUT',body:{title:'雨霖铃·改',baseRevision:1}});
    assert.equal(up1.status,200);
    assert.equal((await up1.json()).work.revision,2);

    // 过期 baseRevision → 409，current.title 为库中最新标题
    const conflict=await api(`/api/works/${work.id}`,{method:'PUT',body:{title:'并发稿',baseRevision:1}});
    assert.equal(conflict.status,409);
    const errBody=await conflict.json();
    assert.equal(errBody.error.code,'CONFLICT');
    assert.equal(errBody.error.current.title,'雨霖铃·改');

    // force 覆盖成功
    const forced=await api(`/api/works/${work.id}`,{method:'PUT',body:{title:'强制覆盖',baseRevision:1,force:true}});
    assert.equal(forced.status,200);
    const after=await api(`/api/works/${work.id}`);
    assert.equal((await after.json()).work.title,'强制覆盖');
  }finally{await close();}
});

// 3. notes：创建返回 revision → 正常保存 → 定稿后保存派生草稿、原稿不变
test('notes：创建 201 返回 revision、正常保存、定稿派生草稿',async()=>{
  const {base,close}=await startApp();
  try{
    const api=apiOf(base,await loginCookie(base));
    const created=await api('/api/notes',{method:'POST',body:{title:'读雨霖铃',content:'初读感受'}});
    assert.equal(created.status,201);
    const {note,revision}=await created.json();
    assert.ok(note.id);
    assert.ok(revision.seq>=1); // revision 为版本记录对象，seq 为库级全局计数

    const saved=await api(`/api/notes/${note.id}`,{method:'PUT',body:{content:'修改后的感受',baseRevision:1}});
    assert.equal(saved.status,200);
    const savedBody=await saved.json();
    assert.equal(savedBody.createdDraft,false);
    assert.equal(savedBody.note.id,note.id);
    assert.equal(savedBody.revision.seq,revision.seq+1);

    // 置 final（正常保存）
    await api(`/api/notes/${note.id}`,{method:'PUT',body:{writingStatus:'final',baseRevision:2}});
    // 定稿后保存 → 派生草稿，原稿一字不动
    const derived=await api(`/api/notes/${note.id}`,{method:'PUT',body:{content:'在定稿上继续写',baseRevision:3}});
    assert.equal(derived.status,200);
    const dBody=await derived.json();
    assert.equal(dBody.createdDraft,true);
    assert.equal(dBody.note.id,note.id);
    assert.equal(dBody.draft.draftOf,note.id);

    const got=await api(`/api/notes/${note.id}`);
    const detail=await got.json();
    assert.equal(detail.note.content,'修改后的感受'); // 原稿内容不变
    assert.equal(detail.note.writingStatus,'final');

    // unprotect 撤销定稿
    const un=await api(`/api/notes/${note.id}/unprotect`,{method:'POST'});
    assert.equal(un.status,200);
    assert.equal((await un.json()).writingStatus,'draft');
  }finally{await close();}
});

// 4. revisions：列表 ≥2 → compare 返回 stats → restore 201 返回新草稿
test('revisions：列表、compare stats、restore 201 新草稿',async()=>{
  const {base,close}=await startApp();
  try{
    const api=apiOf(base,await loginCookie(base));
    const created=await api('/api/notes',{method:'POST',body:{title:'版本测试',content:'第一稿'}});
    const {note}=await created.json();
    await api(`/api/notes/${note.id}`,{method:'PUT',body:{content:'第二稿',baseRevision:1}});

    const revs=await api(`/api/notes/${note.id}/revisions`);
    assert.equal(revs.status,200);
    const revList=await revs.json();
    assert.ok(revList.length>=2);
    const newer=revList[0],older=revList[revList.length-1]; // seq 倒序

    const cmp=await api(`/api/notes/${note.id}/revisions/compare?a=${older.id}&b=${newer.id}`);
    assert.equal(cmp.status,200);
    const cmpBody=await cmp.json();
    assert.equal(typeof cmpBody.stats.added,'number');
    assert.ok(Array.isArray(cmpBody.rows));

    const restored=await api(`/api/notes/${note.id}/revisions/${older.id}/restore`,{method:'POST'});
    assert.equal(restored.status,201);
    const {draft}=await restored.json();
    assert.equal(draft.draftOf,note.id);
    assert.equal(draft.content,'第一稿');
  }finally{await close();}
});

// 5. imagery：创建 → uses 关联到两个作品 → 详情含 uses 与 works → impact/merge → compare shared
test('imagery：创建、uses、详情含 uses、impact、merge、双作品 compare',async()=>{
  const {base,close}=await startApp();
  try{
    const api=apiOf(base,await loginCookie(base));
    const wa=(await (await api('/api/works',{method:'POST',body:{title:'水调歌头',content:'明月几时有'}})).json());
    const wb=(await (await api('/api/works',{method:'POST',body:{title:'静夜思',content:'床前明月光'}})).json());
    const im=await api('/api/imagery',{method:'POST',body:{name:'月',description:'思念的载体'}});
    assert.equal(im.status,201);
    const imagery=await im.json();

    const u1=await api('/api/imagery-uses',{method:'POST',body:{imageryId:imagery.id,targetType:'work',targetId:wa.id,quote:'明月几时有',context:'把酒问月',fn:'寄托思念'}});
    assert.equal(u1.status,201);
    await api('/api/imagery-uses',{method:'POST',body:{imageryId:imagery.id,targetType:'work',targetId:wb.id,quote:'床前明月光',context:'客居思乡',fn:'思乡'}});

    const detail=await api(`/api/imagery/${imagery.id}`);
    assert.equal(detail.status,200);
    const d=await detail.json();
    assert.equal(d.imagery.id,imagery.id);
    assert.equal(d.uses.length,2);
    assert.ok(d.works.some((x)=>x.work.id===wa.id));

    const impact=await api(`/api/imagery/${imagery.id}/impact`);
    const impactBody=await impact.json();
    assert.equal(impactBody.uses,2);
    assert.equal(impactBody.works,2);

    // merge：另建一个意象并入「月」，默认列表隐藏、includeMerged 可见
    const other=await (await api('/api/imagery',{method:'POST',body:{name:'月光'}})).json();
    const merged=await api(`/api/imagery/${other.id}/merge`,{method:'POST',body:{intoId:imagery.id}});
    assert.equal(merged.status,200);
    assert.equal((await merged.json()).movedUses,0);
    const hidden=(await (await api('/api/imagery')).json()).entries;
    assert.ok(!hidden.some((e)=>e.imagery.id===other.id));
    const shown=(await (await api('/api/imagery?includeMerged=true')).json()).entries;
    assert.ok(shown.some((e)=>e.imagery.id===other.id&&e.imagery.mergedInto===imagery.id));

    const cmp=await api(`/api/imagery/compare?a=${wa.id}&b=${wb.id}`);
    assert.equal(cmp.status,200);
    const c=await cmp.json();
    assert.equal(c.shared.length,1);
    assert.equal(c.shared[0].imagery.name,'月');
  }finally{await close();}
});

// 6. allusions：与 imagery 对称，interpretation 字段往返
test('allusions：创建、uses（interpretation 往返）、详情、compare',async()=>{
  const {base,close}=await startApp();
  try{
    const api=apiOf(base,await loginCookie(base));
    const wa=(await (await api('/api/works',{method:'POST',body:{title:'锦瑟',content:'庄生晓梦迷蝴蝶'}})).json());
    const wb=(await (await api('/api/works',{method:'POST',body:{title:'古风',content:'梦蝶无端'}})).json());
    const al=await api('/api/allusions',{method:'POST',body:{name:'庄周梦蝶',source:'庄子·齐物论',original:'昔者庄周梦为胡蝶'}});
    assert.equal(al.status,201);
    const allusion=await al.json();

    const u=await api('/api/allusion-uses',{method:'POST',body:{allusionId:allusion.id,targetType:'work',targetId:wa.id,quote:'庄生晓梦迷蝴蝶',interpretation:'物我两忘',understanding:'迷惘人生如梦'}});
    assert.equal(u.status,201);
    assert.equal((await u.json()).interpretation,'物我两忘');
    await api('/api/allusion-uses',{method:'POST',body:{allusionId:allusion.id,targetType:'work',targetId:wb.id,interpretation:'浮生若梦'}});

    const detail=await api(`/api/allusions/${allusion.id}`);
    assert.equal(detail.status,200);
    const d=await detail.json();
    assert.equal(d.uses.length,2);
    assert.equal(d.uses[0].interpretation,'物我两忘'); // 字段往返无损

    const cmp=await api(`/api/allusions/compare?a=${wa.id}&b=${wb.id}`);
    assert.equal(cmp.status,200);
    const c=await cmp.json();
    assert.equal(c.shared.length,1);
    assert.equal(c.shared[0].allusion.name,'庄周梦蝶');
  }finally{await close();}
});

// 7. trash：DELETE work → 回收站含项 → restore → 列表空、作品恢复可读
test('trash：work 入站、列表含项、restore、列表空',async()=>{
  const {base,close}=await startApp();
  try{
    const api=apiOf(base,await loginCookie(base));
    const work=(await (await api('/api/works',{method:'POST',body:{title:'待删词作',content:'内容'}})).json());
    const del=await api(`/api/works/${work.id}`,{method:'DELETE'});
    assert.equal(del.status,200);
    assert.deepEqual(await del.json(),{trashed:true});

    const items=await (await api('/api/trash')).json();
    const item=items.find((i)=>i.itemType==='work'&&i.itemId===work.id);
    assert.ok(item);

    const restored=await api(`/api/trash/${item.id}/restore`,{method:'POST'});
    assert.equal(restored.status,200);
    assert.equal((await (await api('/api/trash')).json()).length,0);
    assert.equal((await api(`/api/works/${work.id}`)).status,200);
  }finally{await close();}
});

// 8. import：export 备份 → preflight creates 计数 → merge 幂等二次导入 duplicates 命中
test('import：export、preflight creates、merge 幂等、非法 mode 400',async()=>{
  const {base,close}=await startApp();
  try{
    const api=apiOf(base,await loginCookie(base));
    const backupRes=await api('/api/export');
    assert.equal(backupRes.status,200);
    assert.match(backupRes.headers.get('content-disposition'),/attachment; filename="ci-notes-backup\.json"/);
    const backup=await backupRes.json();
    assert.equal(backup.format,'ci-notes-backup');

    // 追加一条库中没有的新词作 → preflight 计为 create，其余全部 duplicate
    backup.data.works.push({id:'w_imp_test0001',title:'导入的新词',content:'内容',kind:'ci',tags:[],claims:[],citations:[],relatedWorkIds:[]});
    const pre=await api('/api/import',{method:'POST',body:{mode:'preflight',backup}});
    assert.equal(pre.status,200);
    const preBody=await pre.json();
    assert.equal(preBody.ok,true);
    assert.equal(preBody.creates.works,1);

    const m1=await api('/api/import',{method:'POST',body:{mode:'merge',backup}});
    assert.equal(m1.status,200);
    const m1Body=await m1.json();
    assert.equal(m1Body.created.works,1);
    assert.equal((await api('/api/works/w_imp_test0001')).status,200);

    // 幂等：同一备份二次导入，全部按重复跳过
    const m2=await api('/api/import',{method:'POST',body:{mode:'merge',backup}});
    const m2Body=await m2.json();
    assert.equal(m2Body.created.works,0);
    assert.ok(m2Body.skipped>0);

    assert.equal((await api('/api/import',{method:'POST',body:{mode:'nope',backup}})).status,400);
    const badBackup={mode:'merge',backup:{format:'unknown',formatVersion:99,data:{}}};
    assert.equal((await api('/api/import',{method:'POST',body:badBackup})).status,400);
  }finally{await close();}
});

// 9. mcp-keys：POST 201 返回 cin_ 前缀明文（仅一次）、列表无明文、空名 400、revoke 即失配
test('mcp-keys：创建返回明文、列表无明文、空名 400、revoke 失配',async()=>{
  const {app,base,close}=await startApp();
  try{
    const api=apiOf(base,await loginCookie(base));
    const created=await api('/api/mcp-keys',{method:'POST',body:{name:' 读取密钥 '}});
    assert.equal(created.status,201);
    const {key,record}=await created.json();
    assert.match(key,/^cin_[0-9a-f]{64}$/);
    assert.ok(record.id);
    assert.equal(record.name,'读取密钥');

    assert.equal((await api('/api/mcp-keys',{method:'POST',body:{name:'   '}})).status,400);

    const keys=await (await api('/api/mcp-keys')).json();
    const rec=keys.find((r)=>r.id===record.id);
    assert.ok(rec);
    assert.equal(rec.key,undefined);
    assert.ok(!JSON.stringify(keys).includes(key)); // 列表无明文
    assert.equal(rec.status,'active');

    assert.equal((await api(`/api/mcp-keys/${record.id}/revoke`,{method:'POST'})).status,200);
    assert.equal(app.store.findMcpKey(key),null); // 撤销即失配
  }finally{await close();}
});

// 9b. Task 13 审查移交：撤销密钥后经 /mcp HTTP 请求得 401（MCP 密钥鉴权）
test('mcp 端点：撤销密钥后经 /mcp 请求 401',async()=>{
  const {base,close}=await startApp();
  try{
    const api=apiOf(base,await loginCookie(base));
    const {key,record}=(await (await api('/api/mcp-keys',{method:'POST',body:{name:'撤销测试'}})).json());
    const ping=()=>fetch(`${base}/mcp`,{
      method:'POST',
      headers:{'Content-Type':'application/json','x-cinotes-key':key},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'}),
    });
    assert.equal((await ping()).status,200);
    assert.equal((await api(`/api/mcp-keys/${record.id}/revoke`,{method:'POST'})).status,200);
    const after=await ping();
    assert.equal(after.status,401);
    assert.equal((await after.json()).error.code,-32001);
  }finally{await close();}
});

// 10. 跨站 / Content-Type / 体积上限 / 会话 Cookie 属性与登出（沿用旧测试断言）
test('安全防护：跨站 403、错误 CT 415、超限 413、Cookie 属性、登出失效',async()=>{
  const {base,close}=await startApp();
  try{
    const login=async(body,extra={})=>fetch(`${base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
    assert.equal((await login({username:USERNAME,password:'wrong-password-long'},{'Content-Type':'text/plain'})).status,415);
    assert.equal((await login({username:USERNAME,password:'wrong-password-long'},{Origin:'https://unrelated.example'})).status,403);
    const session=await login({username:USERNAME,password:PASSWORD});
    assert.equal(session.status,200);
    const setCookie=session.headers.get('set-cookie');
    assert.match(setCookie,/ci_session=/);
    assert.match(setCookie,/HttpOnly/);
    assert.match(setCookie,/SameSite=Strict/);
    assert.match(setCookie,/Max-Age=/);
    const cookie=setCookie.split(';')[0];
    const post=(path,body,extra={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,...extra},body:JSON.stringify(body)});

    assert.equal((await post('/api/works',{title:'x'},{Origin:'https://unrelated.example'})).status,403); // 伪造跨站
    assert.equal((await post('/api/works',{title:'x'},{'Content-Type':'text/plain'})).status,415); // 错误 CT
    assert.equal((await post('/api/works',{title:'x'.repeat(230000)})).status,413); // 超过 220KB
    const bad=await fetch(`${base}/api/works`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:'{oops'});
    assert.equal(bad.status,400); // JSON 损坏

    // SPA shell 公开；登出后旧令牌即时失效，重新登录恢复
    assert.equal((await fetch(`${base}/`)).status,200);
    assert.equal((await fetch(`${base}/api/logout`,{method:'POST',headers:{Cookie:cookie}})).status,200);
    assert.equal((await fetch(`${base}/api/works`,{headers:{Cookie:cookie}})).status,401);
    const again=await login({username:USERNAME,password:PASSWORD});
    const fresh=again.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/api/works`,{headers:{Cookie:fresh}})).status,200);
  }finally{await close();}
});

// 补充覆盖：comparisons CRUD（save 兼创建：POST 新建 201，PUT 带 id 覆盖 200）
test('comparisons：POST 创建 201、GET 列表/详情、PUT 覆盖、DELETE',async()=>{
  const {base,close}=await startApp();
  try{
    const api=apiOf(base,await loginCookie(base));
    const wa=(await (await api('/api/works',{method:'POST',body:{title:'甲词',content:'甲内容'}})).json());
    const wb=(await (await api('/api/works',{method:'POST',body:{title:'乙词',content:'乙内容'}})).json());
    const created=await api('/api/comparisons',{method:'POST',body:{title:'甲乙对照',workAId:wa.id,workBId:wb.id}});
    assert.equal(created.status,201);
    const cmp=await created.json();

    const list=await (await api('/api/comparisons')).json();
    assert.ok(list.some((c)=>c.id===cmp.id&&c.workATitle==='甲词'));

    const updated=await api(`/api/comparisons/${cmp.id}`,{method:'PUT',body:{title:'甲乙对照·改',dimensions:{similarity:{text:'都写离别'}}}});
    assert.equal(updated.status,200);
    const detail=await (await api(`/api/comparisons/${cmp.id}`)).json();
    assert.equal(detail.comparison.title,'甲乙对照·改');
    assert.equal(detail.comparison.dimensions.similarity.text,'都写离别');

    assert.equal((await api(`/api/comparisons/${cmp.id}`,{method:'DELETE'})).status,200);
    assert.equal((await api(`/api/comparisons/${cmp.id}`)).status,404);
  }finally{await close();}
});
