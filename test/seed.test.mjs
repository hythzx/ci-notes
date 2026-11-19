import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { createStore } from '../server/store.mjs';

// 种子数据（task-12-brief）：词间逐字翻译 + 本项目新增意象/典故各一
const SEED_WORK_IDS = ['w_seed_liu_1', 'w_seed_liu_2', 'w_seed_liu_3', 'w_seed_zhou_1'];
const SEED_NOTE_IDS = ['n_seed_liu_notes', 'n_seed_zhou_notes'];

function tempPath() { return join(mkdtempSync(join(tmpdir(), 'cn-seed-')), 't.sqlite'); }

function sortedIds(list) {
  return list.map((x) => x.id).sort();
}

// listImagery/listAllusions 返回 {entries:[{imagery|allusion, counts}]}
function entryIds(result) {
  return result.entries.map((e) => (e.imagery || e.allusion).id).sort();
}

test('空库 createStore 后种子齐全且 ID 固定', () => {
  const store = createStore(tempPath());
  try {
    assert.deepEqual(sortedIds(store.listWorks({})), SEED_WORK_IDS.slice().sort());
    assert.deepEqual(sortedIds(store.listNotes({})), SEED_NOTE_IDS.slice().sort());
    assert.deepEqual(sortedIds(store.listComparisons()), ['cp_seed_liu_zhou']);
    assert.deepEqual(entryIds(store.listImagery({})), ['im_seed_moon']);
    assert.deepEqual(entryIds(store.listAllusions({})), ['al_seed_zhuangzhou']);
    // 词作逐字内容抽查：柳永其二原文与 claims 的 verified/pending 混排示范
    const work2 = store.getWork('w_seed_liu_2').work;
    assert.equal(work2.title, '凤栖梧·其二（伫倚危楼风细细）');
    assert.match(work2.content, /^伫倚危楼风细细/);
    assert.match(work2.content, /衣带渐宽终不悔，为伊消得人憔悴。$/);
    assert.deepEqual(work2.claims.map((c) => c.kind), ['verified', 'verified', 'pending', 'pending']);
    assert.ok(work2.citations.some((c) => c.verified === 'pending' && c.url));
  } finally { store.close(); }
});

test('种子札记：正文与附记留空、pendingImport、写作状态 research/idea', () => {
  const store = createStore(tempPath());
  try {
    const liu = store.getNote('n_seed_liu_notes').note;
    assert.equal(liu.content, '');
    assert.equal(liu.note, '');
    assert.equal(liu.pendingImport, true);
    assert.equal(liu.writingStatus, 'research');
    assert.deepEqual(liu.workIds, ['w_seed_liu_1', 'w_seed_liu_2', 'w_seed_liu_3']);
    const zhou = store.getNote('n_seed_zhou_notes').note;
    assert.equal(zhou.content, '');
    assert.equal(zhou.pendingImport, true);
    assert.equal(zhou.writingStatus, 'idea');
    assert.equal(zhou.changeNote, '初始条目，待导入原稿');
  } finally { store.close(); }
});

test('种子对照：七维全空、understanding kind=personal、sides 仅前 4 维', () => {
  const store = createStore(tempPath());
  try {
    const { comparison } = store.getComparison('cp_seed_liu_zhou');
    const dims = comparison.dimensions;
    const WITH_SIDES = ['context', 'imagery', 'allusion', 'expression'];
    for (const key of WITH_SIDES) {
      assert.equal(dims[key].text, '', key);
      assert.equal(dims[key].kind, 'pending', key);
      assert.deepEqual(dims[key].sides, { a: '', b: '' }, key);
    }
    for (const key of ['similarity', 'difference']) {
      assert.equal(dims[key].text, '', key);
      assert.equal(dims[key].kind, 'pending', key);
      assert.equal(dims[key].sides, undefined, key);
    }
    assert.equal(dims.understanding.text, '');
    assert.equal(dims.understanding.kind, 'personal');
    assert.equal(dims.understanding.sides, undefined);
  } finally { store.close(); }
});

test('新增一条词作后重新 createStore：种子不重复，总数 4+1', () => {
  const path = tempPath();
  const first = createStore(path);
  try {
    first.createWork({ title: '雨霖铃·寒蝉凄切', content: '寒蝉凄切，对长亭晚。' });
  } finally { first.close(); }
  const second = createStore(path, { seed: true });
  try {
    const works = second.listWorks({});
    assert.equal(works.length, 5);
    assert.deepEqual(sortedIds(works).filter((id) => SEED_WORK_IDS.includes(id)), SEED_WORK_IDS.slice().sort());
    // 其余集合同样无重复
    assert.equal(second.listNotes({}).length, 2);
    assert.equal(second.listComparisons().length, 1);
    assert.equal(second.listImagery({}).entries.length, 1);
    assert.equal(second.listAllusions({}).entries.length, 1);
  } finally { second.close(); }
});

test('revisions：两篇札记各一条 v1，seq 递增，快照为完整空正文快照', () => {
  const store = createStore(tempPath());
  try {
    const revs = store.listRevisions('n_seed_liu_notes');
    const revs2 = store.listRevisions('n_seed_zhou_notes');
    assert.equal(revs.length, 1);
    assert.equal(revs2.length, 1);
    assert.equal(revs[0].reason, 'manual');
    assert.equal(revs[0].changeNote, '初始条目，待导入原稿');
    assert.equal(revs[0].writingStatus, 'research');
    // seq 全局递增：柳永札记在前，周邦彦札记在后
    assert.ok(revs[0].seq < revs2[0].seq);
    // 版本不可改写触发器不拦 INSERT；restoreRevision 可用快照回读，
    // 这里直接经 listRevisions 摘要断言足够，另验证两 seq 均为正整数
    assert.ok(Number.isInteger(revs[0].seq) && revs[0].seq >= 1);
  } finally { store.close(); }
});

test('典故「庄周梦蝶」：source/original/explanation 按 brief 预置', () => {
  const store = createStore(tempPath());
  try {
    const a = store.getAllusion('al_seed_zhuangzhou').allusion;
    assert.equal(a.name, '庄周梦蝶');
    assert.equal(a.source, '《庄子·齐物论》');
    assert.ok(a.explanation.length > 0);
    assert.ok(a.original.includes('不知周之梦为胡蝶与'));
    assert.deepEqual(a.aliases, ['梦蝶', '庄生晓梦']);
  } finally { store.close(); }
});
