import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.mjs';
import { createWork, getWork } from '../server/core/works.mjs';
import { createNote, getNote } from '../server/core/notes.mjs';
import {
  listImagery, getImagery, createImagery, updateImagery,
  imageryImpact, deleteImagery, mergeImagery,
  listImageryUses, createImageryUse, updateImageryUse, deleteImageryUse,
  compareImagery,
} from '../server/core/imagery.mjs';
import { StoreError } from '../server/core/errors.mjs';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';

function setup() { return openDb(join(mkdtempSync(join(tmpdir(), 'cn-')), 't.sqlite')); }

/** 把意象的 updatedAt 拨旧到指定时刻（payload 与标量列同步），保证排序断言确定 */
function backdateImagery(db, id, iso) {
  const row = db.prepare('SELECT payload FROM imagery WHERE id=?').get(id);
  const m = JSON.parse(row.payload);
  m.updatedAt = iso;
  db.prepare('UPDATE imagery SET payload=?, updated_at=? WHERE id=?').run(JSON.stringify(m), iso, id);
}

/** 把使用记录的 updatedAt 拨旧到指定时刻，保证「更新时间变化」断言确定 */
function backdateUse(db, id, iso) {
  const row = db.prepare('SELECT payload FROM imagery_uses WHERE id=?').get(id);
  const u = JSON.parse(row.payload);
  u.updatedAt = iso;
  db.prepare('UPDATE imagery_uses SET payload=?, updated_at=? WHERE id=?').run(JSON.stringify(u), iso, id);
}

function useRowById(db, id) {
  return db.prepare('SELECT payload, revision, imagery_id, target_type, target_id, updated_at FROM imagery_uses WHERE id=?').get(id);
}

/* ------------------------------------------------------------------ */
/* 创建与归一化                                                        */
/* ------------------------------------------------------------------ */

test('createImagery：name 必填、各列表字段归一化、标量列落库', () => {
  const db = setup();
  assert.throws(() => createImagery(db, { name: '   ' }), (e) => e instanceof StoreError && e.code === 'INVALID' && /意象要有名字/.test(e.message));
  // verified 级 claim 无出处 → 共享归一化拒绝
  assert.throws(() => createImagery(db, { name: '月', claims: [{ text: 'x', kind: 'verified' }] }), /至少一条出处/);

  const im = createImagery(db, {
    name: '  月亮  ',
    aliases: ['明月、玉盘', '玉盘 婵娟', '月亮'],
    description: ' 夜空之月 ',
    usages: ['寄托相思', { text: '象征团圆', kind: 'personal' }, { text: '寄托相思' }, '   '],
    claims: [{ text: '常用意象考证', kind: 'verified', citations: [{ book: ' 词谱 ', verified: 'verified' }] }],
    citations: [{ book: ' 全宋词 ', verified: 'nonsense' }],
    tags: ['天空', '天空', ' 秋 '],
    note: ' 秋天常写 ',
  });
  assert.match(im.id, /^im_/);
  assert.equal(im.name, '月亮');
  // 别名按顿号/逗号/空白拆分、去重、剔除与主名相同项
  assert.deepEqual(im.aliases, ['明月', '玉盘', '婵娟']);
  // 用途：字符串回落 pending、按 text 去重保序
  assert.deepEqual(im.usages, [{ text: '寄托相思', kind: 'pending' }, { text: '象征团圆', kind: 'personal' }]);
  assert.equal(im.claims.length, 1);
  assert.match(im.claims[0].id, /^cl_/);
  assert.equal(im.claims[0].citations[0].book, '词谱');
  assert.match(im.citations[0].id, /^ct_/);
  assert.equal(im.citations[0].verified, 'pending');
  assert.deepEqual(im.tags, ['天空', '秋']);
  // description/note 照词间 makeImagery 用 str 直转，不 trim
  assert.equal(im.description, ' 夜空之月 ');
  assert.equal(im.note, ' 秋天常写 ');
  assert.equal(im.mergedInto, '');
  assert.equal(im.revision, 1);
  assert.equal(im.createdAt, im.updatedAt);
  // 标量冗余列同步
  const row = db.prepare('SELECT name, merged_into, updated_at FROM imagery WHERE id=?').get(im.id);
  assert.equal(row.name, '月亮');
  assert.equal(row.merged_into, '');
  assert.equal(row.updated_at, im.updatedAt);
});

