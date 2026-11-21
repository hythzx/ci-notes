/**
 * 编辑器组件：表单基件、分段按钮、标签输入、资料标注与引用出处编辑器。
 *
 * 语义与文案翻译自词间 web 版（web/components/editors.js、web/ui.js）：
 * claim/citation 的字段、占位文案、空态文案、verified 门禁沿用词间；
 * switcher/tagInput 的交互沿用 cj-kind / cj-tagwrap，类名换 cn- 前缀，
 * 样式由 Task 23 的 styles.css 提供，本文件只保证类名挂钩正确。
 *
 * 与词间实现的三处差异（均为 brief 决策）：
 *   1. 全部受控组件（value/onChange），不持久内部状态（仅输入草稿）；
 *      词间的「编辑草稿 → 存下这条」模式保留在 ClaimsEditor（草稿即输入草稿），
 *      CitationsEditor 直接逐行受控编辑，改动即抛。
 *   2. 新增条目不生成前端 id，提交空 id 由服务端 normalizeClaims /
 *      normalizeCitations 补（c.id || newId(...)）。因此列表增删改按数组
 *      下标定位，不按 id —— 多条空 id 共存时 id 定位会互相误伤。
 *   3. 编辑面板打开期间禁用其它行的操作按钮：下标定位依赖 value 稳定，
 *      编辑中途删行会使面板落点错位。
 *
 * verified 门禁按「有实际内容的出处」判定（book/edition/page/url 任一非空，
 * 与词间一致）：存稿时过滤全空出处行，避免出现空行凑数绕过服务端
 * 「已核实的资料需要至少一条出处」的强校验。
 */
import { useState } from 'react';
import type { InputHTMLAttributes, KeyboardEvent, ReactNode, TextareaHTMLAttributes } from 'react';
import type { Claim, ClaimKind, Citation } from '../types';
import { Chip, EmptyState, notifyToast } from './ui';

/* ------------------------------------------------------------------ */
/* 表单基件                                                            */
/* ------------------------------------------------------------------ */

/** 表单行：独立标签 + 控件 + 可选提示（词间 cj-field 结构） */
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="cn-field">
      <span className="cn-field-label">{label}</span>
      {children}
      {hint ? <p className="cn-field-hint">{hint}</p> : null}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={className ? `cn-input ${className}` : 'cn-input'} />;
}

export function TextArea({ rows = 3, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} rows={rows} className={className ? `cn-textarea ${className}` : 'cn-textarea'} />;
}

