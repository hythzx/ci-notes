import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.mjs';
import { createWork } from '../server/core/works.mjs';
import {
  COMPARE_DIMENSIONS, SIDE_DIMENSIONS, emptyDimensions,
  listComparisons, getComparison, saveComparison, deleteComparison,
} from '../server/core/comparisons.mjs';
import { StoreError } from '../server/core/errors.mjs';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';

function setup() { return openDb(join(mkdtempSync(join(tmpdir(), 'cn-')), 't.sqlite')); }

/* ------------------------------------------------------------------ */
/* 常量与空维度模板                                                    */
/* ------------------------------------------------------------------ */

test('COMPARE_DIMENSIONS 与 SIDE_DIMENSIONS 常量', () => {
  assert.deepEqual(COMPARE_DIMENSIONS, [
    ['context', '人物与情境'],
    ['imagery', '意象'],
    ['allusion', '典故及出处'],
    ['expression', '表达方式'],
    ['similarity', '相同点'],
    ['difference', '不同点'],
    ['understanding', '自己的阅读理解'],
  ]);
  assert.deepEqual(SIDE_DIMENSIONS, ['context', 'imagery', 'allusion', 'expression']);
});

test('emptyDimensions 七维全空，sides 仅前 4 维，understanding 默认 personal', () => {
  const dims = emptyDimensions();
  assert.deepEqual(Object.keys(dims), COMPARE_DIMENSIONS.map(([k]) => k));
  for (const [key] of COMPARE_DIMENSIONS) {
    const dim = dims[key];
    assert.deepEqual({ text: dim.text, kind: dim.kind, citations: dim.citations }, { text: '', kind: key === 'understanding' ? 'personal' : 'pending', citations: [] });
    if (SIDE_DIMENSIONS.indexOf(key) >= 0) {
      assert.deepEqual(dim.sides, { a: '', b: '' });
    } else {
      assert.equal(dim.sides, undefined);
    }
  }
  // 两次调用互不共享引用
  dims.context.citations.push({ book: 'x' });
  assert.deepEqual(emptyDimensions().context.citations, []);
});

/* ------------------------------------------------------------------ */
/* 新建与维度归一化                                                    */
/* ------------------------------------------------------------------ */

test('新建对照：维度归一化、未知维度丢弃、标量列落库', () => {
  const db = setup();
  const a = createWork(db, { title: '凤栖梧', author: '柳永' });
  const b = createWork(db, { title: '浣溪沙', author: '周邦彦' });
  const c = saveComparison(db, {
    title: '  柳永对照周邦彦  ',
    workAId: a.id,
    workBId: b.id,
    dimensions: {
      context: { text: '  都是羁旅思乡  ', kind: 'verified', citations: [{ book: ' 乐章集 ', verified: 'nonsense' }], sides: { a: ' 柳永 ', b: '周邦彦 ' } },
      similarity: { text: '同样写秋景', kind: 'bogus', sides: { a: '不该有', b: '不该有' } },
      understanding: { text: '我的理解' },
      unknownDim: { text: '应被丢弃' },
    },
  });
  assert.match(c.id, /^cp_/);
  assert.equal(c.title, '柳永对照周邦彦');
  // 七维齐全，未知维度 key 丢弃
  assert.deepEqual(Object.keys(c.dimensions).sort(), Object.keys(emptyDimensions()).sort());
  assert.equal(c.dimensions.unknownDim, undefined);
  // text/sides trim；citation 归一化（trim、verified 回落 pending、生成 id）
  const ctx = c.dimensions.context;
  assert.equal(ctx.text, '都是羁旅思乡');
  assert.deepEqual(ctx.sides, { a: '柳永', b: '周邦彦' });
  assert.equal(ctx.citations.length, 1);
  assert.match(ctx.citations[0].id, /^ct_/);
  assert.equal(ctx.citations[0].book, '乐章集');
  assert.equal(ctx.citations[0].verified, 'pending');
  assert.equal(c.createdAt, c.updatedAt);
  // 后 3 维无 sides；kind 白名单外回落默认（understanding=personal，其余=pending）
  assert.equal(c.dimensions.similarity.sides, undefined);
  assert.equal(c.dimensions.similarity.text, '同样写秋景');
  assert.equal(c.dimensions.similarity.kind, 'pending');
  assert.equal(c.dimensions.understanding.sides, undefined);
  assert.equal(c.dimensions.understanding.kind, 'personal');
  // 未提及的维度保持空模板
  assert.equal(c.dimensions.imagery.text, '');
  assert.deepEqual(c.dimensions.imagery.sides, { a: '', b: '' });
  // 标量冗余列同步
  const row = db.prepare('SELECT work_a_id, work_b_id, updated_at FROM comparisons WHERE id=?').get(c.id);
  assert.equal(row.work_a_id, a.id);
  assert.equal(row.work_b_id, b.id);
  assert.equal(row.updated_at, c.updatedAt);
});

