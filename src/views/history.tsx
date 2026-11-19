/**
 * 版本历史与版本对比两视图：列表 / 对比。
 *
 * 语义与文案照词间 web/views/history.js 功能清单（brief 为准）：
 *   - 列表卡 v{n} 序号 = 总数 - 索引（seq 倒序，最新一条 v 总数）；
 *   - 选两版比较：每卡「设为旧版 / 设为新版」toggle（同卡互斥，再点取消），
 *     选中态用 cn-btn-primary 高亮（styles.css 未备专用高亮类，按钮变体承担）；
 *   - 「导出这一版」需要版本标题与正文：列表摘要行携带快照的 title/content
 *     （本任务在 server/core/notes.mjs revisionSummary 增补，协调者裁定），
 *     其余字段取当前 note，noteToMarkdown 以 snapshotRev.createdAt 标注版本时间；
 *   - 「复制为新草稿」ConfirmBox → api.notes.restore → 跳新草稿编辑页；
 *   - 「看内容」行内展开快照正文 <pre>（cj-rev-detail 自带滚动与 pre-wrap）。
 *
 * 对比页 rows 由服务端算好（content 行级 diff + title 差异并入头部 change 行），
 * 前端只做渲染；change 行双行显示，字级 segments 用 styles.css 的
 * cj-seg-{equal|insert|delete}（brief 写的 cj-seg-del/cj-seg-ins 在本项目
 * 样式表中不存在，实际类名为 cj-seg-delete/cj-seg-insert，视觉效果一致）。
 *
 * 加载模式与 notes.tsx 对齐：load() 返回清理函数做 alive 守卫，重试复用。
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import { ApiError } from '../types';
import type {
  CharSegment,
  DiffRow,
  NoteDetail,
  RevisionCompare,
  RevisionReason,
  RevisionRow,
  WritingStatus,
} from '../types';
import { Chip, ConfirmBox, EmptyState, notifyToast } from '../components/ui';
import { download, formatDateTime, noteToMarkdown } from '../exporter';
import { navigate } from '../router';

/* ------------------------------------------------------------------ */
/* 常量与小件                                                          */
/* ------------------------------------------------------------------ */

/** reason 中文标签映射（brief 指定） */
const REASON_LABEL: Record<RevisionReason, string> = {
  manual: '手动保存',
  'draft-from-final': '定稿后派生草稿',
  restore: '由历史版本复制',
  'conflict-overwrite': '冲突覆盖前留档',
};

/** 写作状态文案（ui 的 WRITING_LABEL 未导出，本地同款映射） */
const WRITING_LABEL: Record<WritingStatus, string> = {
  idea: '构思',
  research: '资料收集',
  draft: '草稿',
  final: '定稿',
};

/** 导出文件名时间戳：本地时间 YYYYMMDD-HHmm（exporter 无此格式 helper） */
function exportStamp(): string {
  const d = new Date();
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes())
  );
}

/** 修改说明占位：无则按词间文案显示 */
function changeNoteText(changeNote: string): string {
  return changeNote || '没有写修改说明';
}

/** 字级 segments：旧行剔除 insert 段、新行剔除 delete 段（charDiff 覆盖两侧） */
function Segments({ segs, hide }: { segs: CharSegment[]; hide: 'insert' | 'delete' }) {
  return (
    <>
      {segs
        .filter((s) => s.type !== hide)
        .map((s, i) => (
          <span key={i} className={'cj-seg-' + s.type}>{s.text}</span>
        ))}
    </>
  );
}

