import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  noteToMarkdown,
  workToMarkdown,
  allusionToMarkdown,
  citationLine,
} from '../src/exporter.ts';

/* ---------------- 测试夹具：最小可用实体 ---------------- */

function citation(over = {}) {
  return {
    id: 'c1', book: '《白氏文集》', edition: '四部丛刊本', page: '卷十二',
    url: '', note: '', verified: 'verified', ...over,
  };
}

function claim(over = {}) {
  return {
    id: 'cl1', kind: 'verified', text: '「绿」字一作「过」，据宋本改', paragraph: 1,
    citations: [citation()], ...over,
  };
}

function work(over = {}) {
  return {
    id: 'w1', kind: 'ci', title: '静夜思', author: '李白', dynasty: '唐',
    cipai: '', content: '床前明月光\n疑是地上霜', background: '作于扬州旅舍。',
    claims: [claim()], citations: [], tags: [], relatedWorkIds: [],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    revision: 1, ...over,
  };
}

function note(over = {}) {
  return {
    id: 'n1', title: '绿字考', content: '王安石此改字历代评家多有论及。', note: '待补《容斋随笔》条目。',
    workIds: ['w1'], claims: [claim({ kind: 'verified', text: '洪迈《容斋随笔》卷八载「改十许字」始末' })],
    citations: [citation({ page: '卷八', note: '中华书局点校本' })], tags: ['炼字'],
    writingStatus: 'draft', publishStatus: 'published',
    publish: { platform: '博客', publishedAt: '2026-02-01', url: 'https://example.com/lv' },
    changeNote: '', createdAt: '2026-01-01T08:00:00Z', updatedAt: '2026-01-02T08:00:00Z',
    revision: 2, ...over,
  };
}

/* ---------------- noteToMarkdown ---------------- */

test('noteToMarkdown：全部节标题与引言状态行', () => {
  const md = noteToMarkdown(note(), [work()]);
  assert.ok(md.startsWith('# 绿字考'));
  for (const heading of ['## 关联原文', '## 正文', '## 附记', '## 资料标注', '## 引用出处']) {
    assert.ok(md.includes(heading), '缺少节标题：' + heading);
  }
  assert.ok(md.includes('写作状态：'));
  assert.ok(md.includes('发布状态：'));
  assert.ok(md.includes('> 发布：博客'));
  // 关联原文：### 标题 + 斜体 meta + 逐行引用块
  assert.ok(md.includes('### 静夜思'));
  assert.ok(md.includes('*李白 · 唐*'));
  assert.ok(md.includes('> 床前明月光'));
  assert.ok(md.includes('> 疑是地上霜'));
});

test('noteToMarkdown：claim 带 [已核实] 标签与出处行', () => {
  const md = noteToMarkdown(note(), []);
  assert.ok(md.includes('- [已核实] 洪迈《容斋随笔》卷八载「改十许字」始末'));
  assert.ok(md.includes('- 出处：《白氏文集》，四部丛刊本，卷十二'));
});

test('noteToMarkdown：引用出处行带可信度标签', () => {
  const md = noteToMarkdown(note(), []);
  assert.ok(md.includes('- 《白氏文集》，四部丛刊本，卷八，中华书局点校本　（已核实）'));
});

test('noteToMarkdown：空正文占位「（正文待导入）」', () => {
  const md = noteToMarkdown(note({ content: '   ' }), []);
  assert.ok(md.includes('（正文待导入）'));
});

test('noteToMarkdown：snapshotRev 生成版本时间行且不透出原始 ISO', () => {
  const md = noteToMarkdown(note(), [], { createdAt: '2026-03-04T05:06:00Z' });
  assert.ok(md.includes('本篇导出版本时间：'));
  assert.ok(!md.includes('2026-03-04T05:06:00Z'));
  // 无 snapshotRev 时无版本行
  assert.ok(!noteToMarkdown(note(), []).includes('本篇导出版本时间'));
});

test('noteToMarkdown：无附记/引用出处时省略对应节；页脚带水印', () => {
  const bare = note({
    content: '正文', note: '', claims: [], citations: [], workIds: [],
    publishStatus: 'unpublished', publish: { platform: '', publishedAt: '', url: '' },
  });
  const md = noteToMarkdown(bare, []);
  assert.ok(!md.includes('## 附记'));
  assert.ok(!md.includes('## 资料标注'));
  assert.ok(!md.includes('## 引用出处'));
  assert.ok(!md.includes('## 关联原文'));
  assert.ok(md.includes('创建：') && md.includes('修改：'));
  assert.ok(md.includes('<!-- 由「ci-notes」导出（通用 Markdown，可迁移到别的写作工具） -->'));
});

/* ---------------- workToMarkdown ---------------- */

