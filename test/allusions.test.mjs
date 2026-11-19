import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.mjs';
import { createWork, getWork } from '../server/core/works.mjs';
import { createNote, getNote } from '../server/core/notes.mjs';
import {
  listAllusions, getAllusion, createAllusion, updateAllusion,
  allusionImpact, deleteAllusion, mergeAllusion,
  listAllusionUses, createAllusionUse, updateAllusionUse, deleteAllusionUse,
  compareAllusions,
} from '../server/core/allusions.mjs';
import { StoreError } from '../server/core/errors.mjs';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';

function setup() { return openDb(join(mkdtempSync(join(tmpdir(), 'cn-')), 't.sqlite')); }

/** 把典故的 updatedAt 拨旧到指定时刻（payload 与标量列同步），保证排序断言确定 */
function backdateAllusion(db, id, iso) {
  const row = db.prepare('SELECT payload FROM allusions WHERE id=?').get(id);
  const a = JSON.parse(row.payload);
  a.updatedAt = iso;
  db.prepare('UPDATE allusions SET payload=?, updated_at=? WHERE id=?').run(JSON.stringify(a), iso, id);
}

/** 把使用记录的 updatedAt 拨旧到指定时刻，保证「更新时间变化」断言确定 */
function backdateUse(db, id, iso) {
  const row = db.prepare('SELECT payload FROM allusion_uses WHERE id=?').get(id);
  const u = JSON.parse(row.payload);
  u.updatedAt = iso;
  db.prepare('UPDATE allusion_uses SET payload=?, updated_at=? WHERE id=?').run(JSON.stringify(u), iso, id);
}

function useRowById(db, id) {
  return db.prepare('SELECT payload, revision, allusion_id, target_type, target_id, updated_at FROM allusion_uses WHERE id=?').get(id);
}

/* ------------------------------------------------------------------ */
/* 创建与归一化                                                        */
/* ------------------------------------------------------------------ */

test('createAllusion：name 必填、source/original/explanation 归一化、各列表字段归一化、标量列落库', () => {
  const db = setup();
  assert.throws(() => createAllusion(db, { name: '   ' }), (e) => e instanceof StoreError && e.code === 'INVALID' && /典故要有名字/.test(e.message));
  // verified 级 claim 无出处 → 共享归一化拒绝
  assert.throws(() => createAllusion(db, { name: '庄周梦蝶', claims: [{ text: 'x', kind: 'verified' }] }), /至少一条出处/);

  const al = createAllusion(db, {
    name: '  庄周梦蝶  ',
    aliases: ['蝶梦、梦蝶', '梦蝶 物化', '庄周梦蝶'],
    source: ' 《庄子·齐物论》 ',
    original: ' 昔者庄周梦为胡蝶 ',
    explanation: ' 人生如梦、物我难辨 ',
    usages: ['抒发人生如梦', { text: '表达物我两忘', kind: 'personal' }, { text: '抒发人生如梦' }, '   '],
    claims: [{ text: '出处考证', kind: 'verified', citations: [{ book: ' 庄子集释 ', verified: 'verified' }] }],
    citations: [{ book: ' 庄子今注今译 ', verified: 'nonsense' }],
    tags: ['哲学', '哲学', ' 梦 '],
    note: ' 宋词中多用于感慨 ',
  });
  assert.match(al.id, /^al_/);
  assert.equal(al.name, '庄周梦蝶');
  // 别名按顿号/逗号/空白拆分、去重、剔除与主名相同项
  assert.deepEqual(al.aliases, ['蝶梦', '梦蝶', '物化']);
  // 三个典故特有字段：字符串、trim、缺省 ''
  assert.equal(al.source, '《庄子·齐物论》');
  assert.equal(al.original, '昔者庄周梦为胡蝶');
  assert.equal(al.explanation, '人生如梦、物我难辨');
  // 用途：字符串回落 pending、按 text 去重保序
  assert.deepEqual(al.usages, [{ text: '抒发人生如梦', kind: 'pending' }, { text: '表达物我两忘', kind: 'personal' }]);
  assert.equal(al.claims.length, 1);
  assert.match(al.claims[0].id, /^cl_/);
  assert.equal(al.claims[0].citations[0].book, '庄子集释');
  assert.match(al.citations[0].id, /^ct_/);
  assert.equal(al.citations[0].verified, 'pending');
  assert.deepEqual(al.tags, ['哲学', '梦']);
  // note 照 imagery 用 str 直转，不 trim
  assert.equal(al.note, ' 宋词中多用于感慨 ');
  assert.equal(al.mergedInto, '');
  assert.equal(al.revision, 1);
  assert.equal(al.createdAt, al.updatedAt);
  // payload 形状：三个新字段在场；无 imagery 的 description；无 fn/function
  assert.deepEqual(Object.keys(al).sort(),
    ['aliases', 'claims', 'citations', 'createdAt', 'explanation', 'id', 'mergedInto', 'name', 'note', 'original', 'revision', 'source', 'tags', 'updatedAt', 'usages'].sort());
  // 标量冗余列同步：allusions 只有 name/updated_at（无 merged_into 列）
  const row = db.prepare('SELECT name, updated_at FROM allusions WHERE id=?').get(al.id);
  assert.equal(row.name, '庄周梦蝶');
  assert.equal(row.updated_at, al.updatedAt);
  const cols = db.prepare('PRAGMA table_info(allusions)').all().map((c) => c.name);
  assert.equal(cols.indexOf('merged_into'), -1);
  // 缺省字段为空串
  const bare = createAllusion(db, { name: '塞上长城' });
  assert.equal(bare.source, '');
  assert.equal(bare.original, '');
  assert.equal(bare.explanation, '');
});

