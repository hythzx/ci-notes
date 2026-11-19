/**
 * 典故三视图：列表 / 详情 / 编辑。结构镜像 src/views/imagery.tsx，字段差异：
 *   - description → source（出处典籍，input）/ original（典故原文，textarea
 *     逐字保留不解析，详情页 <pre> 展示）/ explanation（通用释义，textarea，
 *     详情页 Md 渲染，节标题「典故释义」）；
 *   - 使用记录表达作用字段：ImageryUse.fn → AllusionUse.interpretation，
 *     详情页行 label「此处解释」。
 *
 * 数据契约与意象完全同构（api.allusions list/get/create/update/remove/
 * merge/impact，create/update 均返回实体本身）。?link= 回跳写 sessionStorage
 * （cn:linkTarget / cn:linkEntity，entity 前缀 allusion:），由
 * components/sections 的区块组件按前缀消费并续接 use 编辑。
 *
 * 草稿键 draft:allusion:*（新建 draft:allusion:new:<ms>），防抖写入、
 * 冲突三选一与 skipDraftWrite 语义同意象编辑。布局类名复用 cj-imagery-*
 * 样式段（结构同构，无典故专属样式）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { ApiError } from '../types';
import type {
  Allusion,
  AllusionDetail as AllusionDetailData,
  AllusionImpact,
  AllusionListItem,
  AllusionUse,
  Claim,
  ClaimKind,
  Citation,
  UsageEntry,
} from '../types';
import {
  Chip,
  ChooseBox,
  ConfirmBox,
  EmptyState,
  Modal,
  RelTime,
  Section,
  notifyToast,
  relTime,
} from '../components/ui';
import {
  CitationsEditor,
  ClaimsEditor,
  Field,
  Input,
  TagInput,
  TextArea,
} from '../components/editors';
import { Md } from '../components/md';
import { citationLine, formatDateTime } from '../exporter';
import { navigate } from '../router';

/* ------------------------------------------------------------------ */
/* 常量与小件（模块顶层，供三个视图共用）                                */
/* ------------------------------------------------------------------ */

/** 三档可信度的全称文案（usages chip 与 claims 组标题） */
const CLAIM_GROUP_LABEL: Record<ClaimKind, string> = {
  verified: '已核实资料',
  pending: '待核实信息',
  personal: '个人理解',
};

const CLAIM_GROUP_ORDER: ClaimKind[] = ['verified', 'pending', 'personal'];

/** 三档可信度的角标简称（使用记录条目里用，与 sections 同款） */
const CLAIM_SHORT: Record<ClaimKind, string> = {
  verified: '已核实',
  pending: '待核实',
  personal: '理解',
};

/** 札记写作状态文案（详情札记分组行用） */
const WRITING_LABEL: Record<string, string> = {
  idea: '构思',
  research: '资料收集',
  draft: '草稿',
  final: '定稿',
};

/** 出处行是否携带实际内容（备注不算，与编辑器门禁一致） */
function citationHasContent(c: Citation): boolean {
  return !!(c.book || c.edition || c.page || c.url);
}

/** claims 按 verified/pending/personal 三组拆分，只保留非空组 */
function groupClaims(claims: Claim[]): { kind: ClaimKind; items: Claim[] }[] {
  return CLAIM_GROUP_ORDER.map((kind) => ({
    kind,
    items: claims.filter((c) => c.kind === kind),
  })).filter((g) => g.items.length > 0);
}

