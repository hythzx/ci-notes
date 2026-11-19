/**
 * UI 基件：徽章、相对时间、弹窗族、Toast、错误边界与卡片节。
 *
 * 语义与文案翻译自词间 web 版（web/ui.js、web/app.js、utils/util.js）：
 * relTime 沿用 formatRelative 文案，Confirm/Alert/Choose 沿用其按钮文案
 * （取消/确定、知道了、先不处理）。类名统一 cn- 前缀，样式由 Task 23 的
 * styles.css 提供，本文件只保证类名挂钩正确。
 *
 * Toast 跨视图用法：外壳挂载一次 <ToastHost />（fixed 右下容器），任意代码
 * ——包括 React 组件内外——直接调用 notifyToast('已保存') 即可弹提示，
 * 无需上下文传递；useToasts 供需要读取整个队列的组件使用。
 */
import { Component, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { PublishStatus, WritingStatus } from '../types';

/* ------------------------------------------------------------------ */
/* 徽章                                                                */
/* ------------------------------------------------------------------ */

export type ChipTone = 'verified' | 'pending' | 'personal' | 'status' | 'muted';

/** 可信度 / 状态小徽章，tone 决定配色类 */
export function Chip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return <span className={`cn-chip cn-chip-${tone}`}>{children}</span>;
}

const WRITING_LABEL: Record<WritingStatus, string> = {
  idea: '构思',
  research: '资料收集',
  draft: '草稿',
  final: '定稿',
};

const PUBLISH_LABEL: Record<PublishStatus, string> = {
  unpublished: '未发布',
  pending: '待发布',
  published: '已发布',
};

/** 发布状态配色：已发布绿、待发布黄、未发布灰 */
const PUBLISH_TONE: Record<PublishStatus, ChipTone> = {
  unpublished: 'muted',
  pending: 'pending',
  published: 'verified',
};

export interface StatusChipProps {
  writingStatus?: WritingStatus;
  publishStatus?: PublishStatus;
  pendingImport?: boolean;
  draftOf?: string;
}

