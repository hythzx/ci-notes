/**
 * 对照三视图：列表 / 选两首 / 详情（七维卡 + 意象典故交叉块）。
 * 语义与文案翻译自词间 web/views/compare.js；与参考实现的三处差异
 * （均为 brief 契约，以服务端实际返回为准）：
 *   - imagery/allusions 的 compare 返回 {shared, onlyA, onlyB} 分组结构
 *     （词间是扁平 uses 列表内嵌 imagery），shared 每条甲乙使用记录
 *     上下两块排列，不做左右两栏；
 *   - 列表摘要已由服务端装配 workATitle/workBTitle（已删词作显示
 *     「（已删除的词作）」）与 writtenCount（七维 text 非空计数），
 *     前端不再查词作库；
 *   - 维度编辑面板「存下」即整体 PUT 全部七维（对照无乐观锁、无版本），
 *     服务端 normalizeDimensions 会丢弃未知 key 并重建。
 *
 * 头部甲乙链接、updatedAt、删除确认文案按 brief 补齐；删除为直接删除
 * （不进回收站），词作不受影响。
 */
import { Fragment, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api';
import { ApiError } from '../types';
import type {
  AllusionCompare,
  AllusionUse,
  ClaimKind,
  Citation,
  CompareDimKey,
  CompareDimension,
  Comparison,
  ComparisonDetail,
  ComparisonSummary,
  Imagery,
  ImageryCompare,
  ImageryUse,
  Work,
  WorkSummary,
} from '../types';
import { Chip, ConfirmBox, EmptyState, RelTime, Section, notifyToast } from '../components/ui';
import { CitationsEditor, Field, StatusSwitcher, TextArea } from '../components/editors';
import { Md } from '../components/md';
import { citationLine, formatDateTime } from '../exporter';
import { navigate } from '../router';

/* ------------------------------------------------------------------ */
/* 常量与小件（模块顶层，供三个视图共用）                                */
/* ------------------------------------------------------------------ */

/** 七维 key 与标题（与服务端 comparisons.mjs COMPARE_DIMENSIONS 逐项对齐） */
const DIMENSIONS: [CompareDimKey, string][] = [
  ['context', '人物与情境'],
  ['imagery', '意象'],
  ['allusion', '典故及出处'],
  ['expression', '表达方式'],
  ['similarity', '相同点'],
  ['difference', '不同点'],
  ['understanding', '自己的阅读理解'],
];

/** 前 4 维有甲乙两侧描述，后 3 维只有总结（服务端 SIDE_DIMENSIONS 同款） */
const SIDE_DIMENSIONS: CompareDimKey[] = ['context', 'imagery', 'allusion', 'expression'];

/** 维度默认可信度：理解维是个人观点，其余默认待核实（服务端同款） */
function defaultKind(key: CompareDimKey): ClaimKind {
  return key === 'understanding' ? 'personal' : 'pending';
}

/** 维度兜底归一化：与服务端 emptyDimensions 同构，防旧数据缺字段 */
function normalizeDims(
  src: Partial<Record<CompareDimKey, Partial<CompareDimension>>> | undefined | null,
): Record<CompareDimKey, CompareDimension> {
  const out = {} as Record<CompareDimKey, CompareDimension>;
  for (const [key] of DIMENSIONS) {
    const v = (src && src[key]) || {};
    const dim: CompareDimension = {
      text: v.text || '',
      kind: v.kind || defaultKind(key),
      citations: v.citations || [],
    };
    if (SIDE_DIMENSIONS.indexOf(key) >= 0) {
      dim.sides = { a: (v.sides && v.sides.a) || '', b: (v.sides && v.sides.b) || '' };
    }
    out[key] = dim;
  }
  return out;
}

/** 三档可信度的全称文案（维度编辑面板的三档开关用） */
const KIND_OPTIONS: [ClaimKind, string][] = [
  ['verified', '已核实资料'],
  ['pending', '待核实信息'],
  ['personal', '个人理解'],
];

/** 三档可信度的角标简称（维度卡 chip 用，与 use 记录条目同款） */
const KIND_SHORT: Record<ClaimKind, string> = {
  verified: '已核实',
  pending: '待核实',
  personal: '理解',
};

/** 出处行是否携带实际内容（备注不算，与编辑器门禁一致） */
function citationHasContent(c: Citation): boolean {
  return !!(c.book || c.edition || c.page || c.url);
}

/** meta 行：作者 · 朝代 · 词牌（词类空词牌补「词牌未填」），空字段剔除 */
function workMetaText(w: { author: string; dynasty: string; cipai: string; kind: Work['kind'] }): string {
  const parts = [w.author, w.dynasty, w.kind === 'ci' && !w.cipai ? '词牌未填' : w.cipai].filter(Boolean);
  return parts.join(' · ');
}

/** 衬线首行，超 max 字截断（选两首卡片用） */
function firstLineOf(text: string, max = 40): string {
  const s = (text || '').split('\n')[0].trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
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
 * 只读的意象使用记录：quote 逐字 + 情境 / 表达作用 / 我的理解。
 * 对照块里不做编辑 —— 使用记录在各自作品的意象区域里维护。
 */
function ImageryUseLine({ use }: { use: ImageryUse }) {
  return (
    <div className="cj-imagery-use">
      {use.quote ? <pre className="cj-imagery-quote">{use.quote}</pre> : null}
      <UseFieldRow label="情境" text={use.context} />
      <UseFieldRow label="表达作用" text={use.fn} />
      <UseFieldRow label="我的理解" text={use.understanding} />
    </div>
  );
}

/**
 * 只读的典故使用记录：与意象同构，表达作用字段为 interpretation，
 * 行 label「此处解释」（典故详情页同款）。
 */
function AllusionUseLine({ use }: { use: AllusionUse }) {
  return (
    <div className="cj-imagery-use">
      {use.quote ? <pre className="cj-imagery-quote">{use.quote}</pre> : null}
      <UseFieldRow label="情境" text={use.context} />
      <UseFieldRow label="此处解释" text={use.interpretation} />
      <UseFieldRow label="我的理解" text={use.understanding} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 意象 / 典故交叉块（两库同构，泛型组件共用一份渲染）                   */
/* ------------------------------------------------------------------ */

/** 交叉块的实体条目：compare 返回的 imagery/allusion 键名统一为 entity */
interface CrossData<E, U> {
  shared: { entity: E; usesA: U[]; usesB: U[] }[];
  onlyA: { entity: E; usesA: U[] }[];
  onlyB: { entity: E; usesB: U[] }[];
}

/** 甲乙一侧的使用记录块：label 在上、记录在下（上下排列，移动端不挤） */
function CompareSide<U extends { id: string }>({ label, uses, renderUse }: {
  label: string;
  uses: U[];
  renderUse: (use: U) => ReactNode;
}) {
  if (!uses.length) return null;
  return (
    <div className="cj-imagery-side">
      <div className="cj-imagery-side-label">{label}</div>
      {uses.map((u) => (
        <Fragment key={u.id}>{renderUse(u)}</Fragment>
      ))}
    </div>
  );
}

/**
 * 意象 / 典故交叉块：说明行 + 共同条目（甲乙使用记录上下两块） +
 * 各自条目分列（只有甲有 / 只有乙有，均链接到库内详情）+ 空态。
 * 词间 views.compareDetail 意象块的 React 版，典故块按 brief 同构补齐。
 */
function CrossBlock<E extends { id: string; name: string }, U extends { id: string }>({
  data,
  error,
  noun,
  hrefBase,
  sideA,
  sideB,
  renderUse,
  emptyText,
}: {
  data: CrossData<E, U> | null;
  error: string;
  noun: string;
  hrefBase: string;
  sideA: string;
  sideB: string;
  renderUse: (use: U) => ReactNode;
  emptyText: string;
}) {
  return (
    <div className="cj-card">
      <p className="cj-me-p">
        下面是从两首作品里已记录的{noun}关联直接读出来的，不用重填。
        你自己的比较结论写在下面的维度里，两边互不覆盖。
      </p>

      {error ? (
        <EmptyState text={noun + '对照暂时取不到（' + error + '）。'} />
      ) : !data ? (
        <EmptyState text={'正在整理两边的' + noun + '…'} />
      ) : (
        <>
          {data.shared.length ? (
            <div className="cj-imagery-shared">
              <div className="cj-section-title">共同{noun}</div>
              {data.shared.map((x) => (
                <div className="cj-imagery-work" key={x.entity.id}>
                  <div className="cj-item-head">
                    <a className="cj-item-title cj-serif" href={hrefBase + x.entity.id}>
                      {x.entity.name}
                    </a>
                    <span className="cj-item-time">两首都有</span>
                  </div>
                  <CompareSide label={'甲 · ' + sideA} uses={x.usesA} renderUse={renderUse} />
                  <CompareSide label={'乙 · ' + sideB} uses={x.usesB} renderUse={renderUse} />
                </div>
              ))}
            </div>
          ) : null}

          {data.onlyA.length || data.onlyB.length ? (
            <div className="cj-imagery-diff">
              <div className="cj-section-title">各自的{noun}</div>
              {data.onlyA.length ? (
                <div className="cj-imagery-side">
                  <div className="cj-imagery-side-label">只有甲有</div>
                  {data.onlyA.map((x) => (
                    <div className="cj-imagery-work" key={x.entity.id}>
                      <div className="cj-item-head">
                        <a className="cj-item-title" href={hrefBase + x.entity.id}>{x.entity.name}</a>
                        <span className="cj-item-time">{sideA}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {data.onlyB.length ? (
                <div className="cj-imagery-side">
                  <div className="cj-imagery-side-label">只有乙有</div>
                  {data.onlyB.map((x) => (
                    <div className="cj-imagery-work" key={x.entity.id}>
                      <div className="cj-item-head">
                        <a className="cj-item-title" href={hrefBase + x.entity.id}>{x.entity.name}</a>
                        <span className="cj-item-time">{sideB}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {!data.shared.length && !data.onlyA.length && !data.onlyB.length ? (
            <EmptyState text={emptyText} />
          ) : null}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 列表                                                                */
/* ------------------------------------------------------------------ */

/**
 * 对照列表：说明卡 + 每条（标题、甲 / 乙标题、n / 7 个维度已写、时间）。
 * 已删词作的占位文案由服务端 listComparisons 装配，这里直接显示。
 */
export function CompareList() {
  const [items, setItems] = useState<ComparisonSummary[] | null>(null);

  useEffect(() => {
    let alive = true;
    api.comparisons.list().then(
      (d) => {
        if (alive) setItems(d);
      },
      (e: unknown) => {
        if (!alive) return;
        notifyToast(e instanceof ApiError ? e.message : '对照列表加载失败');
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="cj-page">
      <div className="cj-pagehead">
        <h1 className="cj-h1">词作对照</h1>
        <a className="cn-btn cn-btn-primary" href="#/compare/new">开始一次对照</a>
      </div>

      <div className="cj-card">
        <div className="cj-item-title cj-serif">把两首放在一起看</div>
        <div className="cj-item-meta">
          按人物与情境、意象、典故、表达方式逐项对照，最后写自己的理解。对照笔记会跟着备份一起走。
        </div>
      </div>

      <div className="cj-list">
        {!items ? (
          <EmptyState text="正在打开对照…" />
        ) : !items.length ? (
          <EmptyState text="还没有对照笔记。点「开始一次对照」选两首词作。" />
        ) : (
          items.map((c) => (
            <a className="cj-card cj-listitem" href={'#/compare/' + c.id} key={c.id}>
              <div className="cj-item-title cj-serif">{c.title || '（未命名对照）'}</div>
              <div className="cj-item-meta">甲 · {c.workATitle}</div>
              <div className="cj-item-meta">乙 · {c.workBTitle}</div>
              <div className="cj-item-foot">
                <span className="cj-item-time">{c.writtenCount} / 7 个维度已写</span>
                <RelTime iso={c.updatedAt} />
              </div>
            </a>
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 选两首                                                              */
/* ------------------------------------------------------------------ */

/** ?a= 预选第一首（进入页面时解析一次 hash 查询串，路由切换会重建实例） */
function presetWorkA(): string[] {
  const q = location.hash.split('?')[1] || '';
  const a = new URLSearchParams(q).get('a');
  return a ? [a] : [];
}

/**
 * 选两首：作品卡点选，按点击顺序进 picked（甲 = 先选的那首），
 * 点已选的取消，超过两首给提示。开始对照创建空七维对照后跳详情。
 */
export function ComparePick() {
  const [items, setItems] = useState<WorkSummary[] | null>(null);
  const [picked, setPicked] = useState<string[]>(presetWorkA);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let alive = true;
    api.works.list({}).then(
      (d) => {
        if (alive) setItems(d);
      },
      (e: unknown) => {
        if (!alive) return;
        notifyToast(e instanceof ApiError ? e.message : '词作列表加载失败');
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  /** 点已选的取消；选满两首再点给提示（不替换已选，保住先选为甲的顺序） */
  function toggle(id: string) {
    const idx = picked.indexOf(id);
    if (idx >= 0) {
      setPicked(picked.filter((x) => x !== id));
      return;
    }
    if (picked.length >= 2) {
      notifyToast('一次只能选两首');
      return;
    }
    setPicked([...picked, id]);
  }

  function create() {
    if (picked.length !== 2 || creating) return;
    setCreating(true);
    // dimensions 留空由服务端 emptyDimensions 兜底；甲 = 先选的那首
    api.comparisons
      .create({ workAId: picked[0], workBId: picked[1], title: '' })
      .then(
        (cmp) => navigate('#/compare/' + cmp.id),
        (e: unknown) => {
          setCreating(false);
          notifyToast(e instanceof ApiError ? e.message : '创建对照失败');
        },
      );
  }

  return (
    <div className="cj-page">
      <div className="cj-pagehead">
        <a className="cj-backlink" href="#/compare">‹ 对照</a>
        <h1 className="cj-h1">选两首</h1>
      </div>

      <div className="cj-card">
        <div className="cj-item-title cj-serif">选好后开始对照</div>
        <div className="cj-item-meta">甲是先选的那首，乙是第二首。</div>
      </div>

      <div className="cj-list cj-grid">
        {!items ? (
          <EmptyState text="正在打开词作…" />
        ) : !items.length ? (
          <EmptyState text="这里还没有词作，先去收一首再来对照。" />
        ) : (
          items.map((w) => {
            const on = picked.indexOf(w.id) >= 0;
            return (
              <button
                type="button"
                className="cj-card cj-pickcard"
                key={w.id}
                onClick={() => toggle(w.id)}
                style={on ? { borderColor: 'var(--green)' } : undefined}
              >
                <div className="cj-item-head">
                  <div className="cj-item-title cj-serif">{w.title || '（未命名）'}</div>
                  <span className={'cj-pickbox' + (on ? ' cj-pickbox-on' : '')}>{on ? '✓' : ''}</span>
                </div>
                <div className="cj-item-meta">{workMetaText(w)}</div>
                <div className="cj-item-excerpt cj-serif">{firstLineOf(w.firstLine)}</div>
              </button>
            );
          })
        )}
      </div>

      <div className="cj-savebar">
        <span className="cj-savestate">已选 {picked.length} / 2 首</span>
        <button
          type="button"
          className="cn-btn cn-btn-primary"
          disabled={picked.length !== 2 || creating || !items}
          onClick={create}
        >
          {creating ? '创建中…' : '开始对照'}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 详情：维度卡                                                        */
/* ------------------------------------------------------------------ */

/**
 * 维度编辑面板：前 4 维两侧 textarea，全部维度总结 + 可信度三档 +
 * 每维独立的引用出处。「存下」把草稿整体交给父级随全七维 PUT。
 */
function DimEditor({ label, hasSide, dim, onSave, onCancel }: {
  label: string;
  hasSide: boolean;
  dim: CompareDimension;
  onSave: (dim: CompareDimension) => void;
  onCancel: () => void;
}) {
  const [sideA, setSideA] = useState((dim.sides && dim.sides.a) || '');
  const [sideB, setSideB] = useState((dim.sides && dim.sides.b) || '');
  const [text, setText] = useState(dim.text);
  const [kind, setKind] = useState<ClaimKind>(dim.kind);
  const [cites, setCites] = useState<Citation[]>(dim.citations);

  function save() {
    onSave({
      ...dim,
      text,
      kind,
      citations: cites,
      ...(hasSide ? { sides: { a: sideA, b: sideB } } : {}),
    });
  }

  return (
    <div className="cj-card cj-dim cj-editpanel">
      <div className="cj-dim-label">{label}</div>
      {hasSide ? (
        <Field label="甲的视角">
          <TextArea
            rows={3}
            placeholder="这一首里这一项是什么"
            value={sideA}
            onChange={(e) => setSideA(e.target.value)}
          />
        </Field>
      ) : null}
      {hasSide ? (
        <Field label="乙的视角">
          <TextArea
            rows={3}
            placeholder="那一首里这一项是什么"
            value={sideB}
            onChange={(e) => setSideB(e.target.value)}
          />
        </Field>
      ) : null}
      <Field label="这一维度的总结">
        <TextArea
          rows={3}
          placeholder="相同与不同，或者你的理解"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <Field label="可信度">
        <StatusSwitcher options={KIND_OPTIONS} value={kind} onChange={setKind} />
      </Field>
      <Field label="出处">
        <CitationsEditor value={cites} onChange={setCites} />
      </Field>
      <div className="cn-dialog-ops">
        <button type="button" className="cn-btn cn-btn-primary cn-btn-sm" onClick={save}>存下</button>
        <button type="button" className="cn-btn cn-btn-quiet cn-btn-sm" onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 详情                                                                */
/* ------------------------------------------------------------------ */

/**
 * 对照详情：头部（标题 + 甲乙链接 + 时间 + 删除对照）→ 已记录的意象 /
 * 已记录的典故交叉块（两侧作品齐备时才拉取）→ 原文对照双卡 → 七维卡。
 * 维度卡一次只展开一个编辑面板，「存下」整体 PUT 全七维后用返回值刷新。
 */
export function CompareDetail({ id }: { id: string }) {
  const [data, setData] = useState<ComparisonDetail | null>(null);
  const [error, setError] = useState('');
  const [dims, setDims] = useState<Record<CompareDimKey, CompareDimension> | null>(null);
  const [editingKey, setEditingKey] = useState<CompareDimKey | null>(null);
  const [saving, setSaving] = useState(false);
  const [imData, setImData] = useState<ImageryCompare | null>(null);
  const [imError, setImError] = useState('');
  const [alData, setAlData] = useState<AllusionCompare | null>(null);
  const [alError, setAlError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  /** 返回清理函数供 effect 取消晚到响应；重试按钮也复用此函数 */
  function load(): () => void {
    let alive = true;
    setError('');
    setData(null);
    setDims(null);
    setEditingKey(null);
    api.comparisons.get(id).then(
      (d) => {
        if (!alive) return;
        setData(d);
        setDims(normalizeDims(d.comparison.dimensions));
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

  const workA = data ? data.workA : null;
  const workB = data ? data.workB : null;

  // 交叉块只依赖甲乙作品本身；维度编辑不走这里，保存后无需重拉
  useEffect(() => {
    if (!workA || !workB) return;
    let alive = true;
    setImData(null);
    setImError('');
    setAlData(null);
    setAlError('');
    api.imagery.compare(workA.id, workB.id).then(
      (d) => {
        if (alive) setImData(d);
      },
      (e: unknown) => {
        if (alive) setImError(e instanceof ApiError ? e.message : '加载失败');
      },
    );
    api.allusions.compare(workA.id, workB.id).then(
      (d) => {
        if (alive) setAlData(d);
      },
      (e: unknown) => {
        if (alive) setAlError(e instanceof ApiError ? e.message : '加载失败');
      },
    );
    return () => {
      alive = false;
    };
  }, [workA, workB]);

  /** 存下一维：并入全七维整体 PUT；成功用返回值刷新（对照无乐观锁） */
  function saveDim(key: CompareDimKey, dim: CompareDimension) {
    const current = dims;
    if (!data || !current || saving) return;
    const c = data.comparison;
    const next = { ...current, [key]: dim };
    setDims(next);
    setEditingKey(null);
    setSaving(true);
    api.comparisons
      .update(c.id, {
        id: c.id,
        title: c.title,
        workAId: c.workAId,
        workBId: c.workBId,
        dimensions: next,
      })
      .then(
        (cmp) => {
          setSaving(false);
          setDims(normalizeDims(cmp.dimensions));
          setData({ ...data, comparison: cmp });
          notifyToast('已保存');
        },
        (e: unknown) => {
          setSaving(false);
          notifyToast(e instanceof ApiError ? e.message : '保存失败');
        },
      );
  }

  /** 直接删除（不进回收站），两首词作不受影响 */
  function remove() {
    if (!data || removing) return;
    setRemoving(true);
    api.comparisons.remove(data.comparison.id).then(
      () => {
        notifyToast('已删除对照');
        navigate('#/compare');
      },
      (e: unknown) => {
        setRemoving(false);
        setConfirmRemove(false);
        notifyToast(e instanceof ApiError ? e.message : '删除失败');
      },
    );
  }

  if (error) {
    return (
      <div className="cj-page cj-narrow">
        <EmptyState text={'这条对照暂时打不开（' + error + '）。'} />
        <div style={{ textAlign: 'center' }}>
          <button type="button" className="cn-btn cn-btn-ghost" onClick={load}>重试</button>
        </div>
      </div>
    );
  }
  if (!data || !dims) {
    return (
      <div className="cj-page cj-narrow">
        <EmptyState text="正在打开对照…" />
      </div>
    );
  }

  const c = data.comparison;
  const titleA = workA ? workA.title || '（未命名）' : '（已删除的词作）';
  const titleB = workB ? workB.title || '（未命名）' : '（已删除的词作）';

  // compare 返回的 imagery/allusion 键名统一映射为 entity，交叉块共用一份渲染
  const imCross: CrossData<Imagery, ImageryUse> | null = imData
    ? {
        shared: imData.shared.map(({ imagery, usesA, usesB }) => ({ entity: imagery, usesA, usesB })),
        onlyA: imData.onlyA.map(({ imagery, usesA }) => ({ entity: imagery, usesA })),
        onlyB: imData.onlyB.map(({ imagery, usesB }) => ({ entity: imagery, usesB })),
      }
    : null;
  const alCross: CrossData<{ id: string; name: string }, AllusionUse> | null = alData
    ? {
        shared: alData.shared.map(({ allusion, usesA, usesB }) => ({ entity: allusion, usesA, usesB })),
        onlyA: alData.onlyA.map(({ allusion, usesA }) => ({ entity: allusion, usesA })),
        onlyB: alData.onlyB.map(({ allusion, usesB }) => ({ entity: allusion, usesB })),
      }
    : null;

  return (
    <div className="cj-page cj-narrow">
      <div className="cj-pagehead">
        <a className="cj-backlink" href="#/compare">‹ 对照</a>
        <div className="cj-pagehead-ops">
          <button
            type="button"
            className="cn-btn cn-btn-danger cn-btn-sm"
            disabled={saving}
            onClick={() => setConfirmRemove(true)}
          >
            删除对照
          </button>
        </div>
      </div>

      <div className="cj-card">
        <h1 className="cj-h1 cj-serif">{c.title || '词作对照'}</h1>
        <div className="cj-item-foot">
          {workA ? (
            <a className="cj-item-title" href={'#/works/' + workA.id}>甲 · {titleA}</a>
          ) : (
            <span className="cj-item-time">甲 · {titleA}</span>
          )}
          {workB ? (
            <a className="cj-item-title" href={'#/works/' + workB.id}>乙 · {titleB}</a>
          ) : (
            <span className="cj-item-time">乙 · {titleB}</span>
          )}
          <span className="cj-item-time">最后修改 {formatDateTime(c.updatedAt)}</span>
        </div>
      </div>

      {workA && workB ? (
        <Section title="已记录的意象">
          <CrossBlock
            data={imCross}
            error={imError}
            noun="意象"
            hrefBase="#/imagery/"
            sideA={titleA}
            sideB={titleB}
            renderUse={(u) => <ImageryUseLine use={u} />}
            emptyText="这两首作品还没记录意象。到各自作品的「意象」区域里关联，这里就会自动显示。"
          />
        </Section>
      ) : null}

      {workA && workB ? (
        <Section title="已记录的典故">
          <CrossBlock
            data={alCross}
            error={alError}
            noun="典故"
            hrefBase="#/allusions/"
            sideA={titleA}
            sideB={titleB}
            renderUse={(u) => <AllusionUseLine use={u} />}
            emptyText="这两首作品还没记录典故。到各自作品的「典故」区域里关联，这里就会自动显示。"
          />
        </Section>
      ) : null}

      <Section title="原文对照">
        {workA ? (
          <div className="cj-card cj-cmpwork">
            <a className="cj-worklink cj-serif" href={'#/works/' + workA.id}>{titleA} ›</a>
            <div className="cj-item-meta">{workMetaText(workA)}</div>
            <pre className="cj-poem">{workA.content}</pre>
          </div>
        ) : (
          <div className="cj-card"><EmptyState text="（已删除的词作）" /></div>
        )}
        {workB ? (
          <div className="cj-card cj-cmpwork cj-cmpwork-b">
            <a className="cj-worklink cj-serif" href={'#/works/' + workB.id}>{titleB} ›</a>
            <div className="cj-item-meta">{workMetaText(workB)}</div>
            <pre className="cj-poem">{workB.content}</pre>
          </div>
        ) : (
          <div className="cj-card"><EmptyState text="（已删除的词作）" /></div>
        )}
      </Section>

      <Section title="七维对照">
        <div className="cj-list">
          {DIMENSIONS.map(([key, label]) => {
            const dim = dims[key];
            const hasSide = SIDE_DIMENSIONS.indexOf(key) >= 0;
            if (editingKey === key) {
              return (
                <DimEditor
                  key={key}
                  label={label}
                  hasSide={hasSide}
                  dim={dim}
                  onSave={(next) => saveDim(key, next)}
                  onCancel={() => setEditingKey(null)}
                />
              );
            }
            return (
              <div className="cj-card cj-dim" key={key}>
                <div className="cj-dim-head">
                  <span className="cj-dim-label">{label}</span>
                  <button
                    type="button"
                    className="cn-op"
                    disabled={editingKey !== null || saving}
                    onClick={() => setEditingKey(key)}
                  >
                    编辑
                  </button>
                </div>
                {hasSide ? (
                  <>
                    <div className="cj-imagery-side">
                      <div className="cj-imagery-side-label">甲的视角</div>
                      <Md text={dim.sides ? dim.sides.a || '还没写' : '还没写'} inline />
                    </div>
                    <div className="cj-imagery-side">
                      <div className="cj-imagery-side-label">乙的视角</div>
                      <Md text={dim.sides ? dim.sides.b || '还没写' : '还没写'} inline />
                    </div>
                  </>
                ) : null}
                {dim.text ? (
                  <div className="cj-dim-text"><Md text={dim.text} /></div>
                ) : null}
                <div className="cj-item-foot">
                  <Chip tone={dim.kind}>{KIND_SHORT[dim.kind]}</Chip>
                  {dim.citations.filter(citationHasContent).map((x, i) => (
                    <span className="cj-item-time" key={x.id || `cite-${i}`}>出处：{citationLine(x)}</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      {confirmRemove ? (
        <ConfirmBox
          title="删除这条对照"
          message="删除后这条对照笔记会直接删除且不进回收站；两首词作本身不受影响。"
          danger
          onOk={remove}
          onCancel={() => setConfirmRemove(false)}
        />
      ) : null}
    </div>
  );
}
