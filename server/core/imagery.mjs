import { StoreError } from './errors.mjs';
import { newId } from './ids.mjs';
import { casUpdate } from './db.mjs';
import {
  normalizeTags, normalizeClaims, normalizeCitations,
  normalizeUsages, normalizeAliases,
} from './normalize.mjs';

/**
 * 意象实体：意象库 + 使用记录（uses）+ 合并 + 影响计算 + 双作品对照。
 * 语义逐函数翻译自词间参考实现 utils/imagery-core.js：
 * makeImagery / listImagery / imageryIndex / getImageryDetail /
 * filterImageryWorks（筛选并入 getImagery）/ createImagery / updateImagery /
 * imageryImpact / deleteImagery / mergeImagery / createImageryUse /
 * updateImageryUse / deleteImageryUse / compareImagery。
 * 与参考实现的差异：
 *   - 内存 db 对象改为 SQLite imagery / imagery_uses 表（payload 列 + 标量列），
 *     写操作包 BEGIN IMMEDIATE 事务，更新走 casUpdate 乐观锁；
 *   - 单用户，去掉 ownerId；
 *   - 使用记录的表达作用字段名为 fn（跨计划契约；入参兼容 function，归一化到 fn）；
 *   - targetType 严格白名单 work|note（参考实现会把其他值回落成 work）。
 *
 * 两层严格分离：改意象的通用资料不动任何使用记录；同一意象在
 * 不同作品/札记里的解读互不覆盖。
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

function imageryRow(db, id) {
  return db.prepare('SELECT payload, revision FROM imagery WHERE id=?').get(id);
}

function useRow(db, id) {
  return db.prepare('SELECT payload, revision FROM imagery_uses WHERE id=?').get(id);
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

/** 某意象的全部使用记录，按创建时间升序（照词间 listImageryUses 排序） */
function usesByImagery(db, imageryId) {
  return db.prepare('SELECT payload FROM imagery_uses WHERE imagery_id=?').all(imageryId)
    .map((r) => parseJson(r.payload))
    .sort((a, b) => str(a.createdAt).localeCompare(str(b.createdAt)));
}

/** 某目标（作品/札记）的全部使用记录，按创建时间升序 */
function usesByTarget(db, targetType, targetId) {
  return db.prepare('SELECT payload FROM imagery_uses WHERE target_type=? AND target_id=?')
    .all(targetType, targetId)
    .map((r) => parseJson(r.payload))
    .sort((a, b) => str(a.createdAt).localeCompare(str(b.createdAt)));
}

/**
 * 目标详情装配：按意象分组 [{imagery, uses}]，意象按名称排序。
 * 供 getWork / getNote 接线（imagery.entries）。
 */
export function imageryEntriesForTarget(db, targetType, targetId) {
  const groups = new Map();
  for (const u of usesByTarget(db, targetType, targetId)) {
    const list = groups.get(u.imageryId) || [];
    list.push(u);
    groups.set(u.imageryId, list);
  }
  const entries = [];
  for (const [imageryId, uses] of groups) {
    const row = imageryRow(db, imageryId);
    // 使用记录在而意象行缺失只可能来自异常数据；跳过以免装配失败
    if (!row) continue;
    entries.push({ imagery: parseJson(row.payload), uses });
  }
  entries.sort((a, b) => str(a.imagery.name).localeCompare(str(b.imagery.name)));
  return entries;
}

/* ------------------------------------------------------------------ */
/* 检索                                                                */
/* ------------------------------------------------------------------ */

/** 名称、别名、描述、札记、常见用途文本、标签都能搜到（照词间 imageryMatchesText） */
function imageryMatchesText(imagery, needle) {
  const s = needle.toLowerCase();
  const hay = [
    imagery.name,
    (imagery.aliases || []).join(' '),
    imagery.description,
    imagery.note,
    (imagery.usages || []).map((u) => u.text).join(' '),
    (imagery.tags || []).join(' '),
  ].join('\n').toLowerCase();
  return hay.indexOf(s) >= 0;
}