/** 组合徽章：写作状态 / 发布状态 / 待导入 / 有续稿，全部为空时渲染 null */
export function StatusChip({ writingStatus, publishStatus, pendingImport, draftOf }: StatusChipProps) {
  if (!writingStatus && !publishStatus && !pendingImport && !draftOf) return null;
  return (
    <>
      {writingStatus ? <Chip tone="status">{WRITING_LABEL[writingStatus]}</Chip> : null}
      {publishStatus ? <Chip tone={PUBLISH_TONE[publishStatus]}>{PUBLISH_LABEL[publishStatus]}</Chip> : null}
      {pendingImport ? <Chip tone="pending">待导入</Chip> : null}
      {draftOf ? <Chip tone="status">有续稿</Chip> : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 相对时间                                                            */
/* ------------------------------------------------------------------ */

function pad2(n: number) {
  return n < 10 ? '0' + n : String(n);
}

function formatDate(d: Date) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function formatDateTime(d: Date) {
  return formatDate(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function sameDay(t1: number, t2: number) {
  const a = new Date(t1);
  const b = new Date(t2);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * 相对时间，逐行翻译自词间 utils/util.js formatRelative：
 * 刚刚 / n 分钟前 / n 小时前（仅当天）/ 昨天 / n 天前（<7）/ 具体日期。
 * 空值与非法时间返回空串；未来时间直接给日期时间。
 */
export function relTime(iso: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const diff = Date.now() - t;
  if (diff < 0) return formatDateTime(new Date(t));
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const hour = Math.floor(min / 60);
  if (hour < 24 && sameDay(t, Date.now())) return hour + ' 小时前';
  const day = Math.floor(hour / 24);
  if (day === 1) return '昨天';
  if (day < 7) return day + ' 天前';
  return formatDate(new Date(t));
}

/** 相对时间文本；空值 / 非法时间不渲染 */
export function RelTime({ iso }: { iso: string }) {
  const text = relTime(iso);
  return text ? <span className="cn-reltime">{text}</span> : null;
}

/* ------------------------------------------------------------------ */
/* 弹窗族                                                              */
/* ------------------------------------------------------------------ */

/**
 * 基础弹窗：遮罩（点遮罩空白处关闭）+ Esc 关闭，children 渲染在 cn-modal 卡片。
 */
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="cn-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cn-modal">
        <h3 className="cn-modal-title">{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** 弹窗按钮：variant 对应 cn-btn-{primary|danger|quiet|ghost} */
function Btn({ label, onClick, variant }: { label: string; onClick: () => void; variant: string }) {
  return (
    <button type="button" className={`cn-btn cn-btn-${variant}`} onClick={onClick}>
      {label}
    </button>
  );
}

/** 确认框：取消 / 确定，danger 时确定按钮红色 */
export function ConfirmBox({ title, message, onOk, onCancel, danger }: {
  title: string;
  message: ReactNode;
  onOk: () => void;
  onCancel: () => void;
  danger?: boolean;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="cn-modal-text">{message}</p>
      <div className="cn-modal-ops">
        <Btn label="取消" onClick={onCancel} variant="quiet" />
        <Btn label="确定" onClick={onOk} variant={danger ? 'danger' : 'primary'} />
      </div>
    </Modal>
  );
}

/** 提示框：单个「知道了」按钮 */
export function AlertBox({ title, message, onClose }: {
  title: string;
  message: ReactNode;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="cn-modal-text cn-modal-pre">{message}</p>
      <div className="cn-modal-ops">
        <Btn label="知道了" onClick={onClose} variant="primary" />
      </div>
    </Modal>
  );
}

export interface ChooseItem {
  key: string;
  label: string;
  danger?: boolean;
}

/** 多选一对话框（冲突三选一等场景）：点选项回调 key，取消走 onCancel */
export function ChooseBox({ title, message, choices, onPick, onCancel }: {
  title: string;
  message: ReactNode;
  choices: ChooseItem[];
  onPick: (key: string) => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="cn-modal-text cn-modal-pre">{message}</p>
      <div className="cn-choose-list">
        {choices.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`cn-choose-btn${c.danger ? ' cn-choose-danger' : ''}`}
            onClick={() => onPick(c.key)}
          >
            {c.label}
          </button>
        ))}
        <button type="button" className="cn-choose-btn cn-choose-quiet" onClick={onCancel}>
          先不处理
        </button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

interface ToastItem {
  id: number;
  msg: string;
}

/** 模块级 Toast 队列与订阅者集合：notifyToast 与 useToasts 共用一份状态 */
let toastSeq = 0;
let toastItems: ToastItem[] = [];
const toastSubs = new Set<(items: ToastItem[]) => void>();

function emitToasts() {
  toastSubs.forEach((fn) => fn(toastItems));
}

/**
 * 跨视图弹出提示（3 秒自动移除）。由挂载在外壳的 <ToastHost /> 展示，
 * 调用方无须持有任何状态。
 */
export function notifyToast(msg: string) {
  const id = ++toastSeq;
  toastItems = [...toastItems, { id, msg }];
  emitToasts();
  setTimeout(() => {
    toastItems = toastItems.filter((t) => t.id !== id);
    emitToasts();
  }, 3000);
}

/** 读取 Toast 队列并返回通知函数；通常视图直接用 notifyToast 即可 */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>(toastItems);
  useEffect(() => {
    toastSubs.add(setToasts);
    return () => {
      toastSubs.delete(setToasts);
    };
  }, []);
  return { toasts, notify: notifyToast };
}

/** 单条提示 */
export function Toast({ msg }: { msg: string }) {
  return <div className="cn-toast">{msg}</div>;
}

/** Toast 容器：外壳挂载一次，fixed 右下角 */
export function ToastHost() {
  const { toasts } = useToasts();
  return (
    <div className="cn-toasts">
      {toasts.map((t) => (
        <Toast key={t.id} msg={t.msg} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 错误边界与空态                                                       */
/* ------------------------------------------------------------------ */

/** 捕获子树 render 错误：显示「出错了」+ 错误消息，「重试」清 state 重新渲染子树 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[ci-notes] 渲染错误：', error);
  }

  render() {
    const err = this.state.error;
    if (!err) return this.props.children;
    return (
      <div className="cn-error">
        <div className="cn-error-title">出错了</div>
        <div className="cn-error-msg">{err.message}</div>
        <button type="button" className="cn-btn cn-btn-ghost" onClick={() => this.setState({ error: null })}>
          重试
        </button>
      </div>
    );
  }
}

/** 空列表占位 */
export function EmptyState({ text }: { text: string }) {
  return (
    <div className="cn-empty">
      <div>{text}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 卡片节                                                              */
/* ------------------------------------------------------------------ */

/** 通用卡片节：标题行 + aside 插槽（操作按钮等）+ 内容 */
export function Section({ title, children, aside }: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="cn-section">
      <header className="cn-section-head">
        <span className="cn-section-title">{title}</span>
        {aside ? <span className="cn-section-aside">{aside}</span> : null}
      </header>
      <div className="cn-section-body">{children}</div>
    </section>
  );
}
