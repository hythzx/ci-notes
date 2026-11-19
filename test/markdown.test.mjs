import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plain, paragraphs } from '../src/markdown.ts';

test('plain 去除常见标记', () => {
  // 词间 plain 块间以 '\n' 拼接；brief 断言块级 '' 拼接（与 server plainText 决策一致）
  assert.equal(plain('## 标题\n**粗**体与*斜*体'), '标题粗体与斜体');
  assert.equal(plain('> 引用句'), '引用句');
  // 词间列表项 plain 输出：项内容按 '\n' 拼接，列表符不保留
  assert.equal(plain('- 甲\n- 乙'), '甲\n乙');
  assert.ok(!plain('- 甲\n- 乙').includes('- '));
});
test('paragraphs 按空行分段带序号', () => {
  const p = paragraphs('第一段第一行\n第一段第二行\n\n第二段');
  assert.equal(p.length, 2);
  assert.deepEqual(p[0], ['第一段第一行', '第一段第二行']);
  assert.deepEqual(p[1], ['第二段']);
});
test('claim 段号与段落对齐（核心约束）', () => {
  const text = '段一\n\n段二';
  const p = paragraphs(text);
  assert.equal(p.length, 2); // paragraph=1 → p[1]
  assert.deepEqual(p[1], ['段二']);
});
test('代码块内空行不分段', () => {
  assert.equal(paragraphs('```js\na\n\nb\n```').length, 1);
});
test('paragraphs 边界', () => {
  assert.deepEqual(paragraphs(''), []);
  assert.deepEqual(paragraphs('   \n\n  '), []);
  assert.deepEqual(paragraphs('单段'), [['单段']]);
  // 未闭合围栏到文末，整体算一段
  assert.equal(paragraphs('```js\na\n\nb').length, 1);
});
test('plain 安全与转义（纯字符串行为）', () => {
  // 不安全链接丢地址只留文字（safeHref 白名单）
  assert.equal(plain('[文本](javascript:alert(1))'), '文本');
  // 图片语法降级为 alt 文字
  assert.equal(plain('![图](x.png)'), '图');
  // 原始 HTML 当普通文字
  assert.equal(plain('<b>重</b>'), '<b>重</b>');
  // 转义
  assert.equal(plain('a\\*b'), 'a*b');
  // 段内硬换行保留为换行符（词间 inlineToPlain：br → '\n'）
  assert.equal(plain('a\nb'), 'a\nb');
});
