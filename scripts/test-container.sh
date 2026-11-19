#!/usr/bin/env bash
set -euo pipefail
name="ci-notes-smoke-${RANDOM}"
volume="${name}-data"
password="ci-only-not-a-real-password"
state=$(mktemp)
trap 'rm -f "$state"; docker logs "$name" 2>&1 || true; docker rm -f "$name" >/dev/null 2>&1 || true; docker volume rm "$volume" >/dev/null 2>&1 || true' EXIT
docker volume create "$volume" >/dev/null
docker run -d --name "$name" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true -p 127.0.0.1::3000 -e APP_USERNAME=admin -e APP_PASSWORD="$password" -v "$volume:/app/data" ci-notes:test >/dev/null
port=$(docker port "$name" 3000/tcp | cut -d: -f2)
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null; then break; fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]; then exit 1; fi
  sleep 1
done
export TEST_URL="http://127.0.0.1:$port" TEST_PASSWORD="$password" STATE_FILE="$state"
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
const URL=process.env.TEST_URL,PASSWORD=process.env.TEST_PASSWORD;
const post=async(path,body,cookie)=>fetch(URL+path,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
const login=async()=>{const r=await post('/api/login',{username:'admin',password:PASSWORD});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
// 未登录一律 401
assert.equal((await fetch(URL+'/api/notes')).status,401);
const cookie=await login();
// 创建词作
const work=await(await(await post('/api/works',{title:'容器冒烟词作',author:'冒烟作者',content:'明月几时有，把酒问青天。'},cookie)).json());
assert.ok(work.id);console.log(`[smoke] work created: ${work.id}`);
// 创建札记并关联词作
const note=(await(await post('/api/notes',{title:'容器冒烟札记',content:'这篇札记用来验证容器持久化。',workIds:[work.id]},cookie)).json()).note;
assert.ok(note.id);console.log(`[smoke] note created: ${note.id}`);
// 创建意象并记录用法
const imagery=await(await post('/api/imagery',{name:'明月',aliases:['月亮']},cookie)).json();
assert.ok(imagery.id);console.log(`[smoke] imagery created: ${imagery.id}`);
const imageryUse=await(await post('/api/imagery-uses',{imageryId:imagery.id,targetType:'work',targetId:work.id,quote:'明月几时有',context:'把酒问青天',fn:'寄托思念'},cookie)).json();
assert.ok(imageryUse.id);console.log(`[smoke] imagery linked: ${imageryUse.id}`);
// 创建典故并记录用法
const allusion=await(await post('/api/allusions',{name:'把酒问天',source:'楚辞·天问',explanation:'对天的叩问，抒发人生感慨'},cookie)).json();
assert.ok(allusion.id);console.log(`[smoke] allusion created: ${allusion.id}`);
const allusionUse=await(await post('/api/allusion-uses',{allusionId:allusion.id,targetType:'work',targetId:work.id,quote:'把酒问青天',interpretation:'承天问之思'},cookie)).json();
assert.ok(allusionUse.id);console.log(`[smoke] allusion linked: ${allusionUse.id}`);
// 生成 MCP 密钥（明文仅此一次）
const mcp=await(await post('/api/mcp-keys',{name:'容器冒烟密钥'},cookie)).json();
assert.ok(mcp.key);console.log(`[smoke] mcp key created: ${mcp.record.id}`);
// 用密钥调 MCP tools/call list_works：JSON-RPC result 含新建词作，非 error
const rpc=await fetch(URL+'/mcp',{method:'POST',headers:{'Content-Type':'application/json','X-CiNotes-Key':mcp.key},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_works',arguments:{}}})});
assert.equal(rpc.status,200);
const parsed=await rpc.json();
assert.ok(parsed.result&&!parsed.error);
assert.notEqual(parsed.result.isError,true);
const text=parsed.result.content.map(c=>c.text).join('');
assert.ok(text.includes('容器冒烟词作'));
console.log('[smoke] mcp tools/call list_works ok');
writeFileSync(process.env.STATE_FILE,JSON.stringify({work:work.id,note:note.id,imagery:imagery.id,allusion:allusion.id}));
JS
docker restart "$name" >/dev/null
# Docker Desktop 重启后会重新发布动态端口（Linux 不变），重读映射再继续
port=$(docker port "$name" 3000/tcp | cut -d: -f2)
export TEST_URL="http://127.0.0.1:$port"
for i in $(seq 1 30); do
  if curl -fsS "$TEST_URL/api/health" >/dev/null; then break; fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]; then exit 1; fi
  sleep 1
done
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const URL=process.env.TEST_URL,PASSWORD=process.env.TEST_PASSWORD;
const {work,note,imagery,allusion}=JSON.parse(readFileSync(process.env.STATE_FILE,'utf8'));
const login=async()=>{const r=await fetch(URL+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:PASSWORD})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
const cookie=await login();
// 词作仍在
const w=await(await fetch(`${URL}/api/works/${work}`,{headers:{Cookie:cookie}})).json();
assert.equal(w.work.title,'容器冒烟词作');
console.log('[smoke] work persisted');
// 札记仍在且关联未丢
const n=await(await fetch(`${URL}/api/notes/${note}`,{headers:{Cookie:cookie}})).json();
assert.equal(n.note.title,'容器冒烟札记');
assert.deepEqual(n.note.workIds,[work]);
console.log('[smoke] note persisted with work link');
// 意象仍在且使用记录完整
const im=await(await fetch(`${URL}/api/imagery/${imagery}`,{headers:{Cookie:cookie}})).json();
assert.equal(im.imagery.name,'明月');
assert.equal(im.uses.length,1);
assert.equal(im.uses[0].targetId,work);
assert.equal(im.uses[0].fn,'寄托思念');
console.log('[smoke] imagery persisted with use');
// 典故仍在且使用记录完整
const al=await(await fetch(`${URL}/api/allusions/${allusion}`,{headers:{Cookie:cookie}})).json();
assert.equal(al.allusion.name,'把酒问天');
assert.equal(al.allusion.explanation,'对天的叩问，抒发人生感慨');
assert.equal(al.uses.length,1);
assert.equal(al.uses[0].interpretation,'承天问之思');
console.log('[smoke] allusion persisted with use');
// 静态首页仍可访问
assert.equal((await fetch(URL+'/',{headers:{Cookie:cookie}})).status,200);
console.log('Container persistence verified');
JS
