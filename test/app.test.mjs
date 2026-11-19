import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {openStore} from '../server/store.mjs';
import {createApp} from '../server/app.mjs';
const example=JSON.parse(readFileSync(new URL('../server/seeds.json',import.meta.url),'utf8'))[0];
const draft=(id='note-1')=>({...example,id,status:'草稿',body:'原来的文字'});
test('imports Sites backups atomically, preserves history and is repeatable',()=>{
 const s=openStore(':memory:',{seed:false});try{
  const n=draft();const payload={notes:[n,draft('no-history')],versions:[{id:n.id,data:JSON.stringify(n),created:'2026-11-10T01:00:00Z'},{id:n.id,data:JSON.stringify({...n,body:'修改稿'}),created:'2026-11-10T02:00:00Z'}]};
  assert.equal(s.import(payload),3);assert.equal(s.import(payload),0);assert.equal(JSON.parse(s.latest(n.id).data).body,'修改稿');
  const bad={notes:[draft('bad')],versions:[{id:'bad',data:'{}',created:'invalid'}]};assert.throws(()=>s.import(bad));assert.equal(s.list().length,3);
  const copy=openStore(':memory:',{seed:false});try{assert.equal(copy.import(s.export()),3);assert.deepEqual(copy.export().notes,s.export().notes);}finally{copy.close();}
 }finally{s.close();}
});
test('HTTP session login, cross-origin protection, input validation and optimistic concurrency',async()=>{
 const app=createApp({databasePath:':memory:',username:'admin',password:'test-password-long',seed:false});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const u=`http://127.0.0.1:${app.server.address().port}`;
 const login=async(body,extra={})=>fetch(u+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
 try{
  assert.equal((await fetch(u+'/api/health')).status,200);
  assert.equal((await fetch(u+'/')).status,200); // SPA shell 公开，数据经鉴权 API 返回
  assert.equal((await fetch(u+'/api/notes')).status,401);assert.equal((await fetch(u+'/api/export')).status,401);
  assert.equal((await login({username:'admin',password:'wrong-password-long'})).status,401);
  assert.equal((await login({username:'admin',password:'test-password-long'},{'Content-Type':'text/plain'})).status,415);
  assert.equal((await login({username:'admin',password:'test-password-long'},{Origin:'https://unrelated.example'})).status,403);
  const session=await login({username:'admin',password:'test-password-long'});assert.equal(session.status,200);
  const setCookie=session.headers.get('set-cookie');
  assert.match(setCookie,/ci_session=/);assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Strict/);assert.match(setCookie,/Max-Age=/);
  const cookie=setCookie.split(';')[0];
  const post=(body,extra={})=>fetch(u+'/api/notes',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,...extra},body:JSON.stringify(body)});
  assert.equal((await post({...draft(),expectedSeq:0},{Origin:'https://unrelated.example'})).status,403);
  assert.equal((await post({...draft(),expectedSeq:0},{'Content-Type':'text/plain'})).status,415);
  assert.equal((await post({...draft(),title:'',expectedSeq:0})).status,400);
  assert.equal((await post({...draft(),body:'x'.repeat(230000),expectedSeq:0})).status,413);
  const saved=await post({...draft(),expectedSeq:0});assert.equal(saved.status,201);const row=await saved.json();
  assert.equal((await post({...draft(),expectedSeq:0})).status,409);
  assert.equal((await post({...draft(),body:'新版',expectedSeq:row.seq})).status,201);
  const data=await (await fetch(u+'/api/export',{headers:{Cookie:cookie}})).json();assert.equal(data.versions.length,2);assert.equal(data.notes[0].body,'新版');
  assert.equal((await fetch(u+'/api/logout',{method:'POST',headers:{Cookie:cookie}})).status,200);
  assert.equal((await fetch(u+'/api/notes',{headers:{Cookie:cookie}})).status,401); // 登出后旧令牌即时失效
  const again=await login({username:'admin',password:'test-password-long'});assert.equal(again.status,200);
  const fresh=again.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(u+'/api/notes',{headers:{Cookie:fresh}})).status,200);
 }finally{await new Promise(r=>app.server.close(r));app.store.close();}
});
