import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {openStore} from '../server/store.mjs';
import {createApp} from '../server/app.mjs';
const example=JSON.parse(readFileSync(new URL('../server/seeds.json',import.meta.url),'utf8'))[0];
const draft=(id='note-1')=>({...example,id,status:'草稿',body:'原来的文字'});
test('SQLite persists append-only versions, rejects conflicts and retains final text',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ci-notes-'));const path=join(dir,'test.sqlite');let s=openStore(path,{seed:false});
 try{
  const first=s.save({...draft(),status:'定稿'},0);
  const second=s.save({...draft(),body:'另写的新稿'},first.seq);
  assert.throws(()=>s.save(draft(),first.seq),{status:409});
  assert.throws(()=>s.db.prepare('UPDATE versions SET data=? WHERE seq=?').run('{}',first.seq),/immutable/);
  assert.throws(()=>s.db.prepare('DELETE FROM versions WHERE seq=?').run(first.seq),/immutable/);
  s.close();s=openStore(path,{seed:false});
  assert.equal(s.list().length,2);assert.equal(JSON.parse(s.list()[0].data).body,'原来的文字');assert.equal(s.latest('note-1').seq,second.seq);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('imports Sites backups atomically, preserves history and is repeatable',()=>{
 const s=openStore(':memory:',{seed:false});try{
  const n=draft();const payload={notes:[n,draft('no-history')],versions:[{id:n.id,data:JSON.stringify(n),created:'2026-11-10T01:00:00Z'},{id:n.id,data:JSON.stringify({...n,body:'修改稿'}),created:'2026-11-10T02:00:00Z'}]};
  assert.equal(s.import(payload),3);assert.equal(s.import(payload),0);assert.equal(JSON.parse(s.latest(n.id).data).body,'修改稿');
  const bad={notes:[draft('bad')],versions:[{id:'bad',data:'{}',created:'invalid'}]};assert.throws(()=>s.import(bad));assert.equal(s.list().length,3);
  const copy=openStore(':memory:',{seed:false});try{assert.equal(copy.import(s.export()),3);assert.deepEqual(copy.export().notes,s.export().notes);}finally{copy.close();}
 }finally{s.close();}
});
test('HTTP auth, cross-origin protection, input validation and optimistic concurrency',async()=>{
 const app=createApp({databasePath:':memory:',username:'admin',password:'test-password-long',seed:false});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const u=`http://127.0.0.1:${app.server.address().port}`;
 const headers={Authorization:'Basic '+Buffer.from('admin:test-password-long').toString('base64'),'Content-Type':'application/json'};
 const post=(body,extra={})=>fetch(u+'/api/notes',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
 try{
  assert.equal((await fetch(u+'/api/health')).status,200);assert.equal((await fetch(u+'/api/notes')).status,401);assert.equal((await fetch(u+'/api/export')).status,401);
  assert.equal((await post({...draft(),expectedSeq:0},{Origin:'https://unrelated.example'})).status,403);
  assert.equal((await post({...draft(),expectedSeq:0},{'Content-Type':'text/plain'})).status,415);
  assert.equal((await post({...draft(),title:'',expectedSeq:0})).status,400);
  assert.equal((await post({...draft(),body:'x'.repeat(230000),expectedSeq:0})).status,413);
  const saved=await post({...draft(),expectedSeq:0});assert.equal(saved.status,201);const row=await saved.json();
  assert.equal((await post({...draft(),expectedSeq:0})).status,409);
  assert.equal((await post({...draft(),body:'新版',expectedSeq:row.seq})).status,201);
  const data=await (await fetch(u+'/api/export',{headers})).json();assert.equal(data.versions.length,2);assert.equal(data.notes[0].body,'新版');
 }finally{await new Promise(r=>app.server.close(r));app.store.close();}
});
test('empty database seeds once and does not replace edits',()=>{const dir=mkdtempSync(join(tmpdir(),'ci-seed-'));const p=join(dir,'a.sqlite');let s=openStore(p);try{assert.equal(s.list().length,6);const first=s.list()[0];s.save({...JSON.parse(first.data),body:'自己的文字'},first.seq);s.close();s=openStore(p);assert.equal(s.list().length,7);assert.equal(JSON.parse(s.latest(first.id).data).body,'自己的文字');}finally{s.close();rmSync(dir,{recursive:true,force:true});}});