test('甲乙作品校验：缺失报 INVALID，同一首报「同一首」', () => {
  const db = setup();
  const a = createWork(db, { title: '凤栖梧' });
  const b = createWork(db, { title: '浣溪沙' });
  assert.throws(
    () => saveComparison(db, { workAId: 'w_none', workBId: b.id }),
    (e) => e instanceof StoreError && e.code === 'INVALID' && /甲侧词作不存在/.test(e.message),
  );
  assert.throws(
    () => saveComparison(db, { workAId: a.id, workBId: 'w_none' }),
    (e) => e instanceof StoreError && e.code === 'INVALID' && /乙侧词作不存在/.test(e.message),
  );
  assert.throws(() => saveComparison(db, { workAId: a.id, workBId: a.id }), /同一首/);
});

/* ------------------------------------------------------------------ */
/* 更新整体覆盖                                                        */
/* ------------------------------------------------------------------ */

test('更新整体覆盖：dimensions 重建，留空字段回落原值，列同步', () => {
  const db = setup();
  const a = createWork(db, { title: '凤栖梧' });
  const b = createWork(db, { title: '浣溪沙' });
  const b2 = createWork(db, { title: '少年游' });
  const c1 = saveComparison(db, {
    title: '初版对照',
    workAId: a.id,
    workBId: b.id,
    dimensions: { context: { text: '旧的人物情境', sides: { a: '甲', b: '乙' } } },
  });
  const c2 = saveComparison(db, {
    id: c1.id,
    title: '  改版对照  ',
    workBId: b2.id,
    dimensions: { imagery: { text: '共同意象：月', sides: { a: '甲侧月', b: '乙侧月' } } },
  });
  assert.equal(c2.id, c1.id);
  assert.equal(c2.title, '改版对照');
  // workAId 未提供回落原值，workBId 更新
  assert.equal(c2.workAId, a.id);
  assert.equal(c2.workBId, b2.id);
  // createdAt 不变，updatedAt 推进
  assert.equal(c2.createdAt, c1.createdAt);
  assert.ok(c2.updatedAt >= c1.updatedAt);
  // 整体覆盖：旧 context 清空，只有新填的 imagery
  assert.equal(c2.dimensions.context.text, '');
  assert.deepEqual(c2.dimensions.context.sides, { a: '', b: '' });
  assert.equal(c2.dimensions.imagery.text, '共同意象：月');
  assert.deepEqual(c2.dimensions.imagery.sides, { a: '甲侧月', b: '乙侧月' });
  assert.deepEqual(Object.keys(c2.dimensions).length, 7);
  // 标量列同步
  const row = db.prepare('SELECT work_a_id, work_b_id FROM comparisons WHERE id=?').get(c1.id);
  assert.equal(row.work_a_id, a.id);
  assert.equal(row.work_b_id, b2.id);
  assert.throws(() => saveComparison(db, { id: 'cp_none', title: 'x' }), /对照笔记不存在/);
});

/* ------------------------------------------------------------------ */
/* 列表与详情装配                                                      */
/* ------------------------------------------------------------------ */

