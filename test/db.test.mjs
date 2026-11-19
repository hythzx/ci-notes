import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.mjs';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('openDb 建立全部新表且可重复打开', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cn-'));
  const p = join(dir, 't.sqlite');
  const db = openDb(p, { dataDir: dir });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['works','notes','revisions','comparisons','trash','imagery','imagery_uses','allusions','allusion_uses','mcp_keys','imports','counters','schema_migrations'])
    assert.ok(tables.includes(t), t);
  db.close();
  const db2 = openDb(p, { dataDir: dir }); // 幂等
  assert.equal(db2.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version=2').get().c, 1);
  db2.close();
});

test('旧 versions 库自动导出 legacy 备份并重建', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'cn-'));
  const p = join(dir, 't.sqlite');
  const legacy = new DatabaseSync(p);
  legacy.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);INSERT INTO schema_migrations VALUES(1);CREATE TABLE versions(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL, import_key TEXT UNIQUE);INSERT INTO versions(id,data,created) VALUES('n1','{\"id\":\"n1\",\"title\":\"旧稿\"}','2026-01-01T00:00:00Z')");
  legacy.close();
  const db = openDb(p, { dataDir: dir });
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  assert.ok(!names.includes('versions')); // 旧表已删除
  const bak = join(dir, 'ci-notes-legacy-backup.json');
  assert.ok(existsSync(bak));
  const parsed = JSON.parse(readFileSync(bak, 'utf8'));
  assert.equal(parsed.format, 'ci-notes');
  assert.equal(parsed.versions.length, 1);
  assert.equal(parsed.notes[0].id, 'n1');
  db.close();
});
