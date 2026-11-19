import { StoreError } from './errors.mjs';
import { newId } from './ids.mjs';
import { casUpdate } from './db.mjs';
import {
  normalizeTags, normalizeClaims, normalizeCitations,
  normalizeUsages, normalizeAliases,
} from './normalize.mjs';

/**
 * 典故实体：典故库 + 使用记录（uses）+ 合并 + 影响计算 + 双作品对照。
 * 结构逐函数镜像 imagery.mjs（意象库），为典故场景调整：
 *   - 典故通用资料新增三个语义字段：source（出处典籍）、original（典故原文）、
 *     explanation（通用释义），均为字符串且 trim；去掉 imagery 的 description。
 *   - 使用记录的表达作用字段名为 interpretation（典故此处如何解释），
 *     语义化字段名，不兼容 fn/function 入参。
 *   - allusions 表标量列只有 name/updated_at（无 merged_into 列），
 *     mergedInto 仅存于 payload；casUpdate 会随 payload 持久化。
 * 与 imagery 相同的约束：两层严格分离 —— 改典故的通用资料不动任何使用记录；
 * 同一典故在不同作品/札记里的解读互不覆盖；删除/合并不连带删作品或札记。
 */

const TARGET_TYPES = ['work', 'note'];

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

/* ------------------------------------------------------------------ */
/* 行级辅助                                                            */
/* ------------------------------------------------------------------ */

function allusionRow(db, id) {
  return db.prepare('SELECT payload, revision FROM allusions WHERE id=?').get(id);
}

function useRow(db, id) {
  return db.prepare('SELECT payload, revision FROM allusion_uses WHERE id=?').get(id);
}

/** 校验使用目标：targetType 白名单、targetId 非空、目标行存在 */
function requireTarget(db, targetType, targetId) {
  if (TARGET_TYPES.indexOf(targetType) < 0) {
    throw new StoreError('INVALID', 'targetType 必须是 work 或 note');
  }
  if (!targetId) throw new StoreError('INVALID', '缺少作品或札记 ID');
  const table = targetType === 'note' ? 'notes' : 'works';
  const row = db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(targetId);
  if (!row) {
    throw new StoreError('NOT_FOUND', targetType === 'note' ? '札记不存在' : '作品不存在');
  }
}

/** 某典故的全部使用记录，按创建时间升序（照 imagery 排序） */
function usesByAllusion(db, allusionId) {
  return db.prepare('SELECT payload FROM allusion_uses WHERE allusion_id=?').all(allusionId)
    .map((r) => parseJson(r.payload))
    .sort((a, b) => str(a.createdAt).localeCompare(str(b.createdAt)));
}

/** 某目标（作品/札记）的全部使用记录，按创建时间升序 */
function usesByTarget(db, targetType, targetId) {
  return db.prepare('SELECT payload FROM allusion_uses WHERE target_type=? AND target_id=?')
    .all(targetType, targetId)
    .map((r) => parseJson(r.payload))
    .sort((a, b) => str(a.createdAt).localeCompare(str(b.createdAt)));
}

/**
 * 目标详情装配：按典故分组 [{allusion, uses}]，典故按名称排序。
 * 供 getWork / getNote 接线（allusions.entries）。
 */
export function allusionEntriesForTarget(db, targetType, targetId) {
  const groups = new Map();
  for (const u of usesByTarget(db, targetType, targetId)) {
    const list = groups.get(u.allusionId) || [];
    list.push(u);
    groups.set(u.allusionId, list);
  }
  const entries = [];
  for (const [allusionId, uses] of groups) {
    const row = allusionRow(db, allusionId);
    // 使用记录在而典故行缺失只可能来自异常数据；跳过以免装配失败
    if (!row) continue;
    entries.push({ allusion: parseJson(row.payload), uses });
  }
  entries.sort((a, b) => str(a.allusion.name).localeCompare(str(b.allusion.name)));
  return entries;
}

/* ------------------------------------------------------------------ */
/* 检索                                                                */
/* ------------------------------------------------------------------ */

