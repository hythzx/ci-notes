import { StoreError } from './errors.mjs';
import { newId } from './ids.mjs';
import { plainText } from './normalize.mjs';

/**
 * 回收站与跨实体删除编排。
 * 语义翻译自词间参考实现 utils/store-core.js 的 deleteWork/deleteNote/trash 段。
 * 与 works.mjs / notes.mjs 的关系：删除编排在本模块直接操作表，
 * 不经它们的写函数，避免与模块内的行更新 / casUpdate 交叠。
 *
 * 词间语义核对（以 store-core.js 实测为准）：
 *   - deleteWork 剥除相关札记 workIds，刷新受影响札记 updatedAt，不递增 revision；
 *   - deleteNote 入回收站时不删版本记录，purgeTrashItem 才连带删除；
 *   - restoreFromTrash 同 id 已存在时仅删除回收站项（幂等）；
 *   - 不提供「清空全部」入口。
 *
 * purge note 的实现约束：revisions 表有不可变触发器（preserve_revision_delete，
 * RAISE ABORT），SQLite 触发器无法读连接变量，故在同一事务内
 * DROP TRIGGER → DELETE → 按原 DDL 重建，保证原子且其余路径仍受保护。
 */

// 重建触发器的 DDL 必须与 db.mjs 中 preserve_revision_delete 的定义逐字一致
const PRESERVE_REVISION_DELETE_DDL = `CREATE TRIGGER IF NOT EXISTS preserve_revision_delete BEFORE DELETE ON revisions
BEGIN SELECT RAISE(ABORT,'revisions are immutable'); END;`;

const PREVIEW_LIMIT = 120;

function nowIso() {
  return new Date().toISOString();
}

