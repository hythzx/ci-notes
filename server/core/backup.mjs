import { StoreError } from './errors.mjs';
import { newId, derivedId, digest } from './ids.mjs';
import { nextSeq } from './db.mjs';
import { sameContent } from './normalize.mjs';
import { COMPARE_DIMENSIONS } from './comparisons.mjs';

/**
 * 备份导出与合并导入（brief 契约）：
 *   buildBackup / parseBackup / validateBackup / preflightImport / mergeImport。
 * 合并语义逐段翻译自词间参考实现 utils/store-core.js 的 buildBackup/validateBackup/
 * preflightImport/mergeImport，差异按 ci-notes 的 SQLite 存储调整：
 *   - 内存整库克隆改为 BEGIN IMMEDIATE 单事务逐行 INSERT，失败整体回滚；
 *   - 单用户：写入前剥去词间记录的 ownerId/app_id/owner_name（其余额外键保留）；
 *   - 词间兼容：format='cijian-backup' v1/v2 可导入（缺 imagery/allusions 按空处理），
 *     词间 imageryUse 的表达作用字段 function 导入时改名为 fn；
 *   - seq：版本行的 seq 列改用全局计数器 nextSeq（备份内原 seq 仅作导出展示，
 *     不落库），比较时忽略 seq；
 *   - 幂等增强（idMap 一致性）：冲突副本 id 由 backupHash 确定性派生；副本已存在时
 *     idMap 仍登记 旧id→副本id，且比较先做原样对比、再做经 idMap 重映射的对比，
 *     使同一备份（含跨引用冲突场景）二次导入全部按同内容跳过；
 *   - 对已有内容仅 INSERT（不覆盖、不删除，定稿/已发布自然受保护）；仅对本批次新导入的
 *     札记做派生指针（draftOf/draftNoteId）的 UPDATE 修正（fixupDraftPointers）；
 *     引用重映射只作用于本次导入的记录，不回写目标库既有记录。
 * sameContent 忽略 updatedAt/revision（normalize.mjs），本模块在其外层再剥
 * ownerId/originOwnerId/app_id/owner_name/conflictOf/importedFrom/draftNoteId
 * （照词间语义：忽略账号键、导入痕迹与派生指针）。
 */

const FORMAT = 'ci-notes-backup';
const FORMAT_VERSION = 2;
const CIJIAN_FORMAT = 'cijian-backup';

/** 各实体集合的写入顺序与派生前缀；payload=false 的集合按列分解存储 */
const SETS = [
  { key: 'works', table: 'works', prefix: 'w_', payload: true, select: 'payload' },
  { key: 'notes', table: 'notes', prefix: 'n_', payload: true, select: 'payload' },
  { key: 'revisions', table: 'revisions', prefix: 'rv_', payload: false,
    select: 'id, note_id, seq, snapshot, change_note, reason, created_at' },
  { key: 'comparisons', table: 'comparisons', prefix: 'cp_', payload: true, select: 'payload' },
  { key: 'trash', table: 'trash', prefix: 't_', payload: false,
    select: 'id, item_type, item_id, label, snapshot, trashed_at' },
  { key: 'imagery', table: 'imagery', prefix: 'im_', payload: true, select: 'payload' },
  { key: 'imageryUses', table: 'imagery_uses', prefix: 'iu_', payload: true, select: 'payload' },
  { key: 'allusions', table: 'allusions', prefix: 'al_', payload: true, select: 'payload' },
  { key: 'allusionUses', table: 'allusion_uses', prefix: 'au_', payload: true, select: 'payload' },
];

/** 校验时视作必需的集合（词间 v1 无 imagery/allusions，按空处理） */
const REQUIRED_SETS = ['works', 'notes', 'revisions', 'comparisons', 'trash'];
const OPTIONAL_SETS = ['imagery', 'imageryUses', 'allusions', 'allusionUses'];
const SET_LABELS = {
  works: '词作', notes: '札记', revisions: '版本', comparisons: '对照笔记', trash: '回收站项',
  imagery: '意象', imageryUses: '意象使用记录', allusions: '典故', allusionUses: '典故使用记录',
};

