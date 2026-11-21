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
    const current = containerRef.current;
    if (!current) return;
    // 下方监听器为提升的函数声明，TS 窄化不传入其闭包，需显式绑定非空容器
    const container: HTMLElement = current;

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
      fab.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault(); // 防个别引擎 button 按下即塌陷选区，导致 selectionchange 先收走按钮
      });
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
