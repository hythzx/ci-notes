# 划选标注与虚线回显 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 详情页（札记 + 词作）划选任意文字范围创建资料标注，重进时以三色虚线回显，点虚线回看标注。

**Architecture:** Claim 扩展可选 `anchor: {quote, prefix, suffix}`（引文式锚点，服务端 normalizeClaims 归一化）；新增 `src/annotate.ts`（纯函数定位 + DOM 虚线绘制）与 `src/components/annotate.tsx`（划选捕获 hook + 创建 Modal）；两个详情页接入，保存走现有 update API（定稿札记自然派生草稿）。

**Tech Stack:** React 19 + TypeScript + Vite；Node 24 原生 http + node:sqlite；node:test + assert/strict。

**Spec:** `docs/superpowers/specs/2026-11-21-selection-annotation-design.md`

## Global Constraints

- 后端零 npm 运行时依赖；测试框架只用 node:test + node:assert/strict
- 注释与文案用书面中文，对齐现有 `cj-` / `cn-` 类名与变量命名（`--green/--warn/--purple/--paper/--ink-3`）
- 锚点前后文取样长度 `ANCHOR_CONTEXT = 16`，前端 `src/annotate.ts` 与服务端 `normalize.mjs` 保持一致
- 定稿/已发布札记的标注保存必须走现有 createdDraft 分支，不改服务端保护逻辑
- 词作锚点标注 `paragraph = -1`（整篇锚定）；札记锚点标注 `paragraph = 段落组号`
- 每个任务完成即 commit；`npm test` 与 `npm run build`（含 tsc --noEmit）全绿后才可进入下一任务
- 不引入任何新依赖；不改 `docs/`、`scripts/`、CI 配置

---

### Task 1: ClaimAnchor 类型 + 服务端锚点归一化

**Files:**
- Modify: `src/types.ts`（Claim 接口处，约 28-36 行）
- Modify: `server/core/normalize.mjs`（normalizeClaims，约 110-131 行）
- Test: `test/normalize.test.mjs`

**Interfaces:**
- Produces: `ClaimAnchor` 接口（`quote/prefix/suffix` 三字段，均 string）；`Claim.anchor?: ClaimAnchor`；服务端归一化后 claim 可能带 `anchor` 对象（quote 非空才保留，prefix/suffix 各截 16 字）

- [ ] **Step 1: 在 test/normalize.test.mjs 末尾追加失败测试**

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test 2>&1 | grep -A 3 "锚点"`
Expected: FAIL（`c.anchor` 为 undefined，第一条断言抛 TypeError）

- [ ] **Step 3: 在 src/types.ts 的 Claim 接口前加 ClaimAnchor 并扩展 Claim**

```ts
/** 文字范围锚点：引文 + 前后文各 ≤16 字，用于详情页虚线定位（划选标注） */
export interface ClaimAnchor {
  quote: string;
  prefix: string;
  suffix: string;
}

export interface Claim {
  id: string;
  kind: ClaimKind;
  text: string;
  paragraph: number;
  citations: Citation[];
  /** 有 anchor = 文字范围标注；无 = 整段 / 不挂段落（兼容旧数据） */
  anchor?: ClaimAnchor;
  createdAt?: string;
  updatedAt?: string;
}
```

- [ ] **Step 4: 在 server/core/normalize.mjs 增加 normalizeAnchor 并接入 normalizeClaims**

在 `normalizeClaims` 上方新增：

```js
/** 锚点前后文取样长度（与前端 src/annotate.ts 的 ANCHOR_CONTEXT 一致） */
const ANCHOR_CONTEXT = 16;