/* ------------------------------------------------------------------ */
/* 更新通用资料                                                        */
/* ------------------------------------------------------------------ */

test('updateAllusion：字段级合并、三新字段可改、改名去重别名、mergedInto 不可由此改', () => {
  const db = setup();
  const al = createAllusion(db, { name: '梦蝶', aliases: ['蝶梦'], source: '旧出处', explanation: '旧释义' });
  const al2 = updateAllusion(db, al.id, {
    source: '新出处', original: '新原文', explanation: '新释义', note: '笔记', mergedInto: 'al_elsewhere',
  });
  assert.equal(al2.source, '新出处');
  assert.equal(al2.original, '新原文');
  assert.equal(al2.explanation, '新释义');
  assert.equal(al2.note, '笔记');
  assert.equal(al2.mergedInto, ''); // mergedInto 只能由 mergeAllusion 改
  assert.equal(al2.name, '梦蝶');
  assert.deepEqual(al2.aliases, ['蝶梦']);
  assert.equal(al2.revision, 2);
  assert.ok(al2.updatedAt >= al.updatedAt);
  // 改名后别名里与新名重复的要去掉
  const al3 = updateAllusion(db, al.id, { name: '蝶梦' });
  assert.equal(al3.name, '蝶梦');
  assert.deepEqual(al3.aliases, []);
  // 空名拒绝
  assert.throws(() => updateAllusion(db, al.id, { name: '  ' }), /典故要有名字/);
  assert.throws(() => updateAllusion(db, 'al_none', { note: 'x' }), (e) => e.code === 'NOT_FOUND');
  // 标量列同步
  const row = db.prepare('SELECT name FROM allusions WHERE id=?').get(al.id);
  assert.equal(row.name, '蝶梦');
});

test('updateAllusion：CAS 冲突、force 覆盖、无 baseRevision 直写', () => {
  const db = setup();
  const al = createAllusion(db, { name: '梦蝶' });
  assert.throws(
    () => updateAllusion(db, al.id, { note: 'x' }, { baseRevision: 99 }),
    (e) => e instanceof StoreError && e.code === 'CONFLICT' && /这条典故在别处被改过/.test(e.message) && e.current.id === al.id,
  );
  const forced = updateAllusion(db, al.id, { note: '强制' }, { baseRevision: 99, force: true });
  assert.equal(forced.note, '强制');
  const plain = updateAllusion(db, al.id, { note: '无锁' });
  assert.equal(plain.note, '无锁');
  assert.equal(plain.revision, 3);
});

