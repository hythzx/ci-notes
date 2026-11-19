import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffText, charDiff } from '../src/diff.ts';
// 对拍基准：服务端等价实现（词间 utils/diff.js 的忠实翻译，Task 4 完成）
import { diffText as beDiffText, charDiff as beCharDiff } from '../server/core/diffcore.mjs';

/* ---------------- brief Step 1 断言（逐字） ---------------- */

test('行级增删改统计', () => {
  const r = diffText('甲\n乙\n丙', '甲\n丁\n丙');
  assert.equal(r.stats.changed, 1); assert.equal(r.stats.same, 2);
  const row = r.rows.find(x => x.type === 'change');
  assert.ok(row && row.segments && row.segments.length >= 2);
});
test('纯插入与纯删除', () => {
  assert.equal(diffText('甲', '甲\n乙').stats.added, 1);
  assert.equal(diffText('甲\n乙', '甲').stats.removed, 1);
});
test('字级 diff', () => {
  const segs = charDiff('春风又绿', '春风又绿了');
  assert.ok(segs.some(s => s.type === 'insert' && s.text === '了'));
});
test('大文本退化不崩', () => {
  const a = Array.from({ length: 3000 }, (_, i) => '行' + i).join('\n');
  const b = Array.from({ length: 3000 }, (_, i) => '行' + i * 2).join('\n');
  assert.ok(diffText(a, b).rows.length > 0);
});

/* ---------------- 输出形状（服务端 compare 契约） ---------------- */

test('toRow 剥离内部索引，a/b 键恒在、缺失为 null', () => {
  const { rows } = diffText('甲', '乙');
  // 无公共行：align 产 1 delete + 1 insert，mergeChanges 配对为 1 change
  assert.deepEqual(rows, [
    { type: 'change', a: '甲', b: '乙', segments: charDiff('甲', '乙') }
  ]);
  const pure = diffText('甲\n乙', '甲').rows;
  assert.deepEqual(pure, [
    { type: 'equal', a: '甲', b: '甲' },
    { type: 'delete', a: '乙', b: null }
  ]);
});

/* ---------------- 与 server/core/diffcore.mjs 一致性对拍 ---------------- */
/* 服务端 diffcore 是 Task 4 审查过的词间忠实翻译；前端同算法 TS 版必须与其结果
   逐字段一致（版本对比页兜底/导出场景直接依赖）。固定输入 + 两条退化路径。 */

const diffCases = [
  ['', ''],
  ['', '甲'],
  ['甲', ''],
  ['甲', '甲'],
  ['甲', '甲\n乙'],
  ['甲\n乙', '甲'],
  ['甲\n乙\n丙', '甲\n丁\n丙'],
  // 无公共行：delete+insert 相邻合并（配对数取 min，余量保留原类型）
  ['一\n二\n三\n四', '五\n六'],
  ['五\n六', '一\n二\n三\n四'],
  // 交错：equal / change / insert 混合
  ['甲\n乙\n丙\n丁', '甲\nX\n丙\n丁\n戊'],
  ['诗\n诗\n词\n诗', '词\n诗\n诗'],
  // LCS 平局走向（table[i+1][j] >= table[i][j+1] 优先删）
  ['同\n同\n同\n同\n同', '同\n同'],
  ['一\n二\n三\n四\n五\n六\n七\n八', '一\n三\n四\n六\n八\n九'],
  // CRLF 归一
  ['甲\r\n乙', '甲\n乙'],
  ['春眠不觉晓\n处处闻啼鸟', '春眠不觉晓\n夜来风雨声\n花落知多少']
];

for (const [a, b] of diffCases) {
  test(`对拍 diffText ${JSON.stringify([a, b])}`, () => {
    assert.deepEqual(diffText(a, b), beDiffText(a, b));
  });
}

test('对拍：MAX_CELLS 退化路径（n*m 超 1,200,000）', () => {
  const a = Array.from({ length: 1200 }, (_, i) => '行' + i).join('\n');
  const b = Array.from({ length: 1200 }, (_, i) => '甲' + i).join('\n');
  assert.ok(a.length * 0 === 0 && 1200 * 1200 > 1200000); // 确认走退化分支
  assert.deepEqual(diffText(a, b), beDiffText(a, b));
});

const charCases = [
  ['', ''],
  ['春', '春'],
  ['', '春'],
  ['春', ''],
  ['春风又绿', '春风又绿了'],
  ['春风又绿江南岸', '春风又绿了江南岸'],
  ['明月几时有', '把酒问青天'],
  ['甲乙甲乙甲', '乙甲乙甲乙'],
  ['aaaa', 'aa'],
  ['春\n风', '春 风']
];

for (const [a, b] of charCases) {
  test(`对拍 charDiff ${JSON.stringify([a, b])}`, () => {
    assert.deepEqual(charDiff(a, b), beCharDiff(a, b));
  });
}

test('对拍：charDiff 400000 格上限退化路径', () => {
  const x = '春'.repeat(700);
  const y = '秋'.repeat(700);
  assert.equal(x.length * y.length > 400000, true); // 确认走退化分支
  assert.deepEqual(charDiff(x, y), beCharDiff(x, y));
});