/** 锚点归一化：quote 非空才保留整个 anchor，prefix/suffix 各截 16 字 */
function normalizeAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') return undefined;
  const quote = typeof anchor.quote === 'string' ? anchor.quote.trim() : '';
  if (!quote) return undefined;
  return {
    quote,
    prefix: typeof anchor.prefix === 'string' ? anchor.prefix.slice(0, ANCHOR_CONTEXT) : '',
    suffix: typeof anchor.suffix === 'string' ? anchor.suffix.slice(0, ANCHOR_CONTEXT) : ''
  };
}
```

`normalizeClaims` 的 `out.push({...})` 改为（在 paragraph 行之后插入 anchor）：

```js
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
```

- [ ] **Step 5: 运行测试确认全部通过**

Run: `npm test`
Expected: PASS（既有测试不受影响）

- [ ] **Step 6: Commit**

```bash
git add src/types.ts server/core/normalize.mjs test/normalize.test.mjs
git commit -m "feat(claims): 引文式锚点数据模型与服务端归一化"
```

---

### Task 2: src/annotate.ts 定位与绘制

**Files:**
- Create: `src/annotate.ts`
- Test: `test/annotate.test.mjs`

**Interfaces:**
- Consumes: `Claim`（含 Task 1 的 `anchor?`）
- Produces:
  - `ANCHOR_CONTEXT = 16`
  - `locateAnchor(text: string, anchor: {quote,prefix,suffix}): [number, number] | null`
  - `markRanges(claims: Claim[], text: string): { claim: Claim; start: number; end: number }[]`
  - `collectTextNodes(host: HTMLElement): { node: Text; start: number; end: number }[]`
  - `drawMarks(host: HTMLElement, claims: Claim[], onClick: (claim: Claim) => void): () => void`（返回清理函数）

- [ ] **Step 1: 新建 test/annotate.test.mjs（失败测试，只测纯函数）**

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test 2>&1 | grep annotate`
Expected: FAIL（模块不存在，Cannot find module）

- [ ] **Step 3: 新建 src/annotate.ts**

