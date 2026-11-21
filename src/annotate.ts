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