test('updateAllusion 只动通用资料：先建 use，更新后 use 的 payload/revision/updatedAt 原样', () => {
  const db = setup();
  const al = createAllusion(db, { name: '梦蝶', explanation: 'd' });
  const w = createWork(db, { title: '锦瑟' });
  const u = createAllusionUse(db, { allusionId: al.id, targetType: 'work', targetId: w.id, quote: '庄生晓梦迷蝴蝶', interpretation: '迷惘若梦' });
  const before = useRowById(db, u.id);
  updateAllusion(db, al.id, { name: '庄周梦蝶', explanation: '新释义', tags: ['哲学'] });
  const after = useRowById(db, u.id);
  assert.equal(after.payload, before.payload);
  assert.equal(after.revision, before.revision);
  assert.equal(after.updated_at, before.updated_at);
});

/* ------------------------------------------------------------------ */
/* 列表：筛选、排序、counts                                             */
/* ------------------------------------------------------------------ */

test('listAllusions：counts 统计、q 多字段匹配（含 source/original/explanation）、tag 筛选、名称排序', () => {
  const db = setup();
  const w1 = createWork(db, { title: '锦瑟' });
  const w2 = createWork(db, { title: '书愤' });
  const n1 = createNote(db, { title: '札记一' }).note;
  const butterfly = createAllusion(db, {
    name: '庄周梦蝶', aliases: ['蝶梦'], tags: ['哲学'], source: '《庄子·齐物论》',
    original: '昔者庄周梦为胡蝶', explanation: '人生如梦', usages: ['感慨浮生'], note: '晚唐多用于迷惘',
  });
  const greatWall = createAllusion(db, { name: '塞上长城', tags: ['边塞'] });
  const pearl = createAllusion(db, { name: '沧海珠泪' });
  createAllusionUse(db, { allusionId: butterfly.id, targetType: 'work', targetId: w1.id, quote: '庄生晓梦迷蝴蝶' });
  createAllusionUse(db, { allusionId: butterfly.id, targetType: 'work', targetId: w1.id });
  createAllusionUse(db, { allusionId: butterfly.id, targetType: 'note', targetId: n1.id });
  createAllusionUse(db, { allusionId: greatWall.id, targetType: 'work', targetId: w2.id });

  const list = listAllusions(db);
  // 名称排序（本环境 localeCompare 下 塞上长城 < 庄周梦蝶 < 沧海珠泪）
  assert.deepEqual(list.entries.map((e) => e.allusion.name), ['塞上长城', '庄周梦蝶', '沧海珠泪']);
  // counts：works/notes 为去重目标数，uses 总条数，quotes 非空词句数
  const byName = (name) => list.entries.find((e) => e.allusion.name === name);
  assert.deepEqual(byName('庄周梦蝶').counts, { works: 1, notes: 1, uses: 3, quotes: 1 });
  assert.deepEqual(byName('塞上长城').counts, { works: 1, notes: 0, uses: 1, quotes: 0 });
  assert.deepEqual(byName('沧海珠泪').counts, { works: 0, notes: 0, uses: 0, quotes: 0 });
  // q：别名 / 出处典籍 / 典故原文 / 释义 / 用途文本 / 札记 / 标签都能命中
  assert.deepEqual(listAllusions(db, { q: '蝶梦' }).entries.map((e) => e.allusion.name), ['庄周梦蝶']);
  assert.deepEqual(listAllusions(db, { q: '齐物论' }).entries.map((e) => e.allusion.name), ['庄周梦蝶']);
  assert.deepEqual(listAllusions(db, { q: '胡蝶' }).entries.map((e) => e.allusion.name), ['庄周梦蝶']);
  assert.deepEqual(listAllusions(db, { q: '人生如梦' }).entries.map((e) => e.allusion.name), ['庄周梦蝶']);
  assert.deepEqual(listAllusions(db, { q: '浮生' }).entries.map((e) => e.allusion.name), ['庄周梦蝶']);
  assert.deepEqual(listAllusions(db, { q: '迷惘' }).entries.map((e) => e.allusion.name), ['庄周梦蝶']);
  assert.deepEqual(listAllusions(db, { q: '不存在' }).entries, []);
  // tag 筛选
  assert.deepEqual(listAllusions(db, { tag: '边塞' }).entries.map((e) => e.allusion.name), ['塞上长城']);
  assert.deepEqual(listAllusions(db, { tag: '哲学' }).entries.map((e) => e.allusion.name), ['庄周梦蝶']);
});

