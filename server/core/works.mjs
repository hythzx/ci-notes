import { StoreError } from './errors.mjs';
import { newId } from './ids.mjs';
import { casUpdate } from './db.mjs';
import {
  normalizeTags, normalizeClaims, normalizeCitations,
  excerpt, charCount, plainText, excerptOfNote,
} from './normalize.mjs';
import { imageryEntriesForTarget } from './imagery.mjs';

/**
 * 词作实体：CRUD、CAS 乐观锁、搜索与筛选。
 * 语义逐段翻译自词间参考实现 utils/store-core.js 的 works 部分：
 * makeWork/createWork/updateWork/listWorks/workMatchesText/getWorkDetail。
 * 差异：内存 db 对象改为 SQLite payload 列读写；单用户，去掉 ownerId/ownedRecords。
 * imagery 装配由 imagery.mjs 提供（uses 表按意象分组）；allusions 为空占位，Task 7 接入。
 */

function str(v) {
  if (v === undefined || v === null) return '';
  return String(v);
}

function trim(v) {
  return str(v).trim();
}

function nowIso() {
  return new Date().toISOString();
}

function parseJson(text) {
  return JSON.parse(text);
}

/** DB 行 → 词作 payload 对象 */
export function workRowToRecord(row) {
  return parseJson(row.payload);
}

function workByIdRow(db, id) {
  return db.prepare('SELECT payload FROM works WHERE id=?').get(id);
}

/* ------------------------------------------------------------------ */
/* 写操作                                                              */
/* ------------------------------------------------------------------ */