```ts
/**
 * 划选标注工具：引文式锚点定位与虚线绘制。
 *
 * 锚点存 quote（选中原文）+ prefix/suffix（前后文各 ≤16 字）。定位在容器
 * 文本节点串联出的纯文本上进行；正文改动导致失配时降级不画，标注仍可在
 * 资料区与段落 Modal 查看。规格见 docs/superpowers/specs/
 * 2026-11-21-selection-annotation-design.md。
 */
import type { Claim } from './types';

/** 锚点前后文取样长度（与服务端 normalize.mjs 的 ANCHOR_CONTEXT 一致） */
export const ANCHOR_CONTEXT = 16;

export interface AnchorRange {
  claim: Claim;
  start: number;
  end: number;
}

/**
 * 在 text 中定位 anchor，返回 [start, end)。
 * 枚举 quote 全部出现位置并按 prefix/suffix 匹配计分：双端 > 单端 > 首个；
 * 有前后文却全都对不上时视为正文已改，返回 null（降级不画）。
 */
export function locateAnchor(
  text: string,
  anchor: { quote: string; prefix: string; suffix: string },
): [number, number] | null {
  const quote = anchor.quote;
  if (!quote) return null;
  let best: { at: number; score: number } | null = null;
  let at = text.indexOf(quote);
  while (at >= 0) {
    let score = 0;
    if (anchor.prefix && text.slice(at - anchor.prefix.length, at) === anchor.prefix) score++;
    if (anchor.suffix && text.slice(at + quote.length, at + quote.length + anchor.suffix.length) === anchor.suffix) score++;
    if (!best || score > best.score) best = { at, score };
    if (score === 2) break; // 双端唯一命中，提前结束
    at = text.indexOf(quote, at + 1);
  }
  if (!best) return null;
  if (!!(anchor.prefix || anchor.suffix) && best.score === 0) return null;
  return [best.at, best.at + quote.length];
}

/** 带锚点 claims 全部定位，按 start 升序；与前者重叠的后一条跳过（前一条优先） */
export function markRanges(claims: Claim[], text: string): AnchorRange[] {
  const located: AnchorRange[] = [];
  for (const claim of claims) {
    if (!claim.anchor) continue;
    const hit = locateAnchor(text, claim.anchor);
    if (!hit) continue;
    located.push({ claim, start: hit[0], end: hit[1] });
  }
  located.sort((a, b) => a.start - b.start);
  const out: AnchorRange[] = [];
  for (const r of located) {
    const last = out[out.length - 1];
    if (last && r.start < last.end) continue;
    out.push(r);
  }
  return out;
}

interface NodeSlice {
  node: Text;
  /** 该文本节点在容器纯文本中的起止偏移 */
  start: number;
  end: number;
}

/** TreeWalker 收集 host 下全部文本节点及其在容器纯文本中的偏移区间 */
export function collectTextNodes(host: HTMLElement): NodeSlice[] {
  const out: NodeSlice[] = [];
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let start = 0;
  let cur = walker.nextNode() as Text | null;
  while (cur) {
    out.push({ node: cur, start, end: start + cur.data.length });
    start += cur.data.length;
    cur = walker.nextNode() as Text | null;
  }
  return out;
}

/**
 * 在 host 上绘制锚点虚线：区间切片到文本节点，同节点内从后往前拆分并包
 * span.cj-mark.cj-mark-{kind}，点击回调并阻断冒泡（避免误触段落点击）。
 * 返回清理函数：拆掉 span 还原文本，供重绘前清理。
 */
export function drawMarks(host: HTMLElement, claims: Claim[], onClick: (claim: Claim) => void): () => void {
  const table = collectTextNodes(host);
  const text = table.map((t) => t.node.data).join('');
  const ranges = markRanges(claims, text);
  const spans: HTMLSpanElement[] = [];

  // 每条区间映射到若干 (node, from, to) 切片
  const slices: { node: Text; from: number; to: number; range: AnchorRange }[] = [];
  for (const range of ranges) {
    for (const t of table) {
      if (t.end <= range.start || t.start >= range.end) continue;
      slices.push({
        node: t.node,
        from: Math.max(range.start, t.start) - t.start,
        to: Math.min(range.end, t.end) - t.start,
        range,
      });
    }
  }

  // 同节点切片从后往前拆：先拆不影响后面（更靠前）切片的偏移
  const byNode = new Map<Text, typeof slices>();
  for (const s of slices) {
    const list = byNode.get(s.node);
    if (list) list.push(s);
    else byNode.set(s.node, [s]);
  }
  for (const [node, list] of byNode) {
    list.sort((a, b) => b.from - a.from);
    for (const s of list) {
      // node 拆成 [0,from) + tail；tail 再拆出 [from,to) 与其后半
      const tail = node.splitText(s.from);
      if (s.to - s.from < tail.data.length) tail.splitText(s.to - s.from);
      const span = document.createElement('span');
      span.className = 'cj-mark cj-mark-' + s.range.claim.kind;
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick(s.range.claim);
      });
      const parent = tail.parentNode;
      if (parent) {
        parent.insertBefore(span, tail);
        span.appendChild(tail);
        spans.push(span);
      }
    }
  }

  return () => {
    for (const span of spans) {
      const parent = span.parentNode;
      if (!parent) continue;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      span.remove();
    }
    host.normalize();
  };
}
```

- [ ] **Step 4: 运行测试确认全部通过**

Run: `npm test`
Expected: PASS（annotate 9 条 + 既有全部）

- [ ] **Step 5: Commit**

```bash
git add src/annotate.ts test/annotate.test.mjs
git commit -m "feat(annotate): 引文式锚点定位与虚线绘制工具"
```

---

### Task 3: 划选交互组件 + ClaimPanel 导出 + CSS

**Files:**
- Create: `src/components/annotate.tsx`
- Modify: `src/components/editors.tsx`（ClaimPanel：export + lockParagraph prop，约 331-390 行）
- Modify: `src/styles.css`（文件末尾追加）

**Interfaces:**
- Consumes: `collectTextNodes`、`ANCHOR_CONTEXT`（Task 2）；`ClaimPanel`（editors.tsx）；`Modal`（ui.tsx）
- Produces:
  - `SelectionPick`：`{ paragraph: number; quote: string; prefix: string; suffix: string }`
  - `useSelectionAnnotate(opts: { containerRef: RefObject<HTMLElement | null>; enabled?: boolean; locate: (range: Range) => { paragraph: number; host: HTMLElement } | null; onReject?: () => void; onPick: (pick: SelectionPick) => void })`（locate 返回宿主元素；quote/prefix/suffix 相对宿主文本采样，保证与恢复时同段一致）
  - `AnnotateModal({ pick, onSave, onClose })`
  - `ClaimPanel` 新增可选 prop `lockParagraph?: boolean`（隐藏挂靠段号字段，段号取 initial）