/** 释义首行（列表卡用）：超 max 字截断 */
function firstLine(text: string, max = 80): string {
  const s = (text || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 按行 / 顿号 / 逗号拆分常见表达用途（一行一种，放宽逗号 / 顿号也可分隔） */
function splitUsages(raw: string): string[] {
  return raw.split(/[\n、,，]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * 编辑框文本 → usages：text 与原条目相同的保留原 kind，新条目标 pending。
 * 服务端 normalizeUsages 还会按 text 去重，这里只做 kind 保留。
 */
function usagesFromText(raw: string, original: UsageEntry[]): UsageEntry[] {
  const byText = new Map(original.map((u) => [u.text, u]));
  const out: UsageEntry[] = [];
  const seen = new Set<string>();
  for (const text of splitUsages(raw)) {
    if (seen.has(text)) continue;
    seen.add(text);
    const prev = byText.get(text);
    out.push({ text, kind: prev ? prev.kind : 'pending' });
  }
  return out;
}

/** 通用下拉：首项为「全部 xx」空选项（模块顶层定义，避免每次渲染重挂丢焦点） */
function Sel({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <select className="cj-select cj-select-inline" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{label}</option>
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );
}

/** 使用记录的字段行：中文 label + 行内 Markdown（空值整行不渲染） */
function UseFieldRow({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div className="cj-imagery-field">
      <span className="cj-imagery-field-label">{label}</span>
      <Md text={text} inline />
    </div>
  );
}

/**
 * 只读的使用记录：quote 逐字 + 情境 / 此处解释 / 我的理解各行 +
 * 条目级 claims 徽章（自带出处行）+ use 顶层出处行。详情页「出现在」
 * 分组用，不带编辑按钮（编辑在目标详情页的典故区块里做）。
 */
function UseView({ use }: { use: AllusionUse }) {
  return (
    <div className="cj-imagery-use">
      {use.quote ? <pre className="cj-imagery-quote">{use.quote}</pre> : null}
      <UseFieldRow label="情境" text={use.context} />
      <UseFieldRow label="此处解释" text={use.interpretation} />
      <UseFieldRow label="我的理解" text={use.understanding} />
      {use.claims.length || use.citations.length ? (
        <div className="cj-imagery-claims">
          {use.claims.map((c, i) => (
            <div className="cj-imagery-claim" key={c.id || `claim-${i}`}>
              <Chip tone={c.kind}>{CLAIM_SHORT[c.kind]}</Chip>
              <div className="cj-imagery-claim-text">
                <Md text={c.text} inline />
                {c.citations.filter(citationHasContent).map((x, j) => (
                  <div key={x.id || `cite-${j}`}>出处：{citationLine(x)}</div>
                ))}
              </div>
            </div>
          ))}
          {use.citations.map((x, j) => (
            <div className="cj-imagery-claim" key={x.id || `usecite-${j}`}>
              <Chip tone={x.verified}>{CLAIM_SHORT[x.verified]}</Chip>
              <div className="cj-imagery-claim-text">出处：{citationLine(x)}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 列表                                                                */
/* ------------------------------------------------------------------ */

/**
 * 典故列表：防抖搜索 + 标签筛选 + 「显示已合并」开关 + 卡片列表
 * （镜像意象列表，卡片内容换成出处典籍与释义首行）。
 * 标签选项来自一次性全量拉取（不被当前筛选联动）。
 */
export function AllusionList() {
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [tag, setTag] = useState('');
  const [showMerged, setShowMerged] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [items, setItems] = useState<AllusionListItem[] | null>(null);

  // 搜索词 220ms 防抖（与词作 / 札记列表同值）
  useEffect(() => {
    const t = setTimeout(() => setDq(q), 220);
    return () => clearTimeout(t);
  }, [q]);

  // 标签选项：全量拉一次（含已合并），聚合去重排序
  useEffect(() => {
    let alive = true;
    api.allusions.list({ includeMerged: true }).then(
      (d) => {
        if (!alive) return;
        const seen = new Set<string>();
        for (const e of d.entries) {
          for (const t of e.allusion.tags) seen.add(t);
        }
        setTags([...seen].sort((a, b) => a.localeCompare(b)));
      },
      () => {}, // 筛选面板失败退化为空选项，列表仍可搜索
    );
    return () => {
      alive = false;
    };
  }, []);

  // 列表数据：防抖搜索词 / 标签 / 已合并开关变化即刷新
  useEffect(() => {
    let alive = true;
    api.allusions
      .list({ q: dq, tag, includeMerged: showMerged || undefined })
      .then(
        (d) => {
          if (alive) setItems(d.entries);
        },
        (e: unknown) => {
          if (!alive) return;
          notifyToast(e instanceof ApiError ? e.message : '典故列表加载失败');
        },
      );
    return () => {
      alive = false;
    };
  }, [dq, tag, showMerged]);

  function reset() {
    setQ('');
    setDq('');
    setTag('');
    setShowMerged(false);
  }

  return (
    <div className="cj-page">
      <div className="cj-pagehead">
        <h1 className="cj-h1">典故</h1>
        <a className="cn-btn cn-btn-primary" href="#/allusions/new">＋ 新典故</a>
      </div>

      <p className="cj-me-p cj-mt">
        典故是作品里化用的前人故事或成句 —— 出自哪部书、原本讲什么、
        后来通常表达什么，这里单独积累。
      </p>

      <div className="cj-toolbar">
        <div className="cj-searchbox">
          <Input placeholder="搜典故名称、别名、出处或释义" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Sel label="全部标签" value={tag} onChange={setTag} options={tags} />
        <label className="cj-checkrow">
          <input
            type="checkbox"
            checked={showMerged}
            onChange={(e) => setShowMerged(e.target.checked)}
          />
          <span className="cj-checktext">显示已合并</span>
        </label>
        <button type="button" className="cn-btn cn-btn-ghost" onClick={reset}>重置</button>
      </div>

      <div className="cj-list">
        {!items ? (
          <EmptyState text="正在打开典故…" />
        ) : !items.length ? (
          <EmptyState text={dq || tag ? '没有找到匹配的典故。' : '还没有典故条目。'} />
        ) : (
          items.map((e) => {
            const m = e.allusion;
            return (
              <a className="cj-card cj-imagery-card cj-imagery-card-link" href={'#/allusions/' + m.id} key={m.id}>
                <div className="cj-item-head">
                  <div className="cj-item-title cj-serif">{m.name || '（未命名）'}</div>
                  <span className="cj-item-time">
                    {e.counts.works} 作品 · {e.counts.notes} 札记
                  </span>
                </div>
                {m.aliases.length ? (
                  <div className="cj-item-meta">别名：{m.aliases.join('、')}</div>
                ) : null}
                {m.source ? (
                  <div className="cj-item-meta">出处：{m.source}</div>
                ) : null}
                {m.explanation ? (
                  <div className="cj-item-excerpt cj-serif">{firstLine(m.explanation)}</div>
                ) : null}
                <div className="cj-item-foot">
                  {m.mergedInto ? <Chip tone="muted">已并入</Chip> : null}
                  {m.tags.map((t) => (
                    <Chip tone="muted" key={t}>{t}</Chip>
                  ))}
                  {e.counts.quotes > 0 ? (
                    <span className="cj-item-time">{e.counts.quotes} 处词句</span>
                  ) : null}
                  <RelTime iso={m.updatedAt} />
                </div>
              </a>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 详情                                                                */
/* ------------------------------------------------------------------ */

/**
 * 典故详情（镜像意象详情）。
 * 通用释义卡（出处典籍 / 典故原文 / 典故释义 / usages / 札记） +
 * claims 三组 + 引用出处 + 「出现在」作品 / 札记分组（组内 uses 只读）。
 * 操作：编辑 / 合并到另一典故 / 删除（先看影响）。
 */
export function AllusionDetail({ id }: { id: string }) {
  const [data, setData] = useState<AllusionDetailData | null>(null);
  const [error, setError] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQ, setPickerQ] = useState('');
  const [pickerItems, setPickerItems] = useState<AllusionListItem[]>([]);
  const [mergeInto, setMergeInto] = useState<AllusionListItem | null>(null);
  const [merging, setMerging] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<AllusionImpact | null>(null);
  const [removing, setRemoving] = useState(false);

  /** 返回清理函数供 effect 取消晚到响应；合并后的刷新也复用此函数 */
  function load(): () => void {
    let alive = true;
    setError('');
    setData(null);
    api.allusions.get(id).then(
      (d) => {
        if (alive) setData(d);
      },
      (e: unknown) => {
        if (alive) setError(e instanceof ApiError ? e.message : '加载失败');
      },
    );
    return () => {
      alive = false;
    };
  }

  useEffect(load, [id]);

  /** 打开合并选择器：拉全量典故（服务端默认已排除被合并的），排除自己 */
  function openMerge() {
    setPickerQ('');
    setMergeInto(null);
    setPickerOpen(true);
    api.allusions.list({}).then(
      (d) => setPickerItems(d.entries.filter((e) => e.allusion.id !== id)),
      (e: unknown) => {
        setPickerOpen(false);
        notifyToast(e instanceof ApiError ? e.message : '典故列表加载失败');
      },
    );
  }

  const pickerEntries = useMemo(() => {
    const k = pickerQ.trim().toLowerCase();
    if (!k) return pickerItems;
    return pickerItems.filter(
      (e) =>
        e.allusion.name.toLowerCase().includes(k) ||
        e.allusion.aliases.some((a) => a.toLowerCase().includes(k)) ||
        e.allusion.explanation.toLowerCase().includes(k) ||
        e.allusion.source.toLowerCase().includes(k),
    );
  }, [pickerItems, pickerQ]);

  /** 合并确认：from 的全部使用记录转挂到目标名下，本条不再单独显示 */
  function merge() {
    const into = mergeInto;
    if (!into || merging) return;
    setMerging(true);
    api.allusions.merge(id, into.allusion.id).then(
      () => {
        setMerging(false);
        setMergeInto(null);
        notifyToast('已合并到「' + into.allusion.name + '」');
        load();
      },
      (e: unknown) => {
        setMerging(false);
        setMergeInto(null);
        notifyToast(e instanceof ApiError ? e.message : '合并失败');
      },
    );
  }

  /** 删除前先算影响（uses/works/notes 数），供确认框展示 */
  function askRemove() {
    api.allusions.impact(id).then(
      (imp) => setConfirmRemove(imp),
      (e: unknown) => {
        notifyToast(e instanceof ApiError ? e.message : '拿不到删除影响，请重试');
      },
    );
  }

  function remove() {
    if (!data || removing) return;
    setRemoving(true);
    api.allusions.remove(data.allusion.id).then(
      () => {
        notifyToast('已删除');
        navigate('#/allusions');
      },
      (e: unknown) => {
        setRemoving(false);
        setConfirmRemove(null);
        notifyToast(e instanceof ApiError ? e.message : '删除失败');
      },
    );
  }

  if (error) {
    return (
      <div className="cj-page cj-narrow">
        <EmptyState text={'这个典故暂时打不开（' + error + '）。'} />
        <div style={{ textAlign: 'center' }}>
          <button type="button" className="cn-btn cn-btn-ghost" onClick={load}>重试</button>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cj-page cj-narrow">
        <EmptyState text="正在打开典故…" />
      </div>
    );
  }

  const m = data.allusion;
  const groups = groupClaims(m.claims);
  const hasIntro = !!(m.source || m.original || m.explanation);
  const removeTarget = confirmRemove;

  return (
    <div className="cj-page cj-narrow">
      <div className="cj-pagehead">
        <a className="cj-backlink" href="#/allusions">‹ 典故</a>
        <div className="cj-pagehead-ops">
          <a className="cn-btn cn-btn-ghost cn-btn-sm" href={'#/allusions/' + m.id + '/edit'}>编辑</a>
          <button type="button" className="cn-btn cn-btn-ghost cn-btn-sm" onClick={openMerge}>
            合并到另一典故
          </button>
          <button type="button" className="cn-btn cn-btn-danger cn-btn-sm" onClick={askRemove}>
            删除
          </button>
        </div>
      </div>

      {m.mergedInto ? (
        <div className="cj-card">
          <Chip tone="muted">已并入</Chip>{' '}
          该典故已并入另一个典故，
          <a href={'#/allusions/' + m.mergedInto}>查看并入后的典故 ›</a>
        </div>
      ) : null}

      <div className="cj-card">
        <h1 className="cj-h1 cj-serif">{m.name || '（未命名）'}</h1>
        {m.aliases.length ? (
          <div className="cj-item-meta">别名 / 检索词：{m.aliases.join('、')}</div>
        ) : null}
        <div className="cj-item-foot">
          {m.tags.map((t) => (
            <Chip tone="muted" key={t}>{t}</Chip>
          ))}
          <span className="cj-item-time">最后修改 {formatDateTime(m.updatedAt)}</span>
        </div>
        {hasIntro ? (
          <>
            {m.source ? (
              <div className="cj-mt cj-item-meta">出处：{m.source}</div>
            ) : null}
            {m.original ? (
              <div className="cj-imagery-usages">
                <div className="cj-section-title">典故原文</div>
                <pre className="cj-imagery-quote">{m.original}</pre>
              </div>
            ) : null}
            {m.explanation ? (
              <div className="cj-imagery-usages">
                <div className="cj-section-title">典故释义</div>
                <Md text={m.explanation} />
              </div>
            ) : null}
          </>
        ) : (
          <div className="cj-item-meta">
            还没有写通用释义。释义是可选的 —— 这个典故到具体作品里怎么用，看下面每一处。
          </div>
        )}
        {m.usages.length ? (
          <div className="cj-imagery-usages">
            <div className="cj-section-title">常见表达用途</div>
            {m.usages.map((u) => (
              <div className="cj-imagery-usage" key={u.text}>
                <Chip tone={u.kind}>{CLAIM_GROUP_LABEL[u.kind]}</Chip>
                <Md text={u.text} inline />
              </div>
            ))}
          </div>
        ) : null}
        {m.note ? (
          <div className="cj-imagery-notes">
            <div className="cj-section-title">我的阅读札记</div>
            <Md text={m.note} />
          </div>
        ) : null}
        <div className="cj-imagery-counts">
          <span>{data.counts.works} 首作品</span>
          <span>{data.counts.notes} 篇札记</span>
          <span>{data.counts.quotes} 处词句</span>
        </div>
      </div>

      <Section title="资料与可信度">
        {groups.length ? (
          groups.map((g) => (
            <div className="cj-card" key={g.kind}>
              <div className="cj-claim-group-title">
                <Chip tone={g.kind}>{CLAIM_GROUP_LABEL[g.kind]} · {g.items.length}</Chip>
              </div>
              {g.items.map((c, i) => (
                <div className="cj-claim" key={c.id || `claim-${i}`}>
                  <div className="cj-claim-text">
                    <Md text={c.text} inline />
                  </div>
                  {c.citations.filter(citationHasContent).map((x, j) => (
                    <div className="cj-claim-cite" key={x.id || `cite-${j}`}>出处：{citationLine(x)}</div>
                  ))}
                </div>
              ))}
            </div>
          ))
        ) : (
          <div className="cj-card">
            <EmptyState text="还没有逐条标注。编辑里可以给每条资料单独标「已核实 / 待核实 / 个人理解」。" />
          </div>
        )}
      </Section>

      <Section title="引用出处">
        <div className="cj-card">
          {m.citations.length ? (
            m.citations.map((c, i) => (
              <div className="cj-citerow" key={c.id || `citation-${i}`}>
                <div className="cj-claim-text">{citationLine(c)}</div>
                <Chip tone={c.verified}>{CLAIM_GROUP_LABEL[c.verified]}</Chip>
              </div>
            ))
          ) : (
            <EmptyState text="还没有登记出处。" />
          )}
        </div>
      </Section>

      <Section title="出现在作品">
        <div className="cj-card">
          {data.works.length ? (
            data.works.map(({ work, uses }) => (
              <div className="cj-imagery-work" key={work.id}>
                <div className="cj-item-head">
                  <a className="cj-item-title cj-serif" href={'#/works/' + work.id}>
                    {work.title || '（未命名）'}
                  </a>
                  <span className="cj-item-time">{work.author + (work.cipai ? ' · ' + work.cipai : '')}</span>
                </div>
                {uses.map((u) => (
                  <UseView key={u.id} use={u} />
                ))}
              </div>
            ))
          ) : (
            <EmptyState text="还没有作品用到这个典故。" />
          )}
        </div>
      </Section>

      <Section title="出现在札记">
        <div className="cj-card">
          {data.notes.length ? (
            data.notes.map(({ note, uses }) => (
              <div className="cj-imagery-work" key={note.id}>
                <div className="cj-item-head">
                  <a className="cj-item-title" href={'#/notes/' + note.id}>
                    {note.title || '（未命名札记）'}
                  </a>
                  <span className="cj-item-time">
                    {(WRITING_LABEL[note.writingStatus] || note.writingStatus) + ' · ' + relTime(note.updatedAt)}
                  </span>
                </div>
                {uses.map((u) => (
                  <UseView key={u.id} use={u} />
                ))}
              </div>
            ))
          ) : (
            <EmptyState text="还没有札记写到这个典故。" />
          )}
        </div>
      </Section>

      {pickerOpen ? (
        <Modal title="合并到另一典故" onClose={() => setPickerOpen(false)}>
          <Input
            placeholder="搜名称、别名、出处或释义"
            value={pickerQ}
            onChange={(e) => setPickerQ(e.target.value)}
          />
          <div className="cj-imagery-picker-list">
            {!pickerItems.length ? (
              <EmptyState text="没有可合并进去的典故。" />
            ) : !pickerEntries.length ? (
              <EmptyState text="没有匹配的典故。" />
            ) : (
              pickerEntries.map((e) => (
                <button
                  type="button"
                  className="cj-imagery-picker-item"
                  key={e.allusion.id}
                  onClick={() => {
                    setPickerOpen(false);
                    setMergeInto(e);
                  }}
                >
                  <span className="cj-imagery-picker-name">{e.allusion.name}</span>
                  {e.allusion.aliases.length ? (
                    <span className="cj-imagery-picker-alias">别名：{e.allusion.aliases.join('、')}</span>
                  ) : null}
                  {e.allusion.source ? (
                    <span className="cj-imagery-picker-alias">出处：{e.allusion.source}</span>
                  ) : null}
                  {e.allusion.explanation ? (
                    <span className="cj-imagery-picker-desc">释义：{firstLine(e.allusion.explanation)}</span>
                  ) : null}
                  <span className="cj-imagery-picker-desc">
                    作品 {e.counts.works} · 札记 {e.counts.notes} · 使用 {e.counts.uses} 条
                  </span>
                </button>
              ))
            )}
          </div>
        </Modal>
      ) : null}

      {mergeInto ? (
        <ConfirmBox
          title={'合并「' + m.name + '」'}
          message={
            '「' + m.name + '」的全部使用记录将转挂到「' + mergeInto.allusion.name +
            '」名下，「' + m.name + '」本条将不再单独显示。作品与札记不受影响。'
          }
          danger
          onOk={merge}
          onCancel={() => setMergeInto(null)}
        />
      ) : null}

      {removeTarget ? (
        <ConfirmBox
          title={'删除典故「' + m.name + '」'}
          message={
            '删除后，这个典故本身和它关联的 ' + removeTarget.uses + ' 条使用记录会一起删掉。' +
            '关联的作品与札记不受影响 —— 它们照旧在，只是少了这个索引条目。' +
            (removeTarget.works || removeTarget.notes
              ? '涉及 ' + removeTarget.works + ' 首作品、' + removeTarget.notes + ' 篇札记。'
              : '')
          }
          danger
          onOk={remove}
          onCancel={() => setConfirmRemove(null)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 编辑                                                                */
/* ------------------------------------------------------------------ */

/** 编辑表单状态（usages 以编辑框文本承载，kind 由 usagesFromText 保留） */
interface AllusionForm {
  name: string;
  aliases: string[];
  source: string;
  original: string;
  explanation: string;
  usagesText: string;
  note: string;
  tags: string[];
  claims: Claim[];
  citations: Citation[];
}

const EMPTY_FORM: AllusionForm = {
  name: '', aliases: [], source: '', original: '', explanation: '', usagesText: '',
  note: '', tags: [], claims: [], citations: [],
};

function toForm(m: Allusion): AllusionForm {
  return {
    name: m.name,
    aliases: (m.aliases || []).slice(),
    source: m.source,
    original: m.original,
    explanation: m.explanation,
    usagesText: (m.usages || []).map((u) => u.text).join('\n'),
    note: m.note,
    tags: (m.tags || []).slice(),
    claims: (m.claims || []).slice(),
    citations: (m.citations || []).slice(),
  };
}

/** unknown 草稿安全并入表单：字段类型不符时保留默认值（同词作编辑语义） */
function mergeForm(raw: unknown): AllusionForm {
  const d = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<keyof AllusionForm, unknown>>;
  const f: AllusionForm = { ...EMPTY_FORM };
  for (const key of ['name', 'source', 'original', 'explanation', 'usagesText', 'note'] as const) {
    if (typeof d[key] === 'string') f[key] = d[key] as string;
  }
  if (Array.isArray(d.aliases)) f.aliases = d.aliases as string[];
  if (Array.isArray(d.tags)) f.tags = d.tags as string[];
  if (Array.isArray(d.claims)) f.claims = d.claims as Claim[];
  if (Array.isArray(d.citations)) f.citations = d.citations as Citation[];
  return f;
}

type SaveState = { kind: 'idle' | 'saving' | 'saved' | 'error'; text: string };

/** ?link= 回跳目标：work:w_xxx / note:n_xxx，其余值视为无 */
function parseLinkTarget(): { type: 'work' | 'note'; id: string } | null {
  const q = location.hash.split('?')[1] || '';
  const [type, tid] = (new URLSearchParams(q).get('link') || '').split(':');
  if ((type === 'work' || type === 'note') && tid) return { type, id: tid };
  return null;
}

/**
 * 典故编辑（新建 / 修改一体，镜像意象编辑）。
 * 本机草稿：key 新建 draft:allusion:new:<ms>（进入页面时生成，防多开碰撞）、
 * 已有 draft:allusion:<id>；700ms 防抖写入，进入时恢复并提示，保存成功清除，
 * 卸载不删（保留防丢）。dirty 时挂 beforeunload 拦截。
 *
 * ?link= 存在时：保存成功后把目标写进 sessionStorage（entity 前缀 allusion:）
 * 再回原目标详情，由目标详情页的典故区块续接 use 编辑（components/sections
 * 按前缀消费，不会误开意象区块）。
 */
export function AllusionEdit({ id }: { id?: string }) {
  const draftKey = useMemo(
    () => (id ? 'draft:allusion:' + id : 'draft:allusion:new:' + Date.now()),
    [id],
  );

  // ?link= 只在进入页面时解析一次；路由切换会重建组件实例
  const linkTarget = useMemo(parseLinkTarget, []);

  const [form, setForm] = useState<AllusionForm>(EMPTY_FORM);
  const [baseline, setBaseline] = useState<AllusionForm>(EMPTY_FORM);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle', text: '' });
  const [conflict, setConflict] = useState<ApiError | null>(null);

  // 乐观锁基准版本：ref 供保存闭包随时读取最新值
  const baseRevision = useRef<number | undefined>(undefined);
  // 加载时 / 采用对方回填时的 usages 原条目：序列化时按 text 保留 kind
  const baseUsages = useRef<UsageEntry[]>([]);
  // 采用对方回填时置 true：让草稿写入 effect 跳过这一次写入
  const skipDraftWrite = useRef(false);

  // dirty 由渲染时推导，避免状态双写不同步
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);

  function clearDraft() {
    try {
      localStorage.removeItem(draftKey);
    } catch {
      /* 存储不可用时静默 */
    }
  }

  /* 加载：编辑取详情，之后恢复本机草稿 */
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setLoadError('');
    const p = id
      ? api.allusions.get(id).then((d) => d.allusion)
      : Promise.resolve(null);
    p.then((allusion) => {
      if (!alive) return;
      const base = allusion ? toForm(allusion) : EMPTY_FORM;
      if (allusion) {
        baseRevision.current = allusion.revision;
        baseUsages.current = allusion.usages || [];
      }
      setBaseline(base);
      setForm(base);
      // 本机暂存优先：上次没保存的内容自动接上
      let restored: AllusionForm | null = null;
      try {
        const raw = localStorage.getItem(draftKey);
        if (raw) restored = mergeForm(JSON.parse(raw));
      } catch {
        /* 草稿损坏视为无暂存 */
      }
      if (restored) {
        setForm(restored);
        if (JSON.stringify(restored) !== JSON.stringify(base)) {
          notifyToast('有本机暂存，已恢复');
        }
      }
      setLoaded(true);
    }).catch((e: unknown) => {
      if (!alive) return;
      setLoadError(e instanceof ApiError ? e.message : '加载失败');
    });
    return () => {
      alive = false;
    };
  }, [id, draftKey]);

  /* 草稿暂存：700ms 防抖写入；卸载不删；采用对方回填的那一次跳过 */
  useEffect(() => {
    if (!loaded) return;
    if (skipDraftWrite.current) {
      skipDraftWrite.current = false;
      return;
    }
    const t = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify(form));
      } catch {
        /* 配额不足等场景静默放弃本次暂存 */
      }
    }, 700);
    return () => clearTimeout(t);
  }, [form, draftKey, loaded]);

  /* 未保存修改时拦截页面关闭（浏览器原生确认） */
  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // Safari 等浏览器需 returnValue 才触发原生确认
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  /** 保存：新建 / 更新均返回 allusion 对象本身（与意象同构） */
  async function save(forceRev?: { revision: number; force: true }) {
    if (!loaded || saving) return;
    if (!form.name.trim()) {
      notifyToast('名称不能为空');
      return;
    }
    setSaving(true);
    setSaveState({ kind: 'saving', text: '保存中…' });
    const payload: Partial<Allusion> & { baseRevision?: number; force?: boolean } = {
      name: form.name.trim(),
      aliases: form.aliases,
      source: form.source,
      original: form.original,
      explanation: form.explanation,
      usages: usagesFromText(form.usagesText, baseUsages.current),
      note: form.note,
      tags: form.tags,
      claims: form.claims,
      citations: form.citations,
    };
    if (forceRev) {
      payload.baseRevision = forceRev.revision;
      payload.force = true;
    } else if (id) {
      payload.baseRevision = baseRevision.current;
    }
    try {
      const saved = id ? await api.allusions.update(id, payload) : await api.allusions.create(payload);
      clearDraft();
      notifyToast('已保存');
      if (linkTarget) {
        // 回原目标详情并携带链接上下文，由典故区块续接 use 编辑
        try {
          sessionStorage.setItem('cn:linkTarget', linkTarget.type + ':' + linkTarget.id);
          sessionStorage.setItem('cn:linkEntity', 'allusion:' + saved.id);
        } catch {
          /* 存储不可用时退化为纯跳转 */
        }
        navigate((linkTarget.type === 'work' ? '#/works/' : '#/notes/') + linkTarget.id);
      } else {
        navigate('#/allusions/' + saved.id);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT' && id) {
        setSaveState({ kind: 'error', text: '在别处被改过，需要先处理冲突' });
        setConflict(e);
      } else {
        const msg = e instanceof ApiError ? e.message : '保存失败';
        setSaveState({ kind: 'error', text: msg });
        notifyToast(msg);
      }
    } finally {
      setSaving(false);
    }
  }

  /** 冲突三选一：覆盖 / 采纳 / 先不处理（ChooseBox 自带先不处理按钮） */
  function pickConflict(key: string) {
    const err = conflict;
    setConflict(null);
    if (!err || !id) return;
    const cur = err.current as Partial<Allusion> | undefined;
    if (typeof cur?.revision !== 'number') {
      notifyToast('拿不到对方的最新版本，请刷新后重试');
      return;
    }
    if (key === 'mine') {
      save({ revision: cur.revision, force: true });
      return;
    }
    if (key === 'theirs') {
      // 采用对方的版本：表单与基准同步回填，之后由用户确认再手动保存；
      // 回填触发的防抖写入被跳过，本机暂存里仍是用户自己的文字。
      // mergeForm 逐字段校验，cur 缺字段时回落默认值
      skipDraftWrite.current = true;
      const f = mergeForm(toForm(cur as Allusion));
      baseRevision.current = cur.revision;
      baseUsages.current = cur.usages || [];
      setForm(f);
      setBaseline(f);
      setSaveState({ kind: 'idle', text: '' });
      notifyToast('已载入对方的最新版本');
    }
  }

  if (loadError) {
    return (
      <div className="cj-page cj-formpage">
        <div className="cj-pagehead">
          <a className="cj-backlink" href="#/allusions">‹ 典故</a>
          <h1 className="cj-h1">编辑典故</h1>
        </div>
        <EmptyState text={'这个典故暂时打不开（' + loadError + '）。'} />
      </div>
    );
  }

  const backTo = id ? '#/allusions/' + id : '#/allusions';

  /** 状态条文本优先级：保存中 > 错误 > 本机未保存 > 已保存 */
  const statusKind =
    saveState.kind === 'saving' ? 'saving'
    : saveState.kind === 'error' ? 'error'
    : dirty ? 'draft'
    : saveState.kind === 'saved' ? 'saved'
    : 'idle';
  const statusText =
    saveState.kind === 'saving' ? '保存中…'
    : saveState.kind === 'error' ? saveState.text
    : dirty ? '本机暂存 · 未保存'
    : saveState.kind === 'saved' ? '已保存'
    : '';

  return (
    <div className="cj-page cj-formpage">
      <div className="cj-pagehead">
        <a className="cj-backlink" href={backTo}>‹ 典故</a>
        <h1 className="cj-h1">{id ? '编辑典故' : '新建典故'}</h1>
      </div>

      <div className="cj-card">
        <p className="cj-me-p">
          {id
            ? '改这里只影响通用释义 —— 各作品里的具体解释不会变。'
            : '先给它一个名字就行。出处、原文和释义都可以以后再补。'}
        </p>
        <Field label="名称">
          <Input
            placeholder="如：庄周梦蝶"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="别名或检索词" hint="别名只用来帮你搜到它，不会把别的典故自动合并进来。">
          <TagInput
            value={form.aliases}
            onChange={(aliases) => setForm({ ...form, aliases })}
            placeholder="用顿号分开，如：梦蝶、蝶梦"
          />
        </Field>
        <Field label="出处典籍">
          <Input
            placeholder="如：《庄子·齐物论》"
            value={form.source}
            onChange={(e) => setForm({ ...form, source: e.target.value })}
          />
        </Field>
        <Field label="典故原文" hint="逐字保留，不做解析。">
          <TextArea
            rows={4}
            placeholder="粘贴原文即可，引用方式保持原样"
            value={form.original}
            onChange={(e) => setForm({ ...form, original: e.target.value })}
          />
        </Field>
        <Field label="典故释义" hint="通用层解释——这个典故讲什么、通常表达什么。">
          <TextArea
            rows={4}
            placeholder="这个典故讲什么、通常表达什么"
            value={form.explanation}
            onChange={(e) => setForm({ ...form, explanation: e.target.value })}
          />
        </Field>
        <Field label="常见表达用途" hint="一行一种；用逗号、顿号分隔也可以。已有条目的可信度标注会保留。">
          <TextArea
            rows={3}
            placeholder="一行一种，如：写超脱、写人生如梦"
            value={form.usagesText}
            onChange={(e) => setForm({ ...form, usagesText: e.target.value })}
          />
        </Field>
        <Field label="我的阅读札记">
          <TextArea
            rows={4}
            placeholder="关于这个典故，你想记下什么"
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </Field>
        <Field label="主题标签">
          <TagInput value={form.tags} onChange={(tags) => setForm({ ...form, tags })} />
        </Field>
      </div>

      <Field label="资料与可信度">
        <ClaimsEditor value={form.claims} onChange={(claims) => setForm({ ...form, claims })} />
      </Field>

      <Field label="引用出处">
        <CitationsEditor value={form.citations} onChange={(citations) => setForm({ ...form, citations })} />
      </Field>

      <p className="cn-field-hint">保存不会改动任何作品里已经写好的具体解释。</p>

      <div className="cj-savebar">
        <span className={'cj-savestate cj-savestate-' + statusKind}>{statusText}</span>
        <button
          type="button"
          className="cn-btn cn-btn-primary"
          disabled={saving || !loaded}
          onClick={() => save()}
        >
          保存
        </button>
      </div>

      {conflict ? (
        <ChooseBox
          title="这条典故在别处被改过"
          message="你的文字还留着，没有被覆盖。要怎么处理？"
          choices={[
            { key: 'mine', label: '保留我的，覆盖过去', danger: true },
            { key: 'theirs', label: '采用对方的版本' },
          ]}
          onPick={pickConflict}
          onCancel={() => setConflict(null)}
        />
      ) : null}
    </div>
  );
}
