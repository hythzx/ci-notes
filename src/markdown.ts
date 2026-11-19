/**
 * 词间 · Markdown 渲染（ci-notes 翻译版）
 *
 * 翻译自词间实现：
 *   - 解析与纯文本：/utils/markdown.js（parse/parseInline/parseBlocks/splitGroups/safeHref/plain）
 *   - DOM 渲染：    /web/markdown.js（render/renderInline，结构 → DOM，不用 innerHTML）
 *   - 分段基准：    /utils/util.js toParagraphs（空行分段，claims.paragraph 依赖）
 *
 * 与词间参考实现的三处偏差（均为 brief 明确要求）：
 *   1. plain 顶层块以 '' 而非 '\n' 拼接（与 server/core/normalize.mjs plainText 决策一致，
 *      摘要与搜索需要连续纯文本；块内 br 仍保留 '\n'）。
 *   2. 分段（splitGroups/paragraphs）围栏感知：``` 围栏内的空行不分段。
 *      词间 splitGroups / toParagraphs 均不处理围栏，brief 测试要求处理；
 *      parse 复用同一分段函数，保证 render 组号与 claims.paragraph（即 paragraphs 下标）一致。
 *   3. render 返回 DocumentFragment（brief 签名）；fragment 内保留词间的 div.cj-md 外壳与
 *      各级 cj-md-* 类名作为样式挂钩。onGroup/onBlock 回调参数序按 brief：
 *      onGroup(el, group)、onBlock(el)。
 *
 * 安全约定：
 *   用户正文一律以文本节点写入，不用 innerHTML；链接地址过 safeHref 白名单
 *   （http/https/mailto、站内绝对路径与锚点），其余丢地址只留文字；
 *   原始 HTML 与图片语法分别按普通文字 / alt 文字输出。
 *
 * 模块自含（零相对依赖）：node:test 可直接 import；render/renderInline 仅浏览器路径调用
 * （node 测试只触碰纯字符串函数 plain/paragraphs）。
 */

/* ------------------------------------------------------------------ */
/* 基础                                                                */
/* ------------------------------------------------------------------ */

function str(v: unknown): string {
  if (v === undefined || v === null) return '';
  return String(v);
}

/** 反斜杠后面这些字符可以直接写出来 */
const ESCAPABLE = '\\`*_{}[]()#+-.!~|>';

/* ------------------------------------------------------------------ */
/* AST 结构（内部，不导出）                                             */
/* ------------------------------------------------------------------ */

type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'br' }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  | { type: 'del'; children: InlineNode[] }
  | { type: 'link'; href: string; title: string; children: InlineNode[] };

type Block =
  | { type: 'heading'; level: number; inline: InlineNode[] }
  | { type: 'paragraph'; inline: InlineNode[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'hr' }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'list'; ordered: boolean; items: { blocks: Block[] }[] };

/** 顶层块附带段落分组信息；标注（claim.paragraph）挂在 group 上 */
type GroupedBlock = Block & { group: number; groupFirst: boolean };

interface ParsedDoc {
  blocks: GroupedBlock[];
  groupCount: number;
}

/* ------------------------------------------------------------------ */
/* 段落分组                                                            */
/* ------------------------------------------------------------------ */

/**
 * 按空行切段（围栏感知），规则与词间 splitGroups / util.toParagraphs 一致：
 * 连续两个以上换行构成段界；纯空白行若不构成连续换行（如 "a\n \nb"）不算段界，
 * 空白段丢弃。段带自身序号 —— 标注（claim.paragraph）靠它定位。
 * 与词间的唯一差异：``` 围栏内的空行不分段（brief 要求，见文件头注释）。
 */