function parseJson(text) {
  return JSON.parse(text);
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

/** 回收站预览：正文去 Markdown 后前 120 字；札记正文为空时提示待导入 */
function previewOf(itemType, snapshot) {
  const raw = plainText(snapshot.content || '');
  if (itemType === 'note' && !raw) return '（正文待导入）';
  return raw.slice(0, PREVIEW_LIMIT);
}

function trashRowToItem(row) {
  return {
    id: row.id,
    itemType: row.item_type,
    itemId: row.item_id,
    label: row.label,
    preview: previewOf(row.item_type, parseJson(row.snapshot)),
    trashedAt: row.trashed_at,
  };
}

/** 回收站列表，trashedAt 倒序 */
export function listTrash(db) {
  return db.prepare('SELECT id, item_type, item_id, label, snapshot, trashed_at FROM trash ORDER BY trashed_at DESC')
    .all()
    .map(trashRowToItem);
}

/* ------------------------------------------------------------------ */
/* 删除编排                                                            */
/* ------------------------------------------------------------------ */

/** 压入回收站一条记录，返回回收站项 id */
function pushTrash(db, itemType, itemId, label, payloadText) {
  const trashId = newId('t_');
  db.prepare('INSERT INTO trash(id,item_type,item_id,label,snapshot,trashed_at) VALUES(?,?,?,?,?,?)')
    .run(trashId, itemType, itemId, label, payloadText, nowIso());
  return trashId;
}

/**
 * 词作入回收站：删除 works 行，相关札记保留但剥除 workIds 中的该 id
 * （其余引用 relatedWorkIds/comparisons 保留悬空）。词作不存在抛 NOT_FOUND。
 */
export function trashWork(db, id) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT payload FROM works WHERE id=?').get(id);
    if (!row) throw new StoreError('NOT_FOUND', '词作不存在');
    const work = parseJson(row.payload);
    pushTrash(db, 'work', work.id, work.title || '（未命名词作）', row.payload);
    db.prepare('DELETE FROM works WHERE id=?').run(work.id);
    // 关联札记剥除 workIds 并刷新 updatedAt（照词间 deleteWork：不递增 revision）
    const notes = db.prepare('SELECT id, payload FROM notes').all();
    for (const n of notes) {
      const note = parseJson(n.payload);
      if ((note.workIds || []).indexOf(work.id) < 0) continue;
      note.workIds = note.workIds.filter((x) => x !== work.id);
      note.updatedAt = nowIso();
      db.prepare('UPDATE notes SET payload=? WHERE id=?').run(JSON.stringify(note), n.id);
    }
    db.exec('COMMIT');
    return { id: work.id };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 札记入回收站：删除 notes 行。版本记录保留在库中（恢复后仍可回看），
 * purge 时才连带删除（照词间 deleteNote）。札记不存在抛 NOT_FOUND。
 */
export function trashNote(db, id) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT payload FROM notes WHERE id=?').get(id);
    if (!row) throw new StoreError('NOT_FOUND', '札记不存在');
    const note = parseJson(row.payload);
    pushTrash(db, 'note', note.id, note.title || '（未命名札记）', row.payload);
    db.prepare('DELETE FROM notes WHERE id=?').run(note.id);
    db.exec('COMMIT');
    return { id: note.id };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 按快照恢复：work → works 表（含标量列），note → notes 表（含标量列），
 * revision 取快照值。同 id 在目标表已存在时仅删除回收站项，不覆盖现存数据；
 * 成功后删除回收站项。回收站项不存在抛 NOT_FOUND。
 */
export function restoreTrash(db, trashId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT id, item_type, item_id, label, snapshot, trashed_at FROM trash WHERE id=?')
      .get(trashId);
    if (!row) throw new StoreError('NOT_FOUND', '回收站里没有这一项');
    const snapshot = parseJson(row.snapshot);
    if (row.item_type === 'note') {
      const exists = db.prepare('SELECT id FROM notes WHERE id=?').get(row.item_id);
      if (!exists) {
        db.prepare('INSERT INTO notes(id,payload,revision,title,writing_status,publish_status,updated_at) VALUES(?,?,?,?,?,?,?)')
          .run(row.item_id, row.snapshot, snapshot.revision || 1, snapshot.title || '',
            snapshot.writingStatus || 'draft', snapshot.publishStatus || 'unpublished',
            snapshot.updatedAt || row.trashed_at);
      }
    } else if (row.item_type === 'work') {
      const exists = db.prepare('SELECT id FROM works WHERE id=?').get(row.item_id);
      if (!exists) {
        db.prepare('INSERT INTO works(id,payload,revision,title,author,cipai,kind,updated_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(row.item_id, row.snapshot, snapshot.revision || 1, snapshot.title || '',
            snapshot.author || '', snapshot.cipai || '', snapshot.kind || 'ci',
            snapshot.updatedAt || row.trashed_at);
      }
    }
    const item = { id: row.id, itemType: row.item_type, itemId: row.item_id, label: row.label, trashedAt: row.trashed_at };
    db.prepare('DELETE FROM trash WHERE id=?').run(trashId);
    db.exec('COMMIT');
    return item;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 永久删除回收站一项。itemType==='note' 时连带删除该札记全部版本记录：
 * 同一事务内摘除 preserve_revision_delete → DELETE revisions → 按原 DDL 重建
 * （DDL 参与事务回滚，任何一步失败都会原样恢复）。
 * 返回 { id, removedVersions }。回收站项不存在抛 NOT_FOUND。
 */
export function purgeTrash(db, trashId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT item_type, item_id FROM trash WHERE id=?').get(trashId);
    if (!row) throw new StoreError('NOT_FOUND', '回收站里没有这一项');
    let removedVersions = 0;
    if (row.item_type === 'note') {
      removedVersions = db.prepare('SELECT COUNT(*) c FROM revisions WHERE note_id=?').get(row.item_id).c;
      db.exec('DROP TRIGGER preserve_revision_delete');
      db.prepare('DELETE FROM revisions WHERE note_id=?').run(row.item_id);
      db.exec(PRESERVE_REVISION_DELETE_DDL);
    }
    db.prepare('DELETE FROM trash WHERE id=?').run(trashId);
    db.exec('COMMIT');
    return { id: trashId, removedVersions };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
