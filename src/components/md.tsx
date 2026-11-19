/**
 * Md 渲染包装组件：React 与自绘 DOM 的桥。
 *
 * src/markdown.ts 的 render/renderInline 直接操作 DOM（不走 innerHTML），
 * React 不参与这些子节点的 diff —— 本组件持有容器 ref，在 useEffect 里
 * 清空后整体挂载 render 产物。后续 text 变化时重建，中间态不保留。
 *
 * 挂载逻辑与 render 的 API 对齐：render 返回的 fragment 自带 div.cj-md
 * 外壳与逐段的 div.cj-md-group，onGroup 在组元素装好后即回调（此刻
 * fragment 尚未挂进容器，回调拿到的是组元素引用，先存后用即可）。
 * 段落序号与 paragraphs(text) 下标一致，claims.paragraph 依赖此约定。
 *
 * onGroup 经 latest-ref 传入：effect 依赖保持 [text, inline]（brief 约定），
 * 父组件每次渲染传新闭包也不会触发重建或捕获旧引用。
 */
import { useEffect, useRef } from 'react';
import { render, renderInline } from '../markdown';

export interface MdProps {
  text: string;
  /** true 时只渲染行内内容（摘要、标题旁说明等短文本） */
  inline?: boolean;
  /** 段落组挂载回调：el 为该段组包裹元素，group 为段落序号 */
  onGroup?: (el: HTMLElement, group: number) => void;
}

export function Md({ text, inline, onGroup }: MdProps) {
  const ref = useRef<HTMLDivElement>(null);
  const groupCb = useRef(onGroup);
  groupCb.current = onGroup;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (inline) {
      el.replaceChildren(renderInline(text));
    } else {
      el.replaceChildren(render(text, { onGroup: (g, n) => groupCb.current?.(g, n) }));
    }
  }, [text, inline]);

  return (
    <div
      ref={ref}
      className={inline ? 'cj-md cj-md-inline' : 'cj-md'}
      style={{ overflowWrap: 'break-word' }}
    />
  );
}
