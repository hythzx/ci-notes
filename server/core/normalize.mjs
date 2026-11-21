import { StoreError } from './errors.mjs';
import { newId } from './ids.mjs';

/**
 * 共享字段归一化。
 * 规则逐行翻译自词间参考实现：
 *   - 基础工具与 normalizeTags/excerpt/charCount/sameContent ← utils/util.js、utils/store-core.js
 *   - claims/citations ← utils/store-core.js；usages/aliases ← utils/imagery-core.js
 *   - plainText（Markdown 转纯文本）← utils/markdown.js 的解析管线
 * 与参考实现的唯一偏差：plain 顶层以 '' 而非 '\n' 拼接块
 * （ci-notes 摘要与搜索需要连续纯文本，测试断言 '## 标题\n**粗**体' → '标题粗体'）。
 */

const CLAIM_KINDS = ['verified', 'pending', 'personal'];

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function str(v) {
  if (v === undefined || v === null) return '';
  return String(v);
}

function trim(v) {
  return str(v).trim();
}

function nowIso() {
  return new Date().toISOString();
}

function clone(v) {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v));
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/** 归一化标签：去空、去重、保持顺序 */
export function normalizeTags(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const t = trim(item);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 正文预览：压缩空白后截断到 n 个字 */
export function excerpt(text, n = 60) {
  const s = str(text).replace(/\s+/g, ' ').trim();
  const limit = n || 60;
  if (s.length <= limit) return s;
  return s.slice(0, limit) + '…';
}

/** 统计字数（去空白） */
export function charCount(text) {
  return str(text).replace(/\s+/g, '').length;
}

/** 比较两条记录是否「实质相同」：深比较，忽略 updatedAt/revision 两键 */
export function sameContent(a, b) {
  const x = clone(a) || {};
  const y = clone(b) || {};
  delete x.updatedAt; delete y.updatedAt;
  delete x.revision; delete y.revision;
  return deepEqual(x, y);
}

/* ------------------------------------------------------------------ */
/* 标注与出处                                                          */
/* ------------------------------------------------------------------ */

export function normalizeCitations(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const c = item || {};
    out.push({
      id: c.id || newId('ct_'),
      book: trim(c.book),
      edition: trim(c.edition),
      page: trim(c.page),
      url: trim(c.url),
      note: trim(c.note),
      verified: CLAIM_KINDS.indexOf(c.verified) >= 0 ? c.verified : 'pending'
    });
  }
  return out;
}

/** 锚点前后文取样长度（与前端 src/annotate.ts 的 ANCHOR_CONTEXT 一致） */
const ANCHOR_CONTEXT = 16;

/** 锚点归一化：quote 校验 trim 非空、存储原样（与前端采样边界一致），prefix/suffix 各截 16 字 */
function normalizeAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') return undefined;
  const quote = typeof anchor.quote === 'string' && anchor.quote.trim() ? anchor.quote : '';
  if (!quote) return undefined;
  return {
    quote,
    prefix: typeof anchor.prefix === 'string' ? anchor.prefix.slice(0, ANCHOR_CONTEXT) : '',
    suffix: typeof anchor.suffix === 'string' ? anchor.suffix.slice(0, ANCHOR_CONTEXT) : ''
  };
}

export function normalizeClaims(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const c = item || {};
    const kind = CLAIM_KINDS.indexOf(c.kind) >= 0 ? c.kind : 'pending';
    const citations = normalizeCitations(c.citations);
    // 可信度约束：verified 级资料必须自带至少一条出处
    if (kind === 'verified' && citations.length === 0) {
      throw new StoreError('INVALID', '已核实的资料需要至少一条出处');
    }
    const paragraph = Number(c.paragraph);
    const anchor = normalizeAnchor(c.anchor);
    out.push({
      id: c.id || newId('cl_'),
      kind,
      text: str(c.text),
      paragraph: Number.isInteger(paragraph) && paragraph >= -1 ? paragraph : -1,
      citations,
      ...(anchor ? { anchor } : {}),
      createdAt: c.createdAt || nowIso(),
      updatedAt: c.updatedAt || nowIso()
    });
  }
  return out;
}

/** 常见表达用途：字符串项 → {text, kind:'pending'}，按 text 去重保序 */
export function normalizeUsages(list) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach((u) => {
    if (typeof u === 'string') {
      const v = trim(u);
      if (v && !seen.has(v)) { seen.add(v); out.push({ text: v, kind: 'pending' }); }
      return;
    }
    if (!u || typeof u !== 'object') return;
    const v = trim(u.text);
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push({
      text: v,
      kind: CLAIM_KINDS.indexOf(u.kind) >= 0 ? u.kind : 'pending'
    });
  });
  return out;
}