/** 名称、别名、出处、释义、原文、札记、用途文本、标签都能搜到 */
function allusionMatchesText(allusion, needle) {
  const s = needle.toLowerCase();
  const hay = [
    allusion.name,
    (allusion.aliases || []).join(' '),
    allusion.source,
    allusion.explanation,
    allusion.original,
    allusion.note,
    (allusion.usages || []).map((u) => u.text).join(' '),
    (allusion.tags || []).join(' '),
  ].join('\n').toLowerCase();
  return hay.indexOf(s) >= 0;
}

/** 典故索引：id → {works, notes, uses, quotes}（works/notes 为去重目标数，内部用） */
export function allusionIndex(db) {
  const raw = new Map();
  for (const row of db.prepare('SELECT payload FROM allusion_uses').all()) {
    const u = parseJson(row.payload);
    let e = raw.get(u.allusionId);
    if (!e) {
      e = { workIds: new Set(), noteIds: new Set(), uses: 0, quotes: 0 };
      raw.set(u.allusionId, e);
    }
    e.uses += 1;
    if (trim(u.quote)) e.quotes += 1;
    if (u.targetType === 'note') e.noteIds.add(u.targetId);
    else e.workIds.add(u.targetId);
  }
  const counts = new Map();
  for (const [id, e] of raw) {
    counts.set(id, { works: e.workIds.size, notes: e.noteIds.size, uses: e.uses, quotes: e.quotes });
  }
  return counts;
}

export function listAllusions(db, filters) {
  const f = filters || {};
  const counts = allusionIndex(db);
  let items = db.prepare('SELECT payload FROM allusions').all().map((r) => parseJson(r.payload));
  // 被合并掉的默认不展示（保留数据但不干扰浏览）
  if (!f.includeMerged) items = items.filter((m) => !trim(m.mergedInto));
  if (f.tag) items = items.filter((m) => (m.tags || []).indexOf(f.tag) >= 0);
  const needle = trim(f.q);
  if (needle) items = items.filter((m) => allusionMatchesText(m, needle));
  items.sort((a, b) => {
    const an = str(a.name);
    const bn = str(b.name);
    if (an === bn) return str(b.updatedAt).localeCompare(str(a.updatedAt));
    return an.localeCompare(bn);
  });
  return {
    entries: items.map((m) => ({
      allusion: m,
      counts: counts.get(m.id) || { works: 0, notes: 0, uses: 0, quotes: 0 },
    })),
  };
}

/**
 * 典故详情：通用资料 + 使用记录 + 关联到的作品与札记（各自带上对应 uses）。
 * filters（可选）{author, cipai, tag} 筛关联作品（照 imagery 语义）。
 */