- [ ] **Step 1: 修改 src/components/editors.tsx 的 ClaimPanel**

函数签名改为导出并加 lockParagraph：

```tsx
export function ClaimPanel({ initial, onSave, onCancel, lockParagraph }: {
  initial: Claim;
  onSave: (claim: Claim) => void;
  onCancel: () => void;
  /** 阅读页划选创建用：隐藏挂靠段号字段，段号以 initial 为准 */
  lockParagraph?: boolean;
}) {
```

挂靠段落的 Field 改为条件渲染（其余不动）：

```tsx
      {lockParagraph ? null : (
        <Field label="挂靠段落" hint="对应正文第几段（从 0 起）；留空或 -1 表示不挂段落">
          <Input type="number" min={-1} value={para} onChange={(e) => setPara(e.target.value)} />
        </Field>
      )}
```

save() 不需要改：para state 初始化自 `initial.paragraph`（≥0 时为段号字符串，-1 时为 ''，save 解析回 -1），锁定时仍走原逻辑。

- [ ] **Step 2: 新建 src/components/annotate.tsx**

```tsx
/**
 * 划选标注交互：容器内划选文字 → 浮出「标注」按钮 → 创建标注 Modal。
 * 札记（逐段容器）与词作（整篇 pre）共用：
 *   - useSelectionAnnotate 负责选区捕获、偏移计算、按钮定位与生命周期；
 *   - locate 回调由页面提供（返回宿主元素与段落号；札记校验同段并返回
 *     段号，跨段返回 null；词作返回 pre 与 -1）；
 *   - AnnotateModal 复用 editors 的 ClaimPanel（lockParagraph 隐藏段号）。
 */
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { ANCHOR_CONTEXT, collectTextNodes } from '../annotate';
import type { Claim } from '../types';
import { Modal } from './ui';
import { ClaimPanel } from './editors';

/** 一次可创建的划选标注：段落号 + 引文式锚点三要素 */
export interface SelectionPick {
  paragraph: number;
  quote: string;
  prefix: string;
  suffix: string;
}

type OffsetTable = ReturnType<typeof collectTextNodes>;

/** (node, offset) → 容器纯文本偏移；节点不在表内返回 null */
function toGlobalOffset(node: Node, offset: number, table: OffsetTable): number | null {
  for (const t of table) {
    if (t.node === node) return t.start + offset;
  }
  return null;
}

/**
 * Range 边界转全局偏移；边界落在元素上时（选区从元素边缘起拖）取该元素
 * 内首个 / 末个文本节点近似。解析不出返回 null。
 */
function resolveBoundary(node: Node, offset: number, side: 'start' | 'end', table: OffsetTable): number | null {
  const exact = toGlobalOffset(node, offset, table);
  if (exact !== null) return exact;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const kids = table.filter((t) => el.contains(t.node));
  if (!kids.length) return null;
  return side === 'start' ? kids[0].start : kids[kids.length - 1].end;
}

interface SelectionAnnotateOptions {
  /** 划选监听容器（札记文章根 / 词作原文 pre） */
  containerRef: RefObject<HTMLElement | null>;
  /** 容器就绪后才挂监听（详情加载完成前容器未渲染） */
  enabled?: boolean;
  /** 选区在容器内时调用：返回可标的宿主元素与段落号；null 表示不可标（如跨段） */
  locate: (range: Range) => { paragraph: number; host: HTMLElement } | null;
  /** locate 返回 null 时的提示（如「请在一段之内选择」） */
  onReject?: () => void;
  /** 点击浮动按钮后回调 */
  onPick: (pick: SelectionPick) => void;
}

export function useSelectionAnnotate(opts: SelectionAnnotateOptions) {
  const latest = useRef(opts);
  latest.current = opts;
  const { containerRef, enabled = true } = opts;

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    let fab: HTMLButtonElement | null = null;

    function hideFab() {
      if (fab) fab.remove();
      fab = null;
    }

    function showFab(rect: DOMRect, pick: SelectionPick) {
      hideFab();
      fab = document.createElement('button');
      fab.type = 'button';
      fab.className = 'cj-annotate-fab';
      fab.textContent = '标注';
      // 按钮自身不触发文档级 pointerdown（否则刚出现即被收走）
      fab.addEventListener('pointerdown', (e) => e.stopPropagation());
      fab.addEventListener('click', (e) => {
        e.stopPropagation();
        hideFab();
        latest.current.onPick(pick);
      });
      fab.style.left = Math.round(rect.left + rect.width / 2) + 'px';
      fab.style.top = Math.round(rect.bottom + 6) + 'px';
      document.body.appendChild(fab);
    }

    function onUp() {
      hideFab();
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount !== 1) return;
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) return;
      const target = latest.current.locate(range);
      if (!target) {
        latest.current.onReject?.();
        return;
      }
      // 锚点相对宿主（段落组 / 词作 pre）文本采样，与恢复时 drawMarks 的宿主一致
      const table = collectTextNodes(target.host);
      const start = resolveBoundary(range.startContainer, range.startOffset, 'start', table);
      const end = resolveBoundary(range.endContainer, range.endOffset, 'end', table);
      if (start === null || end === null || end <= start) return;
      const text = table.map((t) => t.node.data).join('');
      const quote = text.slice(start, end);
      if (!quote.trim()) return;
      showFab(range.getBoundingClientRect(), {
        paragraph: target.paragraph,
        quote,
        prefix: text.slice(Math.max(0, start - ANCHOR_CONTEXT), start),
        suffix: text.slice(end, end + ANCHOR_CONTEXT),
      });
    }

    function onDocDown(e: PointerEvent) {
      if (fab && !fab.contains(e.target as Node)) hideFab();
    }
    function onSelectionChange() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) hideFab();
    }

    container.addEventListener('pointerup', onUp);
    document.addEventListener('pointerdown', onDocDown);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      hideFab();
      container.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointerdown', onDocDown);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [enabled, containerRef]);
}

/** 创建标注 Modal：顶部展示选中引文，下方 ClaimPanel（段号锁定不可改） */
export function AnnotateModal({ pick, onSave, onClose }: {
  pick: SelectionPick;
  onSave: (claim: Claim) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="添加标注" onClose={onClose}>
      <div className="cj-markquote cj-serif">“{pick.quote}”</div>
      <ClaimPanel
        lockParagraph
        initial={{
          id: '',
          kind: 'pending',
          text: '',
          paragraph: pick.paragraph,
          anchor: { quote: pick.quote, prefix: pick.prefix, suffix: pick.suffix },
          citations: [],
        }}
        onSave={onSave}
        onCancel={onClose}
      />
    </Modal>
  );
}
```