/** 别名：顿号/逗号/空白分隔的字符串或数组；去空、去重、剔除与主名相同项 */
export function normalizeAliases(list, name) {
  const out = [];
  const seen = new Set();
  const main = trim(name);
  if (main) seen.add(main);
  (Array.isArray(list) ? list : [list]).forEach((item) => {
    const parts = str(item).split(/[、,，\s]+/);
    for (const p of parts) {
      const v = p.trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Markdown 转纯文本（译自词间 utils/markdown.js）                      */
/* ------------------------------------------------------------------ */

/** 反斜杠后面这些字符可以直接写出来 */
const ESCAPABLE = '\\`*_{}[]()#+-.!~|>';

const RE_HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const RE_FENCE = /^\s*```\s*([A-Za-z0-9_+#-]*)\s*$/;
const RE_FENCE_END = /^\s*```\s*$/;
const RE_HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
const RE_UL = /^(\s*)([-*+])\s+(.*)$/;
const RE_OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;

/** 按空行切段，段内单个换行属同一段 */
function splitGroups(text) {
  const s = str(text).replace(/\r\n/g, '\n');
  const raw = s.split(/\n{2,}/);
  const groups = [];
  for (const g of raw) {
    if (!g.trim()) continue;
    groups.push({ index: groups.length, text: g });
  }
  return groups;
}

/** 只放行安全协议：http/https/mailto、站内绝对路径与锚点；其余返回空串 */
function safeHref(url) {
  const u = str(url).trim();
  if (!u) return '';
  if (/\s/.test(u)) return '';
  if (/^(https?:\/\/|mailto:)/i.test(u)) return u;
  if (u.charAt(0) === '#' || u.charAt(0) === '/') return u;
  if (/^[a-z][a-z0-9+.\-]*:/i.test(u)) return '';
  return u;
}

/** 找闭合标记，跳过被转义的；区分「成对」与「单个」闭合 */
function findEmphasisClose(text, from, marker) {
  const ch = marker.charAt(0);
  const width = marker.length;
  let i = from;
  while (i < text.length) {
    const idx = text.indexOf(ch, i);
    if (idx < 0) return -1;
    if (idx > 0 && text.charAt(idx - 1) === '\\') { i = idx + 1; continue; }
    let run = 1;
    while (text.charAt(idx + run) === ch) run++;
    if (run >= width) return idx;
    i = idx + run;
  }
  return -1;
}

/** 那里连续有几个相同字符 */
function runLength(text, at, ch) {
  let n = 0;
  while (text.charAt(at + n) === ch) n++;
  return n;
}

/** 字母、数字、下划线算「词内」 */
function isWordChar(ch) {
  if (!ch) return false;
  return /[0-9A-Za-z_]/.test(ch);
}

/** 行内代码 `code` */
function readCode(text, i) {
  let n = 0;
  while (text.charAt(i + n) === '`') n++;
  if (!n) return null;
  let fence = '';
  for (let k = 0; k < n; k++) fence += '`';
  const close = text.indexOf(fence, i + n);
  if (close < 0) return null;
  let content = text.slice(i + n, close);
  if (content.length > 1 && content.charAt(0) === ' ' && content.charAt(content.length - 1) === ' ') {
    content = content.slice(1, -1);
  }
  return { text: content, end: close + n };
}

/** 链接 [文字](地址 "标题") */
function readLink(text, i) {
  if (text.charAt(i) !== '[') return null;
  let depth = 0, j = i;
  for (; j < text.length; j++) {
    if (text.charAt(j) === '\\') { j++; continue; }
    if (text.charAt(j) === '[') depth++;
    else if (text.charAt(j) === ']') { depth--; if (depth === 0) break; }
  }
  if (j >= text.length) return null;
  const label = text.slice(i + 1, j);
  if (text.charAt(j + 1) !== '(') return null;
  let pdepth = 0, m = j + 1;
  for (; m < text.length; m++) {
    if (text.charAt(m) === '\\') { m++; continue; }
    if (text.charAt(m) === '(') pdepth++;
    else if (text.charAt(m) === ')') { pdepth--; if (pdepth === 0) break; }
  }
  if (m >= text.length) return null;
  const inner = text.slice(j + 2, m).trim();
  let href = inner, title = '';
  const tm = inner.match(/^(\S*)\s+["'(]([\s\S]*)["')]$/);
  if (tm) { href = tm[1]; title = tm[2]; }
  return { label, href: safeHref(href), title, end: m + 1 };
}

/** 强调：粗体、斜体、删除线。顺序要紧：*** 在 ** 前，** 在 * 前 */
const EMPHASIS = [
  { open: '***', node: 'strong', wrap: 'em' },
  { open: '**', node: 'strong' },
  { open: '__', node: 'strong' },
  { open: '~~', node: 'del' },
  { open: '*', node: 'em' },
  { open: '_', node: 'em' }
];

function readEmphasis(text, i) {
  for (const e of EMPHASIS) {
    if (text.substr(i, e.open.length) !== e.open) continue;
    const after = text.charAt(i + e.open.length);
    if (after === '' || /\s/.test(after)) continue;

    const found = findEmphasisClose(text, i + e.open.length, e.open);
    if (found < 0) continue;

    // 闭合处多出来的星号留给内层：**又粗*又斜*** 内层的 * 才有处可闭
    const ch = e.open.charAt(0);
    const run = runLength(text, found, ch);
    let closeAt = found;
    if (run > e.open.length) closeAt = found + (run - e.open.length);

    const inner = text.slice(i + e.open.length, closeAt);
    if (!inner.trim()) continue;
    if (/\s/.test(inner.charAt(inner.length - 1))) continue;

    // 下划线不参与词内强调：snake_case 不该变成斜体
    if (e.open === '_') {
      const before = i > 0 ? text.charAt(i - 1) : '';
      const afterClose = text.charAt(closeAt + 1);
      if (isWordChar(before) || isWordChar(afterClose)) continue;
    }

    let children = parseInline(inner);
    if (e.wrap) children = [{ type: e.wrap, children }];
    return {
      node: { type: e.node, children },
      end: closeAt + e.open.length
    };
  }
  return null;
}

/** 解析一行里的行内标记 → 节点数组 */
function parseInline(text) {
  const s = str(text);
  const out = [];
  let buf = '';
  let i = 0;

  const flush = () => {
    if (buf) { out.push({ type: 'text', text: buf }); buf = ''; }
  };

  while (i < s.length) {
    const ch = s.charAt(i);

    // 转义：\x 直接输出字面 x
    if (ch === '\\' && i + 1 < s.length && ESCAPABLE.indexOf(s.charAt(i + 1)) >= 0) {
      buf += s.charAt(i + 1);
      i += 2;
      continue;
    }

    // 段内换行按硬换行处理
    if (ch === '\n') {
      flush();
      out.push({ type: 'br' });
      i++;
      continue;
    }

    // 行内代码
    if (ch === '`') {
      const code = readCode(s, i);
      if (code) {
        flush();
        out.push({ type: 'code', text: code.text });
        i = code.end;
        continue;
      }
    }

    // 图片：本版不支持附件，降级成文字
    if (ch === '!' && s.charAt(i + 1) === '[') {
      const img = readLink(s, i + 1);
      if (img) {
        flush();
        out.push({ type: 'text', text: img.label || '' });
        i = img.end + 1;
        continue;
      }
    }

    // 链接：不安全地址只留文字
    if (ch === '[') {
      const link = readLink(s, i);
      if (link) {
        flush();
        if (link.href) {
          out.push({ type: 'link', href: link.href, title: link.title, children: parseInline(link.label) });
        } else {
          out.push({ type: 'text', text: link.label });
        }
        i = link.end;
        continue;
      }
    }

    // 强调
    const emph = readEmphasis(s, i);
    if (emph) {
      flush();
      out.push(emph.node);
      i = emph.end;
      continue;
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

function indentOf(line) {
  const m = /^[ \t]*/.exec(line);
  return m[0].length;
}

function matchMarker(line) {
  const ul = RE_UL.exec(line);
  if (ul) {
    return { indent: ul[1].length, ordered: false, rest: ul[3], contentIndent: ul[0].length - ul[3].length };
  }
  const ol = RE_OL.exec(line);
  if (ol) {
    return { indent: ol[1].length, ordered: true, rest: ol[3], contentIndent: ol[0].length - ol[3].length };
  }
  return null;
}

/** 列表：按缩进递归，列表项里的内容再交给 parseBlocks */
function parseList(lines, start) {
  const items = [];
  let ordered = null;
  let cur = null;
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) break;

    const m = matchMarker(line);
    if (m) {
      if (cur && m.indent < cur.indent) break;
      if (cur && m.indent > cur.indent) {
        // 缩进更深 —— 上一项的子项，按续行处理
        cur.lines.push(line.slice(cur.contentIndent));
        i++;
        continue;
      }
      if (cur && m.indent === cur.indent && ordered !== null && m.ordered !== ordered) break;
      if (ordered === null) ordered = m.ordered;
      cur = { indent: m.indent, contentIndent: m.contentIndent, lines: [m.rest] };
      items.push(cur);
      i++;
      continue;
    }

    if (!cur) { i++; continue; }

    const ind = indentOf(line);
    if (ind >= cur.contentIndent) {
      // 续行：切掉与首行相同的缩进，相对缩进保留（嵌套列表靠这个）
      cur.lines.push(line.slice(cur.contentIndent));
      i++;
      continue;
    }
    break;
  }

  const listBlocks = items.map((it) => ({ blocks: parseBlocks(it.lines.join('\n')) }));
  return { block: { type: 'list', ordered: !!ordered, items: listBlocks }, next: i };
}

/** 解析一段里的块级结构 */
function parseBlocks(text) {
  const lines = str(text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  const startsNewBlock = (l) =>
    RE_HEADING.test(l) || RE_FENCE.test(l) || RE_HR.test(l) ||
    RE_QUOTE.test(l) || RE_UL.test(l) || RE_OL.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // 代码块
    const fence = line.match(RE_FENCE);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !RE_FENCE_END.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ type: 'code', lang: fence[1] || '', text: buf.join('\n') });
      continue;
    }

    // 标题
    const head = line.match(RE_HEADING);
    if (head) {
      blocks.push({ type: 'heading', level: head[1].length, inline: parseInline(head[2].replace(/\s+#+\s*$/, '')) });
      i++;
      continue;
    }

    // 分隔线
    if (RE_HR.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // 引用
    const quote = line.match(RE_QUOTE);
    if (quote) {
      const qlines = [];
      while (i < lines.length) {
        const qm = lines[i].match(RE_QUOTE);
        if (!qm) break;
        qlines.push(qm[1]);
        i++;
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(qlines.join('\n')) });
      continue;
    }

    // 列表
    if (RE_UL.test(line) || RE_OL.test(line)) {
      const list = parseList(lines, i);
      blocks.push(list.block);
      i = list.next;
      continue;
    }

    // 段落
    const plines = [];
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) break;
      if (plines.length && startsNewBlock(l)) break;
      plines.push(l);
      i++;
    }
    if (plines.length) {
      blocks.push({ type: 'paragraph', inline: parseInline(plines.join('\n')) });
    }
  }
  return blocks;
}

function inlineToPlain(nodes) {
  let out = '';
  (nodes || []).forEach((n) => {
    switch (n.type) {
      case 'text': out += n.text; break;
      case 'br': out += '\n'; break;
      case 'code': out += n.text; break;
      case 'strong':
      case 'em':
      case 'del':
      case 'link': out += inlineToPlain(n.children); break;
      default: break;
    }
  });
  return out;
}

function blockToPlain(b) {
  switch (b.type) {
    case 'heading':
    case 'paragraph': return inlineToPlain(b.inline);
    case 'quote': return b.blocks.map(blockToPlain).join('\n');
    case 'code': return b.text;
    case 'hr': return '';
    case 'list': return b.items.map((it) => it.blocks.map(blockToPlain).join('\n')).join('\n');
    default: return '';
  }
}

/** Markdown 转纯文本 —— 摘要、搜索都用它 */
function plain(text) {
  const doc = { blocks: [] };
  splitGroups(text).forEach((g) => {
    parseBlocks(g.text).forEach((b) => doc.blocks.push(b));
  });
  // 与参考实现的唯一偏差：顶层以 '' 拼接（ci-notes 摘要/搜索要连续纯文本）
  return doc.blocks.map(blockToPlain)
    .filter((s) => !!s.trim())
    .join('');
}

export function plainText(md) {
  return plain(md);
}

/** 札记摘要：无正文或转纯文本为空时提示待导入，否则截前 80 字 */
export function excerptOfNote(note) {
  const n = note || {};
  const raw = plainText(n.content);
  if (!raw) return '（正文待导入）';
  return raw.slice(0, 80);
}
