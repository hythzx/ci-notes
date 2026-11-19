/**
 * 札记三视图：列表 / 阅读 / 编辑。
 *
 * 语义与文案翻译自词间 web 版（web/views/notes.js、web/views/note-edit.js），
 * 差异以 brief 为准：
 *   - 列表筛选用固定状态枚举（词间 constants 同款），不拉 stats facets；
 *     列表摘要 excerpt 由服务端截 80 字，本地只补截断省略号；
 *   - 阅读页段落标注：Md 的 onGroup 回调里做 DOM 挂载（段类名、点击监听、
 *     该段 claims 角标 chips），点击段落开 Modal 列出该段全部标注与出处，
 *     语义对齐词间 tapPara；
 *   - 编辑草稿暂存 localStorage（key draft:note:*，词间经 store.putDraft），
 *     卸载不删，仅保存成功后清除；
 *   - 定稿/已发布保存 → 服务端派生草稿（createdDraft:true）→ ChooseBox
 *     「去看新草稿 / 留在原篇」；冲突为三选一 ChooseBox（同 Task 25 词作）。
 *
 * 与 Task 25 的三点模式对齐：beforeunload 补 returnValue、load 带 alive
 * 守卫、列表下拉组件定义在模块顶层（避免每次渲染重挂丢焦点）。
 *
 * 阅读页意象 / 典故区本 Task 以占位 div 留槽（Task 28 接线）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { ApiError } from '../types';
import type {
  Claim,
  ClaimKind,
  Citation,
  Note,
  NoteDetail,
  NoteSummary,
  PublishInfo,
  PublishStatus,
  WritingStatus,
  WorkSummary,
} from '../types';
import {
  Chip,
  ChooseBox,
  ConfirmBox,
  EmptyState,
  Modal,
  RelTime,
  Section,
  StatusChip,
  notifyToast,
} from '../components/ui';
import {
  CitationsEditor,
  ClaimsEditor,
  Field,
  Input,
  StatusSwitcher,
  TextArea,
} from '../components/editors';
import { Md } from '../components/md';
import { citationLine, download, formatDateTime, noteToMarkdown } from '../exporter';
import { navigate } from '../router';

/* ------------------------------------------------------------------ */
/* 常量与小件（模块顶层，供三个视图共用）                                */
/* ------------------------------------------------------------------ */

/** 三档可信度的组标题 / 角标文案（词间 claimKindLabel 全称） */
const CLAIM_GROUP_LABEL: Record<ClaimKind, string> = {
  verified: '已核实资料',
  pending: '待核实信息',
  personal: '个人理解',
};

const CLAIM_GROUP_ORDER: ClaimKind[] = ['verified', 'pending', 'personal'];

/** 写作 / 发布状态筛选项（词间 constants 的固定枚举，value 存枚举值） */
const WRITING_STATUS_OPTIONS: [WritingStatus, string][] = [
  ['idea', '构思'],
  ['research', '资料收集'],
  ['draft', '草稿'],
  ['final', '定稿'],
];

const PUBLISH_STATUS_OPTIONS: [PublishStatus, string][] = [
  ['unpublished', '未发布'],
  ['pending', '待发布'],
  ['published', '已发布'],
];

const WRITING_KEYS = WRITING_STATUS_OPTIONS.map(([k]) => k);
const PUBLISH_KEYS = PUBLISH_STATUS_OPTIONS.map(([k]) => k);

/** 写作偏好提示（词间 constants.WRITING_PREFERENCES 原文照搬，只提示不干预） */
const WRITING_PREFERENCES: string[] = [
  '自然、轻快，像随笔。',
  '赏析简洁，但要留一点讨论的余地。',
  '不要过于严肃、官方。',
  '不堆砌辞藻，避免「AI 味」的表达。',
  '不把所有怀念都解释成遗憾。',
];

/** 编辑器自检清单（词间 constants.SELF_CHECK_ITEMS 原文照搬，勾选不持久化） */
const SELF_CHECK_ITEMS: string[] = [
  '有没有把推测写成了事实？',
  '拿不准的地方，标成「待核实」了吗？',
  '这是我的读法，还是书上说的？',
  '结尾是不是又落回「遗憾」了？',
];

