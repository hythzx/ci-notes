import { randomBytes } from 'node:crypto';
import { StoreError } from './errors.mjs';
import { newId, digest } from './ids.mjs';

/**
 * MCP 密钥管理：明文密钥仅在 createMcpKey 返回值中出现一次，
 * 库中只存 sha256 哈希；认证方用 findMcpKey(raw) 做哈希查找。
 */

function nowIso() {
  return new Date().toISOString();
}

/** DB 行 → 对外 record（snake_case 转 camelCase，无哈希无明文） */
function rowToRecord(row) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    status: row.status,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

/** 新建密钥：返回 {key: 'cin_'+64hex 明文（仅此一次）, record}，record 不含明文 */
export function createMcpKey(db, name) {
  const key = 'cin_' + randomBytes(32).toString('hex');
  const id = newId('mk_');
  const now = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO mcp_keys(id,name,key_hash,prefix,status,created_at,last_used_at,revoked_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, String(name ?? ''), digest(key), key.slice(0, 12), 'active', now, null, null);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return {
    key,
    record: {
      id, name: String(name ?? ''), prefix: key.slice(0, 12), status: 'active',
      createdAt: now, lastUsedAt: null, revokedAt: null,
    },
  };
}

/** 按明文密钥查找：sha256 匹配且 status='active' 才命中，否则 null */
export function findMcpKey(db, raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const row = db.prepare("SELECT * FROM mcp_keys WHERE key_hash=? AND status='active'").get(digest(raw));
  return row ? rowToRecord(row) : null;
}

/** 密钥摘要列表（无明文无哈希），createdAt 倒序 */
export function listMcpKeys(db) {
  return db.prepare('SELECT * FROM mcp_keys ORDER BY created_at DESC').all().map(rowToRecord);
}

/** 撤销：置 revoked_at 与 status='revoked'，findMcpKey 随即失配 */
export function revokeMcpKey(db, id) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = db.prepare("UPDATE mcp_keys SET status='revoked', revoked_at=? WHERE id=?")
      .run(nowIso(), id);
    if (r.changes !== 1) throw new StoreError('NOT_FOUND', '密钥不存在');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 重新启用：清 revoked_at、恢复 status='active' */
export function enableMcpKey(db, id) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = db.prepare("UPDATE mcp_keys SET status='active', revoked_at=NULL WHERE id=?")
      .run(id);
    if (r.changes !== 1) throw new StoreError('NOT_FOUND', '密钥不存在');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 轻写：仅 active 密钥刷新 last_used_at（认证成功后调用） */
export function touchMcpKey(db, id) {
  db.prepare("UPDATE mcp_keys SET last_used_at=? WHERE id=? AND status='active'")
    .run(nowIso(), id);
}