/* ------------------------------------------------------------------ */
/* 更新通用资料                                                        */
/* ------------------------------------------------------------------ */

test('updateImagery：字段级合并、改名去重别名、mergedInto 不可由此改', () => {
  const db = setup();
  const im = createImagery(db, { name: '月', aliases: ['明月'], description: '旧描述' });
  const im2 = updateImagery(db, im.id, { description: '新描述', note: '笔记', mergedInto: 'im_elsewhere' });
  assert.equal(im2.description, '新描述');
  assert.equal(im2.note, '笔记');
  assert.equal(im2.mergedInto, ''); // mergedInto 只能由 mergeImagery 改
  assert.equal(im2.name, '月');
  assert.deepEqual(im2.aliases, ['明月']);
  assert.equal(im2.revision, 2);
  assert.ok(im2.updatedAt >= im.updatedAt);
  // 改名后别名里与新名重复的要去掉
  const im3 = updateImagery(db, im.id, { name: '明月' });
  assert.equal(im3.name, '明月');
  assert.deepEqual(im3.aliases, []);
  // 空名拒绝
  assert.throws(() => updateImagery(db, im.id, { name: '  ' }), /意象要有名字/);
  assert.throws(() => updateImagery(db, 'im_none', { note: 'x' }), (e) => e.code === 'NOT_FOUND');
  // 标量列同步
  const row = db.prepare('SELECT name FROM imagery WHERE id=?').get(im.id);
  assert.equal(row.name, '明月');
});

test('updateImagery：CAS 冲突、force 覆盖、无 baseRevision 直写', () => {
  const db = setup();
  const im = createImagery(db, { name: '月' });
  assert.throws(
    () => updateImagery(db, im.id, { note: 'x' }, { baseRevision: 99 }),
    (e) => e instanceof StoreError && e.code === 'CONFLICT' && /这条意象在别处被改过/.test(e.message) && e.current.id === im.id,
  );
  const forced = updateImagery(db, im.id, { note: '强制' }, { baseRevision: 99, force: true });
  assert.equal(forced.note, '强制');
  const plain = updateImagery(db, im.id, { note: '无锁' });
  assert.equal(plain.note, '无锁');
  assert.equal(plain.revision, 3);
});

test('updateImagery 只动通用资料：先建 use，更新后 use 的 payload/revision/updatedAt 原样', () => {
  const db = setup();
  const im = createImagery(db, { name: '月', description: 'd' });
  const w = createWork(db, { title: '静夜思' });
  const u = createImageryUse(db, { imageryId: im.id, targetType: 'work', targetId: w.id, quote: '床前明月光', fn: '以月衬乡愁' });
  const before = useRowById(db, u.id);
  updateImagery(db, im.id, { name: '明月', description: '新描述', tags: ['天空'] });
  const after = useRowById(db, u.id);
  assert.equal(after.payload, before.payload);
  assert.equal(after.revision, before.revision);
  assert.equal(after.updated_at, before.updated_at);
});

/* ------------------------------------------------------------------ */
/* 列表：筛选、排序、counts                                             */
/* ------------------------------------------------------------------ */