/** 意象索引：id → {works, notes, uses, quotes}（works/notes 为去重目标数，内部用） */
export function imageryIndex(db) {
  const raw = new Map();
  for (const row of db.prepare('SELECT payload FROM imagery_uses').all()) {
    const u = parseJson(row.payload);
    let e = raw.get(u.imageryId);
    if (!e) {
      e = { workIds: new Set(), noteIds: new Set(), uses: 0, quotes: 0 };
      raw.set(u.imageryId, e);
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

export function listImagery(db, filters) {
  const f = filters || {};
  const counts = imageryIndex(db);
  let items = db.prepare('SELECT payload FROM imagery').all().map((r) => parseJson(r.payload));
  // 被合并掉的默认不展示（保留数据但不干扰浏览）
  if (!f.includeMerged) items = items.filter((m) => !trim(m.mergedInto));
  if (f.tag) items = items.filter((m) => (m.tags || []).indexOf(f.tag) >= 0);
  const needle = trim(f.q);
  if (needle) items = items.filter((m) => imageryMatchesText(m, needle));
  items.sort((a, b) => {
    const an = str(a.name);
    const bn = str(b.name);
    if (an === bn) return str(b.updatedAt).localeCompare(str(a.updatedAt));
    return an.localeCompare(bn);
  });
  return {
    entries: items.map((m) => ({
      imagery: m,
      counts: counts.get(m.id) || { works: 0, notes: 0, uses: 0, quotes: 0 },
    })),
  };
}

/**
 * 意象详情：通用资料 + 使用记录 + 关联到的作品与札记（各自带上对应 uses）。
 * filters（可选）{author, cipai, tag} 筛关联作品（词间 filterImageryWorks 并入）。
 */
export function getImagery(db, id, filters) {
  const row = imageryRow(db, id);
  if (!row) throw new StoreError('NOT_FOUND', '意象不存在');
  const imagery = parseJson(row.payload);
  const uses = usesByImagery(db, id);
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
    imagery,
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
/* 意象增删改                                                          */
/* ------------------------------------------------------------------ */

/** 按 makeImagery 归一化出完整 payload */
function buildImagery(input) {
  const now = nowIso();
  const name = trim(input.name);
  return {
    id: newId('im_'),
    name,
    aliases: normalizeAliases(input.aliases, name),
    description: str(input.description),
    usages: normalizeUsages(input.usages),
    claims: normalizeClaims(input.claims),
    citations: normalizeCitations(input.citations),
    tags: normalizeTags(input.tags),
    note: str(input.note),
    // 合并到别的意象后指向目标；空串表示没被合并
    mergedInto: trim(input.mergedInto),
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
}

export function createImagery(db, input) {
  const imagery = buildImagery(input || {});
  if (!imagery.name) throw new StoreError('INVALID', '意象要有名字');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO imagery(id,payload,revision,name,merged_into,updated_at) VALUES(?,?,?,?,?,?)')
      .run(imagery.id, JSON.stringify(imagery), imagery.revision, imagery.name, imagery.mergedInto, imagery.updatedAt);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return imagery;
}

/** 字段级合并：undefined 表示不改动（照词间 updateImagery）。★只动通用资料 */
function applyImageryPatch(imagery, patch) {
  if (patch.name !== undefined) {
    const name = trim(patch.name);
    if (!name) throw new StoreError('INVALID', '意象要有名字');
    imagery.name = name;
    // 改名后别名里与新名重复的要去掉
    imagery.aliases = normalizeAliases(imagery.aliases, name);
  }
  if (patch.aliases !== undefined) imagery.aliases = normalizeAliases(patch.aliases, imagery.name);
  if (patch.description !== undefined) imagery.description = str(patch.description);
  if (patch.usages !== undefined) imagery.usages = normalizeUsages(patch.usages);
  if (patch.claims !== undefined) imagery.claims = normalizeClaims(patch.claims);
  if (patch.citations !== undefined) imagery.citations = normalizeCitations(patch.citations);
  if (patch.tags !== undefined) imagery.tags = normalizeTags(patch.tags);
  if (patch.note !== undefined) imagery.note = str(patch.note);
  // mergedInto 不可由此改：只属于 mergeImagery
}

export function updateImagery(db, id, patch, opts) {
  const options = opts || {};
  const hasBase = options.baseRevision !== undefined && options.baseRevision !== null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = imageryRow(db, id);
    if (!row) throw new StoreError('NOT_FOUND', '意象不存在');
    const imagery = parseJson(row.payload);
    if (hasBase && !options.force && imagery.revision !== options.baseRevision) {
      throw new StoreError('CONFLICT', '这条意象在别处被改过', imagery);
    }
    applyImageryPatch(imagery, patch || {});
    const now = nowIso();
    imagery.updatedAt = now;
    imagery.revision = row.revision + 1;
    // force 或无 baseRevision 时以库中当前 revision 为基准，必然命中
    const base = hasBase && !options.force ? options.baseRevision : row.revision;
    const r = casUpdate(db, 'imagery', id, base, imagery, now);
    if (!r.ok) {
      // BEGIN IMMEDIATE 串行化后不会走到这里；保留 casUpdate 的冲突契约
      throw new StoreError('CONFLICT', '这条意象在别处被改过', r.current);
    }
    // casUpdate 只同步 payload/revision/updated_at，标量冗余列在此补齐
    db.prepare('UPDATE imagery SET name=?, merged_into=? WHERE id=?')
      .run(imagery.name, imagery.mergedInto, id);
    db.exec('COMMIT');
    return imagery;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 删除 / 合并前先算清影响：会牵连哪些作品与札记。
 * ★只删意象和它的使用记录 —— 绝不连带删作品或札记。
 */
export function imageryImpact(db, id) {
  const workIds = new Set();
  const noteIds = new Set();
  const uses = usesByImagery(db, id);
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

export function deleteImagery(db, id) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = imageryRow(db, id);
    if (!row) throw new StoreError('NOT_FOUND', '意象不存在');
    const removed = imageryImpact(db, id);
    db.prepare('DELETE FROM imagery WHERE id=?').run(id);
    db.prepare('DELETE FROM imagery_uses WHERE imagery_id=?').run(id);
    db.exec('COMMIT');
    return { id, removed };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 合并意象：from 的全部使用记录改挂 to（各自 revision+1、updatedAt 更新），
 * 然后标记 from 已被合并（保留数据，列表默认隐藏）。
 * 不删除任何作品或札记，也不丢使用记录里的描述。
 */
export function mergeImagery(db, fromId, toId) {
  if (fromId === toId) throw new StoreError('INVALID', '不能合并到它自己');
  db.exec('BEGIN IMMEDIATE');
  try {
    const fromRow = imageryRow(db, fromId);
    const toRow = imageryRow(db, toId);
    if (!fromRow || !toRow) throw new StoreError('NOT_FOUND', '要合并的意象不存在');
    const now = nowIso();
    const from = parseJson(fromRow.payload);
    const to = parseJson(toRow.payload);
    let movedUses = 0;
    for (const uRow of db.prepare('SELECT payload, revision FROM imagery_uses WHERE imagery_id=?').all(fromId)) {
      const u = parseJson(uRow.payload);
      u.imageryId = toId;
      u.updatedAt = now;
      u.revision = uRow.revision + 1;
      const moved = casUpdate(db, 'imagery_uses', u.id, uRow.revision, u, now);
      if (!moved.ok) throw new StoreError('CONFLICT', '这条使用记录在别处被改过', moved.current);
      db.prepare('UPDATE imagery_uses SET imagery_id=? WHERE id=?').run(toId, u.id);
      movedUses += 1;
    }
    from.mergedInto = toId;
    from.updatedAt = now;
    from.revision = fromRow.revision + 1;
    const marked = casUpdate(db, 'imagery', fromId, fromRow.revision, from, now);
    if (!marked.ok) throw new StoreError('CONFLICT', '这条意象在别处被改过', marked.current);
    db.prepare('UPDATE imagery SET merged_into=? WHERE id=?').run(toId, fromId);
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

/** 按 makeImageryUse 归一化出完整 payload；表达作用入参兼容 function/fn，统一存 fn */
function buildImageryUse(input) {
  const now = nowIso();
  const fn = input.fn !== undefined ? input.fn : input.function;
  return {
    id: newId('iu_'),
    imageryId: trim(input.imageryId),
    targetType: input.targetType === 'note' ? 'note' : 'work',
    targetId: trim(input.targetId),
    quote: str(input.quote),
    context: str(input.context),
    fn: str(fn),
    understanding: str(input.understanding),
    claims: normalizeClaims(input.claims),
    citations: normalizeCitations(input.citations),
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
}

/**
 * 记录意象在某作品 / 札记中的使用。
 * 同一个意象在同一作品里可以记多条（作品中出现多处相同意象）。
 */
export function createImageryUse(db, input) {
  const src = input || {};
  const imageryId = trim(src.imageryId);
  if (!imageryId) throw new StoreError('INVALID', '要关联一个意象');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!imageryRow(db, imageryId)) throw new StoreError('NOT_FOUND', '意象不存在');
    requireTarget(db, src.targetType, trim(src.targetId));
    const u = buildImageryUse(src);
    db.prepare('INSERT INTO imagery_uses(id,payload,revision,imagery_id,target_type,target_id,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(u.id, JSON.stringify(u), u.revision, u.imageryId, u.targetType, u.targetId, u.updatedAt);
    db.exec('COMMIT');
    return u;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 使用记录的字段级合并：挂载关系（imageryId/targetType/targetId）不可改 */
function applyUsePatch(u, patch) {
  if (patch.quote !== undefined) u.quote = str(patch.quote);
  if (patch.context !== undefined) u.context = str(patch.context);
  const fn = patch.fn !== undefined ? patch.fn : patch.function;
  if (fn !== undefined) u.fn = str(fn);
  if (patch.understanding !== undefined) u.understanding = str(patch.understanding);
  if (patch.claims !== undefined) u.claims = normalizeClaims(patch.claims);
  if (patch.citations !== undefined) u.citations = normalizeCitations(patch.citations);
}

export function updateImageryUse(db, id, patch, opts) {
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
    const r = casUpdate(db, 'imagery_uses', id, base, u, now);
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

export function deleteImageryUse(db, id) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = db.prepare('DELETE FROM imagery_uses WHERE id=?').run(id);
    if (r.changes !== 1) throw new StoreError('NOT_FOUND', '这条记录不存在');
    db.exec('COMMIT');
    return { id };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 某作品 / 札记关联的全部使用记录（跨意象），按创建时间升序 */
export function listImageryUses(db, filters) {
  const f = filters || {};
  const targetId = trim(f.targetId);
  requireTarget(db, f.targetType, targetId);
  return usesByTarget(db, f.targetType, targetId);
}

/* ------------------------------------------------------------------ */
/* 双作品对照                                                          */
/* ------------------------------------------------------------------ */

/**
 * 两首作品里共同 / 各自不同的意象。
 * 只用已经记录过的关联 —— 不替用户猜；不校验作品存在（无关联即空侧）。
 */
export function compareImagery(db, workAId, workBId) {
  const byImagery = (targetId) => {
    const map = new Map();
    for (const u of usesByTarget(db, 'work', targetId)) {
      const list = map.get(u.imageryId) || [];
      list.push(u);
      map.set(u.imageryId, list);
    }
    return map;
  };
  const mapA = byImagery(workAId);
  const mapB = byImagery(workBId);
  const imageryOf = (id) => {
    const row = imageryRow(db, id);
    return row ? parseJson(row.payload) : null;
  };
  const byName = (x, y) => str(x.imagery.name).localeCompare(str(y.imagery.name));

  const shared = [];
  const onlyA = [];
  for (const [id, usesA] of mapA) {
    const imagery = imageryOf(id);
    if (!imagery) continue;
    if (mapB.has(id)) shared.push({ imagery, usesA, usesB: mapB.get(id) });
    else onlyA.push({ imagery, usesA });
  }
  const onlyB = [];
  for (const [id, usesB] of mapB) {
    if (mapA.has(id)) continue;
    const imagery = imageryOf(id);
    if (!imagery) continue;
    onlyB.push({ imagery, usesB });
  }
  shared.sort(byName);
  onlyA.sort(byName);
  onlyB.sort(byName);
  return { shared, onlyA, onlyB };
}
