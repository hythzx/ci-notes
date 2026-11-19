import { StoreError } from './errors.mjs';
import { newId } from './ids.mjs';
import { nextSeq, casUpdate } from './db.mjs';
import {
  normalizeTags, normalizeClaims, normalizeCitations,
  charCount, excerptOfNote, plainText,
} from './normalize.mjs';
import { diffText, charDiff } from './diffcore.mjs';
import { imageryEntriesForTarget } from './imagery.mjs';
import { allusionEntriesForTarget } from './allusions.mjs';

/**
 * 札记实体：CRUD、CAS 乐观锁、版本历史与 diff。
 * 语义逐段翻译自词间参考实现 utils/store-core.js 的 notes/revisions 部分：
 * makeNote/createNote/saveNote/unprotectNote/snapshotOf/pushRevision/
 * listRevisions/restoreRevisionAsDraft/compareRevisions。
 * 与参考实现的差异：
 *   - 内存整库对象改为 SQLite payload 列读写，全部写路径包 BEGIN IMMEDIATE 事务；
 *   - seq 取自全局计数器（nextSeq，事务内调用），代替数组长度；
 *   - createNote 要求标题非空、返回 {note, revision}（brief 契约）；
 *   - saveNote 冲突消息与返回形状按 brief；
 *   - restoreRevision 恢复 snapshot 的全部内容字段（含 tags/pendingImport，
 *     参考实现沿用当前稿 tags 属于遗留偏差）。
 * imagery / allusions 装配分别由 imagery.mjs / allusions.mjs 提供（uses 表按分组键装配）。
 */

const WRITING_STATUSES = ['idea', 'research', 'draft', 'final'];
const PUBLISH_STATUSES = ['unpublished', 'pending', 'published'];

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

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/* ------------------------------------------------------------------ */
/* payload 归一化                                                      */
/* ------------------------------------------------------------------ */

/** 发布登记：纯字符串三元组，无额外语义 */
function normalizePublish(p) {
  const o = p || {};
  return {
    platform: trim(o.platform),
    publishedAt: trim(o.publishedAt),
    url: trim(o.url),
  };
}

