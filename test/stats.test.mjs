import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.mjs';
import { createWork, listWorks } from '../server/core/works.mjs';
import { createNote, listNotes } from '../server/core/notes.mjs';
import { saveComparison } from '../server/core/comparisons.mjs';
import { createImagery, createImageryUse } from '../server/core/imagery.mjs';
import { createAllusion, createAllusionUse } from '../server/core/allusions.mjs';
import { getHome, globalSearch, getStats } from '../server/core/stats.mjs';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';

function setup() { return openDb(join(mkdtempSync(join(tmpdir(), 'cn-')), 't.sqlite')); }

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

/** 混合数据：3 词作（重复作者、一个 poem、一个无词牌）+ 3 札记（状态各异）+ 对照 + 意象/典故各 1 */
function seedMixed(db) {
  const w1 = createWork(db, { title: '雨霖铃', author: '柳永', cipai: '雨霖铃', kind: 'ci', content: '寒蝉凄切，对长亭晚', tags: ['离别', '婉约'] });
  const w2 = createWork(db, { title: '水调歌头', author: '苏轼', cipai: '水调歌头', kind: 'ci', content: '明月几时有', tags: ['中秋'] });
  const w3 = createWork(db, { title: '静夜思', author: '柳永', kind: 'poem', content: '床前明月光' });
  const n1 = createNote(db, { title: '读雨霖铃', content: '点染之妙', writingStatus: 'draft', workIds: [w1.id], tags: ['离别'] }).note;
  const n2 = createNote(db, { title: '读水调歌头', content: '咏月名篇，明月寄怀', writingStatus: 'final', tags: ['中秋', '离别'] }).note;
  const n3 = createNote(db, { title: '读静夜思', content: '', pendingImport: true, writingStatus: 'idea', publishStatus: 'published', tags: ['思乡'] }).note;
  saveComparison(db, { title: '柳永对照苏轼', workAId: w1.id, workBId: w2.id });
  const moon = createImagery(db, { name: '月亮' });
  createImageryUse(db, { imageryId: moon.id, targetType: 'work', targetId: w2.id, quote: '明月几时有' });
  createImageryUse(db, { imageryId: moon.id, targetType: 'work', targetId: w1.id, quote: '对长亭晚' });
  const zhuang = createAllusion(db, { name: '庄周梦蝶' });
  createAllusionUse(db, { allusionId: zhuang.id, targetType: 'note', targetId: n1.id, quote: '点染之妙' });
  return { w1, w2, w3, n1, n2, n3 };
}

/* ------------------------------------------------------------------ */
/* getHome：统计与最近札记                                             */
/* ------------------------------------------------------------------ */

test('getHome：混合数据各计数正确', () => {
  const db = setup();
  seedMixed(db);
  const { stats, recent } = getHome(db);
  assert.deepEqual(stats, {
    works: 3, notes: 3, revisions: 3, comparisons: 1,
    imagery: 1, allusions: 1,
    draft: 1, final: 1, published: 1, pendingImport: 1,
  });
  assert.equal(recent.length, 3);
});

test('getHome：draft/final/published/pendingImport 按 payload 状态计数', () => {
  const db = setup();
  // 两个 draft、两个 pendingImport、一个 published；final 为零
  createNote(db, { title: 'A', content: 'x', writingStatus: 'draft', pendingImport: true });
  createNote(db, { title: 'B', content: '', pendingImport: true });
  createNote(db, { title: 'C', content: 'y', writingStatus: 'research', publishStatus: 'published' });
  const { stats } = getHome(db);
  assert.equal(stats.draft, 2);
  assert.equal(stats.final, 0);
  assert.equal(stats.published, 1);
  assert.equal(stats.pendingImport, 2);
  assert.equal(stats.notes, 3);
});

test('getHome：recent 截前 8 条且按 updatedAt 倒序', () => {
  const db = setup();
  const created = [];
  for (let i = 1; i <= 10; i++) {
    created.push(createNote(db, { title: '札记' + i, content: '内容' + i }).note);
  }
  // 直接改写 payload.updatedAt 为可分辨的固定时刻，保证排序可断言（listNotes 按 payload 排序）
  const setUpdatedAt = db.prepare('UPDATE notes SET payload=? WHERE id=?');
  created.forEach((n, i) => {
    n.updatedAt = '2026-01-' + String(10 + i).padStart(2, '0') + 'T00:00:00.000Z';
    setUpdatedAt.run(JSON.stringify(n), n.id);
  });
  const { recent } = getHome(db);
  assert.equal(recent.length, 8);
  // 最新在前：札记10 → 札记3
  assert.deepEqual(recent.map((n) => n.title),
    ['札记10', '札记9', '札记8', '札记7', '札记6', '札记5', '札记4', '札记3']);
  for (let i = 1; i < recent.length; i++) {
    assert.ok(recent[i - 1].updatedAt >= recent[i].updatedAt);
  }
  // recent 即 listNotes 摘要（复用既有摘要逻辑，字段一致）
  assert.deepEqual(recent[0], listNotes(db, {})[0]);
});