/** 小号按钮：面板操作行用，variant 对应 cn-btn-{primary|quiet|ghost|danger} */
function SmallBtn({ label, onClick, variant = 'ghost', disabled }: {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'quiet' | 'ghost' | 'danger';
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`cn-btn cn-btn-${variant} cn-btn-sm`}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 分段按钮                                                            */
/* ------------------------------------------------------------------ */

/** 分段按钮组：选中项加 active 类（词间 cj-kinds/cj-kind-on 的 cn- 版） */
export function StatusSwitcher<K extends string>({ options, value, onChange }: {
  options: [K, string][];
  value: K;
  onChange: (key: K) => void;
}) {
  return (
    <div className="cn-seg">
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          className={key === value ? 'cn-seg-item active' : 'cn-seg-item'}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 标签输入                                                            */
/* ------------------------------------------------------------------ */

/** 按分隔符拆分输入草稿，去空去重后并入已有标签 */
function splitTags(raw: string): string[] {
  return raw.split(/[、,，]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * 标签输入（词间 ui.tagInput）：chip 点删；回车 / 顿号 / 逗号添加，
 * 去空去重；输入框为空时按退格删除末项。
 */
export function TagInput({ value, onChange, placeholder = '加一个主题，回车确认' }: {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');

  function commitDraft() {
    const parts = splitTags(draft);
    if (!parts.length) return;
    const seen = new Set(value);
    const next = value.slice();
    for (const p of parts) {
      if (seen.has(p)) continue;
      seen.add(p);
      next.push(p);
    }
    onChange(next);
    setDraft('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === '、' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      commitDraft();
      return;
    }
    if (e.key === 'Backspace' && draft === '' && value.length) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="cn-tagwrap">
      {value.map((t) => (
        <button
          key={t}
          type="button"
          className="cn-chip cn-chip-outline cn-chip-tag"
          onClick={() => onChange(value.filter((x) => x !== t))}
        >
          {t} ×
        </button>
      ))}
      <input
        className="cn-taginput"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 可信度常量                                                          */
/* ------------------------------------------------------------------ */

/** 三档选项：标注编辑用全称，chip 与出处行用简称（词间 KINDS） */
const KIND_OPTIONS: [ClaimKind, string][] = [
  ['verified', '已核实资料'],
  ['pending', '待核实信息'],
  ['personal', '个人理解'],
];

const KIND_SHORT_OPTIONS: [ClaimKind, string][] = [
  ['verified', '已核实'],
  ['pending', '待核实'],
  ['personal', '理解'],
];

const KIND_SHORT: Record<ClaimKind, string> = {
  verified: '已核实',
  pending: '待核实',
  personal: '理解',
};

/** 出处是否有实际内容（备注不算，词间同款判定） */
function citationHasContent(c: Citation): boolean {
  return !!(c.book || c.edition || c.page || c.url);
}

/** 词间 cj-claim-cite 摘要：书名，版本，页码，网址 */
function citationSummary(c: Citation): string {
  const parts: string[] = [];
  if (c.book) parts.push(c.book);
  if (c.edition) parts.push(c.edition);
  if (c.page) parts.push(c.page);
  if (c.url) parts.push(c.url);
  return parts.join('，');
}

/* ------------------------------------------------------------------ */
/* 引用出处编辑器                                                      */
/* ------------------------------------------------------------------ */

/**
 * 引用出处列表：逐行受控编辑（book/edition/page/url/note + verified 三档），
 * 可添加 / 删除。空 id 提交由服务端补。
 */
export function CitationsEditor({ value, onChange }: { value: Citation[]; onChange: (citations: Citation[]) => void }) {
  function update(index: number, patch: Partial<Citation>) {
    onChange(value.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  function remove(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function add() {
    onChange([
      ...value,
      { id: '', book: '', edition: '', page: '', url: '', note: '', verified: 'pending' },
    ]);
  }

  return (
    <div className="cn-cites">
      {!value.length ? <EmptyState text="登记这本书、这个版本、这一页。" /> : null}
      {value.map((c, i) => (
        <div className="cn-cite" key={c.id || `cite-${i}`}>
          <div className="cn-cite-head">
            <StatusSwitcher
              options={KIND_SHORT_OPTIONS}
              value={c.verified}
              onChange={(v) => update(i, { verified: v })}
            />
            <button type="button" className="cn-op cn-op-danger" onClick={() => remove(i)}>
              删除
            </button>
          </div>
          <Input placeholder="如《全宋词》" value={c.book} onChange={(e) => update(i, { book: e.target.value })} />
          <Input placeholder="版本，如 中华书局校订本" value={c.edition} onChange={(e) => update(i, { edition: e.target.value })} />
          <Input placeholder="页码 / 卷次，如 第三册 412 页" value={c.page} onChange={(e) => update(i, { page: e.target.value })} />
          <Input placeholder="网址（可留空）" value={c.url} onChange={(e) => update(i, { url: e.target.value })} />
          <Input placeholder="备注，如「卷次待核实」" value={c.note} onChange={(e) => update(i, { note: e.target.value })} />
        </div>
      ))}
      <SmallBtn label="＋ 添加出处" onClick={add} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 资料标注编辑器                                                      */
/* ------------------------------------------------------------------ */

/** 编辑面板的落点：value 数组下标；新增条目 index 为 -1（追加到末尾） */
interface EditingState {
  index: number;
}

/**
 * 资料标注列表：收起行（内容 + 可信度徽章 + 出处摘要 + 编辑/删除），
 * 一次展开一个编辑面板（kind 三档、内容、挂靠段落、内嵌出处编辑）。
 * 标为「已核实」而没有实际出处时，「存下这条」禁用并给出行内提示。
 */
export function ClaimsEditor({ value, onChange }: { value: Claim[]; onChange: (claims: Claim[]) => void }) {
  const [editing, setEditing] = useState<EditingState | null>(null);

  function startEdit(index: number) {
    setEditing({ index });
  }

  function startAdd() {
    setEditing({ index: -1 });
  }

  function removeAt(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function applyDraft(claim: Claim) {
    const index = editing ? editing.index : -1;
    const next = value.slice();
    if (index >= 0) next[index] = claim;
    else next.push(claim);
    onChange(next);
    setEditing(null);
  }

  return (
    <div className="cn-claims">
      {!value.length && !editing ? <EmptyState text="每条资料单独标一次，不要整篇一个标签。" /> : null}
      {value.map((c, i) => (
        <div className="cn-claim" key={c.id || `claim-${i}`}>
          <div className="cn-claim-text">{c.text}</div>
          {c.anchor?.quote ? <div className="cn-claim-cite">标注范围：{c.anchor.quote}</div> : null}
          {(c.citations || []).filter(citationHasContent).map((x, j) => (
            <div className="cn-claim-cite" key={x.id || `cite-${j}`}>
              出处：{citationSummary(x)}
            </div>
          ))}
          <div className="cn-claim-ops">
            <Chip tone={c.kind}>{KIND_SHORT[c.kind]}</Chip>
            <button type="button" className="cn-op" disabled={!!editing} onClick={() => startEdit(i)}>
              编辑
            </button>
            <button type="button" className="cn-op cn-op-danger" disabled={!!editing} onClick={() => removeAt(i)}>
              删除
            </button>
          </div>
        </div>
      ))}
      {editing ? (
        <ClaimPanel
          initial={editing.index >= 0 ? value[editing.index] : { id: '', kind: 'pending', text: '', paragraph: -1, citations: [] }}
          onSave={applyDraft}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <SmallBtn label="＋ 添加一条" onClick={startAdd} />
      )}
    </div>
  );
}

/**
 * 单条标注的编辑面板：全部字段是输入草稿，「存下这条」才落回 value。
 * 新条目不生成前端 id（留空，服务端 normalizeClaims 补）。
 */
export function ClaimPanel({ initial, onSave, onCancel, lockParagraph }: {
  initial: Claim;
  onSave: (claim: Claim) => void;
  onCancel: () => void;
  /** 阅读页划选创建用：隐藏挂靠段号字段，段号以 initial 为准 */
  lockParagraph?: boolean;
}) {
  const [kind, setKind] = useState<ClaimKind>(initial.kind);
  const [text, setText] = useState(initial.text);
  const [para, setPara] = useState(initial.paragraph >= 0 ? String(initial.paragraph) : '');
  const [cites, setCites] = useState<Citation[]>(initial.citations);

  // 门禁按「有实际内容的出处」判：全空行存稿时会被过滤，不能拿来凑数
  const hasCite = cites.some(citationHasContent);
  const missingCite = kind === 'verified' && !hasCite;

  function save() {
    const content = text.trim();
    if (!content) {
      notifyToast('这条还没写内容');
      return;
    }
    const n = parseInt(para, 10);
    onSave({
      ...initial,
      kind,
      text: content,
      paragraph: Number.isInteger(n) && n >= -1 ? n : -1,
      citations: cites.filter(citationHasContent),
    });
  }

  return (
    <div className="cn-editpanel">
      <Field label="可信度">
        <StatusSwitcher options={KIND_OPTIONS} value={kind} onChange={setKind} />
      </Field>
      <Field label="内容">
        <TextArea
          rows={4}
          value={text}
          placeholder="写下这一条资料、典故解释或你的理解"
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      {lockParagraph ? null : (
        <Field label="挂靠段落" hint="对应正文第几段（从 0 起）；留空或 -1 表示不挂段落">
          <Input type="number" min={-1} value={para} onChange={(e) => setPara(e.target.value)} />
        </Field>
      )}
      <Field label="出处（标「已核实」时必填）">
        <CitationsEditor value={cites} onChange={setCites} />
      </Field>
      {missingCite ? <p className="cn-field-error">已核实的资料需要至少一条出处</p> : null}
      <div className="cn-dialog-ops">
        <SmallBtn label="存下这条" variant="primary" disabled={missingCite} onClick={save} />
        <SmallBtn label="取消" variant="quiet" onClick={onCancel} />
      </div>
    </div>
  );
}
