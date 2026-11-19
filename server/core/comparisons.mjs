import { StoreError } from './errors.mjs';
import { newId } from './ids.mjs';
import { normalizeCitations } from './normalize.mjs';
import { getWork } from './works.mjs';

/**
 * 词作对照实体：七维对照、甲乙双侧描述、创建/整体覆盖/删除。
 * 语义逐段翻译自词间参考实现 utils/store-core.js 的 comparisons 段：
 * emptyDimensions/listComparisons/getComparison/saveComparison/deleteComparison。
 * 与参考实现的差异（brief 契约）：
 *   - sides 仅前 4 维（context/imagery/allusion/expression），后 3 维无 sides；
 *   - understanding 维 kind 默认 'personal'，其余默认 'pending'；
 *   - 维度 text 与 sides 的 a/b 做 trim（词间只 str）；
 *   - 新建时校验甲乙作品存在且不同（词间无校验）；更新沿用词间回落语义：
 *     title/workAId/workBId 留空时保留原值，不做存在性校验；
 *   - 内存数组改为 SQLite payload 行读写，写操作包 BEGIN IMMEDIATE 事务；
 *   - 列表返回摘要并装配 workATitle/workBTitle，作品已删显示「（已删除的词作）」。
 * 对照无乐观锁、无版本历史（整体覆盖保存），不进回收站（直接删除）。
 */

export const COMPARE_DIMENSIONS = [
  ['context', '人物与情境'],
  ['imagery', '意象'],
  ['allusion', '典故及出处'],
  ['expression', '表达方式'],
  ['similarity', '相同点'],
  ['difference', '不同点'],
  ['understanding', '自己的阅读理解'],
];

export const SIDE_DIMENSIONS = ['context', 'imagery', 'allusion', 'expression'];

const CLAIM_KINDS = ['verified', 'pending', 'personal'];
const DELETED_WORK_LABEL = '（已删除的词作）';