test('listAllusions：同名按 updatedAt 倒序；默认隐藏 mergedInto 非空', () => {
  const db = setup();
  const a = createAllusion(db, { name: '梦蝶' });
  const b = createAllusion(db, { name: '梦蝶' });
  backdateAllusion(db, a.id, '2020-01-01T00:00:00.000Z');
  assert.deepEqual(listAllusions(db).entries.map((e) => e.allusion.id), [b.id, a.id]);

  const moon = createAllusion(db, { name: '烂柯' });
  const frost = createAllusion(db, { name: '黍离' });
  mergeAllusion(db, frost.id, moon.id);
  // 默认排除被合并的典故；includeMerged 时保留
  assert.equal(listAllusions(db).entries.map((e) => e.allusion.name).indexOf('黍离'), -1);
  const merged = listAllusions(db, { includeMerged: true }).entries.map((e) => e.allusion.name);
  assert.equal(merged.indexOf('黍离') >= 0, true);
});

/* ------------------------------------------------------------------ */
/* 详情装配                                                            */
/* ------------------------------------------------------------------ */

test('getAllusion：通用资料 + uses + 按目标分组的 works/notes + counts；NOT_FOUND', () => {
  const db = setup();
  const w1 = createWork(db, { title: '锦瑟', author: '李商隐' });
  const w2 = createWork(db, { title: '蝶恋花', author: '晏殊' });
  const n1 = createNote(db, { title: '札记' }).note;
  const butterfly = createAllusion(db, { name: '庄周梦蝶' });
  const u1 = createAllusionUse(db, { allusionId: butterfly.id, targetType: 'work', targetId: w1.id, quote: '庄生晓梦迷蝴蝶' });
  createAllusionUse(db, { allusionId: butterfly.id, targetType: 'work', targetId: w2.id });
  createAllusionUse(db, { allusionId: butterfly.id, targetType: 'note', targetId: n1.id });

  const detail = getAllusion(db, butterfly.id);
  assert.equal(detail.allusion.id, butterfly.id);
  assert.equal(detail.uses.length, 3);
  assert.ok(detail.uses.some((u) => u.id === u1.id));
  assert.equal(detail.works.length, 2);
  const w1Group = detail.works.find((x) => x.work.id === w1.id);
  assert.deepEqual(w1Group.uses.map((u) => u.id), [u1.id]);
  assert.equal(detail.notes.length, 1);
  assert.equal(detail.notes[0].note.id, n1.id);
  assert.equal(detail.notes[0].uses.length, 1);
  assert.deepEqual(detail.counts, { works: 2, notes: 1, uses: 3, quotes: 1 });
  assert.throws(() => getAllusion(db, 'al_none'), (e) => e.code === 'NOT_FOUND' && /典故不存在/.test(e.message));

  // 按作者筛关联作品
  const onlyLi = getAllusion(db, butterfly.id, { author: '李商隐' });
  assert.deepEqual(onlyLi.works.map((x) => x.work.id), [w1.id]);
  assert.equal(onlyLi.counts.works, 1);
});

/* ------------------------------------------------------------------ */
/* 影响计算与删除                                                      */
/* ------------------------------------------------------------------ */

test('allusionImpact：uses/works/notes 计数与 ID 清单', () => {
  const db = setup();
  const w1 = createWork(db, { title: '锦瑟' });
  const w2 = createWork(db, { title: '书愤' });
  const n1 = createNote(db, { title: '札记' }).note;
  const butterfly = createAllusion(db, { name: '庄周梦蝶' });
  createAllusionUse(db, { allusionId: butterfly.id, targetType: 'work', targetId: w1.id });
  createAllusionUse(db, { allusionId: butterfly.id, targetType: 'work', targetId: w2.id });
  createAllusionUse(db, { allusionId: butterfly.id, targetType: 'work', targetId: w1.id });
  createAllusionUse(db, { allusionId: butterfly.id, targetType: 'note', targetId: n1.id });
  assert.deepEqual(allusionImpact(db, butterfly.id), {
    uses: 4, works: 2, notes: 1,
    workIds: [w1.id, w2.id], noteIds: [n1.id],
  });
  assert.deepEqual(allusionImpact(db, 'al_none'), { uses: 0, works: 0, notes: 0, workIds: [], noteIds: [] });
});

