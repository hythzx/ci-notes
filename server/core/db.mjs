import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS works(
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '',
  cipai TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'ci', updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_works_updated ON works(updated_at);
CREATE TABLE IF NOT EXISTS notes(
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL DEFAULT '', writing_status TEXT NOT NULL DEFAULT 'idea',
  publish_status TEXT NOT NULL DEFAULT 'unpublished', updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);
CREATE TABLE IF NOT EXISTS revisions(
  id TEXT PRIMARY KEY, note_id TEXT NOT NULL, seq INTEGER NOT NULL,
  snapshot TEXT NOT NULL, change_note TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_revisions_note ON revisions(note_id, seq);
CREATE TABLE IF NOT EXISTS comparisons(
  id TEXT PRIMARY KEY, payload TEXT NOT NULL,
  work_a_id TEXT NOT NULL DEFAULT '', work_b_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trash(
  id TEXT PRIMARY KEY, item_type TEXT NOT NULL, item_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '', snapshot TEXT NOT NULL, trashed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS imagery(
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL DEFAULT '', merged_into TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS imagery_uses(
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  imagery_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_imagery_uses_img ON imagery_uses(imagery_id);
CREATE INDEX IF NOT EXISTS idx_imagery_uses_target ON imagery_uses(target_type, target_id);
CREATE TABLE IF NOT EXISTS allusions(
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS allusion_uses(
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  allusion_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_allusion_uses_al ON allusion_uses(allusion_id);
CREATE INDEX IF NOT EXISTS idx_allusion_uses_target ON allusion_uses(target_type, target_id);
CREATE TABLE IF NOT EXISTS mcp_keys(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
  last_used_at TEXT, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS imports(
  id TEXT PRIMARY KEY, backup_hash TEXT NOT NULL, stats TEXT NOT NULL, imported_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY, value INTEGER NOT NULL);
`;

function hasLegacy(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='versions'").get();
  return !!row;
}

// 旧库导出：沿用旧 store.mjs 的导出格式，保证数据可回读
function exportLegacy(db, dataDir) {
  const rows = db.prepare('SELECT seq,id,data,created FROM versions ORDER BY seq').all();
  const latest = new Map();
  for (const r of rows) latest.set(r.id, JSON.parse(r.data));
  const backup = {
    format: 'ci-notes', version: 1, exportedAt: new Date().toISOString(),
    notes: [...latest.values()], versions: rows,
  };
  mkdirSync(dataDir, { recursive: true });
  const target = join(dataDir, 'ci-notes-legacy-backup.json');
  if (existsSync(target)) throw new Error('legacy 备份已存在，拒绝覆盖：' + target);
  writeFileSync(target, JSON.stringify(backup));
}

export function openDb(dbPath, { dataDir } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)');
  if (hasLegacy(db)) {
    exportLegacy(db, dataDir || dirname(dbPath));
    db.exec('DROP TABLE versions');
    db.prepare('DELETE FROM schema_migrations').run();
  }
  db.exec(DDL);
  db.prepare("INSERT OR IGNORE INTO counters(name,value) VALUES('revision_seq',0)").run();
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version) VALUES(?)').run(SCHEMA_VERSION);
  return db;
}

export function nextSeq(db) {
  db.prepare('UPDATE counters SET value=value+1 WHERE name=?').run('revision_seq');
  return db.prepare('SELECT value FROM counters WHERE name=?').get('revision_seq').value;
}

// 通用 CAS 更新：WHERE id AND revision；未命中返回当前 payload 供冲突提示
export function casUpdate(db, table, id, baseRevision, payload, updatedAt) {
  const r = db.prepare(`UPDATE ${table} SET payload=?, revision=revision+1, updated_at=? WHERE id=? AND revision=?`)
    .run(JSON.stringify(payload), updatedAt, id, baseRevision);
  if (r.changes === 1) return { ok: true, current: null };
  const row = db.prepare(`SELECT payload FROM ${table} WHERE id=?`).get(id);
  return { ok: false, current: row ? JSON.parse(row.payload) : null };
}