test('getHome：空库全零且 recent 为空', () => {
  const db = setup();
  const { stats, recent } = getHome(db);
  assert.deepEqual(stats, {
    works: 0, notes: 0, revisions: 0, comparisons: 0,
    imagery: 0, allusions: 0,
    draft: 0, final: 0, published: 0, pendingImport: 0,
  });
  assert.deepEqual(recent, []);
});

/* ------------------------------------------------------------------ */
/* globalSearch                                                        */
/* ------------------------------------------------------------------ */

test('globalSearch：空 q / 全空白 / 缺省返回两组空数组', () => {
  const db = setup();
  seedMixed(db);
  assert.deepEqual(globalSearch(db, ''), { works: [], notes: [] });
  assert.deepEqual(globalSearch(db, '   '), { works: [], notes: [] });
  assert.deepEqual(globalSearch(db, undefined), { works: [], notes: [] });
});

test('globalSearch：命中词作与札记摘要', () => {
  const db = setup();
  seedMixed(db);
  const r = globalSearch(db, '明月');
  // 词作：水调歌头与静夜思正文均含「明月」；札记：读水调歌头（正文）
  assert.deepEqual(r.works.map((w) => w.title).sort(), ['水调歌头', '静夜思']);
  assert.deepEqual(r.notes.map((n) => n.title), ['读水调歌头']);
  // 摘要形状来自 listWorks / listNotes
  assert.deepEqual(r.works.find((w) => w.title === '水调歌头'), listWorks(db, {}).find((w) => w.title === '水调歌头'));
  assert.deepEqual(r.notes[0], listNotes(db, { q: '明月' })[0]);
});

test('globalSearch：作者名命中两组；无命中返回空数组', () => {
  const db = setup();
  seedMixed(db);
  const r = globalSearch(db, '柳永');
  assert.deepEqual(r.works.map((w) => w.title).sort(), ['雨霖铃', '静夜思']);
  assert.deepEqual(r.notes, []);
  assert.deepEqual(globalSearch(db, '不存在的词'), { works: [], notes: [] });
});

/* ------------------------------------------------------------------ */
/* getStats：计数与 facets                                             */
/* ------------------------------------------------------------------ */

test('getStats：counts 含 uses 两表行数', () => {
  const db = setup();
  seedMixed(db);
  const { counts } = getStats(db);
  assert.deepEqual(counts, {
    works: 3, notes: 3, revisions: 3, comparisons: 1,
    imagery: 1, allusions: 1, imageryUses: 2, allusionUses: 1,
  });
});

test('getStats：facets 去重排序，kinds 保持 ci/poem 顺序', () => {
  const db = setup();
  seedMixed(db);
  const { facets } = getStats(db);
  // 去重：柳永出现两次；标签合集来自 works + notes
  const byLocale = (arr) => [...arr].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(facets.authors, byLocale(['柳永', '苏轼']));
  assert.deepEqual(facets.cipais, byLocale(['雨霖铃', '水调歌头']));
  assert.deepEqual(facets.tags, byLocale(['离别', '婉约', '中秋', '思乡']));
  // kinds 按常量顺序 ['ci','poem'] 过滤实际存在的
  assert.deepEqual(facets.kinds, ['ci', 'poem']);
  // 状态枚举为全量常量
  assert.deepEqual(facets.writingStatus, ['idea', 'research', 'draft', 'final']);
  assert.deepEqual(facets.publishStatus, ['unpublished', 'pending', 'published']);
});

test('getStats：kinds 只含实际存在的，且保持常量顺序', () => {
  const db = setup();
  createWork(db, { title: '静夜思', author: '李白', kind: 'poem', content: '床前明月光' });
  const { facets } = getStats(db);
  assert.deepEqual(facets.kinds, ['poem']);
});

test('getStats：空库 counts 全零，集合 facets 为空数组、状态 facets 为全量枚举', () => {
  const db = setup();
  const { counts, facets } = getStats(db);
  assert.deepEqual(counts, {
    works: 0, notes: 0, revisions: 0, comparisons: 0,
    imagery: 0, allusions: 0, imageryUses: 0, allusionUses: 0,
  });
  assert.deepEqual(facets, {
    authors: [], cipais: [], tags: [], kinds: [],
    writingStatus: ['idea', 'research', 'draft', 'final'],
    publishStatus: ['unpublished', 'pending', 'published'],
  });
});
