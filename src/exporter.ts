/**
 * 单篇导出：札记 / 词作 / 典故 → Markdown 字符串，以及浏览器端文件下载。
 *
 * 文案与结构翻译自词间 utils/exporter.js（noteToMarkdown / workToMarkdown），
 * 差异：db 对象传参改为显式传 linkedWorks / uses；版本行只携带
 * snapshotRev.createdAt（正文与标题由调用方用快照回填后的 note 提供）。
 * 典故导出为本项目新增，词间无对应物，结构仿 noteToMarkdown 自建。
 *
 * 纯字符串函数；对 ./types 仅 import type（运行时擦除），
 * 因此本模块可被 node:test 直测，无任何运行时依赖。
 */
import type { Allusion, AllusionUse, Claim, Citation, ClaimKind, Note, Work } from './types';

/* ------------------------------------------------------------------ */
/* 基础工具（词间 util.js / constants 的忠实对应）                      */
/* ------------------------------------------------------------------ */

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** 本地时间 YYYY-MM-DD HH:mm；空值或无效输入返回空串（词间 formatDateTime 语义） */
export function formatDateTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return (
    d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  );
}

const CLAIM_LABEL: Record<ClaimKind, string> = {
  verified: '已核实',
  pending: '待核实',
  personal: '个人理解',
};

const WRITING_LABEL: Record<Note['writingStatus'], string> = {
  idea: '构思',
  research: '资料收集',
  draft: '草稿',
  final: '定稿',
};

const PUBLISH_LABEL: Record<Note['publishStatus'], string> = {
  unpublished: '未发布',
  pending: '待发布',
  published: '已发布',
};

/** 多行文本转引用块：每行前置「> 」，空输入返回空串 */
function blockquote(text: string): string {
  const s = str(text);
  if (!s) return '';
  return '> ' + s.split('\n').join('\n> ');
}

function str(v: unknown): string {
  if (v === undefined || v === null) return '';
  return String(v);
}

/* ------------------------------------------------------------------ */
/* 标注与出处                                                          */
/* ------------------------------------------------------------------ */

/** 出处行：book/edition/page 以「，」拼接，url、note 依次追加 */
export function citationLine(c: Citation | null | undefined): string {
  if (!c) return '（未填出处）';
  const parts: string[] = [];
  if (c.book) parts.push(c.book);
  if (c.edition) parts.push(c.edition);
  if (c.page) parts.push(c.page);
  let s = parts.join('，');
  if (c.url) s += (s ? '，' : '') + c.url;
  if (c.note) s += (s ? '，' : '') + c.note;
  return s || '（未填出处）';
}

/**
 * claims → 三级标注列表：
 * `- [已核实] 文本`，有出处时缩进追加 `- 出处：行1；行2`。
 * indent 用于关联原文段内的层级对齐。
 */
export function claimsToText(claims: Claim[] | null | undefined, indent = ''): string {
  const out: string[] = [];
  (claims || []).forEach((c) => {
    let line = indent + '- [' + CLAIM_LABEL[c.kind] + '] ' + str(c.text);
    if (c.citations && c.citations.length) {
      const cites = c.citations.map((x) => citationLine(x)).join('；');
      line += '\n' + indent + '  - 出处：' + cites;
    }
    out.push(line);
  });
  return out.join('\n');
}

/** 词作 meta 行：author · dynasty · cipai，空字段剔除，全空返回空串 */
function workMeta(work: Work): string {
  const meta = [work.author, work.dynasty, work.cipai].filter(Boolean);
  return meta.length ? '*' + meta.join(' · ') + '*' : '';
}

/* ------------------------------------------------------------------ */
/* 札记导出                                                            */
/* ------------------------------------------------------------------ */