test('deleteAllusion：连带删全部 uses，作品与札记不受影响，再删报 NOT_FOUND', () => {
  const db = setup();
  const w = createWork(db, { title: '锦瑟' });
  const n = createNote(db, { title: '札记' }).note;
  const pearl = createAllusion(db, { name: '沧海珠泪' });
  const u1 = createAllusionUse(db, { allusionId: pearl.id, targetType: 'work', targetId: w.id, quote: '沧海月明珠有泪' });
  const u2 = createAllusionUse(db, { allusionId: pearl.id, targetType: 'note', targetId: n.id });
  const r = deleteAllusion(db, pearl.id);
  assert.equal(r.id, pearl.id);
  assert.deepEqual(r.removed, { uses: 2, works: 1, notes: 1, workIds: [w.id], noteIds: [n.id] });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM allusions WHERE id=?').get(pearl.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM allusion_uses WHERE id=?').get(u1.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM allusion_uses WHERE id=?').get(u2.id).n, 0);
  // 作品与札记本身还在
  assert.equal(getWork(db, w.id).work.id, w.id);
  assert.equal(getNote(db, n.id).note.id, n.id);
  assert.throws(() => deleteAllusion(db, pearl.id), (e) => e.code === 'NOT_FOUND');
});

/* ------------------------------------------------------------------ */
/* 合并                                                                */
/* ------------------------------------------------------------------ */

test('mergeAllusion：uses 改挂 to（revision+1、updatedAt 更新），from 标记合并并隐藏', () => {
  const db = setup();
  const w = createWork(db, { title: '锦瑟' });
  const from = createAllusion(db, { name: '黍离' });
  const to = createAllusion(db, { name: '梦蝶' });
  const u1 = createAllusionUse(db, { allusionId: from.id, targetType: 'work', targetId: w.id, quote: '彼黍离离' });
  const u2 = createAllusionUse(db, { allusionId: from.id, targetType: 'work', targetId: w.id });
  backdateUse(db, u1.id, '2020-01-01T00:00:00.000Z');

  assert.throws(() => mergeAllusion(db, from.id, from.id), (e) => e.code === 'INVALID' && /不能合并到它自己/.test(e.message));
  assert.throws(() => mergeAllusion(db, from.id, 'al_none'), (e) => e.code === 'NOT_FOUND' && /要合并的典故不存在/.test(e.message));
  assert.throws(() => mergeAllusion(db, 'al_none', to.id), (e) => e.code === 'NOT_FOUND');

  const r = mergeAllusion(db, from.id, to.id);
  assert.equal(r.movedUses, 2);
  assert.equal(r.from.mergedInto, to.id);
  assert.equal(r.from.revision, 2);
  assert.equal(r.to.revision, 1); // to 不动
  // uses 全部改挂 to
  const row = useRowById(db, u1.id);
  const u = JSON.parse(row.payload);
  assert.equal(u.allusionId, to.id);
  assert.equal(u.revision, 2);
  assert.ok(u.updatedAt > '2020-01-01T00:00:00.000Z');
  assert.equal(row.allusion_id, to.id);
  assert.equal(row.revision, 2);
  assert.equal(JSON.parse(useRowById(db, u2.id).payload).allusionId, to.id);
  // mergedInto 只存 payload（allusions 表无 merged_into 标量列）
  assert.deepEqual(JSON.parse(db.prepare('SELECT payload FROM allusions WHERE id=?').get(from.id).payload).mergedInto, to.id);
  // to 的详情收下两条 uses；from 默认隐藏但按 id 仍可取
  assert.equal(getAllusion(db, to.id).uses.length, 2);
  assert.equal(getAllusion(db, from.id).allusion.mergedInto, to.id);
  assert.equal(listAllusions(db).entries.map((e) => e.allusion.name).indexOf('黍离'), -1);
});