test('listImagery：counts 统计、q 多字段匹配、tag 筛选、名称排序', () => {
  const db = setup();
  const w1 = createWork(db, { title: '静夜思' });
  const w2 = createWork(db, { title: '春望' });
  const n1 = createNote(db, { title: '札记一' }).note;
  const moon = createImagery(db, { name: '月亮', aliases: ['明月'], tags: ['天空'], description: '夜空之月', usages: ['寄托相思'], note: '怀人常客' });
  const grass = createImagery(db, { name: '芳草', tags: ['春天'] });
  const fall = createImagery(db, { name: '落花' });
  createImageryUse(db, { imageryId: moon.id, targetType: 'work', targetId: w1.id, quote: '床前明月光' });
  createImageryUse(db, { imageryId: moon.id, targetType: 'work', targetId: w1.id });
  createImageryUse(db, { imageryId: moon.id, targetType: 'note', targetId: n1.id });
  createImageryUse(db, { imageryId: grass.id, targetType: 'work', targetId: w2.id });

  const list = listImagery(db);
  // 名称排序（本环境 localeCompare 下 月亮 < 芳草 < 落花）
  assert.deepEqual(list.entries.map((e) => e.imagery.name), ['月亮', '芳草', '落花']);
  // counts：works/notes 为去重目标数，uses 总条数，quotes 非空词句数
  assert.deepEqual(list.entries[0].counts, { works: 1, notes: 1, uses: 3, quotes: 1 });
  assert.deepEqual(list.entries[1].counts, { works: 1, notes: 0, uses: 1, quotes: 0 });
  assert.deepEqual(list.entries[2].counts, { works: 0, notes: 0, uses: 0, quotes: 0 });
  // q：别名 / 描述 / 用途文本 / 札记 / 标签都能命中
  assert.deepEqual(listImagery(db, { q: '明月' }).entries.map((e) => e.imagery.name), ['月亮']);
  assert.deepEqual(listImagery(db, { q: '夜空' }).entries.map((e) => e.imagery.name), ['月亮']);
  assert.deepEqual(listImagery(db, { q: '相思' }).entries.map((e) => e.imagery.name), ['月亮']);
  assert.deepEqual(listImagery(db, { q: '怀人' }).entries.map((e) => e.imagery.name), ['月亮']);
  assert.deepEqual(listImagery(db, { q: '不存在' }).entries, []);
  // tag 筛选
  assert.deepEqual(listImagery(db, { tag: '春天' }).entries.map((e) => e.imagery.name), ['芳草']);
  assert.deepEqual(listImagery(db, { tag: '天空' }).entries.map((e) => e.imagery.name), ['月亮']);
});

test('listImagery：同名按 updatedAt 倒序；默认隐藏 mergedInto 非空', () => {
  const db = setup();
  const a = createImagery(db, { name: '雪' });
  const b = createImagery(db, { name: '雪' });
  backdateImagery(db, a.id, '2020-01-01T00:00:00.000Z');
  assert.deepEqual(listImagery(db).entries.map((e) => e.imagery.id), [b.id, a.id]);

  const moon = createImagery(db, { name: '月' });
  const grass = createImagery(db, { name: '霜' });
  mergeImagery(db, grass.id, moon.id);
  // 默认排除被合并的霜（本环境 zh 排序按码点：月 < 雪 < 霜）；includeMerged 时保留
  assert.deepEqual(listImagery(db).entries.map((e) => e.imagery.name), ['月', '雪', '雪']);
  const merged = listImagery(db, { includeMerged: true }).entries.map((e) => e.imagery.name);
  assert.deepEqual(merged, ['月', '雪', '雪', '霜']);
});

/* ------------------------------------------------------------------ */
/* 详情装配                                                            */
/* ------------------------------------------------------------------ */

test('getImagery：通用资料 + uses + 按目标分组的 works/notes + counts；NOT_FOUND', () => {
  const db = setup();
  const w1 = createWork(db, { title: '静夜思', author: '李白' });
  const w2 = createWork(db, { title: '月夜', author: '杜甫' });
  const n1 = createNote(db, { title: '札记' }).note;
  const moon = createImagery(db, { name: '月亮' });
  const u1 = createImageryUse(db, { imageryId: moon.id, targetType: 'work', targetId: w1.id, quote: '床前明月光' });
  createImageryUse(db, { imageryId: moon.id, targetType: 'work', targetId: w2.id });
  createImageryUse(db, { imageryId: moon.id, targetType: 'note', targetId: n1.id });

  const detail = getImagery(db, moon.id);
  assert.equal(detail.imagery.id, moon.id);
  assert.equal(detail.uses.length, 3);
  assert.ok(detail.uses.some((u) => u.id === u1.id));
  assert.equal(detail.works.length, 2);
  const w1Group = detail.works.find((x) => x.work.id === w1.id);
  assert.deepEqual(w1Group.uses.map((u) => u.id), [u1.id]);
  assert.equal(detail.notes.length, 1);
  assert.equal(detail.notes[0].note.id, n1.id);
  assert.equal(detail.notes[0].uses.length, 1);
  assert.deepEqual(detail.counts, { works: 2, notes: 1, uses: 3, quotes: 1 });
  assert.throws(() => getImagery(db, 'im_none'), (e) => e.code === 'NOT_FOUND' && /意象不存在/.test(e.message));

  // filterImageryWorks 的筛选并入：按作者筛关联作品
  const onlyLi = getImagery(db, moon.id, { author: '李白' });
  assert.deepEqual(onlyLi.works.map((x) => x.work.id), [w1.id]);
  assert.equal(onlyLi.counts.works, 1);
});