/** 定稿 / 已发布的内容冻结（与 server/core isProtected 同判） */
function isProtected(n: Note): boolean {
  return n.writingStatus === 'final' || n.publishStatus === 'published';
}

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

/** 列表摘要：服务端已截 80 字，这里压空白并给截断省略号（词间 excerptOf 语义） */
function excerptText(n: NoteSummary): string {
  const s = (n.excerpt || '').replace(/\s+/g, ' ').trim();
  if (!s) return '正文待导入';
  return s.length >= 80 ? s + '…' : s;
}

/** 导出文件名时间戳：本地时间 YYYYMMDD-HHmm（exporter 无此格式 helper） */
function exportStamp(): string {
  const d = new Date();
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes())
  );
}

/** 通用下拉：首项为「全部 xx」空选项；值与文案分离（模块顶层定义，避免重挂） */
function Sel({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <select className="cj-select cj-select-inline" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{label}</option>
      {options.map(([v, l]) => (
        <option key={v} value={v}>{l}</option>
      ))}
    </select>
  );
}

/** 单条标注行（段落 Modal / 资料区共用）：可信度徽章 + 内容 + 出处行 */
function ClaimRow({ claim }: { claim: Claim }) {
  return (
    <div className="cj-claim">
      <Chip tone={claim.kind}>{CLAIM_GROUP_LABEL[claim.kind]}</Chip>
      <div className="cj-claim-text">
        <Md text={claim.text} inline />
      </div>
      {claim.citations.filter(citationHasContent).map((x, j) => (
        <div className="cj-claim-cite" key={x.id || `cite-${j}`}>出处：{citationLine(x)}</div>
      ))}
    </div>
  );
}

