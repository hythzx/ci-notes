import { listWorks } from './works.mjs';
import { listNotes } from './notes.mjs';

/**
 * 统计 / 全局搜索 / 首页聚合（collectFacets 语义）。
 * 全部只读：各计数对表直接 COUNT(*)；札记状态计数与 recent 复用
 * listNotes 摘要（按 payload，updatedAt 倒序），不重复实现摘要逻辑。
 * facets：authors/cipais/tags 取值去重后 localeCompare 排序；
 *   tags 为 works.tags 与 notes.tags 的合集；
 *   kinds 按常量顺序 ['ci','poem'] 过滤实际存在的；
 *   writingStatus/publishStatus 输出全量枚举常量。
 */

const KINDS = ['ci', 'poem'];
const WRITING_STATUSES = ['idea', 'research', 'draft', 'final'];
const PUBLISH_STATUSES = ['unpublished', 'pending', 'published'];

function countTable(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function byLocale(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

/** 筛选面板数据：作者 / 词牌 / 标签去重排序，kinds 与状态枚举 */
function collectFacets(db) {
  const works = db.prepare('SELECT payload FROM works').all()
    .map((r) => JSON.parse(r.payload));
  const notes = db.prepare('SELECT payload FROM notes').all()
    .map((r) => JSON.parse(r.payload));
  const authors = new Set();
  const cipais = new Set();
  const tags = new Set();
  for (const w of works) {
    if (w.author) authors.add(w.author);
    if (w.cipai) cipais.add(w.cipai);
    for (const t of w.tags || []) { if (t) tags.add(t); }
  }
  for (const n of notes) {
    for (const t of n.tags || []) { if (t) tags.add(t); }
  }
  const present = new Set(works.map((w) => w.kind));
  return {
    authors: byLocale(authors),
    cipais: byLocale(cipais),
    tags: byLocale(tags),
    kinds: KINDS.filter((k) => present.has(k)),
    writingStatus: WRITING_STATUSES.slice(),
    publishStatus: PUBLISH_STATUSES.slice(),
  };
}

/** 六个实体表的行数计数（getHome/getStats 共用部分） */
function entityCounts(db) {
  return {
    works: countTable(db, 'works'),
    notes: countTable(db, 'notes'),
    revisions: countTable(db, 'revisions'),
    comparisons: countTable(db, 'comparisons'),
    imagery: countTable(db, 'imagery'),
    allusions: countTable(db, 'allusions'),
  };
}

/** 首页：统计 + 最近修改的 8 篇札记摘要 */
export function getHome(db) {
  const notes = listNotes(db, {});
  const stats = {
    ...entityCounts(db),
    draft: notes.filter((n) => n.writingStatus === 'draft').length,
    final: notes.filter((n) => n.writingStatus === 'final').length,
    published: notes.filter((n) => n.publishStatus === 'published').length,
    pendingImport: notes.filter((n) => n.pendingImport === true).length,
  };
  return { stats, recent: notes.slice(0, 8) };
}

/** 全局搜索：q 空或全空白返回两组空数组；非空复用两列表的 q 过滤 */
export function globalSearch(db, q) {
  const needle = String(q === undefined || q === null ? '' : q).trim();
  if (!needle) return { works: [], notes: [] };
  return {
    works: listWorks(db, { q: needle }),
    notes: listNotes(db, { q: needle }),
  };
}

/** 统计面板：实体与 uses 表计数 + facets */
export function getStats(db) {
  return {
    counts: {
      ...entityCounts(db),
      imageryUses: countTable(db, 'imagery_uses'),
      allusionUses: countTable(db, 'allusion_uses'),
    },
    facets: collectFacets(db),
  };
}