/* ------------------------------------------------------------------ */
/* 影响计算与删除                                                      */
/* ------------------------------------------------------------------ */

test('imageryImpact：uses/works/notes 计数与 ID 清单', () => {
  const db = setup();
  const w1 = createWork(db, { title: '静夜思' });
  const w2 = createWork(db, { title: '春望' });
  const n1 = createNote(db, { title: '札记' }).note;
  const moon = createImagery(db, { name: '月亮' });
  createImageryUse(db, { imageryId: moon.id, targetType: 'work', targetId: w1.id });
  createImageryUse(db, { imageryId: moon.id, targetType: 'work', targetId: w2.id });
  createImageryUse(db, { imageryId: moon.id, targetType: 'work', targetId: w1.id });
  createImageryUse(db, { imageryId: moon.id, targetType: 'note', targetId: n1.id });
  assert.deepEqual(imageryImpact(db, moon.id), {
    uses: 4, works: 2, notes: 1,
    workIds: [w1.id, w2.id], noteIds: [n1.id],
  });
  assert.deepEqual(imageryImpact(db, 'im_none'), { uses: 0, works: 0, notes: 0, workIds: [], noteIds: [] });
});

test('deleteImagery：连带删全部 uses，作品与札记不受影响，再删报 NOT_FOUND', () => {
  const db = setup();
  const w = createWork(db, { title: '静夜思' });
  const n = createNote(db, { title: '札记' }).note;
  const fall = createImagery(db, { name: '落花' });
  const u1 = createImageryUse(db, { imageryId: fall.id, targetType: 'work', targetId: w.id, quote: '花落知多少' });
  const u2 = createImageryUse(db, { imageryId: fall.id, targetType: 'note', targetId: n.id });
  const r = deleteImagery(db, fall.id);
  assert.equal(r.id, fall.id);
  assert.deepEqual(r.removed, { uses: 2, works: 1, notes: 1, workIds: [w.id], noteIds: [n.id] });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM imagery WHERE id=?').get(fall.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM imagery_uses WHERE id=?').get(u1.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM imagery_uses WHERE id=?').get(u2.id).n, 0);
  // 作品与札记本身还在
  assert.equal(getWork(db, w.id).work.id, w.id);
  assert.equal(getNote(db, n.id).note.id, n.id);
  assert.throws(() => deleteImagery(db, fall.id), (e) => e.code === 'NOT_FOUND');
});

/* ------------------------------------------------------------------ */
/* 合并                                                                */
/* ------------------------------------------------------------------ */