/** 三组可信度的标注块（资料区 / 关联原文摘要共用，词间 views.claimGroups） */
function ClaimGroupsBlock({ claims }: { claims: Claim[] }) {
  const groups = groupClaims(claims);
  if (!groups.length) return null;
  return (
    <>
      {groups.map((g) => (
        <div className="cj-claim-group-title" key={g.kind}>
          <Chip tone={g.kind}>{CLAIM_GROUP_LABEL[g.kind]} · {g.items.length}</Chip>
        </div>
      ))}
      {groups.flatMap((g) => g.items.map((c) => <ClaimRow key={c.id} claim={c} />))}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 列表                                                                */
/* ------------------------------------------------------------------ */

/** 札记列表：防抖搜索 + 写作/发布状态双筛选 + 卡片列表（词间 views.notes 语义） */
export function NotesList() {
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [writing, setWriting] = useState('');
  const [publish, setPublish] = useState('');
  const [items, setItems] = useState<NoteSummary[] | null>(null);

  // 搜索词 220ms 防抖（词间 schedule 同值）
  useEffect(() => {
    const t = setTimeout(() => setDq(q), 220);
    return () => clearTimeout(t);
  }, [q]);

  // 列表数据：防抖搜索词或任一下拉变化即刷新
  useEffect(() => {
    let alive = true;
    api.notes
      .list({
        q: dq,
        writingStatus: WRITING_KEYS.indexOf(writing as WritingStatus) >= 0 ? (writing as WritingStatus) : undefined,
        publishStatus: PUBLISH_KEYS.indexOf(publish as PublishStatus) >= 0 ? (publish as PublishStatus) : undefined,
      })
      .then(
        (d) => {
          if (alive) setItems(d);
        },
        (e: unknown) => {
          if (!alive) return;
          notifyToast(e instanceof ApiError ? e.message : '札记列表加载失败');
        },
      );
    return () => {
      alive = false;
    };
  }, [dq, writing, publish]);

  function reset() {
    setQ('');
    setDq('');
    setWriting('');
    setPublish('');
  }

  return (
    <div className="cj-page">
      <div className="cj-pagehead">
        <h1 className="cj-h1">札记</h1>
        <a className="cn-btn cn-btn-primary" href="#/notes/new">＋ 写一篇</a>
      </div>

      <div className="cj-toolbar">
        <div className="cj-searchbox">
          <Input placeholder="搜标题、随笔正文" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Sel
          label="全部写作状态"
          value={writing}
          onChange={setWriting}
          options={WRITING_STATUS_OPTIONS}
        />
        <Sel
          label="全部发布状态"
          value={publish}
          onChange={setPublish}
          options={PUBLISH_STATUS_OPTIONS}
        />
        <button type="button" className="cn-btn cn-btn-ghost" onClick={reset}>重置</button>
      </div>

      <div className="cj-list">
        {!items ? (
          <EmptyState text="正在打开札记…" />
        ) : !items.length ? (
          <EmptyState text="这里还没有札记。点「＋ 写一篇」开一篇。" />
        ) : (
          items.map((n) => (
            <a className="cj-card cj-listitem" href={'#/notes/' + n.id} key={n.id}>
              <div className="cj-item-title">{n.title || '（未命名札记）'}</div>
              <div className="cj-item-excerpt">{excerptText(n)}</div>
              <div className="cj-item-foot">
                <StatusChip
                  writingStatus={n.writingStatus}
                  publishStatus={n.publishStatus}
                  pendingImport={n.pendingImport}
                  draftOf={n.draftNoteId}
                />
                <RelTime iso={n.updatedAt} />
              </div>
            </a>
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 阅读                                                                */
/* ------------------------------------------------------------------ */

/**
 * 札记阅读（词间 views.noteDetail 语义）。
 * 段落标注：Md 渲染完成后在 onGroup 里给每个段落组挂类名、点击监听与
 * 该段 claims 角标；点击任意段落开 Modal 列出该段全部标注与出处。
 * 意象 / 典故区为 Task 28 占位。
 */
export function NoteDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<NoteDetail | null>(null);
  const [error, setError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** 撤销定稿 / 移入回收站的防重入标志（两个写操作共用） */
  const [busy, setBusy] = useState(false);
  const [confirmUnprotect, setConfirmUnprotect] = useState(false);
  const [paraModal, setParaModal] = useState<number | null>(null);

  /** 返回清理函数供 effect 取消晚到响应；重试按钮也复用此函数 */
  function load(): () => void {
    let alive = true;
    setError('');
    setDetail(null);
    api.notes.get(id).then(
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

  /** claims 按挂靠段落分组（paragraph >= 0 才参与，词间 marksByParagraph 语义） */
  const marks = useMemo(() => {
    const m = new Map<number, Claim[]>();
    if (!detail) return m;
    for (const c of detail.note.claims) {
      if (typeof c.paragraph !== 'number' || c.paragraph < 0) continue;
      const list = m.get(c.paragraph);
      if (list) list.push(c);
      else m.set(c.paragraph, [c]);
    }
    return m;
  }, [detail]);

  /**
   * Md onGroup 回调：段落组刚装好（尚未入容器），在此做 DOM 挂载。
   * 注意不经过 React——组元素由 markdown.ts 创建，effect 里整体挂载，
   * 直接操作与词间 mdView.render 的 onGroup 同构。
   */
  function attachMarks(el: HTMLElement, group: number) {
    el.className = 'cj-para cj-md-group';
    el.addEventListener('click', () => setParaModal(group));
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
  }

  function doExport() {
    if (!detail) return;
    const n = detail.note;
    const md = noteToMarkdown(n, detail.linkedWorks.map((lw) => lw.work));
    download(`${n.title || '札记'}-${exportStamp()}.md`, md);
    notifyToast('已下载 Markdown 文件');
  }

  function copyContent() {
    if (!detail) return;
    navigator.clipboard.writeText(detail.note.content).then(
      () => notifyToast('已复制正文'),
      () => notifyToast('复制失败，请手动选择正文复制'),
    );
  }

  function unprotect() {
    if (!detail || busy) return;
    setBusy(true);
    api.notes.unprotect(detail.note.id).then(
      () => {
        setBusy(false);
        setConfirmUnprotect(false);
        notifyToast('已撤销，这篇现在可以继续修改');
        load();
      },
      (e: unknown) => {
        setBusy(false);
        setConfirmUnprotect(false);
        notifyToast(e instanceof ApiError ? e.message : '撤销失败');
      },
    );
  }

  function remove() {
    if (!detail || busy) return;
    setBusy(true);
    api.notes.remove(detail.note.id).then(
      () => {
        notifyToast('已移入回收站');
        navigate('#/notes');
      },
      (e: unknown) => {
        setBusy(false);
        setConfirmRemove(false);
        notifyToast(e instanceof ApiError ? e.message : '移入回收站失败');
      },
    );
  }

  if (error) {
    return (
      <div className="cj-page cj-narrow">
        <EmptyState text={'这篇札记暂时打不开（' + error + '）。'} />
        <div style={{ textAlign: 'center' }}>
          <button type="button" className="cn-btn cn-btn-ghost" onClick={load}>重试</button>
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="cj-page cj-narrow">
        <EmptyState text="正在打开札记…" />
      </div>
    );
  }

  const n = detail.note;
  const hasContent = !!(n.content && n.content.trim());
  const paraClaims = paraModal !== null ? marks.get(paraModal) ?? [] : [];
  const linkedWorks = detail.linkedWorks;

  return (
    <div className="cj-page cj-narrow">
      <div className="cj-pagehead">
        <a className="cj-backlink" href="#/notes">‹ 札记</a>
        <div className="cj-pagehead-ops">
          <a className="cn-btn cn-btn-ghost cn-btn-sm" href={'#/notes/' + n.id + '/edit'}>编辑</a>
          <a className="cn-btn cn-btn-ghost cn-btn-sm" href={'#/notes/' + n.id + '/history'}>版本历史</a>
          <button type="button" className="cn-btn cn-btn-ghost cn-btn-sm" onClick={doExport}>
            导出 Markdown
          </button>
          <button type="button" className="cn-btn cn-btn-ghost cn-btn-sm" onClick={copyContent}>
            复制内容
          </button>
          {isProtected(n) ? (
            <button
              type="button"
              className="cn-btn cn-btn-quiet cn-btn-sm"
              onClick={() => setConfirmUnprotect(true)}
            >
              撤销定稿
            </button>
          ) : null}
          <button
            type="button"
            className="cn-btn cn-btn-danger cn-btn-sm"
            onClick={() => setConfirmRemove(true)}
          >
            移入回收站
          </button>
        </div>
      </div>

      <div className="cj-readhead">
        <h1 className="cj-h1 cj-serif">{n.title || '（未命名札记）'}</h1>
        <div className="cj-item-foot">
          <StatusChip
            writingStatus={n.writingStatus}
            publishStatus={n.publishStatus}
            pendingImport={n.pendingImport}
            draftOf={n.draftNoteId}
          />
          {n.draftOf ? <Chip tone="muted">续稿</Chip> : null}
        </div>
        <div className="cj-item-meta">
          写于 {formatDateTime(n.createdAt)}　·　改于 {formatDateTime(n.updatedAt)}
        </div>
        {n.changeNote ? <div className="cj-read-change">本次修改说明：{n.changeNote}</div> : null}
      </div>

      {isProtected(n) ? (
        <div className="cj-notice">
          这篇已经定稿或标记为已发布，内容被保护着。继续修改时会另起一篇新草稿，原版一字不动。
        </div>
      ) : null}
      {n.pendingImport ? (
        <div className="cj-notice">正文还没有导入。点「编辑」把你写的原稿贴进来。</div>
      ) : null}
      {n.draftNoteId ? (
        <div className="cj-notice">
          这篇已另起续稿草稿，<a href={'#/notes/' + n.draftNoteId}>点这里继续写</a>。原版保持不动。
        </div>
      ) : null}

      <div className="cj-article">
        {hasContent ? (
          <Md text={n.content} onGroup={attachMarks} />
        ) : (
          <EmptyState text="正文待导入。点「编辑」把你写的原稿贴进来。" />
        )}
      </div>

      {n.note ? (
        <Section title="附记">
          <div className="cj-card">
            <Md text={n.note} />
          </div>
        </Section>
      ) : null}

      {linkedWorks.length ? (
        <Section title="关联原文">
          {linkedWorks.map((lw) => (
            <div className="cj-card" key={lw.work.id}>
              <a className="cj-worklink cj-serif" href={'#/works/' + lw.work.id}>{lw.work.title || '（未命名）'} ›</a>
              <div className="cj-item-meta">
                {[lw.work.author, lw.work.dynasty, lw.work.cipai].filter(Boolean).join(' · ')}
              </div>
              <pre className="cj-poem cj-poem-poem" style={{ margin: 0 }}>{lw.work.content}</pre>
              <ClaimGroupsBlock claims={lw.work.claims} />
            </div>
          ))}
        </Section>
      ) : null}

      {n.claims.length ? (
        <Section title="资料与可信度">
          <div className="cj-card">
            <ClaimGroupsBlock claims={n.claims} />
          </div>
        </Section>
      ) : null}

      {n.citations.length ? (
        <Section title="引用出处">
          <div className="cj-card">
            {n.citations.map((c, i) => (
              <div className="cj-citerow" key={c.id || `citation-${i}`}>
                <div className="cj-claim-text">{citationLine(c)}</div>
                <Chip tone={c.verified}>{CLAIM_GROUP_LABEL[c.verified]}</Chip>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {n.publish && (n.publish.platform || n.publish.url) ? (
        <Section title="发布记录">
          <div className="cj-card">
            <div className="cj-row">
              <span className="cj-row-label">平台</span>
              <span className="cj-row-value">{n.publish.platform || '未填'}</span>
            </div>
            <div className="cj-row">
              <span className="cj-row-label">时间</span>
              <span className="cj-row-value">{n.publish.publishedAt || '未填'}</span>
            </div>
            <div className="cj-row">
              <span className="cj-row-label">链接</span>
              <span className="cj-row-value">{n.publish.url || '未填'}</span>
            </div>
          </div>
        </Section>
      ) : null}

      <Section title="意象">
        {/* Task 28 接线：<ImagerySection targetType="note" targetId={n.id} /> */}
        <div data-slot="imagery-section" className="cj-card" />
      </Section>

      <Section title="典故">
        {/* Task 28 接线：<AllusionSection targetType="note" targetId={n.id} /> */}
        <div data-slot="allusion-section" className="cj-card" />
      </Section>

      {paraModal !== null ? (
        <Modal title={'第 ' + (paraModal + 1) + ' 段'} onClose={() => setParaModal(null)}>
          <div className="cj-card" style={{ maxHeight: '50vh', overflowY: 'auto' }}>
            {paraClaims.length ? (
              paraClaims.map((c) => <ClaimRow key={c.id} claim={c} />)
            ) : (
              <EmptyState text="这一段还没有资料标注。" />
            )}
          </div>
        </Modal>
      ) : null}

      {confirmUnprotect ? (
        <ConfirmBox
          title="撤销定稿 / 发布标记"
          message="撤销后这篇就可以原地继续修改，不会再另起草稿。已发布到别处的内容不会因此改变。"
          danger
          onOk={unprotect}
          onCancel={() => setConfirmUnprotect(false)}
        />
      ) : null}

      {confirmRemove ? (
        <ConfirmBox
          title="移到回收站"
          message="移入回收站后可恢复；只有永久删除才会连历史版本一起清掉。"
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

/** 编辑表单状态（词间 note-edit form 同构；tags 不在编辑面，保存不携带则服务端不动） */
interface NoteForm {
  title: string;
  content: string;
  note: string;
  workIds: string[];
  claims: Claim[];
  citations: Citation[];
  writingStatus: WritingStatus;
  publishStatus: PublishStatus;
  publish: PublishInfo;
  changeNote: string;
}

const EMPTY_FORM: NoteForm = {
  title: '', content: '', note: '', workIds: [], claims: [], citations: [],
  writingStatus: 'draft', publishStatus: 'unpublished',
  publish: { platform: '', publishedAt: '', url: '' },
  changeNote: '',
};

function toForm(n: Note): NoteForm {
  return {
    title: n.title,
    content: n.content,
    note: n.note,
    workIds: (n.workIds || []).slice(),
    claims: (n.claims || []).slice(),
    citations: (n.citations || []).slice(),
    writingStatus: n.writingStatus,
    publishStatus: n.publishStatus,
    publish: {
      platform: n.publish?.platform || '',
      publishedAt: n.publish?.publishedAt || '',
      url: n.publish?.url || '',
    },
    changeNote: n.changeNote,
  };
}

/** unknown 草稿安全并入表单：字段类型不符时保留默认值（词间逐字段判断语义） */
function mergeForm(raw: unknown): NoteForm {
  const d = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<keyof NoteForm, unknown>>;
  const f: NoteForm = { ...EMPTY_FORM };
  for (const key of ['title', 'content', 'note', 'changeNote'] as const) {
    if (typeof d[key] === 'string') f[key] = d[key] as string;
  }
  if (WRITING_KEYS.indexOf(d.writingStatus as WritingStatus) >= 0) {
    f.writingStatus = d.writingStatus as WritingStatus;
  }
  if (PUBLISH_KEYS.indexOf(d.publishStatus as PublishStatus) >= 0) {
    f.publishStatus = d.publishStatus as PublishStatus;
  }
  if (Array.isArray(d.workIds)) f.workIds = d.workIds as string[];
  if (Array.isArray(d.claims)) f.claims = d.claims as Claim[];
  if (Array.isArray(d.citations)) f.citations = d.citations as Citation[];
  const p = d.publish;
  if (typeof p === 'object' && p !== null) {
    const src = p as Partial<Record<keyof PublishInfo, unknown>>;
    for (const key of ['platform', 'publishedAt', 'url'] as const) {
      if (typeof src[key] === 'string') f.publish[key] = src[key] as string;
    }
  }
  return f;
}

type SaveState = { kind: 'idle' | 'saving' | 'saved' | 'error'; text: string };

/** 保存请求体：表单字段平铺（baseRevision/force 由 save 时补） */
function toPayload(form: NoteForm): Partial<Note> {
  return {
    title: form.title,
    content: form.content,
    note: form.note,
    workIds: form.workIds,
    claims: form.claims,
    citations: form.citations,
    writingStatus: form.writingStatus,
    publishStatus: form.publishStatus,
    publish: form.publish,
    changeNote: form.changeNote,
  };
}

/** 正文字号范围（A−/A＋ 步进 1，词间编辑区字号偏好同语义） */
const FONT_MIN = 12;
const FONT_MAX = 24;
const FONT_DEFAULT = 16;

/**
 * 札记编辑（新建 / 修改一体，词间 views.noteEdit 语义）。
 * 本机草稿：key 新建 draft:note:new:<ms>（进入页面时生成，防多开碰撞）、
 * 已有 draft:note:<id>；700ms 防抖写入，进入时恢复并提示，保存成功清除，
 * 卸载不删（保留防丢）。dirty 时挂 beforeunload 拦截。
 *
 * 保存结果三分支：createdDraft → 「去看新草稿 / 留在原篇」ChooseBox；
 * CONFLICT → 三选一（保留我的 force / 采用对方回填 / 先不处理）；
 * 正常 → 回详情页。
 */
export function NoteEdit({ id }: { id?: string }) {
  const draftKey = useMemo(
    () => (id ? 'draft:note:' + id : 'draft:note:new:' + Date.now()),
    [id],
  );

  const [form, setForm] = useState<NoteForm>(EMPTY_FORM);
  const [baseline, setBaseline] = useState<NoteForm>(EMPTY_FORM);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [allWorks, setAllWorks] = useState<WorkSummary[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle', text: '' });
  const [conflict, setConflict] = useState<ApiError | null>(null);
  /** 定稿派生草稿：createdDraft 响应时记录，供 ChooseBox 跳转 */
  const [derivedDraft, setDerivedDraft] = useState<Note | null>(null);
  const [previewOn, setPreviewOn] = useState(false);
  const [fontSize, setFontSize] = useState(FONT_DEFAULT);
  /** 自检清单勾选（不持久化，词间 checks 同语义） */
  const [checks, setChecks] = useState<boolean[]>(() => SELF_CHECK_ITEMS.map(() => false));

  // 乐观锁基准版本：ref 供保存闭包随时读取最新值
  const baseRevision = useRef<number | undefined>(undefined);
  // 采用对方回填时置 true：让草稿写入 effect 跳过这一次写入，保护
  // localStorage 里用户自己的文字（词间 theirs 分支不写暂存，同语义）
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

  /* 加载：编辑取详情，同时拉全量作品列表供「关联作品」勾选；之后恢复本机草稿 */
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setLoadError('');
    const pNote = id ? api.notes.get(id).then((d) => d.note) : Promise.resolve(null);
    Promise.all([pNote, api.works.list()])
      .then(([note, list]) => {
        if (!alive) return;
        const base = note ? toForm(note) : EMPTY_FORM;
        if (note) baseRevision.current = note.revision;
        setBaseline(base);
        setForm(base);
        setAllWorks(list);
        // 本机暂存优先：上次没保存的内容自动接上
        let restored: NoteForm | null = null;
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

  /** 保存：新建 create 返回 {note, revision}，更新返回 SaveNoteResult 判别联合 */
  async function save(forceRev?: { revision: number; force: true }) {
    if (!loaded || saving) return;
    if (!form.title.trim() && !form.content.trim()) {
      notifyToast('至少填标题或正文');
      return;
    }
    setSaving(true);
    setSaveState({ kind: 'saving', text: '保存中…' });
    const payload: Partial<Note> & { baseRevision?: number; force?: boolean } = toPayload(form);
    if (forceRev) {
      payload.baseRevision = forceRev.revision;
      payload.force = true;
    } else if (id) {
      payload.baseRevision = baseRevision.current;
    }
    try {
      if (id) {
        const res = await api.notes.update(id, payload);
        clearDraft();
        if (res.createdDraft) {
          // 定稿 / 已发布：原稿一字不动，修改存成了新草稿
          setSaveState({ kind: 'saved', text: '已存为新草稿' });
          setDerivedDraft(res.draft);
        } else {
          notifyToast('已保存');
          navigate('#/notes/' + res.note.id);
        }
      } else {
        const res = await api.notes.create(payload);
        clearDraft();
        notifyToast('已保存');
        navigate('#/notes/' + res.note.id);
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
    const cur = err.current as Partial<Note> | undefined;
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
      notifyToast('已载入对方的最新版本，你的文字还在本机暂存里');
    }
  }

  /** 派生草稿弹窗：去看新草稿（其编辑页）或留在原篇（仅关闭） */
  function pickDerived(key: string) {
    const draft = derivedDraft;
    setDerivedDraft(null);
    if (key === 'go' && draft) {
      navigate('#/notes/' + draft.id + '/edit');
    }
  }

  function toggleWork(workId: string) {
    setForm((f) => ({
      ...f,
      workIds: f.workIds.includes(workId)
        ? f.workIds.filter((x) => x !== workId)
        : [...f.workIds, workId],
    }));
  }

  function stepFont(delta: number) {
    setFontSize((s) => Math.min(FONT_MAX, Math.max(FONT_MIN, s + delta)));
  }

  if (loadError) {
    return (
      <div className="cj-page cj-formpage">
        <div className="cj-pagehead">
          <a className="cj-backlink" href="#/notes">‹ 札记</a>
          <h1 className="cj-h1">编辑札记</h1>
        </div>
        <EmptyState text={'这篇札记暂时打不开（' + loadError + '）。'} />
      </div>
    );
  }

  const backTo = id ? '#/notes/' + id : '#/notes';

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
    : saveState.kind === 'saved' ? saveState.text
    : '';

  return (
    <div className="cj-page cj-formpage">
      <div className="cj-pagehead">
        <a className="cj-backlink" href={backTo}>‹ 札记</a>
        <h1 className="cj-h1">{id ? '编辑札记' : '新写一篇'}</h1>
      </div>

      <div className="cj-card">
        <Field label="标题">
          <Input
            placeholder="这篇叫什么"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </Field>
        <Field label="关联作品（一篇札记可以关联多首）">
          {allWorks.length ? (
            <div className="cj-picklist">
              {allWorks.map((x) => (
                <label className="cj-pickrow" key={x.id}>
                  <input
                    type="checkbox"
                    checked={form.workIds.includes(x.id)}
                    onChange={() => toggleWork(x.id)}
                  />
                  <div className="cj-picktext">
                    <div className="cj-picktitle cj-serif">{x.title || '（未命名）'}</div>
                    <div className="cj-item-meta">
                      {[x.author, x.dynasty, x.cipai].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          ) : (
            <p className="cn-field-hint">还没有词作可关联。</p>
          )}
        </Field>
      </div>

      <div className="cj-card">
        <div className="cj-editbar">
          <span className="cj-field-label cj-nomargin">正文</span>
          <div className="cj-editbar-ops">
            <button type="button" className="cn-btn cn-btn-ghost cn-btn-sm" onClick={() => stepFont(-1)}>
              A−
            </button>
            <button type="button" className="cn-btn cn-btn-ghost cn-btn-sm" onClick={() => stepFont(1)}>
              A＋
            </button>
            <button
              type="button"
              className="cn-btn cn-btn-ghost cn-btn-sm"
              onClick={() => setPreviewOn((v) => !v)}
            >
              {previewOn ? '回到编辑' : '预览'}
            </button>
          </div>
        </div>
        {previewOn ? (
          <div className="cj-article">
            {form.content.trim() ? (
              <Md text={form.content} />
            ) : (
              <EmptyState text="还没有正文。" />
            )}
          </div>
        ) : (
          <TextArea
            rows={18}
            className="cj-textarea-serif cj-editorarea"
            placeholder="正文。空行分段，换行会原样保留。"
            style={{ fontSize }}
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
          />
        )}
        <p className="cj-meta cj-md-hint">
          支持 Markdown：# 标题、**粗体**、*斜体*、`代码`、- 列表、&gt; 引用。空行分段，单个换行原样保留。
        </p>
      </div>

      <div className="cj-card">
        <Field label="附记">
          <TextArea
            rows={3}
            placeholder="附记：还想查什么、哪里拿不准"
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </Field>
      </div>

      <Field label="资料与可信度">
        <ClaimsEditor value={form.claims} onChange={(claims) => setForm({ ...form, claims })} />
      </Field>

      <Field label="引用出处">
        <CitationsEditor value={form.citations} onChange={(citations) => setForm({ ...form, citations })} />
      </Field>

      <div className="cj-card">
        <Field label="写作状态">
          <StatusSwitcher
            options={WRITING_STATUS_OPTIONS}
            value={form.writingStatus}
            onChange={(k) => setForm({ ...form, writingStatus: k })}
          />
        </Field>
        <Field label="发布状态（只作记录，不会自动发布）">
          <StatusSwitcher
            options={PUBLISH_STATUS_OPTIONS}
            value={form.publishStatus}
            onChange={(k) => setForm({ ...form, publishStatus: k })}
          />
        </Field>
        {form.publishStatus !== 'unpublished' ? (
          <>
            <Field label="发布平台">
              <Input
                placeholder="如 公众号 / 朋友圈"
                value={form.publish.platform}
                onChange={(e) => setForm({ ...form, publish: { ...form.publish, platform: e.target.value } })}
              />
            </Field>
            <Field label="发布时间">
              <Input
                placeholder="如 2026-11-19"
                value={form.publish.publishedAt}
                onChange={(e) => setForm({ ...form, publish: { ...form.publish, publishedAt: e.target.value } })}
              />
            </Field>
            <Field label="链接">
              <Input
                placeholder="可留空"
                value={form.publish.url}
                onChange={(e) => setForm({ ...form, publish: { ...form.publish, url: e.target.value } })}
              />
            </Field>
          </>
        ) : null}
        <Field label="本次修改说明">
          <Input
            placeholder="这次改了什么（会记进历史版本）"
            value={form.changeNote}
            onChange={(e) => setForm({ ...form, changeNote: e.target.value })}
          />
        </Field>
      </div>

      <div className="cj-card cj-prefcard">
        <div className="cj-section-title cj-block-head">写之前看一眼</div>
        <div className="cj-pref-intro">只是提醒，不会替你改字。</div>
        {WRITING_PREFERENCES.map((t, i) => (
          <div className="cj-pref-item" key={i}>· {t}</div>
        ))}
        <div className="cj-divider" />
        <div className="cj-checklist">
          {SELF_CHECK_ITEMS.map((item, i) => (
            <label className="cj-checkrow" key={i}>
              <input
                type="checkbox"
                checked={checks[i]}
                onChange={() => setChecks((arr) => arr.map((v, j) => (j === i ? !v : v)))}
              />
              <span className="cj-checktext">{item}</span>
            </label>
          ))}
        </div>
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
          title="这篇札记在别处被改过"
          message="你的文字还留着，没有被覆盖。要怎么处理？"
          choices={[
            { key: 'mine', label: '保留我的，覆盖过去', danger: true },
            { key: 'theirs', label: '采用对方的版本' },
          ]}
          onPick={pickConflict}
          onCancel={() => setConflict(null)}
        />
      ) : null}

      {derivedDraft ? (
        <ChooseBox
          title="原版已保留，另起新草稿"
          message="这篇已经定稿或标记为已发布，内容一字未动。你的修改存成了一篇新草稿。"
          choices={[{ key: 'go', label: '去看新草稿' }]}
          onPick={pickDerived}
          onCancel={() => setDerivedDraft(null)}
          cancelLabel="留在原篇"
        />
      ) : null}
    </div>
  );
}