test('listComparisons 摘要带双侧标题，已删作品占位，updatedAt 倒序', () => {
  const db = setup();
  const a = createWork(db, { title: '凤栖梧' });
  const b = createWork(db, { title: '浣溪沙' });
  // 悬空引用由更新路径产生（新建校验存在，更新不做校验，对应词作删除后的悬空状态）
  const c1 = saveComparison(db, { title: '早的', workAId: a.id, workBId: b.id, dimensions: {} });
  saveComparison(db, { id: c1.id, workBId: 'w_gone' });
  const c2 = saveComparison(db, { title: '晚的', workAId: a.id, workBId: b.id, dimensions: {} });
  // 手动把 c1 的 updated_at 拨旧，保证排序断言确定
  db.prepare('UPDATE comparisons SET updated_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', c1.id);
  const items = listComparisons(db);
  assert.deepEqual(items.map((i) => i.id), [c2.id, c1.id]);
  const one = items[0];
  assert.deepEqual(Object.keys(one).sort(),
    ['createdAt', 'id', 'title', 'updatedAt', 'workAId', 'workATitle', 'workBId', 'workBTitle', 'writtenCount'].sort());
  assert.equal(one.title, '晚的');
  assert.equal(one.workATitle, '凤栖梧');
  assert.equal(one.workBTitle, '浣溪沙');
  // 悬空引用的作品显示占位
  assert.equal(items[1].workATitle, '凤栖梧');
  assert.equal(items[1].workBTitle, '（已删除的词作）');
});

test('listComparisons writtenCount：七维中 text 非空（trim 后）计数', () => {
  const db = setup();
  const a = createWork(db, { title: '凤栖梧' });
  const b = createWork(db, { title: '浣溪沙' });
  const empty = saveComparison(db, { title: '全空', workAId: a.id, workBId: b.id, dimensions: {} });
  const c = saveComparison(db, {
    title: '三维已写',
    workAId: a.id,
    workBId: b.id,
    dimensions: {
      context: { text: '情境' },
      imagery: { text: '   ' }, // trim 后为空串，不计入
      allusion: { text: '典故' },
      similarity: { text: '相同点' },
    },
  });
  const byId = new Map(listComparisons(db).map((i) => [i.id, i]));
  assert.equal(byId.get(empty.id).writtenCount, 0);
  assert.equal(byId.get(c.id).writtenCount, 3);
});

test('在册但标题为空的词作不误显示「已删除」占位', () => {
  const db = setup();
  const b = createWork(db, { title: '浣溪沙' });
  // 直接插入一条标题为空的在册词作（绕过 createWork 的「标题或原文必填」校验）
  db.prepare('INSERT INTO works(id,payload,revision,title,author,cipai,kind,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('w_emptytitle', JSON.stringify({ id: 'w_emptytitle', title: '' }), 1, '', '', '', 'ci', new Date().toISOString());
  const c = saveComparison(db, { title: '对照', workAId: 'w_emptytitle', workBId: b.id, dimensions: {} });
  const item = listComparisons(db).find((i) => i.id === c.id);
  assert.equal(item.workATitle, '');
  assert.equal(item.workBTitle, '浣溪沙');
});

test('getComparison 装配 workA/workB，缺失为 null，NOT_FOUND', () => {
  const db = setup();
  const a = createWork(db, { title: '凤栖梧', author: '柳永' });
  const b = createWork(db, { title: '浣溪沙' });
  const c = saveComparison(db, { title: '对照', workAId: a.id, workBId: b.id, dimensions: {} });
  // 乙侧引用置为悬空（更新路径不校验存在，对应词作删除后的状态）
  saveComparison(db, { id: c.id, workBId: 'w_gone' });
  const detail = getComparison(db, c.id);
  assert.equal(detail.comparison.id, c.id);
  assert.equal(detail.comparison.title, '对照');
  assert.equal(detail.workA.title, '凤栖梧');
  assert.equal(detail.workA.author, '柳永');
  assert.equal(detail.workB, null);
  assert.throws(() => getComparison(db, 'cp_none'), (e) => e instanceof StoreError && e.code === 'NOT_FOUND' && /对照笔记不存在/.test(e.message));
});

/* ------------------------------------------------------------------ */
/* 删除                                                                */
/* ------------------------------------------------------------------ */

test('删除直接移除，不进回收站，再删报 NOT_FOUND', () => {
  const db = setup();
  const a = createWork(db, { title: '凤栖梧' });
  const b = createWork(db, { title: '浣溪沙' });
  const c = saveComparison(db, { title: '对照', workAId: a.id, workBId: b.id, dimensions: {} });
  const r = deleteComparison(db, c.id);
  assert.deepEqual(r, { id: c.id });
  assert.equal(listComparisons(db).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trash').get().n, 0);
  assert.throws(() => deleteComparison(db, c.id), /对照笔记不存在/);
});