- [ ] **Step 3: 在 src/styles.css 末尾追加样式**

```css
/* 划选标注：三色虚线 + 浮动「标注」按钮 + 引文预览 */
.cj-mark { cursor: pointer; border-radius: 2px; }
.cj-mark-verified,
.cj-mark-pending,
.cj-mark-personal {
  text-decoration: underline dashed;
  text-decoration-thickness: 1.5px;
  text-underline-offset: 3px;
}
.cj-mark-verified { text-decoration-color: var(--green); }
.cj-mark-pending { text-decoration-color: var(--warn); }
.cj-mark-personal { text-decoration-color: var(--purple); }
.cj-annotate-fab {
  position: fixed;
  z-index: 80;
  transform: translateX(-50%);
  padding: 4px 12px;
  border: 1px solid var(--ink-3);
  border-radius: 999px;
  background: var(--paper);
  color: var(--ink);
  font-size: 13px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}
.cj-markquote {
  margin: 0 0 12px;
  padding: 8px 12px;
  background: var(--paper-2);
  border-left: 3px solid #d8d2c4;
  border-radius: 4px;
  font-size: 15px;
}
```

- [ ] **Step 4: 编译验证**

Run: `npm run build`
Expected: tsc --noEmit + vite build 成功

- [ ] **Step 5: Commit**