/** 「## 关联原文」内每首词作的小节（### 标题 + 斜体 meta + 逐字引用块 + 资料与出处） */
function worksSection(works: Work[]): string {
  const lines: string[] = [];
  works.forEach((w) => {
    lines.push('### ' + w.title);
    const meta = workMeta(w);
    if (meta) lines.push(meta);
    lines.push('');
    lines.push(blockquote(w.content));
    lines.push('');
    const claims = claimsToText(w.claims);
    if (claims) {
      lines.push('**资料与出处**');
      lines.push('');
      lines.push(claims);
      lines.push('');
    }
  });
  return lines.join('\n');
}

/**
 * 札记 → Markdown。
 * snapshotRev 为历史版本导出时的版本元信息：只携带 createdAt，
 * 标题/正文/状态由调用方用快照回填后的 note 传入。
 */
export function noteToMarkdown(note: Note, linkedWorks: Work[], snapshotRev?: { createdAt: string }): string {
  const lines: string[] = [];

  lines.push('# ' + (str(note.title) || '（未命名）'));
  lines.push('');
  lines.push(
    '> 导出时间：' + formatDateTime(new Date().toISOString()) +
    '　·　写作状态：' + WRITING_LABEL[note.writingStatus] +
    '　·　发布状态：' + PUBLISH_LABEL[note.publishStatus]
  );
  // 发布记录：仅已登记发布（非未发布且填了 url）时输出
  if (note.publishStatus !== 'unpublished' && note.publish && str(note.publish.url)) {
    lines.push(
      '> 发布：' + (str(note.publish.platform) || '未填平台') +
      '　' + str(note.publish.publishedAt || '') +
      '　' + str(note.publish.url)
    );
  }
  lines.push('');

  if (linkedWorks.length) {
    lines.push('## 关联原文');
    lines.push('');
    lines.push(worksSection(linkedWorks));
  }

  lines.push('## 正文');
  lines.push('');
  lines.push(str(note.content).trim() ? note.content : '（正文待导入）');
  lines.push('');

  const noteText = str(note.note);
  if (noteText.trim()) {
    lines.push('## 附记');
    lines.push('');
    lines.push(noteText);
    lines.push('');
  }

  const claims = claimsToText(note.claims);
  if (claims) {
    lines.push('## 资料标注');
    lines.push('');
    lines.push(claims);
    lines.push('');
  }

  if (note.citations && note.citations.length) {
    lines.push('## 引用出处');
    lines.push('');
    note.citations.forEach((c) => {
      lines.push('- ' + citationLine(c) + '　（' + CLAIM_LABEL[c.verified] + '）');
    });
    lines.push('');
  }

  lines.push('---');
  lines.push('创建：' + formatDateTime(note.createdAt) + '　修改：' + formatDateTime(note.updatedAt));
  if (snapshotRev && snapshotRev.createdAt) {
    lines.push('本篇导出版本时间：' + formatDateTime(snapshotRev.createdAt));
  }
  lines.push('');
  lines.push('<!-- 由「ci-notes」导出（通用 Markdown，可迁移到别的写作工具） -->');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 词作导出                                                            */
/* ------------------------------------------------------------------ */

export function workToMarkdown(work: Work): string {
  const lines: string[] = [];
  lines.push('# ' + (str(work.title) || '（未命名）'));
  lines.push('');
  const meta = workMeta(work);
  if (meta) lines.push(meta);
  lines.push('');
  lines.push('## 原文');
  lines.push('');
  const content = str(work.content);
  lines.push(content ? blockquote(content) : '（原文待补）');
  lines.push('');

  const background = str(work.background);
  if (background) {
    lines.push('## 背景');
    lines.push('');
    lines.push(background);
    lines.push('');
  }

  const claims = claimsToText(work.claims);
  if (claims) {
    lines.push('## 资料与可信度');
    lines.push('');
    lines.push(claims);
    lines.push('');
  }

  if (work.citations && work.citations.length) {
    lines.push('## 引用出处');
    lines.push('');
    work.citations.forEach((c) => {
      lines.push('- ' + citationLine(c) + '　（' + CLAIM_LABEL[c.verified] + '）');
    });
    lines.push('');
  }

  lines.push('---');
  lines.push('导出时间：' + formatDateTime(new Date().toISOString()));
  lines.push('');
  lines.push('<!-- 由「ci-notes」导出（通用 Markdown） -->');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 典故导出（本项目新增，词间无对应物）                                 */
/* ------------------------------------------------------------------ */

/** 单条使用记录：引用块 + 情境 / 此处解释 / 我的理解 + 该条 claims 与出处 */
function allusionUseSection(use: AllusionUse): string {
  const lines: string[] = [];
  const quote = blockquote(use.quote);
  if (quote) {
    lines.push(quote);
    lines.push('');
  }
  const context = str(use.context);
  if (context) {
    lines.push('**情境**：' + context);
    lines.push('');
  }
  const interpretation = str(use.interpretation);
  if (interpretation) {
    lines.push('**此处解释**：' + interpretation);
    lines.push('');
  }
  const understanding = str(use.understanding);
  if (understanding) {
    lines.push('**我的理解**：' + understanding);
    lines.push('');
  }
  const claims = claimsToText(use.claims);
  if (claims) {
    lines.push('**资料与出处**');
    lines.push('');
    lines.push(claims);
    lines.push('');
  }
  if (use.citations && use.citations.length) {
    lines.push('**出处**');
    lines.push('');
    use.citations.forEach((c) => {
      lines.push('- ' + citationLine(c) + '　（' + CLAIM_LABEL[c.verified] + '）');
    });
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 典故 → Markdown：通用资料段（出处典籍 / 典故原文引用块 / 释义 /
 * 常见表达用途 / 阅读札记）、三级资料标注、引用出处、使用记录逐条。
 */
export function allusionToMarkdown(allusion: Allusion, uses: AllusionUse[]): string {
  const lines: string[] = [];

  lines.push('# ' + (str(allusion.name) || '（未命名）'));
  lines.push('');
  lines.push('> 导出时间：' + formatDateTime(new Date().toISOString()));
  lines.push('');

  lines.push('## 通用资料');
  lines.push('');
  const source = str(allusion.source);
  if (source) {
    lines.push('**出处典籍**：' + source);
    lines.push('');
  }
  const original = blockquote(allusion.original);
  if (original) {
    lines.push('**典故原文**');
    lines.push('');
    lines.push(original);
    lines.push('');
  }
  const explanation = str(allusion.explanation);
  if (explanation) {
    lines.push('**典故释义**');
    lines.push('');
    lines.push(explanation);
    lines.push('');
  }
  if (allusion.usages && allusion.usages.length) {
    lines.push('**常见表达用途**');
    lines.push('');
    allusion.usages.forEach((u) => {
      lines.push('- [' + CLAIM_LABEL[u.kind] + '] ' + str(u.text));
    });
    lines.push('');
  }
  const noteText = str(allusion.note);
  if (noteText.trim()) {
    lines.push('**我的阅读札记**');
    lines.push('');
    lines.push(noteText);
    lines.push('');
  }

  const claims = claimsToText(allusion.claims);
  if (claims) {
    lines.push('## 资料标注');
    lines.push('');
    lines.push(claims);
    lines.push('');
  }

  if (allusion.citations && allusion.citations.length) {
    lines.push('## 引用出处');
    lines.push('');
    allusion.citations.forEach((c) => {
      lines.push('- ' + citationLine(c) + '　（' + CLAIM_LABEL[c.verified] + '）');
    });
    lines.push('');
  }

  if (uses.length) {
    lines.push('## 使用记录');
    lines.push('');
    uses.forEach((u) => {
      lines.push(allusionUseSection(u));
    });
  }

  lines.push('---');
  lines.push('导出时间：' + formatDateTime(new Date().toISOString()));
  lines.push('');
  lines.push('<!-- 由「ci-notes」导出（通用 Markdown） -->');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 浏览器下载                                                          */
/* ------------------------------------------------------------------ */

/** 触发浏览器下载：Blob + a[download]，用后立即释放对象 URL */
export function download(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