export function getAllusion(db, id, filters) {
  const row = allusionRow(db, id);
  if (!row) throw new StoreError('NOT_FOUND', '典故不存在');
  const allusion = parseJson(row.payload);
  const uses = usesByAllusion(db, id);
  const workIds = new Set();
  const noteIds = new Set();
  for (const u of uses) {
    if (u.targetType === 'note') noteIds.add(u.targetId);
    else workIds.add(u.targetId);
  }
  const f = filters || {};
  let works = [...workIds]
    .map((wid) => db.prepare('SELECT payload FROM works WHERE id=?').get(wid))
    .filter(Boolean)
    .map((r) => {
      const work = parseJson(r.payload);
      return { work, uses: uses.filter((u) => u.targetType === 'work' && u.targetId === work.id) };
    });
  let notes = [...noteIds]
    .map((nid) => db.prepare('SELECT payload FROM notes WHERE id=?').get(nid))
    .filter(Boolean)
    .map((r) => {
      const note = parseJson(r.payload);
      return { note, uses: uses.filter((u) => u.targetType === 'note' && u.targetId === note.id) };
    });
  if (f.author) works = works.filter((x) => x.work.author === f.author);
  if (f.cipai) works = works.filter((x) => x.work.cipai === f.cipai);
  if (f.tag) works = works.filter((x) => (x.work.tags || []).indexOf(f.tag) >= 0);
  works.sort((a, b) => str(b.work.updatedAt).localeCompare(str(a.work.updatedAt)));
  notes.sort((a, b) => str(b.note.updatedAt).localeCompare(str(a.note.updatedAt)));
  return {
    allusion,
    uses,
    works,
    notes,
    counts: {
      works: works.length,
      notes: notes.length,
      uses: uses.length,
      quotes: uses.filter((u) => trim(u.quote)).length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 典故增删改                                                          */
/* ------------------------------------------------------------------ */

/** 归一化出完整 payload；source/original/explanation 为 trim 字符串 */
function buildAllusion(input) {
  const now = nowIso();
  const name = trim(input.name);
  return {
    id: newId('al_'),
    name,
    aliases: normalizeAliases(input.aliases, name),
    source: trim(input.source),
    original: trim(input.original),
    explanation: trim(input.explanation),
    usages: normalizeUsages(input.usages),
    claims: normalizeClaims(input.claims),
    citations: normalizeCitations(input.citations),
    tags: normalizeTags(input.tags),
    note: str(input.note),
    // 合并到别的典故后指向目标；空串表示没被合并
    mergedInto: trim(input.mergedInto),
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
}

export function createAllusion(db, input) {
  const allusion = buildAllusion(input || {});
  if (!allusion.name) throw new StoreError('INVALID', '典故要有名字');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO allusions(id,payload,revision,name,updated_at) VALUES(?,?,?,?,?)')
      .run(allusion.id, JSON.stringify(allusion), allusion.revision, allusion.name, allusion.updatedAt);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return allusion;
}

/** 字段级合并：undefined 表示不改动（照 imagery）。★只动通用资料 */
function applyAllusionPatch(allusion, patch) {
  if (patch.name !== undefined) {
    const name = trim(patch.name);
    if (!name) throw new StoreError('INVALID', '典故要有名字');
    allusion.name = name;
    // 改名后别名里与新名重复的要去掉
    allusion.aliases = normalizeAliases(allusion.aliases, name);
  }
  if (patch.aliases !== undefined) allusion.aliases = normalizeAliases(patch.aliases, allusion.name);
  if (patch.source !== undefined) allusion.source = trim(patch.source);
  if (patch.original !== undefined) allusion.original = trim(patch.original);
  if (patch.explanation !== undefined) allusion.explanation = trim(patch.explanation);
  if (patch.usages !== undefined) allusion.usages = normalizeUsages(patch.usages);
  if (patch.claims !== undefined) allusion.claims = normalizeClaims(patch.claims);
  if (patch.citations !== undefined) allusion.citations = normalizeCitations(patch.citations);
  if (patch.tags !== undefined) allusion.tags = normalizeTags(patch.tags);
  if (patch.note !== undefined) allusion.note = str(patch.note);
  // mergedInto 不可由此改：只属于 mergeAllusion
}

export function updateAllusion(db, id, patch, opts) {
  const options = opts || {};
  const hasBase = options.baseRevision !== undefined && options.baseRevision !== null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = allusionRow(db, id);
    if (!row) throw new StoreError('NOT_FOUND', '典故不存在');
    const allusion = parseJson(row.payload);
    if (hasBase && !options.force && allusion.revision !== options.baseRevision) {
      throw new StoreError('CONFLICT', '这条典故在别处被改过', allusion);
    }
    applyAllusionPatch(allusion, patch || {});
    const now = nowIso();
    allusion.updatedAt = now;
    allusion.revision = row.revision + 1;
    // force 或无 baseRevision 时以库中当前 revision 为基准，必然命中
    const base = hasBase && !options.force ? options.baseRevision : row.revision;
    const r = casUpdate(db, 'allusions', id, base, allusion, now);
    if (!r.ok) {
      // BEGIN IMMEDIATE 串行化后不会走到这里；保留 casUpdate 的冲突契约
      throw new StoreError('CONFLICT', '这条典故在别处被改过', r.current);
    }
    // casUpdate 只同步 payload/revision/updated_at，标量冗余列（仅 name）在此补齐
    db.prepare('UPDATE allusions SET name=? WHERE id=?').run(allusion.name, id);
    db.exec('COMMIT');
    return allusion;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 删除 / 合并前先算清影响：会牵连哪些作品与札记。
 * ★只删典故和它的使用记录 —— 绝不连带删作品或札记。
 */
export function allusionImpact(db, id) {
  const workIds = new Set();
  const noteIds = new Set();
  const uses = usesByAllusion(db, id);
  for (const u of uses) {
    if (u.targetType === 'note') noteIds.add(u.targetId);
    else workIds.add(u.targetId);
  }
  return {
    uses: uses.length,
    works: workIds.size,
    notes: noteIds.size,
    workIds: [...workIds],
    noteIds: [...noteIds],
  };
}

export function deleteAllusion(db, id) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = allusionRow(db, id);
    if (!row) throw new StoreError('NOT_FOUND', '典故不存在');
    const removed = allusionImpact(db, id);
    db.prepare('DELETE FROM allusions WHERE id=?').run(id);
    db.prepare('DELETE FROM allusion_uses WHERE allusion_id=?').run(id);
    db.exec('COMMIT');
    return { id, removed };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 合并典故：from 的全部使用记录改挂 to（各自 revision+1、updatedAt 更新），
 * 然后标记 from 已被合并（payload.mergedInto；表无 merged_into 标量列）。
 * 不删除任何作品或札记，也不丢使用记录里的解读。
 */
export function mergeAllusion(db, fromId, toId) {
  if (fromId === toId) throw new StoreError('INVALID', '不能合并到它自己');
  db.exec('BEGIN IMMEDIATE');
  try {
    const fromRow = allusionRow(db, fromId);
    const toRow = allusionRow(db, toId);
    if (!fromRow || !toRow) throw new StoreError('NOT_FOUND', '要合并的典故不存在');
    const now = nowIso();
    const from = parseJson(fromRow.payload);
    const to = parseJson(toRow.payload);
    let movedUses = 0;
    for (const uRow of db.prepare('SELECT payload, revision FROM allusion_uses WHERE allusion_id=?').all(fromId)) {
      const u = parseJson(uRow.payload);
      u.allusionId = toId;
      u.updatedAt = now;
      u.revision = uRow.revision + 1;
      const moved = casUpdate(db, 'allusion_uses', u.id, uRow.revision, u, now);
      if (!moved.ok) throw new StoreError('CONFLICT', '这条使用记录在别处被改过', moved.current);
      db.prepare('UPDATE allusion_uses SET allusion_id=? WHERE id=?').run(toId, u.id);
      movedUses += 1;
    }
    from.mergedInto = toId;
    from.updatedAt = now;
    from.revision = fromRow.revision + 1;
    // mergedInto 随 payload 由 casUpdate 持久化，无标量列需要补齐
    const marked = casUpdate(db, 'allusions', fromId, fromRow.revision, from, now);
    if (!marked.ok) throw new StoreError('CONFLICT', '这条典故在别处被改过', marked.current);
    db.exec('COMMIT');
    return { from, to, movedUses };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 使用记录                                                            */
/* ------------------------------------------------------------------ */

/** 归一化出完整 payload；interpretation 为语义化字段名（无 fn/function 别名） */
function buildAllusionUse(input) {
  const now = nowIso();
  return {
    id: newId('au_'),
    allusionId: trim(input.allusionId),
    targetType: input.targetType === 'note' ? 'note' : 'work',
    targetId: trim(input.targetId),
    quote: str(input.quote),
    context: str(input.context),
    interpretation: str(input.interpretation),
    understanding: str(input.understanding),
    claims: normalizeClaims(input.claims),
    citations: normalizeCitations(input.citations),
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
}

/**
 * 记录典故在某作品 / 札记中的使用。
 * 同一典故在同一作品里可以记多条（作品中多处用典）。
 */
export function createAllusionUse(db, input) {
  const src = input || {};
  const allusionId = trim(src.allusionId);
  if (!allusionId) throw new StoreError('INVALID', '要关联一个典故');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!allusionRow(db, allusionId)) throw new StoreError('NOT_FOUND', '典故不存在');
    requireTarget(db, src.targetType, trim(src.targetId));
    const u = buildAllusionUse(src);
    db.prepare('INSERT INTO allusion_uses(id,payload,revision,allusion_id,target_type,target_id,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(u.id, JSON.stringify(u), u.revision, u.allusionId, u.targetType, u.targetId, u.updatedAt);
    db.exec('COMMIT');
    return u;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 使用记录的字段级合并：挂载关系（allusionId/targetType/targetId）不可改 */
function applyUsePatch(u, patch) {
  if (patch.quote !== undefined) u.quote = str(patch.quote);
  if (patch.context !== undefined) u.context = str(patch.context);
  if (patch.interpretation !== undefined) u.interpretation = str(patch.interpretation);
  if (patch.understanding !== undefined) u.understanding = str(patch.understanding);
  if (patch.claims !== undefined) u.claims = normalizeClaims(patch.claims);
  if (patch.citations !== undefined) u.citations = normalizeCitations(patch.citations);
}

export function updateAllusionUse(db, id, patch, opts) {
  const options = opts || {};
  const hasBase = options.baseRevision !== undefined && options.baseRevision !== null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = useRow(db, id);
    if (!row) throw new StoreError('NOT_FOUND', '这条记录不存在');
    const u = parseJson(row.payload);
    if (hasBase && !options.force && u.revision !== options.baseRevision) {
      throw new StoreError('CONFLICT', '这条使用记录在别处被改过', u);
    }
    applyUsePatch(u, patch || {});
    const now = nowIso();
    u.updatedAt = now;
    u.revision = row.revision + 1;
    const base = hasBase && !options.force ? options.baseRevision : row.revision;
    const r = casUpdate(db, 'allusion_uses', id, base, u, now);
    if (!r.ok) {
      // BEGIN IMMEDIATE 串行化后不会走到这里；保留 casUpdate 的冲突契约
      throw new StoreError('CONFLICT', '这条使用记录在别处被改过', r.current);
    }
    db.exec('COMMIT');
    return u;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function deleteAllusionUse(db, id) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = db.prepare('DELETE FROM allusion_uses WHERE id=?').run(id);
    if (r.changes !== 1) throw new StoreError('NOT_FOUND', '这条记录不存在');
    db.exec('COMMIT');
    return { id };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 某作品 / 札记关联的全部使用记录（跨典故），按创建时间升序 */
export function listAllusionUses(db, filters) {
  const f = filters || {};
  const targetId = trim(f.targetId);
  requireTarget(db, f.targetType, targetId);
  return usesByTarget(db, f.targetType, targetId);
}

/* ------------------------------------------------------------------ */
/* 双作品对照                                                          */
/* ------------------------------------------------------------------ */

/**
 * 两首作品里共同 / 各自不同的典故。
 * 只用已经记录过的关联 —— 不替用户猜；不校验作品存在（无关联即空侧）。
 */
export function compareAllusions(db, workAId, workBId) {
  const byAllusion = (targetId) => {
    const map = new Map();
    for (const u of usesByTarget(db, 'work', targetId)) {
      const list = map.get(u.allusionId) || [];
      list.push(u);
      map.set(u.allusionId, list);
    }
    return map;
  };
  const mapA = byAllusion(workAId);
  const mapB = byAllusion(workBId);
  const allusionOf = (id) => {
    const row = allusionRow(db, id);
    return row ? parseJson(row.payload) : null;
  };
  const byName = (x, y) => str(x.allusion.name).localeCompare(str(y.allusion.name));

  const shared = [];
  const onlyA = [];
  for (const [id, usesA] of mapA) {
    const allusion = allusionOf(id);
    if (!allusion) continue;
    if (mapB.has(id)) shared.push({ allusion, usesA, usesB: mapB.get(id) });
    else onlyA.push({ allusion, usesA });
  }
  const onlyB = [];
  for (const [id, usesB] of mapB) {
    if (mapA.has(id)) continue;
    const allusion = allusionOf(id);
    if (!allusion) continue;
    onlyB.push({ allusion, usesB });
  }
  shared.sort(byName);
  onlyA.sort(byName);
  onlyB.sort(byName);
  return { shared, onlyA, onlyB };
}