test('workToMarkdown：原文逐字引用块与背景', () => {
  const md = workToMarkdown(work());
  assert.ok(md.startsWith('# 静夜思'));
  assert.ok(md.includes('## 原文'));
  assert.ok(md.includes('> 床前明月光'));
  assert.ok(md.includes('> 疑是地上霜'));
  assert.ok(md.includes('## 背景'));
  assert.ok(md.includes('作于扬州旅舍。'));
  assert.ok(md.includes('## 资料与可信度'));
  assert.ok(md.includes('- [已核实] 「绿」字一作「过」，据宋本改'));
  assert.ok(md.includes('<!-- 由「ci-notes」导出（通用 Markdown） -->'));
});

test('workToMarkdown：空原文占位「（原文待补）」；斜体 meta 三段', () => {
  const md = workToMarkdown(work({ content: '', cipai: '五绝' }));
  assert.ok(md.includes('（原文待补）'));
  assert.ok(md.includes('*李白 · 唐 · 五绝*'));
});

/* ---------------- allusionToMarkdown ---------------- */

function allusion(over = {}) {
  return {
    id: 'a1', name: '东风夜放花千树', aliases: [], source: '《东京梦华录》',
    original: '东风夜放花千树，更吹落、星如雨。', explanation: '以花灯如星雨形容元宵盛景。',
    usages: [
      { text: '写灯火繁盛', kind: 'verified' },
      { text: '写一夜繁华忽歇', kind: 'pending' },
    ],
    claims: [claim({ kind: 'pending', text: '出处待复核《东京梦华录》卷六' })],
    citations: [citation({ verified: 'pending', page: '卷六' })],
    tags: ['元宵'], note: '辛弃疾实写临安而非汴京，此条存疑。',
    mergedInto: '', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    revision: 1, ...over,
  };
}

function allusionUse(over = {}) {
  return {
    id: 'u1', allusionId: 'a1', targetType: 'work', targetId: 'w2',
    quote: '蓦然回首，那人却在，灯火阑珊处', context: '元宵灯会人潮散尽的瞬间',
    interpretation: '由极闹转入极静，反衬孤高', understanding: '热闹是背景，阑珊才是落点',
    claims: [claim()], citations: [citation()], createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z', revision: 1, ...over,
  };
}

test('allusionToMarkdown：通用资料段 source/original/explanation/usages/note', () => {
  const md = allusionToMarkdown(allusion(), []);
  assert.ok(md.startsWith('# 东风夜放花千树'));
  assert.ok(md.includes('出处典籍'));
  assert.ok(md.includes('《东京梦华录》'));
  assert.ok(md.includes('> 东风夜放花千树，更吹落、星如雨。'));
  assert.ok(md.includes('以花灯如星雨形容元宵盛景。'));
  assert.ok(md.includes('- [已核实] 写灯火繁盛'));
  assert.ok(md.includes('- [待核实] 写一夜繁华忽歇'));
  assert.ok(md.includes('辛弃疾实写临安而非汴京，此条存疑。'));
});

test('allusionToMarkdown：claims 三级标签与使用记录逐条', () => {
  const md = allusionToMarkdown(allusion(), [allusionUse(), allusionUse({ id: 'u2', quote: '单行引文' })]);
  assert.ok(md.includes('## 资料标注'));
  assert.ok(md.includes('- [待核实] 出处待复核《东京梦华录》卷六'));
  assert.ok(md.includes('## 使用记录'));
  assert.ok(md.includes('> 蓦然回首，那人却在，灯火阑珊处'));
  assert.ok(md.includes('> 单行引文'));
  assert.equal(md.split('> 蓦然回首').length - 1, 1);
  assert.ok(md.includes('**情境**：元宵灯会人潮散尽的瞬间'));
  assert.ok(md.includes('**此处解释**：由极闹转入极静，反衬孤高'));
  assert.ok(md.includes('**我的理解**：热闹是背景，阑珊才是落点'));
  assert.ok(md.includes('- [已核实] 「绿」字一作「过」，据宋本改'));
});

test('allusionToMarkdown：无使用记录时省略该节；页脚带水印', () => {
  const md = allusionToMarkdown(allusion(), []);
  assert.ok(!md.includes('## 使用记录'));
  assert.ok(md.includes('导出时间：'));
  assert.ok(md.includes('<!-- 由「ci-notes」导出（通用 Markdown） -->'));
});

/* ---------------- citationLine ---------------- */

test('citationLine：字段拼接与（未填出处）兜底', () => {
  assert.equal(
    citationLine(citation({ edition: '', note: '', url: 'https://x' })),
    '《白氏文集》，卷十二，https://x'
  );
  assert.equal(citationLine(null), '（未填出处）');
  assert.equal(citationLine(citation({ book: '', edition: '', page: '', url: '', note: '' })), '（未填出处）');
});