function splitGroups(text: string): { index: number; text: string }[] {
  const s = str(text).replace(/\r\n/g, '\n');
  const groups: { index: number; text: string }[] = [];
  let start = 0;
  let cursor = 0;
  let inFence = false;
  while (cursor < s.length) {
    const nl = s.indexOf('\n', cursor);
    if (nl < 0) break;
    const line = s.slice(cursor, nl);
    if (/^\s*```/.test(line)) inFence = !inFence;
    // 段界：围栏外出现连续两个以上换行（nl 处必为 \n，其后紧跟 \n 即连续换行）
    if (!inFence && s.charCodeAt(nl + 1) === 10) {
      const seg = s.slice(start, nl);
      if (seg.trim()) groups.push({ index: groups.length, text: seg });
      cursor = nl;
      while (cursor < s.length && s[cursor] === '\n') cursor++;
      start = cursor;
      continue;
    }
    cursor = nl + 1;
  }
  const rest = s.slice(start);
  if (rest.trim()) groups.push({ index: groups.length, text: rest });
  return groups;
}

/**
 * 按空行分段，段内按单换行拆行。
 * claims.paragraph 依赖本函数的分组序号：paragraph=1 对应返回值 p[1]。
 * 围栏代码块内的空行不分段（brief 要求；词间 toParagraphs 不处理围栏）。
 */
export function paragraphs(text: string): string[][] {
  return splitGroups(text).map((g) => g.text.split('\n'));
}

/* ------------------------------------------------------------------ */
/* 链接                                                                */
/* ------------------------------------------------------------------ */

/**
 * 只放行安全协议：http / https / mailto、站内绝对路径与锚点。
 * 其它带协议的（javascript:、data: 之类）与含空白的地址一律返回空串。
 */
function safeHref(url: string): string {
  const u = str(url).trim();
  if (!u) return '';
  if (/\s/.test(u)) return '';
  if (/^(https?:\/\/|mailto:)/i.test(u)) return u;
  if (u.charAt(0) === '#' || u.charAt(0) === '/') return u;
  if (/^[a-z][a-z0-9+.\-]*:/i.test(u)) return '';
  return u;
}

/* ------------------------------------------------------------------ */
/* 行内                                                                */
/* ------------------------------------------------------------------ */

/**
 * 找闭合标记时会区分「成对」与「单个」：
 *   **x** 的闭合是成对的那个 **
 *   **x*y*** 里，*x* 的闭合是单个的那个 *
 * 所以按标记长度分别找，找到成对就跳过整对。
 */
function findEmphasisClose(text: string, from: number, marker: string): number {
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
function runLength(text: string, at: number, ch: string): number {
  let n = 0;
  while (text.charAt(at + n) === ch) n++;
  return n;
}

/** 字母、数字、下划线算「词内」 */
function isWordChar(ch: string): boolean {
  if (!ch) return false;
  return /[0-9A-Za-z_]/.test(ch);
}

/** 行内代码 `code` */
function readCode(text: string, i: number): { text: string; end: number } | null {
  let n = 0;
  while (text.charAt(i + n) === '`') n++;
  if (!n) return null;
  const fence = '`'.repeat(n);
  const close = text.indexOf(fence, i + n);
  if (close < 0) return null;
  let content = text.slice(i + n, close);
  if (content.length > 1 && content.charAt(0) === ' ' && content.charAt(content.length - 1) === ' ') {
    content = content.slice(1, -1);
  }
  return { text: content, end: close + n };
}

/** 链接 [文字](地址 "标题") */
function readLink(text: string, i: number): { label: string; href: string; title: string; end: number } | null {
  if (text.charAt(i) !== '[') return null;
  let depth = 0;
  let j = i;
  for (; j < text.length; j++) {
    if (text.charAt(j) === '\\') { j++; continue; }
    if (text.charAt(j) === '[') depth++;
    else if (text.charAt(j) === ']') { depth--; if (depth === 0) break; }
  }
  if (j >= text.length) return null;
  const label = text.slice(i + 1, j);
  if (text.charAt(j + 1) !== '(') return null;
  let pdepth = 0;
  let m = j + 1;
  for (; m < text.length; m++) {
    if (text.charAt(m) === '\\') { m++; continue; }
    if (text.charAt(m) === '(') pdepth++;
    else if (text.charAt(m) === ')') { pdepth--; if (pdepth === 0) break; }
  }
  if (m >= text.length) return null;
  const inner = text.slice(j + 2, m).trim();
  let href = inner;
  let title = '';
  const tm = inner.match(/^(\S*)\s+["'(]([\s\S]*)["')]$/);
  if (tm) { href = tm[1]; title = tm[2]; }
  return { label, href: safeHref(href), title, end: m + 1 };
}

/** 强调：粗体、斜体、删除线。顺序要紧：*** 排在 ** 前，** 排在 * 前。 */
interface EmphasisDef {
  open: string;
  node: 'strong' | 'em' | 'del';
  wrap?: 'em';
}

const EMPHASIS: EmphasisDef[] = [
  { open: '***', node: 'strong', wrap: 'em' },
  { open: '**', node: 'strong' },
  { open: '__', node: 'strong' },
  { open: '~~', node: 'del' },
  { open: '*', node: 'em' },
  { open: '_', node: 'em' }
];

function readEmphasis(text: string, i: number): { node: InlineNode; end: number } | null {
  for (const e of EMPHASIS) {
    if (text.slice(i, i + e.open.length) !== e.open) continue;
    const after = text.charAt(i + e.open.length);
    if (after === '' || /\s/.test(after)) continue;

    const found = findEmphasisClose(text, i + e.open.length, e.open);
    if (found < 0) continue;

    // 闭合处若连着好几个星号，多出来的留给内层 —— **又粗*又斜*** 内层的 * 才有处可闭
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

    const children = parseInline(inner);
    // 词间：node 即 e.node；带 wrap 时把 e.node 包到 e.wrap 内层（***x*** → strong > em）
    const nodeChildren: InlineNode[] = e.wrap ? [{ type: e.wrap, children }] : children;
    return { node: { type: e.node, children: nodeChildren }, end: closeAt + e.open.length };
  }
  return null;
}

/**
 * 解析一行里的行内标记
 */
function parseInline(text: string): InlineNode[] {
  const s = str(text);
  const out: InlineNode[] = [];
  let buf = '';
  let i = 0;

  function flush(): void {
    if (buf) { out.push({ type: 'text', text: buf }); buf = ''; }
  }

  while (i < s.length) {
    const ch = s.charAt(i);

    // 转义
    if (ch === '\\' && i + 1 < s.length && ESCAPABLE.indexOf(s.charAt(i + 1)) >= 0) {
      buf += s.charAt(i + 1);
      i += 2;
      continue;
    }

    // 段内换行 —— 硬换行（与词间显示约定一致）
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

    // 图片 —— 本版不支持附件，降级成 alt 文字
    if (ch === '!' && s.charAt(i + 1) === '[') {
      const img = readLink(s, i + 1);
      if (img) {
        flush();
        out.push({ type: 'text', text: img.label || '' });
        i = img.end + 1;
        continue;
      }
    }

    // 链接：地址不安全时丢地址只留文字
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

    // 其余字符（含原始 HTML 的尖括号）一律当普通文字
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/* ------------------------------------------------------------------ */
/* 块级                                                                */
/* ------------------------------------------------------------------ */

const RE_HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const RE_FENCE = /^\s*```\s*([A-Za-z0-9_+#-]*)\s*$/;
const RE_FENCE_END = /^\s*```\s*$/;
const RE_HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
const RE_UL = /^(\s*)([-*+])\s+(.*)$/;
const RE_OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;

function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].length : 0;
}

function matchMarker(line: string): { indent: number; ordered: boolean; rest: string; contentIndent: number } | null {
  const ul = RE_UL.exec(line);
  if (ul) {
    return {
      indent: ul[1].length,
      ordered: false,
      rest: ul[3],
      contentIndent: ul[0].length - ul[3].length
    };
  }
  const ol = RE_OL.exec(line);
  if (ol) {
    return {
      indent: ol[1].length,
      ordered: true,
      rest: ol[3],
      contentIndent: ol[0].length - ol[3].length
    };
  }
  return null;
}

/**
 * 解析一段里的块级结构
 */
function parseBlocks(text: string): Block[] {
  const lines = str(text).replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  function startsNewBlock(l: string): boolean {
    return RE_HEADING.test(l) || RE_FENCE.test(l) || RE_HR.test(l) ||
      RE_QUOTE.test(l) || RE_UL.test(l) || RE_OL.test(l);
  }

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // 代码块：内容原样保留
    const fence = line.match(RE_FENCE);
    if (fence) {
      const buf: string[] = [];
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
      blocks.push({
        type: 'heading',
        level: head[1].length,
        inline: parseInline(head[2].replace(/\s+#+\s*$/, ''))
      });
      i++;
      continue;
    }

    // 分隔线
    if (RE_HR.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // 引用（递归解析引用体）
    const quote = line.match(RE_QUOTE);
    if (quote) {
      const qlines: string[] = [];
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
    const plines: string[] = [];
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

/**
 * 列表：按缩进递归，列表项里的内容再交给 parseBlocks
 */
function parseList(lines: string[], start: number): { block: Block; next: number } {
  interface Item {
    indent: number;
    contentIndent: number;
    lines: string[];
  }
  const items: Item[] = [];
  let ordered: boolean | null = null;
  let cur: Item | null = null;
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) break;

    const m = matchMarker(line);
    if (m) {
      if (cur && m.indent < cur.indent) break;
      if (cur && m.indent > cur.indent) {
        // 缩进更深 —— 是上一项里的子项，按续行处理
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
      // 续行：切掉与首行相同的缩进，剩余相对缩进保留（嵌套列表靠这个）
      cur.lines.push(line.slice(cur.contentIndent));
      i++;
      continue;
    }
    break;
  }

  const listBlocks = items.map((it) => ({ blocks: parseBlocks(it.lines.join('\n')) }));

  return {
    block: { type: 'list', ordered: !!ordered, items: listBlocks },
    next: i
  };
}

/* ------------------------------------------------------------------ */
/* 解析整篇                                                            */
/* ------------------------------------------------------------------ */

/**
 * 解析整篇文本：每个块带 group（段落序号）与 groupFirst（是否该段第一个块）。
 * 组序号来自 splitGroups —— 与 paragraphs() 的下标一致，标注按它对齐。
 */
function parse(text: string): ParsedDoc {
  const groups = splitGroups(text);
  const blocks: GroupedBlock[] = [];
  for (const g of groups) {
    const gs = parseBlocks(g.text);
    gs.forEach((b, idx) => {
      blocks.push({ ...b, group: g.index, groupFirst: idx === 0 });
    });
  }
  return { blocks, groupCount: groups.length };
}

/* ------------------------------------------------------------------ */
/* 纯文本                                                              */
/* ------------------------------------------------------------------ */

function inlineToPlain(nodes: InlineNode[]): string {
  let out = '';
  for (const n of nodes || []) {
    switch (n.type) {
      case 'text': out += n.text; break;
      case 'br': out += '\n'; break;
      case 'code': out += n.text; break;
      case 'strong':
      case 'em':
      case 'del':
      case 'link': out += inlineToPlain(n.children); break;
    }
  }
  return out;
}

function blockToPlain(b: Block): string {
  switch (b.type) {
    case 'heading':
    case 'paragraph': return inlineToPlain(b.inline);
    case 'quote': return b.blocks.map(blockToPlain).join('\n');
    case 'code': return b.text;
    case 'hr': return '';
    case 'list': return b.items
      .map((it) => it.blocks.map(blockToPlain).join('\n'))
      .join('\n');
  }
}

/** Markdown 转纯文本 —— 摘要、复制、搜索都用它。
 *  与词间 plain 的唯一偏差：顶层块以 '' 拼接而非 '\n'（brief 断言，与 server plainText 决策一致）。 */
export function plain(text: string): string {
  const doc = parse(text);
  return doc.blocks
    .map(blockToPlain)
    .filter((s) => !!s.trim())
    .join('');
}

/* ------------------------------------------------------------------ */
/* DOM 渲染（结构 → DOM，不用 innerHTML；仅浏览器路径调用）              */
/* ------------------------------------------------------------------ */

/** 极简建元素：attrs 值为 null 的属性跳过；字符串子节点转文本节点 */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | null> | null,
  children?: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== null) node.setAttribute(k, v);
    }
  }
  for (const c of children || []) {
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** 行内节点写入 parent（全部 createElement / createTextNode） */
function renderInlineNodes(nodes: InlineNode[], parent: Node): void {
  for (const n of nodes || []) {
    if (!n) continue;
    switch (n.type) {
      case 'text':
        parent.appendChild(document.createTextNode(n.text));
        break;
      case 'br':
        parent.appendChild(h('br'));
        break;
      case 'code':
        parent.appendChild(h('code', { class: 'cj-md-inline-code' }, [n.text]));
        break;
      case 'strong':
      case 'em':
      case 'del':
        parent.appendChild(h(n.type, null, [inlineToFragment(n.children)]));
        break;
      case 'link':
        parent.appendChild(renderLink(n));
        break;
    }
  }
}

function inlineToFragment(nodes: InlineNode[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  renderInlineNodes(nodes, frag);
  return frag;
}

function renderLink(n: Extract<InlineNode, { type: 'link' }>): HTMLAnchorElement {
  const internal = n.href.charAt(0) === '#' || n.href.charAt(0) === '/';
  const a = h('a', {
    class: 'cj-md-link',
    href: n.href,
    title: n.title || null,
    // 外链新开页并切断 opener
    target: internal ? null : '_blank',
    rel: internal ? null : 'noopener noreferrer'
  });
  renderInlineNodes(n.children, a);
  return a;
}

/* ---------------- 块级元素 ---------------- */

function headingEl(block: Extract<Block, { type: 'heading' }>): HTMLElement {
  // 词间约定：一级标题降为 h3，最高 h6 —— 正文里不出现巨型标题
  const level = Math.min(6, Math.max(3, block.level + 2));
  const el = document.createElement('h' + level);
  el.className = 'cj-md-h cj-md-h' + block.level;
  el.appendChild(inlineToFragment(block.inline));
  return el;
}

function listEl(block: Extract<Block, { type: 'list' }>): HTMLElement {
  const list = h(block.ordered ? 'ol' : 'ul', { class: 'cj-md-list' });
  for (const item of block.items || []) {
    const li = h('li', { class: 'cj-md-li' });
    for (const b of item.blocks || []) {
      li.appendChild(blockEl(b));
    }
    list.appendChild(li);
  }
  return list;
}

function quoteEl(block: Extract<Block, { type: 'quote' }>): HTMLElement {
  const q = h('blockquote', { class: 'cj-md-quote' });
  for (const b of block.blocks || []) {
    q.appendChild(blockEl(b));
  }
  return q;
}

function codeEl(block: Extract<Block, { type: 'code' }>): HTMLElement {
  const code = h('code', { class: 'cj-md-code' }, [block.text]);
  return h('pre', { class: 'cj-md-pre' }, [code]);
}

function paragraphEl(block: Extract<Block, { type: 'paragraph' }>): HTMLElement {
  const p = h('p', { class: 'cj-md-p' });
  renderInlineNodes(block.inline, p);
  return p;
}

function blockEl(block: Block): HTMLElement {
  switch (block.type) {
    case 'heading': return headingEl(block);
    case 'paragraph': return paragraphEl(block);
    case 'list': return listEl(block);
    case 'quote': return quoteEl(block);
    case 'code': return codeEl(block);
    case 'hr': return h('hr', { class: 'cj-md-hr' });
  }
}

/* ---------------- 对外渲染 ---------------- */

export interface RenderOpts {
  /** 段落组包裹 div 渲染完成时回调（el 为组 div，group 为段落序号）——札记段落标注的挂钩点 */
  onGroup?: (el: HTMLElement, group: number) => void;
  /** 每个块元素渲染完成时回调 */
  onBlock?: (el: HTMLElement) => void;
}

/**
 * 渲染一段 Markdown 文本。
 * 返回 DocumentFragment（brief 签名），内部结构沿用词间：
 *   div.cj-md → div.cj-md-group（每段落组一个）→ 块元素。
 * 标注按段落序号存取，组保持原样、顺序与 paragraphs() 下标一致。
 */
export function render(text: string, opts?: RenderOpts): DocumentFragment {
  const doc = parse(str(text));
  const frag = document.createDocumentFragment();
  const box = h('div', { class: 'cj-md' });
  frag.appendChild(box);

  let i = 0;
  while (i < doc.blocks.length) {
    const group = doc.blocks[i].group;
    const groupEl = h('div', { class: 'cj-md-group' });
    while (i < doc.blocks.length && doc.blocks[i].group === group) {
      const b = doc.blocks[i];
      const el = blockEl(b);
      groupEl.appendChild(el);
      if (opts && opts.onBlock) opts.onBlock(el);
      i++;
    }
    box.appendChild(groupEl);
    if (opts && opts.onGroup) opts.onGroup(groupEl, group);
  }
  return frag;
}

/**
 * 只渲染行内内容（摘要、标题旁说明这类短文本）。
 * 词间的 span.cj-md-inline 外壳不保留：fragment 本身无样式，
 * 容器类名由调用方决定（brief 签名返回 DocumentFragment）。
 */
export function renderInline(text: string): DocumentFragment {
  return inlineToFragment(parseInline(str(text)));
}
