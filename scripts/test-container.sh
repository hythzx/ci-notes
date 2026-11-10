#!/usr/bin/env bash
set -euo pipefail
name="ci-notes-smoke-${RANDOM}"
volume="${name}-data"
password="ci-only-not-a-real-password"
trap 'docker logs "$name" 2>&1 || true; docker rm -f "$name" >/dev/null 2>&1 || true; docker volume rm "$volume" >/dev/null 2>&1 || true' EXIT
docker volume create "$volume" >/dev/null
docker run -d --name "$name" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true -p 127.0.0.1::3000 -e APP_USERNAME=admin -e APP_PASSWORD="$password" -v "$volume:/app/data" ci-notes:test >/dev/null
port=$(docker port "$name" 3000/tcp | cut -d: -f2)
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null; then break; fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]; then exit 1; fi
  sleep 1
done
export TEST_URL="http://127.0.0.1:$port" TEST_PASSWORD="$password"
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const headers={Authorization:'Basic '+Buffer.from('admin:'+process.env.TEST_PASSWORD).toString('base64'),'Content-Type':'application/json'};
assert.equal((await fetch(process.env.TEST_URL+'/api/notes')).status,401);
const rows=await (await fetch(process.env.TEST_URL+'/api/notes',{headers})).json();
const note=JSON.parse(rows[0].data);note.id='container-test';note.title='容器持久化测试';
const response=await fetch(process.env.TEST_URL+'/api/notes',{method:'POST',headers,body:JSON.stringify({...note,expectedSeq:0})});
assert.equal(response.status,201);
JS
docker restart "$name" >/dev/null
for i in $(seq 1 30); do
  if curl -fsS "$TEST_URL/api/health" >/dev/null; then break; fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]; then exit 1; fi
  sleep 1
done
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const headers={Authorization:'Basic '+Buffer.from('admin:'+process.env.TEST_PASSWORD).toString('base64')};
const rows=await (await fetch(process.env.TEST_URL+'/api/notes',{headers})).json();
assert.ok(rows.some(r=>r.id==='container-test'));
assert.equal((await fetch(process.env.TEST_URL+'/',{headers})).status,200);
console.log('Container persistence verified');
JS