/* ------------------------------------------------------------------ */
/* 使用记录 CRUD                                                       */
/* ------------------------------------------------------------------ */

test('createAllusionUse：典故与目标校验、targetType 白名单、interpretation 字段且无 fn/function', () => {
  const db = setup();
  const al = createAllusion(db, { name: '庄周梦蝶' });
  const w = createWork(db, { title: '锦瑟' });
  const n = createNote(db, { title: '札记' }).note;
  assert.throws(() => createAllusionUse(db, { targetType: 'work', targetId: w.id }), (e) => e.code === 'INVALID' && /要关联一个典故/.test(e.message));
  assert.throws(() => createAllusionUse(db, { allusionId: 'al_none', targetType: 'work', targetId: w.id }), (e) => e.code === 'NOT_FOUND' && /典故不存在/.test(e.message));
  assert.throws(() => createAllusionUse(db, { allusionId: al.id, targetType: 'work' }), (e) => e.code === 'INVALID' && /缺少作品或札记 ID/.test(e.message));
  assert.throws(() => createAllusionUse(db, { allusionId: al.id, targetType: 'poem', targetId: w.id }), (e) => e.code === 'INVALID');
  assert.throws(() => createAllusionUse(db, { allusionId: al.id, targetType: 'work', targetId: 'w_none' }), (e) => e.code === 'NOT_FOUND' && /作品不存在/.test(e.message));
  assert.throws(() => createAllusionUse(db, { allusionId: al.id, targetType: 'note', targetId: 'n_none' }), (e) => e.code === 'NOT_FOUND' && /札记不存在/.test(e.message));

  const u = createAllusionUse(db, {
    allusionId: al.id,
    targetType: 'work',
    targetId: w.id,
    quote: ' 庄生晓梦迷蝴蝶 ',
    interpretation: ' 迷惘若梦 ',
    context: '悼亡与自伤交织',
    understanding: '以梦蝶写人生迷惘',
    claims: [{ text: '异文待核' }],
  });
  assert.match(u.id, /^au_/);
  assert.equal(u.allusionId, al.id);
  assert.equal(u.targetType, 'work');
  assert.equal(u.targetId, w.id);
  // quote/context 照 imagery 用 str 直转，不 trim；interpretation 同为 str 直转
  assert.equal(u.quote, ' 庄生晓梦迷蝴蝶 ');
  assert.equal(u.interpretation, ' 迷惘若梦 ');
  assert.equal(u.context, '悼亡与自伤交织');
  assert.equal(u.understanding, '以梦蝶写人生迷惘');
  assert.equal(u.claims.length, 1);
  assert.equal(u.revision, 1);
  // 典故用语义化字段名 interpretation，不存在 fn/function 键
  assert.equal('fn' in u, false);
  assert.equal('function' in u, false);
  assert.equal('interpretation' in u, true);
  assert.deepEqual(Object.keys(u).sort(),
    ['allusionId', 'claims', 'citations', 'context', 'createdAt', 'id', 'interpretation', 'quote', 'revision', 'targetId', 'targetType', 'understanding', 'updatedAt'].sort());
  // note 目标可用
  const u2 = createAllusionUse(db, { allusionId: al.id, targetType: 'note', targetId: n.id, interpretation: '札记里以梦蝶收束' });
  assert.equal(u2.targetType, 'note');
  assert.equal(u2.interpretation, '札记里以梦蝶收束');
  // 标量列同步
  const row = useRowById(db, u.id);
  assert.equal(row.allusion_id, al.id);
  assert.equal(row.target_type, 'work');
  assert.equal(row.target_id, w.id);
  assert.equal(row.updated_at, u.updatedAt);
});