test('mergeImagery：uses 改挂 to（revision+1、updatedAt 更新），from 标记合并并隐藏', () => {
  const db = setup();
  const w = createWork(db, { title: '静夜思' });
  const from = createImagery(db, { name: '霜' });
  const to = createImagery(db, { name: '月' });
  const u1 = createImageryUse(db, { imageryId: from.id, targetType: 'work', targetId: w.id, quote: '疑是地上霜' });
  const u2 = createImageryUse(db, { imageryId: from.id, targetType: 'work', targetId: w.id });
  backdateUse(db, u1.id, '2020-01-01T00:00:00.000Z');

  assert.throws(() => mergeImagery(db, from.id, from.id), (e) => e.code === 'INVALID' && /不能合并到它自己/.test(e.message));
  assert.throws(() => mergeImagery(db, from.id, 'im_none'), (e) => e.code === 'NOT_FOUND' && /要合并的意象不存在/.test(e.message));
  assert.throws(() => mergeImagery(db, 'im_none', to.id), (e) => e.code === 'NOT_FOUND');

  const r = mergeImagery(db, from.id, to.id);
  assert.equal(r.movedUses, 2);
  assert.equal(r.from.mergedInto, to.id);
  assert.equal(r.from.revision, 2);
  assert.equal(r.to.revision, 1); // to 不动
  // uses 全部改挂 to
  const row = useRowById(db, u1.id);
  const u = JSON.parse(row.payload);
  assert.equal(u.imageryId, to.id);
  assert.equal(u.revision, 2);
  assert.ok(u.updatedAt > '2020-01-01T00:00:00.000Z');
  assert.equal(row.imagery_id, to.id);
  assert.equal(row.revision, 2);
  assert.equal(JSON.parse(useRowById(db, u2.id).payload).imageryId, to.id);
  // to 的详情收下两条 uses；from 默认隐藏但按 id 仍可取
  assert.equal(getImagery(db, to.id).uses.length, 2);
  assert.equal(getImagery(db, from.id).imagery.mergedInto, to.id);
  assert.equal(listImagery(db).entries.map((e) => e.imagery.name).indexOf('霜'), -1);
});

/* ------------------------------------------------------------------ */
/* 使用记录 CRUD                                                       */
/* ------------------------------------------------------------------ */

test('createImageryUse：意象与目标校验、targetType 白名单、function 归一化到 fn', () => {
  const db = setup();
  const im = createImagery(db, { name: '月亮' });
  const w = createWork(db, { title: '静夜思' });
  const n = createNote(db, { title: '札记' }).note;
  assert.throws(() => createImageryUse(db, { targetType: 'work', targetId: w.id }), (e) => e.code === 'INVALID' && /要关联一个意象/.test(e.message));
  assert.throws(() => createImageryUse(db, { imageryId: 'im_none', targetType: 'work', targetId: w.id }), (e) => e.code === 'NOT_FOUND' && /意象不存在/.test(e.message));
  assert.throws(() => createImageryUse(db, { imageryId: im.id, targetType: 'work' }), (e) => e.code === 'INVALID' && /缺少作品或札记 ID/.test(e.message));
  assert.throws(() => createImageryUse(db, { imageryId: im.id, targetType: 'poem', targetId: w.id }), (e) => e.code === 'INVALID');
  assert.throws(() => createImageryUse(db, { imageryId: im.id, targetType: 'work', targetId: 'w_none' }), (e) => e.code === 'NOT_FOUND' && /作品不存在/.test(e.message));
  assert.throws(() => createImageryUse(db, { imageryId: im.id, targetType: 'note', targetId: 'n_none' }), (e) => e.code === 'NOT_FOUND' && /札记不存在/.test(e.message));

  const u = createImageryUse(db, {
    imageryId: im.id,
    targetType: 'work',
    targetId: w.id,
    quote: ' 床前明月光 ',
    function: '以月衬乡愁',
    context: '客夜难眠',
    understanding: '见月怀乡',
    claims: [{ text: '异文待核' }],
  });
  assert.match(u.id, /^iu_/);
  assert.equal(u.imageryId, im.id);
  assert.equal(u.targetType, 'work');
  assert.equal(u.targetId, w.id);
  // quote/context 照词间 makeImageryUse 用 str 直转，不 trim
  assert.equal(u.quote, ' 床前明月光 ');
  assert.equal(u.context, '客夜难眠');
  // 跨计划契约：入参 function 归一化为 payload 字段 fn，且不再有 function 键
  assert.equal(u.fn, '以月衬乡愁');
  assert.equal('function' in u, false);
  assert.equal(u.understanding, '见月怀乡');
  assert.equal(u.claims.length, 1);
  assert.equal(u.revision, 1);
  assert.deepEqual(Object.keys(u).sort(),
    ['claims', 'citations', 'context', 'createdAt', 'fn', 'id', 'imageryId', 'quote', 'revision', 'targetId', 'targetType', 'understanding', 'updatedAt'].sort());
  // fn 直传同样接受；note 目标可用
  const u2 = createImageryUse(db, { imageryId: im.id, targetType: 'note', targetId: n.id, fn: '札记里以月收束' });
  assert.equal(u2.targetType, 'note');
  assert.equal(u2.fn, '札记里以月收束');
  // 标量列同步
  const row = useRowById(db, u.id);
  assert.equal(row.imagery_id, im.id);
  assert.equal(row.target_type, 'work');
  assert.equal(row.target_id, w.id);
  assert.equal(row.updated_at, u.updatedAt);
});