```bash
git add src/components/annotate.tsx src/components/editors.tsx src/styles.css
git commit -m "feat(annotate): 划选捕获与创建标注组件"
```

---

### Task 4: 札记详情页接入

**Files:**
- Modify: `src/views/notes.tsx`（ClaimRow 约 159-171 行；NoteDetail 约 300-612 行）

**Interfaces:**
- Consumes: `drawMarks`（Task 2）；`AnnotateModal`/`useSelectionAnnotate`/`SelectionPick`（Task 3）；`api.notes.update` 返回 `SaveNoteResult`；`Claim.anchor`

- [ ] **Step 1: 顶部导入**

```tsx
import { drawMarks } from '../annotate';
import { AnnotateModal, useSelectionAnnotate } from '../components/annotate';
import type { SelectionPick } from '../components/annotate';
```

并在模块顶层（`isProtected` 附近）加组定位 helper：

```tsx
/** Range 边界所在节点向上找段落组元素（划选定位用；文本节点取父元素） */
function groupOf(node: Node): HTMLElement | null {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  return el ? el.closest('.cj-md-group') : null;
}
```

- [ ] **Step 2: ClaimRow 增加锚点展示行（ cj-claim-text 之后）**

```tsx
      {claim.anchor?.quote ? <div className="cj-claim-cite">标注范围：{claim.anchor.quote}</div> : null}
```

- [ ] **Step 3: NoteDetail 增加状态与 hook（在 `paraModal` state 之后）**

```tsx
  const [annotatePick, setAnnotatePick] = useState<SelectionPick | null>(null);
  const [markModal, setMarkModal] = useState<Claim | null>(null);
  /** 划选标注保存后若派生草稿（定稿/已发布），供 ChooseBox 跳转 */
  const [derivedDraft, setDerivedDraft] = useState<Note | null>(null);
  const articleRef = useRef<HTMLDivElement>(null);
```

在 `marks` useMemo 之后加划选 hook（enabled 随 detail 就绪）：

```tsx
  /* 划选标注：选区必须完整落在同一段落组内，跨段拒绝 */
  useSelectionAnnotate({
    containerRef: articleRef,
    enabled: !!detail,
    locate: (range) => {
      const el = groupOf(range.startContainer);
      if (!el || el !== groupOf(range.endContainer)) return null;
      const g = Number(el.dataset.group);
      return Number.isInteger(g) && g >= 0 ? { paragraph: g, host: el } : null;
    },
    onReject: () => notifyToast('请在一段之内选择'),
    onPick: (pick) => setAnnotatePick(pick),
  });
```

- [ ] **Step 4: attachMarks 扩展（dataset + 划选守卫 + 虚线绘制）**

整体替换为：

```tsx
  function attachMarks(el: HTMLElement, group: number) {
    el.className = 'cj-para cj-md-group';
    el.dataset.group = String(group);
    el.addEventListener('click', () => {
      // 划选结束的 click（选区非空）不当段落点击
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      setParaModal(group);
    });
    const list = marks.get(group);
    if (list && list.length) {
      const box = document.createElement('div');
      box.className = 'cj-para-marks';
      for (const c of list) {
        const chip = document.createElement('span');
        chip.className = 'cn-chip cn-chip-' + c.kind;
        chip.textContent = CLAIM_GROUP_LABEL[c.kind];
        box.appendChild(chip);
      }
      el.appendChild(box);
    }
    // 带锚点的条目画虚线；点击虚线弹单条标注 Modal
    const anchored = (list || []).filter((c) => c.anchor && c.anchor.quote);
    if (anchored.length) drawMarks(el, anchored, (c) => setMarkModal(c));
  }
```

- [ ] **Step 5: 保存函数（在 remove() 之后加）**