test('listAllusionUses：按目标取全部使用记录，目标与类型校验', () => {
  const db = setup();
  const al = createAllusion(db, { name: '庄周梦蝶' });
  const other = createAllusion(db, { name: '塞上长城' });
  const w = createWork(db, { title: '锦瑟' });
  const n = createNote(db, { title: '札记' }).note;
  createAllusionUse(db, { allusionId: al.id, targetType: 'work', targetId: w.id, quote: '庄生晓梦迷蝴蝶' });
  createAllusionUse(db, { allusionId: other.id, targetType: 'work', targetId: w.id });
  createAllusionUse(db, { allusionId: al.id, targetType: 'note', targetId: n.id });

  assert.throws(() => listAllusionUses(db, { targetType: 'poem', targetId: w.id }), (e) => e.code === 'INVALID');
  assert.throws(() => listAllusionUses(db, { targetType: 'work' }), (e) => e.code === 'INVALID');
  assert.throws(() => listAllusionUses(db, { targetType: 'work', targetId: 'w_none' }), (e) => e.code === 'NOT_FOUND' && /作品不存在/.test(e.message));
  assert.throws(() => listAllusionUses(db, { targetType: 'note', targetId: 'n_none' }), (e) => e.code === 'NOT_FOUND' && /札记不存在/.test(e.message));
  const workUses = listAllusionUses(db, { targetType: 'work', targetId: w.id });
  assert.equal(workUses.length, 2); // 跨典故的全部使用
  assert.ok(workUses.every((u) => u.targetType === 'work' && u.targetId === w.id));
  assert.equal(listAllusionUses(db, { targetType: 'note', targetId: n.id }).length, 1);
});

test('updateAllusionUse / deleteAllusionUse：interpretation 合并、CAS、NOT_FOUND', () => {
  const db = setup();
  const al = createAllusion(db, { name: '庄周梦蝶' });
  const w = createWork(db, { title: '锦瑟' });
  const u = createAllusionUse(db, { allusionId: al.id, targetType: 'work', targetId: w.id, quote: '旧句', context: '旧情境', understanding: '旧理解', interpretation: '旧解释' });
  const u2 = updateAllusionUse(db, u.id, {
    quote: '新句', interpretation: '新解释', context: '新情境', understanding: '新理解',
    claims: [{ text: '新注', kind: 'personal' }],
  });
  assert.equal(u2.quote, '新句');
  assert.equal(u2.interpretation, '新解释');
  assert.equal(u2.context, '新情境');
  assert.equal(u2.understanding, '新理解');
  assert.equal(u2.claims.length, 1);
  // 挂载关系不可改
  assert.equal(u2.allusionId, al.id);
  assert.equal(u2.targetId, w.id);
  assert.equal(u2.revision, 2);
  assert.throws(
    () => updateAllusionUse(db, u.id, { quote: 'x' }, { baseRevision: u.revision }),
    (e) => e instanceof StoreError && e.code === 'CONFLICT' && /这条使用记录在别处被改过/.test(e.message),
  );
  const forced = updateAllusionUse(db, u.id, { quote: '强制' }, { baseRevision: u.revision, force: true });
  assert.equal(forced.quote, '强制');
  assert.equal(forced.revision, 3); // 创建 1 → 更新 2 → 冲突不推进 → 强制 3
  assert.throws(() => updateAllusionUse(db, 'au_none', { quote: 'x' }), (e) => e.code === 'NOT_FOUND' && /这条记录不存在/.test(e.message));

  assert.deepEqual(deleteAllusionUse(db, u.id), { id: u.id });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM allusion_uses WHERE id=?').get(u.id).n, 0);
  assert.throws(() => deleteAllusionUse(db, u.id), (e) => e.code === 'NOT_FOUND');
});

/* ------------------------------------------------------------------ */
/* 双作品对照                                                          */
/* ------------------------------------------------------------------ */

