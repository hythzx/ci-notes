/**
 * 词作三视图：列表 / 详情 / 编辑。
 *
 * 语义与文案翻译自词间 web 版（web/views/library.js works、workDetail，
 * web/views/work-edit.js），差异以 brief 为准：
 *   - 列表筛选项来自 api.stats().facets（词间为本地 collectFacets）；
 *   - 详情「原文」用 <pre> 逐字呈现，不解析 Markdown；
 *   - 编辑草稿暂存 localStorage（词间经 store.putDraft），卸载不删，
 *     仅保存成功后清除；
 *   - 冲突为三选一 ChooseBox（词间为二选确认框）。
 *
 * 详情页意象 / 典故区本 Task 以占位 div 留槽（Task 28 接线）。
 * 布局类名 cj-*（Task 23 全量样式），基件复用 components 的 cn-* 组件。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { ApiError } from '../types';
import type {
  Claim,
  ClaimKind,
  Citation,
  Facets,
  Work,
  WorkDetail,
  WorkKind,
  WorkSummary,
} from '../types';
import {
  Chip,
  ChooseBox,
  ConfirmBox,
  EmptyState,
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
  StatusSwitcher,
  TagInput,
  TextArea,
} from '../components/editors';
import { Md } from '../components/md';
import { citationLine, download, formatDateTime, workToMarkdown } from '../exporter';
import { navigate } from '../router';

/* ------------------------------------------------------------------ */
/* 共用小件                                                            */
/* ------------------------------------------------------------------ */

const KIND_LABEL: Record<WorkKind, string> = { ci: '词', poem: '诗' };

/** 三档可信度的组标题文案 */
const CLAIM_GROUP_LABEL: Record<ClaimKind, string> = {
  verified: '已核实资料',
  pending: '待核实信息',
  personal: '个人理解',
};

const CLAIM_GROUP_ORDER: ClaimKind[] = ['verified', 'pending', 'personal'];

/** 札记写作状态文案（详情关联札记行用；ui 的 WRITING_LABEL 未导出） */
const WRITING_LABEL: Record<string, string> = {
  idea: '构思',
  research: '资料收集',
  draft: '草稿',
  final: '定稿',
};

/** meta 行：作者 · 朝代 · 词牌，仅词类空词牌补「词牌未填」（词间 utils/view 语义），空字段剔除 */
function workMetaText(w: { author: string; dynasty: string; cipai: string; kind: WorkKind }): string {
  const parts = [w.author, w.dynasty, w.kind === 'ci' && !w.cipai ? '词牌未填' : w.cipai].filter(Boolean);
  return parts.join(' · ');
}

/** 列表首行：衬线展示，超 48 字截断（词间 renderList 同款截断） */
function firstLineOf(w: WorkSummary): string {
  const s = (w.firstLine || '').replace(/\s+/g, ' ').trim();
  if (!s) return '原文待补';
  return s.length > 48 ? s.slice(0, 48) + '…' : s;
}

/** 导出文件名时间戳：本地时间 YYYYMMDD-HHmm（exporter 无此格式 helper） */
function exportStamp(): string {
  const d = new Date();
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes())
  );
}

/* ------------------------------------------------------------------ */
/* 列表                                                                */
/* ------------------------------------------------------------------ */