```tsx
  /** 划选标注落库：claims 追加一条带 baseRevision 保存；定稿/已发布走派生草稿分支 */
  function saveAnnotation(claim: Claim) {
    if (!detail) return;
    const claims = [...detail.note.claims, claim];
    api.notes.update(detail.note.id, { claims, baseRevision: detail.note.revision }).then(
      (res) => {
        setAnnotatePick(null);
        if (res.createdDraft) {
          setDerivedDraft(res.draft);
        } else {
          notifyToast('已标注');
          load();
        }
      },
      (e: unknown) => {
        notifyToast(
          e instanceof ApiError && e.code === 'CONFLICT'
            ? '内容在别处被改过，请刷新后重试'
            : e instanceof ApiError ? e.message : '标注保存失败',
        );
      },
    );
  }
```

- [ ] **Step 6: JSX 接线**

正文容器加 ref，Md 加 key（revision 变化重挂 → attachMarks 重画虚线）：

```tsx
      <div className="cj-article" ref={articleRef}>
        {hasContent ? (
          <Md key={n.revision} text={n.content} onGroup={attachMarks} />
        ) : (
          <EmptyState text="正文待导入。点「编辑」把你写的原稿贴进来。" />
        )}
      </div>
```

段落 Modal 之后追加三个 Modal：

```tsx
      {annotatePick ? (
        <AnnotateModal
          pick={annotatePick}
          onSave={saveAnnotation}
          onClose={() => setAnnotatePick(null)}
        />
      ) : null}

      {markModal ? (
        <Modal title="标注" onClose={() => setMarkModal(null)}>
          <div className="cj-card">
            <ClaimRow claim={markModal} />
          </div>
        </Modal>
      ) : null}

      {derivedDraft ? (
        <ChooseBox
          title="原版已保留，另起新草稿"
          message="这篇已经定稿或标记为已发布，内容一字未动。你的标注存成了一篇新草稿。"
          choices={[{ key: 'go', label: '去看新草稿' }]}
          onPick={(key) => {
            const d = derivedDraft;
            setDerivedDraft(null);
            if (key === 'go' && d) navigate('#/notes/' + d.id + '/edit');
          }}
          onCancel={() => setDerivedDraft(null)}
          cancelLabel="留在原篇"
        />
      ) : null}
```

- [ ] **Step 7: 编译 + 全量测试**

Run: `npm run build && npm test`
Expected: 全部通过

- [ ] **Step 8: Commit**

```bash
git add src/views/notes.tsx
git commit -m "feat(notes): 详情页划选标注与虚线回显"
```

---

### Task 5: 词作详情页接入

**Files:**
- Modify: `src/views/works.tsx`（imports 约 15-50 行；WorkDetail 约 256-470 行；claim 行约 383 行；原文 pre 约 360 行）

**Interfaces:**
- Consumes: 同 Task 4；`api.works.update` 返回 `{ work: Work }`；works 无保护模型，无 ChooseBox

- [ ] **Step 1: 顶部导入**

```tsx
import { drawMarks } from '../annotate';
import { AnnotateModal, useSelectionAnnotate } from '../components/annotate';
import type { SelectionPick } from '../components/annotate';
```

`ui` 导入清单里补 `Modal`（现无）。

- [ ] **Step 2: WorkDetail 状态与 hook（在 `removing` state 之后、`load` 之前加）**

```tsx
  const [annotatePick, setAnnotatePick] = useState<SelectionPick | null>(null);
  const [markModal, setMarkModal] = useState<Claim | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
```

在 `useEffect(load, [id])` 之后加（early return 之前，hook 须无条件调用）：

```tsx
  /* 划选标注：词作原文整篇可标（paragraph=-1），无段落边界 */
  useSelectionAnnotate({
    containerRef: preRef,
    enabled: !!detail,
    locate: () => (preRef.current ? { paragraph: -1, host: preRef.current } : null),
    onPick: (pick) => setAnnotatePick(pick),
  });

  /* 原文锚点虚线：词作变更时重绘，清理函数拆旧 span 防叠加 */
  const work = detail?.work;
  useEffect(() => {
    const el = preRef.current;
    if (!el || !work) return;
    const anchored = work.claims.filter((c) => c.anchor && c.anchor.quote);
    if (!anchored.length) return;
    return drawMarks(el, anchored, (c) => setMarkModal(c));
  }, [work]);
```

- [ ] **Step 3: 保存函数（在 remove() 之后加）**

