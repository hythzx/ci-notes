import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { openDb } from '../server/core/db.mjs';
import {
  createMcpKey, findMcpKey, listMcpKeys,
  revokeMcpKey, enableMcpKey, touchMcpKey,
} from '../server/core/mcpkeys.mjs';
import { StoreError } from '../server/core/errors.mjs';

function setup() { return openDb(join(mkdtempSync(join(tmpdir(), 'cn-mk-')), 't.sqlite')); }

/* ------------------------------------------------------------------ */
/* createMcpKey                                                        */
/* ------------------------------------------------------------------ */

test('createMcpKey：明文仅此一次返回，record 不含明文，落库为哈希', () => {
  const db = setup();
  const { key, record } = createMcpKey(db, 'claude-desktop');
  // 明文格式：cin_ + 64 位小写 hex
  assert.match(key, /^cin_[0-9a-f]{64}$/);
  assert.equal(key.length, 68);
  // record 不含明文
  assert.equal(JSON.stringify(record).includes(key), false);
  assert.deepEqual(Object.keys(record).sort(),
    ['createdAt', 'id', 'lastUsedAt', 'name', 'prefix', 'revokedAt', 'status']);
  assert.equal(record.name, 'claude-desktop');
  assert.match(record.id, /^mk_/);
  assert.equal(record.prefix, key.slice(0, 12));
  assert.equal(record.status, 'active');
  assert.equal(record.lastUsedAt, null);
  assert.equal(record.revokedAt, null);
  assert.ok(record.createdAt);
  // 库中只存 sha256 哈希，不存明文
  const row = db.prepare('SELECT * FROM mcp_keys WHERE id=?').get(record.id);
  assert.notEqual(row.key_hash, key);
  assert.equal(/^[0-9a-f]{64}$/.test(row.key_hash), true);
  assert.equal(row.key_hash, createHash('sha256').update(key).digest('hex'));
});

/* ------------------------------------------------------------------ */
/* findMcpKey                                                          */
/* ------------------------------------------------------------------ */

test('findMcpKey：按明文 sha256 查找，仅 active 命中', () => {
  const db = setup();
  const { key, record } = createMcpKey(db, 'k1');
  const found = findMcpKey(db, key);
  assert.ok(found);
  assert.equal(found.id, record.id);
  assert.equal(found.status, 'active');
  assert.equal(findMcpKey(db, 'cin_' + '0'.repeat(64)), null);
  assert.equal(findMcpKey(db, ''), null);
  assert.equal(findMcpKey(db, null), null);
});

/* ------------------------------------------------------------------ */
/* revoke / enable                                                     */
/* ------------------------------------------------------------------ */

test('revokeMcpKey：撤销即失配；enableMcpKey：恢复命中且清 revokedAt', () => {
  const db = setup();
  const { key, record } = createMcpKey(db, 'k1');
  revokeMcpKey(db, record.id);
  assert.equal(findMcpKey(db, key), null); // 撤销后立即失配
  const listed = listMcpKeys(db)[0];
  assert.equal(listed.status, 'revoked');
  assert.ok(listed.revokedAt);
  enableMcpKey(db, record.id);
  const again = findMcpKey(db, key);
  assert.ok(again);
  assert.equal(again.status, 'active');
  assert.equal(again.revokedAt, null);
});

test('revoke/enable 不存在的 id 抛 NOT_FOUND', () => {
  const db = setup();
  assert.throws(() => revokeMcpKey(db, 'mk_nope'), (e) => e instanceof StoreError && e.code === 'NOT_FOUND');
  assert.throws(() => enableMcpKey(db, 'mk_nope'), (e) => e instanceof StoreError && e.code === 'NOT_FOUND');
});

/* ------------------------------------------------------------------ */
/* touchMcpKey                                                         */
/* ------------------------------------------------------------------ */

test('touchMcpKey：仅 active 密钥更新 last_used_at', () => {
  const db = setup();
  const { key, record } = createMcpKey(db, 'k1');
  assert.equal(findMcpKey(db, key).lastUsedAt, null);
  touchMcpKey(db, record.id);
  assert.ok(findMcpKey(db, key).lastUsedAt);
  // 撤销后 touch 不再更新
  const before = findMcpKey(db, key).lastUsedAt;
  revokeMcpKey(db, record.id);
  touchMcpKey(db, record.id);
  const row = db.prepare('SELECT last_used_at FROM mcp_keys WHERE id=?').get(record.id);
  assert.equal(row.last_used_at, before);
});

/* ------------------------------------------------------------------ */
/* listMcpKeys                                                         */
/* ------------------------------------------------------------------ */

test('listMcpKeys：摘要无明文无哈希，createdAt 倒序', () => {
  const db = setup();
  const a = createMcpKey(db, 'older');
  const b = createMcpKey(db, 'newer');
  // 固定时间使顺序确定：a 更早
  db.prepare('UPDATE mcp_keys SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', a.record.id);
  const list = listMcpKeys(db);
  assert.deepEqual(list.map((r) => r.name), ['newer', 'older']);
  // 摘要不泄漏明文与哈希
  const text = JSON.stringify(list);
  assert.equal(text.includes(a.key), false);
  assert.equal(text.includes(b.key), false);
  assert.equal(/[0-9a-f]{64}/.test(text), false);
});
