import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateAnchor, markRanges } from '../src/annotate.ts';

const A = (quote, prefix = '', suffix = '') => ({ quote, prefix, suffix });
const C = (id, anchor) => ({ id, kind: 'pending', text: '', paragraph: -1, anchor });

test('唯一命中', () => {
  assert.deepEqual(locateAnchor('床前明月光，疑是地上霜', A('明月光')), [2, 5]);
});

test('多次出现靠 prefix 消歧', () => {
  const text = '明月光。夜，明月光。';
  assert.deepEqual(locateAnchor(text, A('明月光', '夜，')), [6, 9]);
});

test('双端匹配优先于靠前的单端', () => {
  assert.deepEqual(locateAnchor('明月光甲明月光乙', A('明月光', '甲', '乙')), [4, 7]);
});

test('有前后文却全失配 → 降级 null', () => {
  assert.equal(locateAnchor('床前明月光', A('明月光', '不存在的上文')), null);
});

test('无前后文取首个命中', () => {
  assert.deepEqual(locateAnchor('明月光。夜，明月光。', A('明月光')), [0, 3]);
});

test('quote 为空 → null', () => {
  assert.equal(locateAnchor('abc', A('')), null);
});

test('markRanges：升序排列', () => {
  const text = '床前明月光，疑是明月光';
  const rs = markRanges([C('b', A('明月光', '疑是')), C('a', A('明月光'))], text);
  assert.deepEqual(rs.map((r) => r.claim.id), ['a', 'b']);
  assert.deepEqual(rs.map((r) => r.start), [2, 8]);
});

test('markRanges：与前者重叠的后一条跳过', () => {
  const text = '床前明月光，疑是明月光';
  const rs = markRanges([C('x', A('明月光')), C('y', A('光，疑'))], text);
  assert.deepEqual(rs.map((r) => r.claim.id), ['x']);
});

test('markRanges：失配条目直接略过', () => {
  const rs = markRanges([C('a', A('没有这句', '上下文'))], '床前明月光');
  assert.deepEqual(rs, []);
});
