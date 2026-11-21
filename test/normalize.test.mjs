import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClaims, normalizeUsages, normalizeAliases, sameContent, excerptOfNote, plainText } from '../server/core/normalize.mjs';
import { newId, derivedId } from '../server/core/ids.mjs';

test('verified claim 无出处报错', () => {
  assert.throws(() => normalizeClaims([{ kind: 'verified', text: 'x' }]), /已核实/);
});
test('claim 归一化补 id 与默认值', () => {
  const [c] = normalizeClaims([{ text: '系年待查', paragraph: 2, citations: [{ book: '全宋词' }] }]);
  assert.equal(c.kind, 'pending'); assert.equal(c.paragraph, 2);
  assert.match(c.id, /^cl_/);
  assert.equal(c.citations[0].verified, 'pending');
});
test('usages 字符串转对象；aliases 剔除主名', () => {
  assert.deepEqual(normalizeUsages(['蟾宫折桂', { text: '折桂', kind: 'verified' }]),
    [{ text: '蟾宫折桂', kind: 'pending' }, { text: '折桂', kind: 'verified' }]);
  assert.deepEqual(normalizeAliases('玉兔、月轮, 月亮 月亮', '月亮'), ['玉兔', '月轮']);
});
test('sameContent 忽略 updatedAt/revision', () => {
  assert.ok(sameContent({ id: 'a', title: 't', updatedAt: '1', revision: 3 }, { id: 'a', title: 't', updatedAt: '9', revision: 8 }));
  assert.ok(!sameContent({ id: 'a', title: 't' }, { id: 'a', title: 'x' }));
});
test('excerptOfNote 与 plainText', () => {
  assert.equal(excerptOfNote({ content: '', pendingImport: true }), '（正文待导入）');
  assert.equal(plainText('## 标题\n**粗**体'), '标题粗体');
});
test('id 生成稳定', () => {
  assert.match(newId('w_'), /^w_[0-9a-f]{12}$/);
  assert.equal(derivedId('w_', 'a', 'b'), derivedId('w_', 'a', 'b'));
  assert.notEqual(derivedId('w_', 'a', 'b'), derivedId('w_', 'a', 'c'));
});
test('claims 锚点：quote 非空保留，prefix/suffix 各截 16 字', () => {
  const [c] = normalizeClaims([{
    text: '注',
    paragraph: 0,
    anchor: { quote: '  菩萨蛮  ', prefix: '一字一行一' + 'x'.repeat(20), suffix: '。' + 'y'.repeat(20) },
  }]);
  assert.equal(c.anchor.quote, '菩萨蛮');
  assert.equal(c.anchor.prefix.length, 16);
  assert.equal(c.anchor.suffix, '。' + 'y'.repeat(15));
});

test('claims 锚点：quote 为空或 anchor 非对象则丢弃', () => {
  const [a] = normalizeClaims([{ text: 'x', anchor: { quote: '   ' } }]);
  const [b] = normalizeClaims([{ text: 'x', anchor: 'nope' }]);
  assert.equal(a.anchor, undefined);
  assert.equal(b.anchor, undefined);
});

test('claims 锚点：旧数据无 anchor 字段不受影响', () => {
  const [c] = normalizeClaims([{ text: '系年待查', paragraph: 2 }]);
  assert.equal(c.anchor, undefined);
});