test('listImageryUses：按目标取全部使用记录，目标与类型校验', () => {
  const db = setup();
  const im = createImagery(db, { name: '月亮' });
  const other = createImagery(db, { name: '芳草' });
  const w = createWork(db, { title: '静夜思' });
  const n = createNote(db, { title: '札记' }).note;
  createImageryUse(db, { imageryId: im.id, targetType: 'work', targetId: w.id, quote: '床前明月光' });
  createImageryUse(db, { imageryId: other.id, targetType: 'work', targetId: w.id });
  createImageryUse(db, { imageryId: im.id, targetType: 'note', targetId: n.id });

  assert.throws(() => listImageryUses(db, { targetType: 'poem', targetId: w.id }), (e) => e.code === 'INVALID');
  assert.throws(() => listImageryUses(db, { targetType: 'work' }), (e) => e.code === 'INVALID');
  assert.throws(() => listImageryUses(db, { targetType: 'work', targetId: 'w_none' }), (e) => e.code === 'NOT_FOUND' && /作品不存在/.test(e.message));
  assert.throws(() => listImageryUses(db, { targetType: 'note', targetId: 'n_none' }), (e) => e.code === 'NOT_FOUND' && /札记不存在/.test(e.message));
  const workUses = listImageryUses(db, { targetType: 'work', targetId: w.id });
  assert.equal(workUses.length, 2); // 跨意象的全部使用
  assert.ok(workUses.every((u) => u.targetType === 'work' && u.targetId === w.id));
  assert.equal(listImageryUses(db, { targetType: 'note', targetId: n.id }).length, 1);
});

test('updateImageryUse / deleteImageryUse：字段合并、CAS、NOT_FOUND', () => {
  const db = setup();
  const im = createImagery(db, { name: '月亮' });
  const w = createWork(db, { title: '静夜思' });
  const u = createImageryUse(db, { imageryId: im.id, targetType: 'work', targetId: w.id, quote: '旧句', context: '旧情境', understanding: '旧理解' });
  const u2 = updateImageryUse(db, u.id, {
    quote: '新句', function: '新作用', context: '新情境', understanding: '新理解',
    claims: [{ text: '新注', kind: 'personal' }],
  });
  assert.equal(u2.quote, '新句');
  assert.equal(u2.fn, '新作用'); // 更新同样接受 function 别名
  assert.equal(u2.context, '新情境');
  assert.equal(u2.understanding, '新理解');
  assert.equal(u2.claims.length, 1);
  // 挂载关系不可改
  assert.equal(u2.imageryId, im.id);
  assert.equal(u2.targetId, w.id);
  assert.equal(u2.revision, 2);
  assert.throws(
    () => updateImageryUse(db, u.id, { quote: 'x' }, { baseRevision: u.revision }),
    (e) => e instanceof StoreError && e.code === 'CONFLICT' && /这条使用记录在别处被改过/.test(e.message),
  );
  const forced = updateImageryUse(db, u.id, { quote: '强制' }, { baseRevision: u.revision, force: true });
  assert.equal(forced.quote, '强制');
  assert.equal(forced.revision, 3); // 创建 1 → 更新 2 → 冲突不推进 → 强制 3
  assert.throws(() => updateImageryUse(db, 'iu_none', { quote: 'x' }), (e) => e.code === 'NOT_FOUND' && /这条记录不存在/.test(e.message));

  assert.deepEqual(deleteImageryUse(db, u.id), { id: u.id });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM imagery_uses WHERE id=?').get(u.id).n, 0);
  assert.throws(() => deleteImageryUse(db, u.id), (e) => e.code === 'NOT_FOUND');
});

/* ------------------------------------------------------------------ */
/* 双作品对照                                                          */
/* ------------------------------------------------------------------ */