test('compareAllusions：shared/onlyA/onlyB，uses 含 interpretation', () => {
  const db = setup();
  const a = createWork(db, { title: '锦瑟' });
  const b = createWork(db, { title: '书愤' });
  const butterfly = createAllusion(db, { name: '庄周梦蝶' });
  const pearl = createAllusion(db, { name: '沧海珠泪' });
  const wall = createAllusion(db, { name: '塞上长城' });
  const ma = createAllusionUse(db, { allusionId: butterfly.id, targetType: 'work', targetId: a.id, quote: '庄生晓梦迷蝴蝶', interpretation: '迷惘若梦' });
  const mb = createAllusionUse(db, { allusionId: butterfly.id, targetType: 'work', targetId: b.id, quote: '梦里不知身是客', interpretation: '身世如梦' });
  const pa = createAllusionUse(db, { allusionId: pearl.id, targetType: 'work', targetId: a.id });
  createAllusionUse(db, { allusionId: wall.id, targetType: 'work', targetId: b.id });

  const r = compareAllusions(db, a.id, b.id);
  assert.equal(r.shared.length, 1);
  assert.equal(r.shared[0].allusion.id, butterfly.id);
  assert.equal(r.shared[0].allusion.name, '庄周梦蝶');
  assert.deepEqual(r.shared[0].usesA.map((u) => u.id), [ma.id]);
  assert.deepEqual(r.shared[0].usesB.map((u) => u.id), [mb.id]);
  assert.equal(r.shared[0].usesA[0].interpretation, '迷惘若梦');
  assert.equal(r.shared[0].usesB[0].interpretation, '身世如梦');
  assert.deepEqual(r.onlyA.map((x) => x.allusion.id), [pearl.id]);
  assert.deepEqual(r.onlyA[0].usesA.length, 1);
  assert.deepEqual(r.onlyB.map((x) => x.allusion.id), [wall.id]);
  assert.deepEqual(r.onlyB[0].usesB.length, 1);
  // 无关联的作品：三组皆空（不校验作品存在）
  const empty = compareAllusions(db, 'w_none1', 'w_none2');
  assert.deepEqual(empty, { shared: [], onlyA: [], onlyB: [] });
});

/* ------------------------------------------------------------------ */
/* getWork / getNote 详情装配                                          */
/* ------------------------------------------------------------------ */

test('getWork/getNote 装配 allusions entries：按典故分组含真实 uses，imagery 装配不受影响', () => {
  const db = setup();
  const w = createWork(db, { title: '锦瑟' });
  const n = createNote(db, { title: '读锦瑟' }).note;
  const butterfly = createAllusion(db, { name: '庄周梦蝶' });
  const ua1 = createAllusionUse(db, { allusionId: butterfly.id, targetType: 'work', targetId: w.id, quote: '庄生晓梦迷蝴蝶', interpretation: '迷惘若梦' });
  const ua2 = createAllusionUse(db, { allusionId: butterfly.id, targetType: 'work', targetId: w.id, quote: '望帝春心托杜鹃' });
  createAllusionUse(db, { allusionId: butterfly.id, targetType: 'note', targetId: n.id, quote: '札记里的梦蝶' });

  const wd = getWork(db, w.id);
  assert.equal(wd.imagery.allusions.entries.length, 1);
  assert.equal(wd.imagery.allusions.entries[0].allusion.id, butterfly.id);
  assert.deepEqual(wd.imagery.allusions.entries[0].uses.map((u) => u.id).sort(), [ua1.id, ua2.id].sort());
  assert.equal(wd.imagery.allusions.entries[0].uses[0].interpretation, '迷惘若梦');
  // 无意象关联的作品 imagery.entries 为空，两组装配互不干扰
  assert.deepEqual(wd.imagery.entries, []);
  const w2 = createWork(db, { title: '书愤' });
  assert.deepEqual(getWork(db, w2.id).imagery.allusions.entries, []);

  const nd = getNote(db, n.id);
  assert.equal(nd.imagery.allusions.entries.length, 1);
  assert.equal(nd.imagery.allusions.entries[0].allusion.id, butterfly.id);
  assert.equal(nd.imagery.allusions.entries[0].uses.length, 1);
  assert.equal(nd.imagery.allusions.entries[0].uses[0].quote, '札记里的梦蝶');

  // 合并后：黍离的 uses 并入庄周梦蝶，entries 只剩一组
  const millet = createAllusion(db, { name: '黍离' });
  createAllusionUse(db, { allusionId: millet.id, targetType: 'work', targetId: w.id });
  mergeAllusion(db, millet.id, butterfly.id);
  const wd2 = getWork(db, w.id);
  assert.equal(wd2.imagery.allusions.entries.length, 1);
  assert.equal(wd2.imagery.allusions.entries[0].allusion.id, butterfly.id);
  assert.equal(wd2.imagery.allusions.entries[0].uses.length, 3);
});