/** 词作列表：防抖搜索 + 四下拉筛选 + 卡片列表（词间 views.works 语义） */
export function WorksList() {
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [author, setAuthor] = useState('');
  const [cipai, setCipai] = useState('');
  const [tag, setTag] = useState('');
  const [kind, setKind] = useState('');
  const [facets, setFacets] = useState<Facets | null>(null);
  const [items, setItems] = useState<WorkSummary[] | null>(null);

  // 搜索词 220ms 防抖（词间 schedule 同值）
  useEffect(() => {
    const t = setTimeout(() => setDq(q), 220);
    return () => clearTimeout(t);
  }, [q]);

  // 筛选面板选项：一次拉取；失败时下拉退化为空选项，列表仍可搜索
  useEffect(() => {
    let alive = true;
    api.stats().then(
      (d) => {
        if (alive) setFacets(d.facets);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  // 列表数据：防抖搜索词或任一下拉变化即刷新
  useEffect(() => {
    let alive = true;
    api.works
      .list({
        q: dq,
        author,
        cipai,
        tag,
        kind: kind === 'ci' || kind === 'poem' ? kind : undefined,
      })
      .then(
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
  }, [dq, author, cipai, tag, kind]);

  function reset() {
    setQ('');
    setDq('');
    setAuthor('');
    setCipai('');
    setTag('');
    setKind('');
  }

  /** 通用下拉：首项为「全部 xx」空选项 */
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

  return (
    <div className="cj-page">
      <div className="cj-pagehead">
        <h1 className="cj-h1">词作</h1>
        <a className="cn-btn cn-btn-primary" href="#/works/new">＋ 收一首</a>
      </div>

      <div className="cj-toolbar">
        <div className="cj-searchbox">
          <Input placeholder="搜标题、原文、作者" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Sel label="全部作者" value={author} onChange={setAuthor} options={facets?.authors ?? []} />
        <Sel label="全部词牌" value={cipai} onChange={setCipai} options={facets?.cipais ?? []} />
        <Sel label="全部主题" value={tag} onChange={setTag} options={facets?.tags ?? []} />
        {/* 体裁下拉：值存 ci/poem，显示用中文标签 */}
        <select className="cj-select cj-select-inline" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">全部体裁</option>
          {(facets?.kinds ?? []).map((k) => (
            <option key={k} value={k}>{KIND_LABEL[k]}</option>
          ))}
        </select>
        <button type="button" className="cn-btn cn-btn-ghost" onClick={reset}>重置</button>
      </div>

      <div className="cj-list cj-grid">
        {!items ? (
          <EmptyState text="正在打开词作…" />
        ) : !items.length ? (
          <EmptyState text="这里还没有词作。点「＋ 收一首」添进来。" />
        ) : (
          items.map((w) => (
            <a className="cj-card cj-listitem" href={'#/works/' + w.id} key={w.id}>
              <div className="cj-item-head">
                <div className="cj-item-title cj-serif">{w.title || '（未命名）'}</div>
                <span className="cj-kindtag">{KIND_LABEL[w.kind]}</span>
              </div>
              <div className="cj-item-meta">{workMetaText(w)}</div>
              <div className="cj-item-excerpt cj-serif">{firstLineOf(w)}</div>
              <div className="cj-item-foot">
                {w.tags.map((t) => (
                  <Chip tone="muted" key={t}>{t}</Chip>
                ))}
                {w.pendingClaims > 0 ? <Chip tone="pending">{w.pendingClaims} 条待核实</Chip> : null}
                {w.noteCount > 0 ? <span className="cj-item-time">札记 {w.noteCount}</span> : null}
                <RelTime iso={w.updatedAt} />
              </div>
            </a>
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 详情                                                                */
/* ------------------------------------------------------------------ */

/** claims 按 verified/pending/personal 三组拆分，只保留非空组 */
function groupClaims(claims: Claim[]): { kind: ClaimKind; items: Claim[] }[] {
  return CLAIM_GROUP_ORDER.map((kind) => ({
    kind,
    items: claims.filter((c) => c.kind === kind),
  })).filter((g) => g.items.length > 0);
}

/** 出处行是否携带实际内容（备注不算，与编辑器门禁一致） */
function citationHasContent(c: Citation): boolean {
  return !!(c.book || c.edition || c.page || c.url);
}

/** 词作详情（词间 views.workDetail 语义；意象/典故区为 Task 28 占位） */
export function WorkDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<WorkDetail | null>(null);
  const [error, setError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  /** 返回清理函数供 effect 取消晚到响应；重试按钮也复用此函数 */
  function load(): () => void {
    let alive = true;
    setError('');
    setDetail(null);
    api.works.get(id).then(
      (d) => {
        if (alive) setDetail(d);
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

  function doExport() {
    if (!detail) return;
    const w = detail.work;
    download(`${w.title || '词作'}-${exportStamp()}.md`, workToMarkdown(w));
    notifyToast('已下载 Markdown 文件');
  }

  function remove() {
    if (!detail || removing) return;
    setRemoving(true);
    api.works.remove(detail.work.id).then(
      () => {
        notifyToast('已移入回收站');
        navigate('#/works');
      },
      (e: unknown) => {
        setRemoving(false);
        setConfirmRemove(false);
        notifyToast(e instanceof ApiError ? e.message : '移入回收站失败');
      },
    );
  }

  if (error) {
    return (
      <div className="cj-page cj-narrow">
        <EmptyState text={'这篇词作暂时打不开（' + error + '）。'} />
        <div style={{ textAlign: 'center' }}>
          <button type="button" className="cn-btn cn-btn-ghost" onClick={load}>重试</button>
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="cj-page cj-narrow">
        <EmptyState text="正在打开词作…" />
      </div>
    );
  }

  const w = detail.work;
  const groups = groupClaims(w.claims);

  return (
    <div className="cj-page cj-narrow">
      <div className="cj-pagehead">
        <a className="cj-backlink" href="#/works">‹ 词作</a>
        <div className="cj-pagehead-ops">
          <a className="cn-btn cn-btn-ghost cn-btn-sm" href={'#/works/' + w.id + '/edit'}>编辑</a>
          <a className="cn-btn cn-btn-ghost cn-btn-sm" href={'#/compare/new?a=' + w.id}>加入对照</a>
          <button type="button" className="cn-btn cn-btn-ghost cn-btn-sm" onClick={doExport}>
            导出 Markdown
          </button>
          <button
            type="button"
            className="cn-btn cn-btn-danger cn-btn-sm"
            onClick={() => setConfirmRemove(true)}
          >
            移入回收站
          </button>
        </div>
      </div>

      <div className="cj-card">
        <h1 className="cj-h1 cj-serif">{w.title || '（未命名）'}</h1>
        <div className="cj-item-meta">{workMetaText(w)}</div>
        <div className="cj-item-foot">
          {w.tags.map((t) => (
            <Chip tone="muted" key={t}>{t}</Chip>
          ))}
          <span className="cj-item-time">最后修改 {formatDateTime(w.updatedAt)}</span>
        </div>
      </div>

      <Section title="原文">
        {w.content ? (
          <div className="cj-card">
            {/* 词作原文逐字呈现，不解析 Markdown */}
            <pre className="cj-poem" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{w.content}</pre>
          </div>
        ) : (
          <div className="cj-card">
            <EmptyState text="原文待补，编辑里可以贴进去。" />
          </div>
        )}
      </Section>

      <Section title="背景">
        <div className="cj-card">
          {w.background ? <Md text={w.background} /> : <EmptyState text="还没有写背景。" />}
        </div>
      </Section>

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
          {w.citations.length ? (
            w.citations.map((c, i) => (
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

      {detail.relatedWorks.length ? (
        <Section title="相关作品">
          <div className="cj-card">
            {detail.relatedWorks.map((r) => (
              <a className="cj-row cj-row-tap" href={'#/works/' + r.id} key={r.id}>
                <span className="cj-row-label cj-serif">{r.title || '（未命名）'}</span>
                <span className="cj-row-value">{(r.author || '') + ' ›'}</span>
              </a>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="关联札记">
        <div className="cj-card">
          {detail.linkedNotes.length ? (
            detail.linkedNotes.map((n) => (
              <a className="cj-row cj-row-tap" href={'#/notes/' + n.id} key={n.id}>
                <span className="cj-row-label">{n.title}</span>
                <span className="cj-row-value">
                  {(WRITING_LABEL[n.writingStatus] || n.writingStatus) + ' · ' + relTime(n.updatedAt) + ' ›'}
                </span>
              </a>
            ))
          ) : (
            <EmptyState text="还没有札记写到这首。" />
          )}
        </div>
      </Section>

      <Section title="意象">
        {/* Task 28 接线：<ImagerySection targetType="work" targetId={w.id} /> */}
        <div data-slot="imagery-section" className="cj-card" />
      </Section>

      <Section title="典故">
        {/* Task 28 接线：<AllusionSection targetType="work" targetId={w.id} /> */}
        <div data-slot="allusion-section" className="cj-card" />
      </Section>

      {confirmRemove ? (
        <ConfirmBox
          title="移到回收站"
          message="这条词作会先进回收站，可以再恢复。相关札记不受影响，只是解除关联。"
          danger
          onOk={remove}
          onCancel={() => setConfirmRemove(false)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 编辑                                                                */
/* ------------------------------------------------------------------ */

/** 编辑表单状态（词间 work-edit form 同构） */
interface WorkForm {
  title: string;
  author: string;
  dynasty: string;
  kind: WorkKind;
  cipai: string;
  content: string;
  background: string;
  tags: string[];
  claims: Claim[];
  citations: Citation[];
  relatedWorkIds: string[];
}

const EMPTY_FORM: WorkForm = {
  title: '', author: '', dynasty: '', kind: 'ci', cipai: '',
  content: '', background: '', tags: [], claims: [], citations: [], relatedWorkIds: [],
};

function toForm(w: Work): WorkForm {
  return {
    title: w.title, author: w.author, dynasty: w.dynasty,
    kind: w.kind === 'poem' ? 'poem' : 'ci', cipai: w.cipai,
    content: w.content, background: w.background,
    tags: (w.tags || []).slice(), claims: (w.claims || []).slice(),
    citations: (w.citations || []).slice(), relatedWorkIds: (w.relatedWorkIds || []).slice(),
  };
}

/** unknown 草稿安全并入表单：字段类型不符时保留默认值（词间逐字段判断语义） */
function mergeForm(raw: unknown): WorkForm {
  const d = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<keyof WorkForm, unknown>>;
  const f: WorkForm = { ...EMPTY_FORM };
  for (const key of ['title', 'author', 'dynasty', 'cipai', 'content', 'background'] as const) {
    if (typeof d[key] === 'string') f[key] = d[key] as string;
  }
  if (d.kind === 'ci' || d.kind === 'poem') f.kind = d.kind;
  if (Array.isArray(d.tags)) f.tags = d.tags as string[];
  if (Array.isArray(d.claims)) f.claims = d.claims as Claim[];
  if (Array.isArray(d.citations)) f.citations = d.citations as Citation[];
  if (Array.isArray(d.relatedWorkIds)) f.relatedWorkIds = d.relatedWorkIds as string[];
  return f;
}

type SaveState = { kind: 'idle' | 'saving' | 'saved' | 'error'; text: string };

/** 保存请求体：表单字段平铺 + 可选乐观锁字段 */
function toPayload(form: WorkForm): Partial<Work> {
  return {
    title: form.title, author: form.author, dynasty: form.dynasty, kind: form.kind,
    cipai: form.cipai, content: form.content, background: form.background,
    tags: form.tags, claims: form.claims, citations: form.citations,
    relatedWorkIds: form.relatedWorkIds,
  };
}

/**
 * 词作编辑（新建 / 修改一体，词间 views.workEdit 语义）。
 * 本机草稿：key 新建 draft:work:new:<ms>（进入页面时生成，防多开碰撞）、
 * 已有 draft:work:<id>；700ms 防抖写入，进入时恢复并提示，保存成功清除，
 * 卸载不删（保留防丢）。dirty 时挂 beforeunload 拦截。
 */
export function WorkEdit({ id }: { id?: string }) {
  const draftKey = useMemo(
    () => (id ? 'draft:work:' + id : 'draft:work:new:' + Date.now()),
    [id],
  );

  const [form, setForm] = useState<WorkForm>(EMPTY_FORM);
  const [baseline, setBaseline] = useState<WorkForm>(EMPTY_FORM);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [allWorks, setAllWorks] = useState<WorkSummary[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle', text: '' });
  const [conflict, setConflict] = useState<ApiError | null>(null);

  // 乐观锁基准版本：ref 供保存闭包随时读取最新值
  const baseRevision = useRef<number | undefined>(undefined);
  // 采用对方回填时置 true：让草稿写入 effect 跳过这一次写入，保护
  // localStorage 里用户自己的文字（与 notes.tsx 同款防护）
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

  /* 加载：编辑取详情，同时拉全量列表供「相关作品」勾选；之后恢复本机草稿 */
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setLoadError('');
    const pWork = id ? api.works.get(id).then((d) => d.work) : Promise.resolve(null);
    Promise.all([pWork, api.works.list()])
      .then(([work, list]) => {
        if (!alive) return;
        const base = work ? toForm(work) : EMPTY_FORM;
        if (work) baseRevision.current = work.revision;
        setBaseline(base);
        setForm(base);
        setAllWorks(list.filter((x) => x.id !== id));
        // 本机暂存优先：上次没保存的内容自动接上
        let restored: WorkForm | null = null;
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
      })
      .catch((e: unknown) => {
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
      // 本次 form 变化来自「采用对方」回填，不落暂存，复位标志
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

  /** 保存：新建 create 返回 work 对象本身，更新返回 {work} */
  async function save(forceRev?: { revision: number; force: true }) {
    if (!loaded || saving) return;
    if (!form.title.trim() && !form.content.trim()) {
      notifyToast('至少填标题或原文');
      return;
    }
    setSaving(true);
    setSaveState({ kind: 'saving', text: '保存中…' });
    const payload: Partial<Work> & { baseRevision?: number; force?: boolean } = toPayload(form);
    if (forceRev) {
      payload.baseRevision = forceRev.revision;
      payload.force = true;
    } else if (id) {
      payload.baseRevision = baseRevision.current;
    }
    try {
      const savedId = id
        ? (await api.works.update(id, payload)).work.id
        : (await api.works.create(payload)).id;
      clearDraft();
      notifyToast('已保存');
      navigate('#/works/' + savedId);
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
    const cur = err.current as Partial<Work> | undefined;
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
      // 回填触发的防抖写入被跳过，本机暂存里仍是用户自己的文字
      skipDraftWrite.current = true;
      const f = mergeForm(cur);
      baseRevision.current = cur.revision;
      setForm(f);
      setBaseline(f);
      setSaveState({ kind: 'idle', text: '' });
      notifyToast('已载入对方的最新版本');
    }
  }

  function toggleRelated(workId: string) {
    setForm((f) => ({
      ...f,
      relatedWorkIds: f.relatedWorkIds.includes(workId)
        ? f.relatedWorkIds.filter((x) => x !== workId)
        : [...f.relatedWorkIds, workId],
    }));
  }

  if (loadError) {
    return (
      <div className="cj-page cj-formpage">
        <div className="cj-pagehead">
          <a className="cj-backlink" href="#/works">‹ 词作</a>
          <h1 className="cj-h1">编辑词作</h1>
        </div>
        <EmptyState text={'这篇词作暂时打不开（' + loadError + '）。'} />
      </div>
    );
  }

  const backTo = id ? '#/works/' + id : '#/works';
  const relatedOptions = allWorks.filter((x) => x.id !== id);

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
        <a className="cj-backlink" href={backTo}>‹ 词作</a>
        <h1 className="cj-h1">{id ? '编辑词作' : '收一首'}</h1>
      </div>

      <div className="cj-card">
        <Field label="标题">
          <Input
            placeholder="如 凤栖梧·其二（伫倚危楼风细细）"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </Field>
        <div className="cj-grid2">
          <Field label="作者">
            <Input
              placeholder="如 柳永"
              value={form.author}
              onChange={(e) => setForm({ ...form, author: e.target.value })}
            />
          </Field>
          <Field label="朝代">
            <Input
              placeholder="如 北宋"
              value={form.dynasty}
              onChange={(e) => setForm({ ...form, dynasty: e.target.value })}
            />
          </Field>
        </div>
        <Field label="体裁">
          <StatusSwitcher
            options={[['ci', '词'], ['poem', '诗']]}
            value={form.kind}
            onChange={(k) => setForm({ ...form, kind: k })}
          />
        </Field>
        <Field label="词牌 / 体裁名（可留空）">
          <Input
            placeholder="如 凤栖梧（可留空）"
            value={form.cipai}
            onChange={(e) => setForm({ ...form, cipai: e.target.value })}
          />
        </Field>
      </div>

      <div className="cj-card">
        <Field label="原文">
          <TextArea
            rows={10}
            className="cj-textarea-serif"
            placeholder="按句分行录入，换行会原样保留"
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
          />
        </Field>
      </div>

      <div className="cj-card">
        <Field label="背景">
          <TextArea
            rows={4}
            placeholder="简短的背景说明"
            value={form.background}
            onChange={(e) => setForm({ ...form, background: e.target.value })}
          />
        </Field>
      </div>

      <div className="cj-card">
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

      <div className="cj-card">
        <Field label="相关作品">
          {relatedOptions.length ? (
            <div className="cj-picklist">
              {relatedOptions.map((x) => (
                <label className="cj-pickrow" key={x.id}>
                  <input
                    type="checkbox"
                    checked={form.relatedWorkIds.includes(x.id)}
                    onChange={() => toggleRelated(x.id)}
                  />
                  <div className="cj-picktext">
                    <div className="cj-picktitle cj-serif">{x.title || '（未命名）'}</div>
                    <div className="cj-item-meta">{workMetaText(x)}</div>
                  </div>
                </label>
              ))}
            </div>
          ) : (
            <p className="cn-field-hint">还没有别的作品可以关联。</p>
          )}
        </Field>
      </div>

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
          title="这条词作在别处被改过"
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