test('compareImagery：shared/onlyA/onlyB 与各自的 uses 分组', () => {
  const db = setup();
  const a = createWork(db, { title: '静夜思' });
  const b = createWork(db, { title: '春望' });
  const moon = createImagery(db, { name: '月亮' });
  const fall = createImagery(db, { name: '落花' });
  const grass = createImagery(db, { name: '芳草' });
  const ma = createImageryUse(db, { imageryId: moon.id, targetType: 'work', targetId: a.id, quote: '床前明月光' });
  const mb = createImageryUse(db, { imageryId: moon.id, targetType: 'work', targetId: b.id, quote: '月是故乡明' });
  const fa = createImageryUse(db, { imageryId: fall.id, targetType: 'work', targetId: a.id });
  createImageryUse(db, { imageryId: grass.id, targetType: 'work', targetId: b.id });

  const r = compareImagery(db, a.id, b.id);
  assert.equal(r.shared.length, 1);
  assert.equal(r.shared[0].imagery.id, moon.id);
  assert.equal(r.shared[0].imagery.name, '月亮');
  assert.deepEqual(r.shared[0].usesA.map((u) => u.id), [ma.id]);
  assert.deepEqual(r.shared[0].usesB.map((u) => u.id), [mb.id]);
  assert.deepEqual(r.onlyA.map((x) => x.imagery.id), [fall.id]);
  assert.deepEqual(r.onlyA[0].usesA.length, 1);
  assert.deepEqual(r.onlyB.map((x) => x.imagery.id), [grass.id]);
  assert.deepEqual(r.onlyB[0].usesB.length, 1);
  // 无关联的作品：三组皆空（不校验作品存在，照词间语义）
  const empty = compareImagery(db, 'w_none1', 'w_none2');
  assert.deepEqual(empty, { shared: [], onlyA: [], onlyB: [] });
});

/* ------------------------------------------------------------------ */
/* getWork / getNote 详情装配                                          */
/* ------------------------------------------------------------------ */

test('getWork/getNote 装配 imagery entries：按意象分组含真实 uses，allusions 占位', () => {
  const db = setup();
  const w = createWork(db, { title: '静夜思' });
  const n = createNote(db, { title: '读静夜思' }).note;
  const moon = createImagery(db, { name: '月亮' });
  const um1 = createImageryUse(db, { imageryId: moon.id, targetType: 'work', targetId: w.id, quote: '床前明月光' });
  const um2 = createImageryUse(db, { imageryId: moon.id, targetType: 'work', targetId: w.id, quote: '疑是地上霜' });
  createImageryUse(db, { imageryId: moon.id, targetType: 'note', targetId: n.id, quote: '札记里的月' });

  const wd = getWork(db, w.id);
  assert.equal(wd.imagery.entries.length, 1);
  assert.equal(wd.imagery.entries[0].imagery.id, moon.id);
  assert.deepEqual(wd.imagery.entries[0].uses.map((u) => u.id).sort(), [um1.id, um2.id].sort());
  assert.deepEqual(wd.imagery.allusions, { entries: [] }); // Task 7 接线
  // 无关联的作品 entries 为空
  const w2 = createWork(db, { title: '春晓' });
  assert.deepEqual(getWork(db, w2.id).imagery.entries, []);

  const nd = getNote(db, n.id);
  assert.equal(nd.imagery.entries.length, 1);
  assert.equal(nd.imagery.entries[0].imagery.id, moon.id);
  assert.equal(nd.imagery.entries[0].uses.length, 1);
  assert.equal(nd.imagery.entries[0].uses[0].quote, '札记里的月');
  assert.deepEqual(nd.imagery.allusions, { entries: [] });

  // 合并后：霜的 uses 并入月亮，entries 只剩月亮一组
  const frost = createImagery(db, { name: '霜' });
  createImageryUse(db, { imageryId: frost.id, targetType: 'work', targetId: w.id });
  mergeImagery(db, frost.id, moon.id);
  const wd2 = getWork(db, w.id);
  assert.equal(wd2.imagery.entries.length, 1);
  assert.equal(wd2.imagery.entries[0].imagery.id, moon.id);
  assert.equal(wd2.imagery.entries[0].uses.length, 3);
});