/** 按 makeNote 归一化出完整 payload */
function buildNote(input) {
  const src = input || {};
  const now = nowIso();
  return {
    id: newId('n_'),
    title: trim(src.title),
    content: str(src.content),
    note: str(src.note),
    workIds: Array.isArray(src.workIds) ? src.workIds.slice() : [],
    claims: normalizeClaims(src.claims),
    citations: normalizeCitations(src.citations),
    tags: normalizeTags(src.tags),
    writingStatus: WRITING_STATUSES.indexOf(src.writingStatus) >= 0 ? src.writingStatus : 'draft',
    publishStatus: PUBLISH_STATUSES.indexOf(src.publishStatus) >= 0 ? src.publishStatus : 'unpublished',
    publish: normalizePublish(src.publish),
    changeNote: trim(src.changeNote),
    pendingImport: !!src.pendingImport,
    draftOf: trim(src.draftOf),
    draftNoteId: '',
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
}

/** 字段级合并：undefined 表示不改动（照词间 applyNotePatch） */
function applyNotePatch(note, patch) {
  if (patch.title !== undefined) note.title = trim(patch.title);
  if (patch.content !== undefined) note.content = str(patch.content);
  if (patch.note !== undefined) note.note = str(patch.note);
  if (patch.workIds !== undefined) note.workIds = Array.isArray(patch.workIds) ? patch.workIds.slice() : [];
  if (patch.claims !== undefined) note.claims = normalizeClaims(patch.claims);
  if (patch.citations !== undefined) note.citations = normalizeCitations(patch.citations);
  if (patch.tags !== undefined) note.tags = normalizeTags(patch.tags);
  if (patch.writingStatus !== undefined && WRITING_STATUSES.indexOf(patch.writingStatus) >= 0) {
    note.writingStatus = patch.writingStatus;
  }
  if (patch.publishStatus !== undefined && PUBLISH_STATUSES.indexOf(patch.publishStatus) >= 0) {
    note.publishStatus = patch.publishStatus;
  }
  if (patch.publish !== undefined) note.publish = normalizePublish(patch.publish);
  if (patch.changeNote !== undefined) note.changeNote = trim(patch.changeNote);
  if (patch.pendingImport !== undefined) note.pendingImport = !!patch.pendingImport;
}

/** 定稿 / 已发布的札记内容冻结，保存时另起派生草稿 */
function isProtected(note) {
  return note.writingStatus === 'final' || note.publishStatus === 'published';
}

/** 版本快照：只含内容字段（规格 4.2 revision），不含 id/时间戳/revision */
export function snapshotOf(note) {
  return {
    title: note.title,
    content: note.content,
    note: note.note,
    workIds: (note.workIds || []).slice(),
    claims: clone(note.claims || []),
    citations: clone(note.citations || []),
    tags: (note.tags || []).slice(),
    writingStatus: note.writingStatus,
    publishStatus: note.publishStatus,
    publish: clone(note.publish),
    changeNote: note.changeNote,
    pendingImport: !!note.pendingImport,
  };
}

function noteRowToRecord(row) {
  return parseJson(row.payload);
}

/* ------------------------------------------------------------------ */
/* 持久化辅助                                                          */
/* ------------------------------------------------------------------ */

function insertNoteRow(db, note) {
  db.prepare('INSERT INTO notes(id,payload,revision,title,writing_status,publish_status,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(note.id, JSON.stringify(note), note.revision, note.title, note.writingStatus, note.publishStatus, note.updatedAt);
}

/** payload/revision 更新走 casUpdate；标量冗余列在此同步 */
function writeNoteRow(db, note, baseRevision) {
  const r = casUpdate(db, 'notes', note.id, baseRevision, note, note.updatedAt);
  if (!r.ok) {
    // BEGIN IMMEDIATE 串行化后不会走到这里；保留 casUpdate 的冲突契约
    throw new StoreError('CONFLICT', '这条札记在别处被改过。可以保留你的版本覆盖，或采用对方的版本。', r.current);
  }
  db.prepare('UPDATE notes SET title=?, writing_status=?, publish_status=? WHERE id=?')
    .run(note.title, note.writingStatus, note.publishStatus, note.id);
}

/**
 * 追加一条版本记录。必须在 BEGIN IMMEDIATE 事务内调用（nextSeq 依赖写锁）。
 */
function pushRevision(db, note, reason, changeNote) {
  const rev = {
    id: newId('rv_'),
    noteId: note.id,
    seq: nextSeq(db),
    snapshot: snapshotOf(note),
    changeNote: trim(changeNote),
    reason: reason || 'manual',
    createdAt: nowIso(),
  };
  db.prepare('INSERT INTO revisions(id,note_id,seq,snapshot,change_note,reason,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(rev.id, rev.noteId, rev.seq, JSON.stringify(rev.snapshot), rev.changeNote, rev.reason, rev.createdAt);
  return rev;
}

/** 版本行 → 列表摘要；charCount/writingStatus 从快照取 */
function revisionSummary(row) {
  const snap = parseJson(row.snapshot);
  return {
    id: row.id,
    seq: row.seq,
    createdAt: row.created_at,
    changeNote: row.change_note,
    reason: row.reason,
    charCount: charCount(snap.content),
    writingStatus: snap.writingStatus,
  };
}

function revisionByIdRow(db, revId) {
  return db.prepare('SELECT id, note_id, seq, snapshot, change_note, reason, created_at FROM revisions WHERE id=?').get(revId);
}

function noteByIdRow(db, id) {
  return db.prepare('SELECT payload, revision FROM notes WHERE id=?').get(id);
}

/** 断言札记存在，返回行；统一 NOT_FOUND 文案 */
function requireNoteRow(db, id) {
  const row = noteByIdRow(db, id);
  if (!row) throw new StoreError('NOT_FOUND', '札记不存在');
  return row;
}

/* ------------------------------------------------------------------ */
/* 写操作                                                              */
/* ------------------------------------------------------------------ */

export function createNote(db, input) {
  const note = buildNote(input || {});
  if (!note.title) throw new StoreError('INVALID', '标题不能为空');
  db.exec('BEGIN IMMEDIATE');
  try {
    insertNoteRow(db, note);
    const revision = pushRevision(db, note, 'manual', note.changeNote);
    db.exec('COMMIT');
    return { note, revision };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 保存札记。三种结果：
 *   1. 正常 → { note, revision, createdDraft: false }（reason='manual'）
 *   2. CAS 未命中且 force=false → 抛 CONFLICT，current 为库中最新 payload
 *      force=true → 先把服务器当前内容存一条 conflict-overwrite 版本，再覆盖保存
 *   3. protected（final/published）→ 原稿一字不动，创建派生草稿并回写
 *      原稿 draftNoteId → { createdDraft: true, note: 原稿, draft }，
 *      草稿生成 reason='draft-from-final' 版本
 */
export function saveNote(db, id, input, opts) {
  const options = opts || {};
  const patch = input || {};
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = requireNoteRow(db, id);
    const note = noteRowToRecord(row);
    const hasBase = options.baseRevision !== undefined && options.baseRevision !== null;

    // CAS 检查：未命中且非 force 时抛冲突；force 覆盖总是先留档当前内容（含命中场景），避免丢失他人改动
    if (hasBase && !options.force && note.revision !== options.baseRevision) {
      throw new StoreError('CONFLICT', '这条札记在别处被改过。可以保留你的版本覆盖，或采用对方的版本。', note);
    }
    if (options.force) {
      pushRevision(db, note, 'conflict-overwrite', '覆盖前的版本（来自别处的改动）');
    }

    const changeNote = trim(patch.changeNote);

    // 定稿 / 已发布：内容冻结，另起新草稿，原版一字不动
    if (isProtected(note)) {
      const draft = clone(note);
      draft.id = newId('n_');
      draft.createdAt = nowIso();
      draft.updatedAt = draft.createdAt;
      draft.draftOf = note.id;
      draft.draftNoteId = '';
      applyNotePatch(draft, patch);
      // 状态字段在承接 patch 之后强制重置：派生草稿永远是 draft/unpublished，
      // 不受 patch 携带的 final/published 状态影响
      draft.writingStatus = 'draft';
      draft.publishStatus = 'unpublished';
      draft.publish = normalizePublish({});
      // 前缀固定标记草稿来源；用户 changeNote 附在后
      draft.changeNote = changeNote ? '基于定稿继续修改：' + changeNote : '基于定稿继续修改';
      draft.revision = 1;
      insertNoteRow(db, draft);
      pushRevision(db, draft, 'draft-from-final', draft.changeNote);
      // 原稿只回写指针，内容与 revision 均不变
      note.draftNoteId = draft.id;
      note.updatedAt = nowIso();
      db.prepare('UPDATE notes SET payload=?, updated_at=? WHERE id=?')
        .run(JSON.stringify(note), note.updatedAt, note.id);
      db.exec('COMMIT');
      return { createdDraft: true, note, draft };
    }

    applyNotePatch(note, patch);
    note.changeNote = changeNote;
    note.updatedAt = nowIso();
    note.revision = row.revision + 1;
    writeNoteRow(db, note, row.revision);
    const revision = pushRevision(db, note, 'manual', changeNote);
    db.exec('COMMIT');
    return { note, revision, createdDraft: false };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 明确撤销定稿 / 发布状态：就地修改并生成 manual 版本记录变更 */
export function unprotectNote(db, id) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = requireNoteRow(db, id);
    const note = noteRowToRecord(row);
    if (note.writingStatus === 'final') note.writingStatus = 'draft';
    if (note.publishStatus === 'published') note.publishStatus = 'unpublished';
    note.updatedAt = nowIso();
    note.revision = row.revision + 1;
    writeNoteRow(db, note, row.revision);
    pushRevision(db, note, 'manual', '调整状态');
    db.exec('COMMIT');
    return note;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

/** q 全文匹配：字段清单照词间 noteMatchesText，content 去 Markdown 标记后匹配 */
function noteMatchesText(note, needle) {
  const s = needle.toLowerCase();
  const hay = [
    note.title,
    plainText(note.content),
    note.note,
    (note.claims || []).map((c) => c.text).join(' '),
    (note.citations || []).map((c) => c.book + ' ' + c.note).join(' '),
  ].join('\n').toLowerCase();
  return hay.indexOf(s) >= 0;
}

/** 列表摘要：brief 契约字段 */
function noteSummary(note) {
  return {
    id: note.id,
    title: note.title,
    excerpt: excerptOfNote(note),
    tags: note.tags || [],
    writingStatus: note.writingStatus,
    publishStatus: note.publishStatus,
    pendingImport: !!note.pendingImport,
    draftOf: note.draftOf || '',
    draftNoteId: note.draftNoteId || '',
    updatedAt: note.updatedAt,
    charCount: charCount(note.content),
  };
}

export function listNotes(db, filters) {
  const f = filters || {};
  let items = db.prepare('SELECT payload FROM notes').all().map(noteRowToRecord);
  const needle = trim(f.q);
  if (needle) items = items.filter((n) => noteMatchesText(n, needle));
  if (f.writingStatus) items = items.filter((n) => n.writingStatus === f.writingStatus);
  if (f.publishStatus) items = items.filter((n) => n.publishStatus === f.publishStatus);
  if (f.workId) items = items.filter((n) => (n.workIds || []).indexOf(f.workId) >= 0);
  if (f.tag) items = items.filter((n) => (n.tags || []).indexOf(f.tag) >= 0);
  items.sort((a, b) => str(b.updatedAt).localeCompare(str(a.updatedAt)));
  return items.map(noteSummary);
}

/** work.claims 按 kind 分组（works payload 无 claimGroups 概念） */
function claimGroupsOf(work) {
  const groups = { verified: [], pending: [], personal: [] };
  for (const c of work.claims || []) {
    if (groups[c.kind]) groups[c.kind].push(c);
  }
  return groups;
}

export function getNote(db, id) {
  const row = requireNoteRow(db, id);
  const note = noteRowToRecord(row);
  const linkedWorks = (note.workIds || [])
    .map((wid) => db.prepare('SELECT payload FROM works WHERE id=?').get(wid))
    .filter(Boolean)
    .map((r) => {
      const work = parseJson(r.payload);
      return { work, claimGroups: claimGroupsOf(work) };
    });
  // imagery / allusions 分别装配自 imagery_uses / allusion_uses 表（按各自实体分组）
  const imagery = {
    entries: imageryEntriesForTarget(db, 'note', note.id),
    allusions: { entries: allusionEntriesForTarget(db, 'note', note.id) },
  };
  return { note, linkedWorks, imagery };
}

/* ------------------------------------------------------------------ */
/* 版本                                                                */
/* ------------------------------------------------------------------ */

export function listRevisions(db, noteId) {
  requireNoteRow(db, noteId);
  // 按序号倒序：同一毫秒里连续保存时时间戳可能相同，序号才是可靠顺序
  const rows = db.prepare(
    'SELECT id, seq, snapshot, change_note, reason, created_at FROM revisions WHERE note_id=? ORDER BY seq DESC',
  ).all(noteId);
  return rows.map(revisionSummary);
}

/**
 * 比较两个版本。rows 以 content 的行级 diff 为主体，
 * 标题不同时在头部并入一条 change 行（字级 segments），并计入 stats.changed。
 */
export function compareRevisions(db, noteId, aId, bId) {
  const ra = revisionByIdRow(db, aId);
  if (!ra) throw new StoreError('NOT_FOUND', '版本不存在');
  const rb = revisionByIdRow(db, bId);
  if (!rb) throw new StoreError('NOT_FOUND', '版本不存在');
  if (ra.note_id !== noteId || rb.note_id !== noteId) {
    throw new StoreError('INVALID', '这两个版本不属于同一篇札记');
  }
  const aSnap = parseJson(ra.snapshot);
  const bSnap = parseJson(rb.snapshot);
  const contentDiff = diffText(aSnap.content || '', bSnap.content || '');
  const rows = contentDiff.rows;
  const stats = { ...contentDiff.stats };
  if (aSnap.title !== bSnap.title) {
    rows.unshift({ type: 'change', a: aSnap.title, b: bSnap.title, segments: charDiff(aSnap.title, bSnap.title) });
    stats.changed++;
  }
  return {
    a: { id: ra.id, seq: ra.seq, createdAt: ra.created_at, changeNote: ra.change_note, title: aSnap.title },
    b: { id: rb.id, seq: rb.seq, createdAt: rb.created_at, changeNote: rb.change_note, title: bSnap.title },
    rows,
    stats,
  };
}

/** 把某个历史版本复制成独立新草稿，原稿挂上 draftNoteId 指针 */
export function restoreRevision(db, noteId, revId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const noteRow = requireNoteRow(db, noteId);
    const note = noteRowToRecord(noteRow);
    const revRow = revisionByIdRow(db, revId);
    if (!revRow) throw new StoreError('NOT_FOUND', '版本不存在');
    if (revRow.note_id !== noteId) throw new StoreError('INVALID', '版本不属于这篇札记');
    const snap = parseJson(revRow.snapshot);
    const draft = clone(note);
    draft.id = newId('n_');
    draft.createdAt = nowIso();
    draft.updatedAt = draft.createdAt;
    // 内容字段恢复到快照时刻
    draft.title = snap.title !== undefined ? snap.title : note.title;
    draft.content = snap.content !== undefined ? snap.content : note.content;
    draft.note = snap.note !== undefined ? snap.note : note.note;
    draft.workIds = snap.workIds ? snap.workIds.slice() : (note.workIds || []).slice();
    draft.claims = normalizeClaims(snap.claims);
    draft.citations = normalizeCitations(snap.citations);
    draft.tags = snap.tags ? normalizeTags(snap.tags) : (note.tags || []).slice();
    draft.pendingImport = snap.pendingImport !== undefined ? !!snap.pendingImport : !!note.pendingImport;
    // 状态字段强制重置为草稿
    draft.writingStatus = 'draft';
    draft.publishStatus = 'unpublished';
    draft.publish = normalizePublish({});
    draft.draftOf = note.id;
    draft.draftNoteId = '';
    draft.changeNote = '由版本「' + (revRow.change_note || ('v' + revRow.seq)) + '」复制为草稿';
    draft.revision = 1;
    insertNoteRow(db, draft);
    pushRevision(db, draft, 'restore', draft.changeNote);
    // 原稿只回写指针，内容与 revision 均不变
    note.draftNoteId = draft.id;
    note.updatedAt = nowIso();
    db.prepare('UPDATE notes SET payload=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(note), note.updatedAt, note.id);
    db.exec('COMMIT');
    return { draft };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