function trim(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function nowIso() {
  return new Date().toISOString();
}

/** 维度默认可信度：理解维是个人观点，其余默认待核实 */
function defaultKind(key) {
  return key === 'understanding' ? 'personal' : 'pending';
}

function hasSide(key) {
  return SIDE_DIMENSIONS.indexOf(key) >= 0;
}

/* ------------------------------------------------------------------ */
/* 维度归一化                                                          */
/* ------------------------------------------------------------------ */

/** 七维全空模板。每次新建独立对象，避免调用方共享引用 */
export function emptyDimensions() {
  const dims = {};
  for (const [key] of COMPARE_DIMENSIONS) {
    dims[key] = hasSide(key)
      ? { text: '', kind: defaultKind(key), citations: [], sides: { a: '', b: '' } }
      : { text: '', kind: defaultKind(key), citations: [] };
  }
  return dims;
}

/** 以空模板为底覆盖输入；未知维度 key 丢弃（照词间 saveComparison） */
function normalizeDimensions(input) {
  const dims = emptyDimensions();
  const src = input && typeof input === 'object' ? input : {};
  for (const [key] of COMPARE_DIMENSIONS) {
    const v = src[key];
    if (!v) continue;
    const dim = {
      text: trim(v.text),
      kind: CLAIM_KINDS.indexOf(v.kind) >= 0 ? v.kind : defaultKind(key),
      citations: normalizeCitations(v.citations),
    };
    if (hasSide(key)) {
      dim.sides = { a: trim(v.sides && v.sides.a), b: trim(v.sides && v.sides.b) };
    }
    dims[key] = dim;
  }
  return dims;
}

/* ------------------------------------------------------------------ */
/* 持久化辅助                                                          */
/* ------------------------------------------------------------------ */

function comparisonRow(db, id) {
  return db.prepare('SELECT payload FROM comparisons WHERE id=?').get(id);
}

function workExists(db, id) {
  return !!db.prepare('SELECT 1 FROM works WHERE id=?').get(id);
}

/* ------------------------------------------------------------------ */
/* 写操作                                                              */
/* ------------------------------------------------------------------ */

/**
 * 保存对照。无 id 新建（校验甲乙作品存在且不同），有 id 整体覆盖
 * （dimensions 重建归一化；title/workAId/workBId 留空回落原值，照词间语义）。
 */
export function saveComparison(db, input) {
  const src = input || {};
  db.exec('BEGIN IMMEDIATE');
  try {
    const dims = normalizeDimensions(src.dimensions);
    const existing = src.id ? comparisonRow(db, src.id) : null;
    // 带 id 即视为整体覆盖既有记录：id 不存在报 NOT_FOUND，不落回新建
    if (src.id && !existing) throw new StoreError('NOT_FOUND', '对照笔记不存在');
    const now = nowIso();

    if (existing) {
      const c = JSON.parse(existing.payload);
      c.title = trim(src.title) || c.title;
      c.workAId = trim(src.workAId) || c.workAId;
      c.workBId = trim(src.workBId) || c.workBId;
      c.dimensions = dims;
      c.updatedAt = now;
      db.prepare('UPDATE comparisons SET payload=?, work_a_id=?, work_b_id=?, updated_at=? WHERE id=?')
        .run(JSON.stringify(c), c.workAId, c.workBId, c.updatedAt, c.id);
      db.exec('COMMIT');
      return c;
    }

    const workAId = trim(src.workAId);
    const workBId = trim(src.workBId);
    if (!workExists(db, workAId)) throw new StoreError('INVALID', '甲侧词作不存在');
    if (!workExists(db, workBId)) throw new StoreError('INVALID', '乙侧词作不存在');
    if (workAId === workBId) throw new StoreError('INVALID', '甲乙两侧不能是同一首词作');
    const cmp = {
      id: newId('cp_'),
      title: trim(src.title),
      workAId,
      workBId,
      dimensions: dims,
      createdAt: now,
      updatedAt: now,
    };
    db.prepare('INSERT INTO comparisons(id,payload,work_a_id,work_b_id,updated_at) VALUES(?,?,?,?,?)')
      .run(cmp.id, JSON.stringify(cmp), cmp.workAId, cmp.workBId, cmp.updatedAt);
    db.exec('COMMIT');
    return cmp;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 直接删除（不进回收站） */
export function deleteComparison(db, id) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = db.prepare('DELETE FROM comparisons WHERE id=?').run(id);
    if (r.changes !== 1) throw new StoreError('NOT_FOUND', '对照笔记不存在');
    db.exec('COMMIT');
    return { id };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

/** 作品存在返回 payload，已删/悬空引用返回 null */
function workOrNull(db, id) {
  try {
    return getWork(db, id).work;
  } catch (e) {
    if (e instanceof StoreError && e.code === 'NOT_FOUND') return null;
    throw e;
  }
}

export function getComparison(db, id) {
  const row = comparisonRow(db, id);
  if (!row) throw new StoreError('NOT_FOUND', '对照笔记不存在');
  const comparison = JSON.parse(row.payload);
  return { comparison, workA: workOrNull(db, comparison.workAId), workB: workOrNull(db, comparison.workBId) };
}

/** 列表摘要：双侧标题从 works 标量列取，已删作品显示占位；updatedAt 倒序 */
export function listComparisons(db) {
  const titles = new Map(db.prepare('SELECT id, title FROM works').all().map((r) => [r.id, r.title]));
  const rows = db.prepare('SELECT payload FROM comparisons ORDER BY updated_at DESC').all();
  return rows.map((row) => {
    const c = JSON.parse(row.payload);
    return {
      id: c.id,
      title: c.title,
      workAId: c.workAId,
      workBId: c.workBId,
      workATitle: titles.get(c.workAId) || DELETED_WORK_LABEL,
      workBTitle: titles.get(c.workBId) || DELETED_WORK_LABEL,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  });
}