```tsx
  /** 划选标注落库：claims 追加一条带 baseRevision 保存（词作无保护模型） */
  function saveAnnotation(claim: Claim) {
    if (!detail) return;
    const claims = [...detail.work.claims, claim];
    api.works.update(detail.work.id, { claims, baseRevision: detail.work.revision }).then(
      () => {
        setAnnotatePick(null);
        notifyToast('已标注');
        load();
      },
      (e: unknown) => {
        notifyToast(
          e instanceof ApiError && e.code === 'CONFLICT'
            ? '内容在别处被改过，请刷新后重试'
            : e instanceof ApiError ? e.message : '标注保存失败',
        );
      },
    );
  }
```

- [ ] **Step 4: JSX 接线**

原文 pre 加 ref：

```tsx
            <pre ref={preRef} className="cj-poem" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{w.content}</pre>
```

「资料与可信度」的 claim 行（`cj-claim-text` 之后）加锚点展示：

```tsx
                  {c.anchor?.quote ? <div className="cj-claim-cite">标注范围：{c.anchor.quote}</div> : null}
```

组件 JSX 末尾（ConfirmBox 附近）追加：

```tsx
      {annotatePick ? (
        <AnnotateModal
          pick={annotatePick}
          onSave={saveAnnotation}
          onClose={() => setAnnotatePick(null)}
        />
      ) : null}

      {markModal ? (
        <Modal title="标注" onClose={() => setMarkModal(null)}>
          <div className="cj-card">
            <div className="cj-claim">
              <Chip tone={markModal.kind}>{CLAIM_GROUP_LABEL[markModal.kind]}</Chip>
              <div className="cj-claim-text">
                <Md text={markModal.text} inline />
              </div>
              {markModal.anchor?.quote ? <div className="cj-claim-cite">标注范围：{markModal.anchor.quote}</div> : null}
              {markModal.citations.filter(citationHasContent).map((x, j) => (
                <div className="cj-claim-cite" key={x.id || `cite-${j}`}>出处：{citationLine(x)}</div>
              ))}
            </div>
          </div>
        </Modal>
      ) : null}
```

- [ ] **Step 5: 编译 + 全量测试**

Run: `npm run build && npm test`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add src/views/works.tsx
git commit -m "feat(works): 词作详情页划选标注与虚线回显"
```

---

### Task 6: ClaimsEditor 锚点展示 + 收尾验证与版本

**Files:**
- Modify: `src/components/editors.tsx`（ClaimsEditor 收起行，约 295-313 行）
- Modify: `package.json`（version 2.0.5 → 2.1.0）

**Interfaces:**
- Consumes: `Claim.anchor`

- [ ] **Step 1: ClaimsEditor 收起行加锚点展示（cn-claim-text 之后）**

```tsx
          {c.anchor?.quote ? <div className="cn-claim-cite">标注范围：{c.anchor.quote}</div> : null}
```

- [ ] **Step 2: 版本号升 2.1.0**

`package.json`：`"version": "2.0.5"` → `"version": "2.1.0"`

- [ ] **Step 3: 全量验证**

Run: `npm test && npm run build`
Expected: 全部通过

- [ ] **Step 4: Commit**

```bash
git add src/components/editors.tsx package.json
git commit -m "chore(release): 2.1.0 — 编辑页展示标注范围，发布划选标注"
```

---

## 手动验收清单（部署前在本地 dev 或部署后执行）

1. 札记详情页：划选一句 → 浮出「标注」→ 填内容保存 → toast「已标注」→ 虚线立即出现
2. 刷新页面 → 虚线仍在；点虚线 → 单条标注 Modal（含标注范围与出处）
3. 划选跨两段 → toast「请在一段之内选择」，不出现按钮
4. 定稿札记：划选保存 → ChooseBox「去看新草稿 / 留在原篇」；原版虚线不变
5. 词作详情页：原文划选任意范围（含跨行）→ 保存 → 虚线回显；点虚线看标注
6. 编辑页改札记正文（使锚点失配）→ 详情页不画错位虚线，标注仍在资料区可见且带「标注范围」
7. 编辑页 ClaimsEditor 里带锚点的条目显示「标注范围：…」