/** 按 makeWork 归一化出完整 payload（含校验前的默认值） */
function buildWork(input) {
  const now = nowIso();
  return {
    id: newId('w_'),
    kind: input.kind === 'poem' ? 'poem' : 'ci',
    title: trim(input.title),
    author: trim(input.author),
    dynasty: trim(input.dynasty),
    cipai: trim(input.cipai),
    content: str(input.content),
    background: str(input.background),
    claims: normalizeClaims(input.claims),
    citations: normalizeCitations(input.citations),
    tags: normalizeTags(input.tags),
    relatedWorkIds: Array.isArray(input.relatedWorkIds) ? input.relatedWorkIds.slice() : [],
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
}

export function createWork(db, input) {
  const work = buildWork(input || {});
  if (!work.title && !work.content) {
    throw new StoreError('INVALID', '至少填写标题或原文');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO works(id,payload,revision,title,author,cipai,kind,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(work.id, JSON.stringify(work), 1, work.title, work.author, work.cipai, work.kind, work.updatedAt);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return work;
}

/**
 * 字段级合并：undefined 表示不改动（照词间 updateWork）。
 * patch 里的 id/revision/createdAt/updatedAt 被忽略，revision 由本函数推进。
 */
function applyPatch(work, patch) {
  if (patch.title !== undefined) work.title = trim(patch.title);
  if (patch.author !== undefined) work.author = trim(patch.author);
  if (patch.dynasty !== undefined) work.dynasty = trim(patch.dynasty);
  if (patch.cipai !== undefined) work.cipai = trim(patch.cipai);
  if (patch.kind !== undefined) work.kind = patch.kind === 'poem' ? 'poem' : 'ci';
  if (patch.content !== undefined) work.content = str(patch.content);
  if (patch.background !== undefined) work.background = str(patch.background);
  if (patch.claims !== undefined) work.claims = normalizeClaims(patch.claims);
  if (patch.citations !== undefined) work.citations = normalizeCitations(patch.citations);
  if (patch.tags !== undefined) work.tags = normalizeTags(patch.tags);
  if (patch.relatedWorkIds !== undefined) {
    work.relatedWorkIds = Array.isArray(patch.relatedWorkIds) ? patch.relatedWorkIds.slice() : [];
  }
}

export function updateWork(db, id, patch, opts) {
  const options = opts || {};
  // 词间语义：未传 baseRevision 视为无并发检查，直接写；force 则越过检查强制覆盖
  const hasBase = options.baseRevision !== undefined && options.baseRevision !== null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT payload, revision FROM works WHERE id=?').get(id);
    if (!row) throw new StoreError('NOT_FOUND', '词作不存在');
    const work = workRowToRecord(row);
    if (hasBase && !options.force && work.revision !== options.baseRevision) {
      throw new StoreError('CONFLICT', '这条词作在别处被改过', work);
    }
    applyPatch(work, patch || {});
    const now = nowIso();
    work.updatedAt = now;
    work.revision = row.revision + 1;
    // force 或无 baseRevision 时以库中当前 revision 为基准，必然命中
    const base = hasBase && !options.force ? options.baseRevision : row.revision;
    const r = casUpdate(db, 'works', id, base, work, now);
    if (!r.ok) {
      // BEGIN IMMEDIATE 串行化后不会走到这里；保留 casUpdate 的冲突契约
      throw new StoreError('CONFLICT', '这条词作在别处被改过', r.current);
    }
    // casUpdate 只同步 payload/revision/updated_at，标量冗余列在此补齐
    db.prepare('UPDATE works SET title=?, author=?, cipai=?, kind=? WHERE id=?')
      .run(work.title, work.author, work.cipai, work.kind, id);
    db.exec('COMMIT');
    return { work };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 搜索与筛选                                                          */
/* ------------------------------------------------------------------ */

/** q 全文匹配：字段清单照词间 workMatchesText，content/background 去 Markdown 标记后匹配 */
function workMatchesText(work, needle) {
  const s = needle.toLowerCase();
  const hay = [
    work.title, work.author, work.dynasty, work.cipai,
    plainText(work.content), plainText(work.background),
    (work.tags || []).join(' '),
    (work.claims || []).map((c) => c.text).join(' '),
    (work.citations || []).map((c) => c.book + ' ' + c.note).join(' '),
  ].join('\n').toLowerCase();
  return hay.indexOf(s) >= 0;
}

/** 正文首行：第一个非空行，去首尾空白 */
function firstLine(content) {
  const line = str(content).split('\n').map((s) => s.trim()).find(Boolean);
  return line || '';
}

/** 待核实资料数（claims 中 kind=pending） */
function pendingClaimCount(work) {
  return (work.claims || []).filter((c) => c.kind === 'pending').length;
}

/** 列表摘要：{id,title,author,dynasty,cipai,kind,excerpt,firstLine,tags,pendingClaims,noteCount,updatedAt} */
function workSummary(work, noteCount) {
  return {
    id: work.id,
    title: work.title,
    author: work.author,
    dynasty: work.dynasty,
    cipai: work.cipai,
    kind: work.kind,
    excerpt: excerpt(plainText(work.content), 60),
    firstLine: firstLine(work.content),
    tags: work.tags || [],
    pendingClaims: pendingClaimCount(work),
    noteCount,
    updatedAt: work.updatedAt,
  };
}

/** workIds → 关联札记数。数据量小，notes 全量读 payload 后 JS 统计 */
function noteCountByWork(db) {
  const counts = new Map();
  const rows = db.prepare('SELECT payload FROM notes').all();
  for (const row of rows) {
    const note = parseJson(row.payload);
    for (const wid of note.workIds || []) {
      counts.set(wid, (counts.get(wid) || 0) + 1);
    }
  }
  return counts;
}

export function listWorks(db, filters) {
  const f = filters || {};
  const counts = noteCountByWork(db);
  let items = db.prepare('SELECT payload FROM works').all().map(workRowToRecord);
  const needle = trim(f.q);
  if (needle) items = items.filter((w) => workMatchesText(w, needle));
  if (f.author) items = items.filter((w) => w.author === f.author);
  if (f.cipai) items = items.filter((w) => w.cipai === f.cipai);
  if (f.tag) items = items.filter((w) => (w.tags || []).indexOf(f.tag) >= 0);
  if (f.kind) items = items.filter((w) => w.kind === f.kind);
  items.sort((a, b) => str(b.updatedAt).localeCompare(str(a.updatedAt)));
  return items.map((w) => workSummary(w, counts.get(w.id) || 0));
}

/* ------------------------------------------------------------------ */
/* 详情                                                                */
/* ------------------------------------------------------------------ */

/** 关联札记摘要：字段照词间 noteSummary（excerpt 用 ci-notes 的 excerptOfNote） */
function noteSummary(note) {
  return {
    id: note.id,
    title: note.title,
    tags: note.tags || [],
    writingStatus: note.writingStatus,
    publishStatus: note.publishStatus,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    excerpt: excerptOfNote(note),
    wordCount: charCount(note.content),
    workIds: note.workIds || [],
  };
}

export function getWork(db, id) {
  const row = workByIdRow(db, id);
  if (!row) throw new StoreError('NOT_FOUND', '词作不存在');
  const work = workRowToRecord(row);
  const relatedWorks = (work.relatedWorkIds || [])
    .map((rid) => workByIdRow(db, rid))
    .filter(Boolean)
    .map((r) => {
      const w = workRowToRecord(r);
      return { id: w.id, title: w.title, author: w.author };
    });
  const linkedNotes = db.prepare('SELECT payload FROM notes').all()
    .map((r) => parseJson(r.payload))
    .filter((n) => (n.workIds || []).indexOf(work.id) >= 0)
    .sort((a, b) => str(b.updatedAt).localeCompare(str(a.updatedAt)))
    .map(noteSummary);
  // imagery 装配自 imagery_uses 表（按意象分组）；allusions 空占位，Task 7 接入
  const imagery = { entries: imageryEntriesForTarget(db, 'work', work.id), allusions: { entries: [] } };
  return { work, relatedWorks, linkedNotes, imagery };
}