/** 单条 diff 行渲染：equal 平铺；delete/insert 单行；change 旧行 + 新行双行 */
function DiffRowView({ row }: { row: DiffRow }) {
  if (row.type === 'equal') {
    return <div className="cj-diff-line">{row.a}</div>;
  }
  if (row.type === 'delete') {
    return (
      <div className="cj-diff-line cj-diff-delete">
        <span className="cj-diff-badge">删</span>
        {row.a}
      </div>
    );
  }
  if (row.type === 'insert') {
    return (
      <div className="cj-diff-line cj-diff-insert">
        <span className="cj-diff-badge">增</span>
        {row.b}
      </div>
    );
  }
  return (
    <>
      <div className="cj-diff-line cj-diff-delete cj-diff-oldline">
        <span className="cj-diff-badge">旧</span>
        {row.segments ? <Segments segs={row.segments} hide="insert" /> : row.a}
      </div>
      <div className="cj-diff-line cj-diff-insert cj-diff-newline">
        <span className="cj-diff-badge">新</span>
        {row.segments ? <Segments segs={row.segments} hide="delete" /> : row.b}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 版本历史列表                                                        */
/* ------------------------------------------------------------------ */

/**
 * 版本历史列表（#/notes/:id/history）。
 * 一次拉取版本摘要与札记详情（详情供导出时的关联原文与 note 形状）。
 */
export function HistoryList({ id }: { id: string }) {
  const [rows, setRows] = useState<RevisionRow[] | null>(null);
  const [detail, setDetail] = useState<NoteDetail | null>(null);
  const [error, setError] = useState('');
  /** 选两版比较：旧版 / 新版的 revision id（同卡互斥，可再点取消） */
  const [oldId, setOldId] = useState<string | null>(null);
  const [newId, setNewId] = useState<string | null>(null);
  /** 「看内容」当前展开的 revision id（单开） */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** 「复制为新草稿」确认中与执行中 */
  const [confirmRev, setConfirmRev] = useState<RevisionRow | null>(null);
  const [restoring, setRestoring] = useState(false);

  /** 返回清理函数供 effect 取消晚到响应；重试按钮也复用此函数 */
  function load(): () => void {
    let alive = true;
    setError('');
    setRows(null);
    setDetail(null);
    Promise.all([api.notes.revisions(id), api.notes.get(id)]).then(
      ([rs, d]) => {
        if (!alive) return;
        setRows(rs);
        setDetail(d);
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

  /** 设为旧版：再点取消；同卡互斥——它已是新版时先清掉新版标记 */
  function pickOld(rowId: string) {
    if (oldId === rowId) {
      setOldId(null);
      return;
    }
    if (newId === rowId) setNewId(null);
    setOldId(rowId);
  }

  /** 设为新版：再点取消；同卡互斥——它已是旧版时先清掉旧版标记 */
  function pickNew(rowId: string) {
    if (newId === rowId) {
      setNewId(null);
      return;
    }
    if (oldId === rowId) setOldId(null);
    setNewId(rowId);
  }

  function exportRow(row: RevisionRow) {
    if (!detail) return;
    // 标题与正文取该版本快照，其余字段（附记/资料/出处等）取当前稿
    const md = noteToMarkdown(
      { ...detail.note, title: row.title, content: row.content },
      detail.linkedWorks.map((lw) => lw.work),
      { createdAt: row.createdAt },
    );
    download(`${row.title || '札记'}-${exportStamp()}.md`, md);
    notifyToast('已下载该版本的 Markdown 文件');
  }

  /** 复制为新草稿：restore 返回 201 {draft}，跳新草稿编辑页 */
  function doRestore() {
    const rev = confirmRev;
    if (!rev || restoring) return;
    setRestoring(true);
    api.notes.restore(id, rev.id).then(
      (r) => {
        setRestoring(false);
        setConfirmRev(null);
        notifyToast('已复制为新草稿');
        navigate('#/notes/' + r.draft.id + '/edit');
      },
      (e: unknown) => {
        setRestoring(false);
        setConfirmRev(null);
        notifyToast(e instanceof ApiError ? e.message : '复制为新草稿失败');
      },
    );
  }

  /** 两版齐 → 进对比页（URL 顺序：旧版在前） */
  function compareSelected() {
    if (!oldId || !newId) return;
    navigate(`#/notes/${id}/history/${oldId}/${newId}`);
  }

  if (error) {
    return (
      <div className="cj-page cj-narrow">
        <EmptyState text={'版本历史暂时打不开（' + error + '）。'} />
        <div style={{ textAlign: 'center' }}>
          <button type="button" className="cn-btn cn-btn-ghost" onClick={load}>重试</button>
        </div>
      </div>
    );
  }
  if (!rows || !detail) {
    return (
      <div className="cj-page cj-narrow">
        <EmptyState text="正在打开版本历史…" />
      </div>
    );
  }

  // 选版提示：两版齐可比较，只选一侧时提示补另一侧
  const oldRow = rows.find((r) => r.id === oldId) || null;
  const newRow = rows.find((r) => r.id === newId) || null;
  const pickHint = oldRow && newRow
    ? `旧版 v${rows.length - rows.indexOf(oldRow)} ↔ 新版 v${rows.length - rows.indexOf(newRow)}，点「比较两版」看差异。`
    : oldRow
      ? `已选旧版 v${rows.length - rows.indexOf(oldRow)}，再选一个新版即可对比。`
      : newRow
        ? `已选新版 v${rows.length - rows.indexOf(newRow)}，再选一个旧版即可对比。`
        : '选两版可以逐行对比差异。';

  return (
    <div className="cj-page cj-narrow">
      <div className="cj-pagehead">
        <a className="cj-backlink" href={'#/notes/' + id}>‹ 札记</a>
        <h1 className="cj-h1">版本历史</h1>
      </div>

      {(oldRow || newRow) ? (
        <div
          className="cj-card"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
        >
          <span className="cj-item-meta" style={{ marginTop: 0 }}>{pickHint}</span>
          <button
            type="button"
            className="cn-btn cn-btn-primary cn-btn-sm"
            disabled={!oldRow || !newRow}
            onClick={compareSelected}
          >
            比较两版
          </button>
        </div>
      ) : null}

      <div className="cj-list">
        {rows.map((row, i) => {
          const vNo = rows.length - i;
          const isOld = oldId === row.id;
          const isNew = newId === row.id;
          const expanded = expandedId === row.id;
          return (
            <div className="cj-card cj-rev" key={row.id}>
              <div className="cj-rev-head">
                <span className="cj-rev-seq">v{vNo}</span>
                <div className="cj-rev-info">
                  <div className="cj-rev-time">{formatDateTime(row.createdAt)}</div>
                  <div className="cj-rev-note">{changeNoteText(row.changeNote)}</div>
                  <div className="cj-rev-meta">
                    {REASON_LABEL[row.reason]}　·　字数 {row.charCount}　·　{WRITING_LABEL[row.writingStatus]}
                  </div>
                </div>
                <span className="cj-rev-tag">{isOld ? '旧版' : isNew ? '新版' : ''}</span>
              </div>
              <div className="cj-rev-ops">
                <button
                  type="button"
                  className={'cn-btn cn-btn-sm ' + (isOld ? 'cn-btn-primary' : 'cn-btn-ghost')}
                  onClick={() => pickOld(row.id)}
                >
                  设为旧版
                </button>
                <button
                  type="button"
                  className={'cn-btn cn-btn-sm ' + (isNew ? 'cn-btn-primary' : 'cn-btn-ghost')}
                  onClick={() => pickNew(row.id)}
                >
                  设为新版
                </button>
                <button
                  type="button"
                  className="cn-btn cn-btn-ghost cn-btn-sm"
                  onClick={() => setExpandedId(expanded ? null : row.id)}
                >
                  {expanded ? '收起内容' : '看内容'}
                </button>
                <button type="button" className="cn-btn cn-btn-ghost cn-btn-sm" onClick={() => exportRow(row)}>
                  导出这一版
                </button>
                <button
                  type="button"
                  className="cn-btn cn-btn-quiet cn-btn-sm"
                  onClick={() => setConfirmRev(row)}
                >
                  复制为新草稿
                </button>
              </div>
              {expanded ? <pre className="cj-rev-detail">{row.content || '（正文为空）'}</pre> : null}
            </div>
          );
        })}
      </div>

      {confirmRev ? (
        <ConfirmBox
          title="复制为新草稿"
          message="会把这一版的内容复制成一篇独立的新草稿，原稿和历史都不动。"
          onOk={doRestore}
          onCancel={() => setConfirmRev(null)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 版本对比                                                            */
/* ------------------------------------------------------------------ */

/**
 * 版本对比（#/notes/:id/history/:a/:b，a 为旧版 b 为新版）。
 * 头部旧/新两卡（时间 + 修改说明）、统计 chips、服务端算好的 rows 直接渲染。
 */
export function HistoryCompare({ id, a, b }: { id: string; a: string; b: string }) {
  const [data, setData] = useState<RevisionCompare | null>(null);
  const [error, setError] = useState('');

  /** 返回清理函数供 effect 取消晚到响应；重试按钮也复用此函数 */
  function load(): () => void {
    let alive = true;
    setError('');
    setData(null);
    api.notes.compare(id, a, b).then(
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

  useEffect(load, [id, a, b]);

  if (error) {
    return (
      <div className="cj-page cj-narrow">
        <EmptyState text={'版本对比暂时打不开（' + error + '）。'} />
        <div style={{ textAlign: 'center' }}>
          <button type="button" className="cn-btn cn-btn-ghost" onClick={load}>重试</button>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cj-page cj-narrow">
        <EmptyState text="正在对比两个版本…" />
      </div>
    );
  }

  return (
    <div className="cj-page cj-narrow">
      <div className="cj-pagehead">
        <a className="cj-backlink" href={'#/notes/' + id + '/history'}>‹ 版本历史</a>
        <h1 className="cj-h1">版本对比</h1>
      </div>

      <div className="cj-grid2">
        <div className="cj-card cj-rev">
          <div className="cj-cmp-old">旧版</div>
          <div className="cj-rev-time">{formatDateTime(data.a.createdAt)}</div>
          <div className="cj-rev-note">{changeNoteText(data.a.changeNote)}</div>
        </div>
        <div className="cj-card cj-rev">
          <div className="cj-cmp-new">新版</div>
          <div className="cj-rev-time">{formatDateTime(data.b.createdAt)}</div>
          <div className="cj-rev-note">{changeNoteText(data.b.changeNote)}</div>
        </div>
      </div>

      <div className="cj-tagwrap" style={{ margin: '14px 0' }}>
        <Chip tone="verified">增 {data.stats.added}</Chip>
        <Chip tone="pending">删 {data.stats.removed}</Chip>
        <Chip tone="personal">改 {data.stats.changed}</Chip>
        <Chip tone="muted">未变 {data.stats.same}</Chip>
      </div>

      <div className="cj-card cj-diffbox">
        {data.rows.length ? (
          data.rows.map((row, i) => <DiffRowView key={i} row={row} />)
        ) : (
          <EmptyState text="这两个版本内容一致。" />
        )}
      </div>
    </div>
  );
}