/** 写入前剥去的词间账号键 */
const SCRUB_KEYS = ['ownerId', 'app_id', 'owner_name'];
/** 内容比较时忽略的键：账号键 + 导入痕迹 + 词间 sameContent 忽略的派生指针 */
const COMPARE_IGNORE = [
  'ownerId', 'originOwnerId', 'app_id', 'owner_name',
  'conflictOf', 'importedFrom', 'draftNoteId', 'updatedAt', 'revision',
];

/** 各集合需要跟随 idMap 重映射的引用字段；list 表示数组逐项映射 */
const REF_FIELDS = {
  works: [['relatedWorkIds', 'list']],
  notes: [['workIds', 'list'], ['draftOf', 'one'], ['draftNoteId', 'one']],
  revisions: [['noteId', 'one']],
  comparisons: [['workAId', 'one'], ['workBId', 'one']],
  imagery: [['mergedInto', 'one']],
  imageryUses: [['imageryId', 'one'], ['targetId', 'one']],
  allusions: [['mergedInto', 'one']],
  allusionUses: [['allusionId', 'one'], ['targetId', 'one']],
  trash: [],
};

function nowIso() {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

function payloadList(db, table) {
  return db.prepare(`SELECT payload FROM ${table}`).all().map((r) => JSON.parse(r.payload));
}

/** works+notes+imagery+allusions 的 tags 全集去重 localeCompare 排序 */
function collectTags(lists) {
  const seen = new Set();
  for (const list of lists) {
    for (const rec of list) {
      for (const t of rec.tags || []) {
        if (t) seen.add(t);
      }
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** claims/citations 总数：works/notes/imagery/imageryUses/allusions/allusionUses
 *  的实体级 claims/citations + 对照笔记各维度（text 非空计 1 条 claim），照词间语义 */
function countAnnotations(comparisons, payloadSets) {
  let claims = 0;
  let citations = 0;
  const addEntity = (rec) => {
    claims += (rec.claims || []).length;
    citations += (rec.citations || []).length;
  };
  for (const rec of payloadSets) addEntity(rec);
  for (const c of comparisons) {
    for (const [key] of COMPARE_DIMENSIONS) {
      const v = c.dimensions && c.dimensions[key];
      if (v) {
        claims += v.text ? 1 : 0;
        citations += (v.citations || []).length;
      }
    }
  }
  return { claims, citations };
}

/** 完整备份对象：全部实体集合 + links（notes.workIds 展开）+ tags 全集 */
export function buildBackup(db) {
  const works = payloadList(db, 'works');
  const notes = payloadList(db, 'notes');
  // 版本只导出在册札记名下的（照词间语义：回收站札记的版本不随备份走）
  const noteIds = new Set(notes.map((n) => n.id));
  const revisions = db.prepare('SELECT id, note_id, seq, snapshot, change_note, reason, created_at FROM revisions').all()
    .filter((r) => noteIds.has(r.note_id))
    .map((r) => ({
      id: r.id,
      noteId: r.note_id,
      seq: r.seq,
      snapshot: JSON.parse(r.snapshot),
      changeNote: r.change_note,
      reason: r.reason,
      createdAt: r.created_at,
    }));
  const comparisons = payloadList(db, 'comparisons');
  const trash = db.prepare('SELECT id, item_type, item_id, label, snapshot, trashed_at FROM trash').all()
    .map((r) => ({
      id: r.id,
      itemType: r.item_type,
      itemId: r.item_id,
      label: r.label,
      snapshot: JSON.parse(r.snapshot),
      trashedAt: r.trashed_at,
    }));
  const imagery = payloadList(db, 'imagery');
  const imageryUses = payloadList(db, 'imagery_uses');
  const allusions = payloadList(db, 'allusions');
  const allusionUses = payloadList(db, 'allusion_uses');

  const links = [];
  for (const n of notes) {
    for (const wid of n.workIds || []) {
      links.push({ workId: wid, noteId: n.id });
    }
  }
  const tags = collectTags([works, notes, imagery, allusions]);
  const { claims, citations } = countAnnotations(comparisons, [
    ...works, ...notes, ...imagery, ...imageryUses, ...allusions, ...allusionUses,
  ]);

  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    exportedAt: nowIso(),
    attachmentsSupported: false,
    counts: {
      works: works.length,
      notes: notes.length,
      revisions: revisions.length,
      comparisons: comparisons.length,
      trash: trash.length,
      imagery: imagery.length,
      imageryUses: imageryUses.length,
      allusions: allusions.length,
      allusionUses: allusionUses.length,
      links: links.length,
      tags: tags.length,
      claims,
      citations,
    },
    data: {
      works, notes, revisions, comparisons, trash,
      imagery, imageryUses, allusions, allusionUses,
      links, tags,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 解析与校验                                                          */
/* ------------------------------------------------------------------ */

/** 文本 → 备份对象；体积限制由调用方先行执行 */
export function parseBackup(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: '备份内容为空' };
  }
  let backup;
  try {
    backup = JSON.parse(text);
  } catch {
    return { ok: false, error: '备份内容不是有效的 JSON' };
  }
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    return { ok: false, error: '备份内容不是一个 JSON 对象' };
  }
  return { ok: true, backup };
}

/**
 * 结构校验。返回 {ok, errors, dangling}：
 *   - errors：格式/版本/必需集合/缺 id 等硬错误，任一存在即不可导入；
 *   - dangling：uses 引用了集合内不存在的 imagery/allusion/target 的警告清单，
 *     {type,id,ref}（type 为 imageryUse/allusionUse，ref 为缺失的引用 id）。
 */
export function validateBackup(backup) {
  const errors = [];
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    return { ok: false, errors: ['备份内容不是一个 JSON 对象'], dangling: [] };
  }
  if (backup.format !== FORMAT && backup.format !== CIJIAN_FORMAT) {
    errors.push('不是可识别的备份文件（format 标识为 ' + String(backup.format || '缺失') + '）');
  }
  if (typeof backup.formatVersion !== 'number') {
    errors.push('缺少格式版本号 formatVersion');
  } else if (backup.formatVersion > FORMAT_VERSION) {
    errors.push('备份格式版本 v' + backup.formatVersion + ' 高于本机支持的 v' + FORMAT_VERSION);
  }
  const d = backup.data;
  if (!d || typeof d !== 'object' || Array.isArray(d)) {
    errors.push('缺少 data 字段');
    return { ok: false, errors, dangling: [] };
  }
  for (const k of REQUIRED_SETS) {
    if (!Array.isArray(d[k])) errors.push('缺少数据集合：' + k);
  }
  // imagery/allusions 及其 uses 是 v2 才有（词间 v1 没有），缺失按空处理，存在则必须是数组
  for (const k of OPTIONAL_SETS) {
    if (d[k] !== undefined && !Array.isArray(d[k])) errors.push('数据集合格式不对：' + k);
  }
  for (const [k, label] of Object.entries(SET_LABELS)) {
    const list = d[k];
    if (!Array.isArray(list)) continue;
    list.forEach((rec, i) => {
      if (!rec || !rec.id) errors.push('第 ' + (i + 1) + ' 条' + label + '缺少 id');
    });
  }
  if (errors.length) return { ok: false, errors, dangling: [] };

  // 悬空引用：uses 指向的意象/典故必须在集合内；targetId 按 targetType 查 works/notes
  const workIds = new Set(d.works.map((w) => w.id));
  const noteIds = new Set(d.notes.map((n) => n.id));
  const targetMissing = (u) => (u.targetType === 'note' ? !noteIds.has(u.targetId) : !workIds.has(u.targetId));
  const dangling = [];
  const imageryIds = new Set((d.imagery || []).map((m) => m.id));
  for (const u of d.imageryUses || []) {
    if (!imageryIds.has(u.imageryId)) dangling.push({ type: 'imageryUse', id: u.id, ref: u.imageryId });
    if (targetMissing(u)) dangling.push({ type: 'imageryUse', id: u.id, ref: u.targetId });
  }
  const allusionIds = new Set((d.allusions || []).map((a) => a.id));
  for (const u of d.allusionUses || []) {
    if (!allusionIds.has(u.allusionId)) dangling.push({ type: 'allusionUse', id: u.id, ref: u.allusionId });
    if (targetMissing(u)) dangling.push({ type: 'allusionUse', id: u.id, ref: u.targetId });
  }
  return { ok: true, errors: [], dangling };
}

/* ------------------------------------------------------------------ */
/* 记录变换：剥离账号键、function→fn、引用重映射                        */
/* ------------------------------------------------------------------ */

/** 词间 imageryUse 的表达作用字段为 function，ci-notes 存 fn */
function renameImageryUseFn(rec) {
  if (rec.fn === undefined && rec.function !== undefined) rec.fn = rec.function;
  delete rec.function;
}

function remapRefs(setKey, rec, idMap) {
  for (const [field, mode] of REF_FIELDS[setKey] || []) {
    if (!idMap) break;
    if (mode === 'list' && Array.isArray(rec[field])) {
      rec[field] = rec[field].map((x) => (typeof x === 'string' && idMap.has(x) ? idMap.get(x) : x));
    } else if (mode === 'one') {
      const v = rec[field];
      if (typeof v === 'string' && v && idMap.has(v)) rec[field] = idMap.get(v);
    }
  }
}

/** 复制并清洗一条备份记录：剥账号键、改名字段、按 idMap 重映射引用 */
function transformRecord(setKey, rec, idMap) {
  const c = JSON.parse(JSON.stringify(rec));
  for (const k of SCRUB_KEYS) delete c[k];
  if (setKey === 'imageryUses') renameImageryUseFn(c);
  remapRefs(setKey, c, idMap);
  return c;
}

/** 内容比较口径：清洗后的记录再剥导入痕迹/派生指针/时间戳/revision */
function stripCompareKeys(rec) {
  for (const k of COMPARE_IGNORE) delete rec[k];
  if (rec.seq !== undefined) delete rec.seq; // 版本 seq 落库时改用全局计数器，比较不参与
  return rec;
}

/** 备份记录的可比较形态（raw：不重映射；传 idMap 则重映射后比较） */
function incomingComparable(setKey, rec, idMap) {
  return stripCompareKeys(transformRecord(setKey, rec, idMap));
}

/** 库中行 → 同口径的可比较形态 */
function storedComparable(set, row) {
  let c;
  if (set.key === 'revisions') {
    c = {
      id: row.id,
      noteId: row.note_id,
      snapshot: JSON.parse(row.snapshot),
      changeNote: row.change_note,
      reason: row.reason,
      createdAt: row.created_at,
    };
  } else if (set.key === 'trash') {
    c = {
      id: row.id,
      itemType: row.item_type,
      itemId: row.item_id,
      label: row.label,
      snapshot: JSON.parse(row.snapshot),
      trashedAt: row.trashed_at,
    };
  } else {
    c = JSON.parse(row.payload);
  }
  return stripCompareKeys(c);
}

/**
 * 同内容判定（sameContent 外层剥账号键等，见模块头注释）：
 * 原样对比（覆盖目标库既有记录）或经 idMap 重映射后对比
 * （覆盖此前由同一备份导入、引用已改挂冲突副本的记录）。
 */
function contentEqual(set, row, rec, idMap) {
  const stored = storedComparable(set, row);
  if (sameContent(stored, incomingComparable(set.key, rec, null))) return true;
  if (!idMap) return false;
  return sameContent(stored, incomingComparable(set.key, rec, idMap));
}

/* ------------------------------------------------------------------ */
/* 分类规划（preflight 与 merge 共用，只读）                            */
/* ------------------------------------------------------------------ */

/** 落库形态：清洗 + 重映射；冲突副本另附 conflictOf/importedFrom（仅 payload 集合） */
function buildStored(set, rec, idMap, copyId) {
  const c = transformRecord(set.key, rec, idMap);
  if (copyId !== undefined) {
    c.id = copyId;
    if (set.payload) {
      c.conflictOf = rec.id;
      c.importedFrom = 'backup';
      c.updatedAt = nowIso();
    }
  }
  return c;
}

function insertRecord(db, set, c) {
  const now = nowIso();
  switch (set.key) {
    case 'works':
      db.prepare('INSERT INTO works(id,payload,revision,title,author,cipai,kind,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(c.id, JSON.stringify(c), c.revision || 1, c.title || '', c.author || '',
          c.cipai || '', c.kind || 'ci', c.updatedAt || now);
      break;
    case 'notes':
      db.prepare('INSERT INTO notes(id,payload,revision,title,writing_status,publish_status,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(c.id, JSON.stringify(c), c.revision || 1, c.title || '',
          c.writingStatus || 'draft', c.publishStatus || 'unpublished', c.updatedAt || now);
      break;
    case 'revisions':
      // seq 列改用全局计数器，保持与库内既有版本的全局顺序一致
      db.prepare('INSERT INTO revisions(id,note_id,seq,snapshot,change_note,reason,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(c.id, c.noteId, nextSeq(db), JSON.stringify(c.snapshot), c.changeNote || '', c.reason, c.createdAt || now);
      break;
    case 'comparisons':
      db.prepare('INSERT INTO comparisons(id,payload,work_a_id,work_b_id,updated_at) VALUES(?,?,?,?,?)')
        .run(c.id, JSON.stringify(c), c.workAId || '', c.workBId || '', c.updatedAt || now);
      break;
    case 'trash':
      db.prepare('INSERT INTO trash(id,item_type,item_id,label,snapshot,trashed_at) VALUES(?,?,?,?,?,?)')
        .run(c.id, c.itemType, c.itemId || '', c.label || '', JSON.stringify(c.snapshot), c.trashedAt || now);
      break;
    case 'imagery':
      db.prepare('INSERT INTO imagery(id,payload,revision,name,merged_into,updated_at) VALUES(?,?,?,?,?,?)')
        .run(c.id, JSON.stringify(c), c.revision || 1, c.name || '', c.mergedInto || '', c.updatedAt || now);
      break;
    case 'imageryUses':
      db.prepare('INSERT INTO imagery_uses(id,payload,revision,imagery_id,target_type,target_id,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(c.id, JSON.stringify(c), c.revision || 1, c.imageryId, c.targetType || 'work', c.targetId, c.updatedAt || now);
      break;
    case 'allusions':
      db.prepare('INSERT INTO allusions(id,payload,revision,name,updated_at) VALUES(?,?,?,?,?)')
        .run(c.id, JSON.stringify(c), c.revision || 1, c.name || '', c.updatedAt || now);
      break;
    case 'allusionUses':
      db.prepare('INSERT INTO allusion_uses(id,payload,revision,allusion_id,target_type,target_id,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(c.id, JSON.stringify(c), c.revision || 1, c.allusionId, c.targetType || 'work', c.targetId, c.updatedAt || now);
      break;
  }
}

/** 本次导入札记的悬空派生指针清空：draftOf/draftNoteId 指向的札记不在库内置空串 */
function fixupDraftPointers(db, noteIds) {
  for (const id of noteIds) {
    const row = db.prepare('SELECT payload FROM notes WHERE id=?').get(id);
    if (!row) continue;
    const note = JSON.parse(row.payload);
    let changed = false;
    for (const key of ['draftOf', 'draftNoteId']) {
      const v = note[key];
      if (typeof v === 'string' && v && !db.prepare('SELECT 1 FROM notes WHERE id=?').get(v)) {
        note[key] = '';
        changed = true;
      }
    }
    if (changed) db.prepare('UPDATE notes SET payload=? WHERE id=?').run(JSON.stringify(note), id);
  }
}

/**
 * 导入规划（只读，preflight 与 merge 共用，保证两者分类一致）。
 * 按集合依赖顺序逐条分类：
 *   create  目标库无此 id，按原 id 新增；
 *   skip    同 id 同内容；或同 id 不同内容但确定性副本 id 已存在（幂等重放）；
 *   copy    同 id 不同内容，另存冲突副本 derivedId(前缀, backupHash, 原id, 'conflict')。
 * idMap：旧id → 最终 id（create/skip 为原 id；冲突场景指向副本 id），
 * 后续集合的重映射与比较都依赖它 —— 这是重复导入幂等的关键。
 */
function planImport(db, backup) {
  const d = backup.data;
  const backupHash = digest(JSON.stringify(d));
  const idMap = new Map();
  const plan = [];
  const conflicts = [];
  for (const set of SETS) {
    const list = Array.isArray(d[set.key]) ? d[set.key] : [];
    for (const rec of list) {
      if (!rec || !rec.id) continue; // 缺 id 已由 validateBackup 拦截，防御性跳过
      const row = db.prepare(`SELECT ${set.select} FROM ${set.table} WHERE id=?`).get(rec.id);
      if (!row) {
        idMap.set(rec.id, rec.id);
        plan.push({ set, rec, kind: 'create' });
        continue;
      }
      if (contentEqual(set, row, rec, idMap)) {
        idMap.set(rec.id, rec.id);
        plan.push({ set, rec, kind: 'skip' });
        continue;
      }
      const copyId = derivedId(set.prefix, backupHash, rec.id, 'conflict');
      const copyRow = db.prepare(`SELECT ${set.select} FROM ${set.table} WHERE id=?`).get(copyId);
      // 副本已存在（同一备份的再次导入）：按重复跳过，idMap 指向既有副本，
      // 使后续记录的重映射与首次导入一致
      idMap.set(rec.id, copyId);
      if (copyRow) {
        plan.push({ set, rec, kind: 'skip' });
        continue;
      }
      plan.push({ set, rec, kind: 'copy', copyId });
      conflicts.push({ type: set.key, id: rec.id, copyId });
    }
  }
  return { backupHash, idMap, plan, conflicts };
}

function zeroCreated() {
  const out = {};
  for (const set of SETS) out[set.key] = 0;
  return out;
}

/* ------------------------------------------------------------------ */
/* 预检与合并                                                          */
/* ------------------------------------------------------------------ */

/**
 * 预检：只读，不写任何表。creates 按集合计数，duplicates 为同内容跳过总数，
 * conflicts 为 {type,id,copyId} 冲突清单，dangling 透传 validateBackup 的清单。
 */
export function preflightImport(db, backup) {
  const v = validateBackup(backup);
  if (!v.ok) {
    return { ok: false, errors: v.errors, creates: zeroCreated(), duplicates: 0, conflicts: [], dangling: [] };
  }
  const { plan, conflicts } = planImport(db, backup);
  const creates = zeroCreated();
  let duplicates = 0;
  for (const item of plan) {
    if (item.kind === 'create') creates[item.set.key] += 1;
    else if (item.kind === 'skip') duplicates += 1;
  }
  return { ok: true, creates, duplicates, conflicts, dangling: v.dangling };
}

/**
 * 安全合并导入：BEGIN IMMEDIATE 单事务，只有 INSERT（不删除/不覆盖任何已有内容，
 * 定稿与已发布内容因此不可能被覆盖）；任何一步失败整体回滚。
 * 完成后写 imports 表一行（backupHash = sha256(backup.data 的 JSON 串)），
 * 同一备份重复导入也各记一行。
 */
export function mergeImport(db, backup) {
  const v = validateBackup(backup);
  if (!v.ok) {
    throw new StoreError('INVALID', '这份文件不是可用的备份，无法导入', v.errors);
  }
  const { backupHash, idMap, plan } = planImport(db, backup);
  const created = zeroCreated();
  let skipped = 0;
  let conflictCopies = 0;
  const importedNoteIds = [];

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of plan) {
      if (item.kind === 'skip') {
        skipped += 1;
        continue;
      }
      const copyId = item.kind === 'copy' ? item.copyId : undefined;
      const c = buildStored(item.set, item.rec, idMap, copyId);
      insertRecord(db, item.set, c);
      if (item.kind === 'copy') conflictCopies += 1;
      else created[item.set.key] += 1;
      if (item.set.key === 'notes') importedNoteIds.push(c.id);
    }
    fixupDraftPointers(db, importedNoteIds);
    db.prepare('INSERT INTO imports(id,backup_hash,stats,imported_at) VALUES(?,?,?,?)')
      .run(newId('imp_'), backupHash, JSON.stringify({ created, skipped, conflictCopies }), nowIso());
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { created, skipped, conflictCopies };
}
