/**
 * 「我的」与回收站两视图：账号 / 阅读字号 / 数据统计 / 导出 / 导入 / MCP 入口
 * / 写作偏好，以及回收站列表。
 *
 * 语义照词间 web/views/me.js 与 trash 视图（brief 为准），实现取舍：
 *   - 会话为无状态 HMAC Cookie，不回传用户名：账号卡读 localStorage
 *     'cn:username'（外壳登录成功时写入的约定键），无值时显示「私人写作空间」；
 *   - 导出走 fetch('/api/export') → blob 下载（同源请求自动携带会话 Cookie），
 *     按钮旁显示 Content-Length（缺头回退 blob.size）折算的 KB；
 *   - 导入必须 preflight 通过后才允许 merge（Task 17 审查备忘：merge 失败的
 *     服务端 INVALID 响应不带错误明细，errors 只能在 preflight 阶段拿到）；
 *   - 大文件保护：文件与粘贴文本均超 64MB 在本地拒绝读取；
 *   - TrashView 恢复文案固定「已恢复」：restore 对「同 id 已存在」只清回收站项
 *     （服务端幂等语义），对用户而言结果同样是内容回到库里。
 *
 * 加载模式与 history.tsx 对齐：load() 返回清理函数做 alive 守卫，重试复用。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api';
import { ApiError } from '../types';
import type { BackupSetKey, Preflight, StatsCounts, StatsData, TrashItem } from '../types';
import {
  AlertBox,
  Chip,
  ConfirmBox,
  EmptyState,
  Modal,
  notifyToast,
  relTime,
  Section,
} from '../components/ui';
import { TextArea } from '../components/editors';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 字号七档与缺省值（styles.css --reading-size 缺省 17px 同源） */
const FONT_SIZES = [15, 16, 17, 18, 20, 22, 24];
const FONT_DEFAULT = 17;
const FONT_KEY = 'cn:fontSize';
const USERNAME_KEY = 'cn:username';

/** 备份导出文件名（与服务端 Content-Disposition 一致） */
const EXPORT_FILENAME = 'ci-notes-backup.json';

/** 大文件保护上限：64MB */
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

/** 备份集合中文标签：导入明细与结果共用 */
const SET_LABEL: Record<BackupSetKey, string> = {
  works: '词作',
  notes: '札记',
  revisions: '历史版本',
  comparisons: '词作对照',
  trash: '回收站',
  imagery: '意象',
  imageryUses: '意象使用记录',
  allusions: '典故',
  allusionUses: '典故使用记录',
};

/** 集合展示顺序：实体在前，使用记录与回收站殿后 */
const SET_ORDER: BackupSetKey[] = [
  'works',
  'notes',
  'revisions',
  'comparisons',
  'imagery',
  'allusions',
  'imageryUses',
  'allusionUses',
  'trash',
];

/** 统计卡八项：key 对应 StatsCounts 字段 */
const STAT_ITEMS: { key: keyof StatsCounts; label: string }[] = [
  { key: 'works', label: '词作' },
  { key: 'notes', label: '札记' },
  { key: 'revisions', label: '历史版本' },
  { key: 'comparisons', label: '对照' },
  { key: 'imagery', label: '意象' },
  { key: 'allusions', label: '典故' },
  { key: 'imageryUses', label: '意象记录' },
  { key: 'allusionUses', label: '典故记录' },
];

/** 写作偏好五条：与 home.tsx 同款（词间 utils/constants.js WRITING_PREFERENCES） */
const WRITING_PREFERENCES = [
  '自然、轻快，像随笔。',
  '赏析简洁，但要留一点讨论的余地。',
  '不要过于严肃、官方。',
  '不堆砌辞藻，避免「AI 味」的表达。',
  '不把所有怀念都解释成遗憾。',
];

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 读存储字号：非七档取值一律按缺省处理 */
function readStoredFont(): number {
  const raw = localStorage.getItem(FONT_KEY);
  const n = raw === null ? NaN : parseInt(raw, 10);
  return FONT_SIZES.includes(n) ? n : FONT_DEFAULT;
}

function formatKB(bytes: number): string {
  return (bytes / 1024).toFixed(1) + ' KB';
}

/** 计数对象 → 非零集合的「标签 数」串，如「词作 3 · 札记 2」（全零返回空串） */
function countsText(counts: Record<BackupSetKey, number>): string {
  return SET_ORDER.filter((k) => counts[k] > 0)
    .map((k) => `${SET_LABEL[k]} ${counts[k]}`)
    .join(' · ');
}

/** 读文件为文本（FileReader readAsText 的 Promise 封装） */
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'));
    reader.readAsText(file);
  });
}

/* ------------------------------------------------------------------ */
/* 我的                                                                */
/* ------------------------------------------------------------------ */

export function Me() {
  /** 当前字号：仅作按钮高亮，应用 CSS 变量在点击时统一做 */
  const [font, setFont] = useState(readStoredFont);

  /* 数据统计 */
  const [stats, setStats] = useState<StatsData | null>(null);
  const [statsError, setStatsError] = useState('');

  /* 导出 */
  const [exporting, setExporting] = useState(false);
  const [exportInfo, setExportInfo] = useState('');

  /* 导入：粘贴弹窗 → 预检确认 → 结果弹窗 */
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [confirmImport, setConfirmImport] = useState<{ backup: unknown; pre: Preflight } | null>(null);
  const [importing, setImporting] = useState(false);
  const [alertBox, setAlertBox] = useState<{ title: string; message: ReactNode } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 会话 Cookie 不含用户名，账号卡按约定键读取（外壳登录成功时写入）
  const username = localStorage.getItem(USERNAME_KEY) || '';

  function loadStats(): () => void {
    let alive = true;
    setStatsError('');
    api.stats().then(
      (d) => {
        if (alive) setStats(d);
      },
      (e: unknown) => {
        if (alive) setStatsError(e instanceof ApiError ? e.message : '加载失败');
      },
    );
    return () => {
      alive = false;
    };
  }

  useEffect(loadStats, []);

  function pickFont(n: number) {
    setFont(n);
    localStorage.setItem(FONT_KEY, String(n));
    document.documentElement.style.setProperty('--reading-size', n + 'px');
  }

  async function exportAll() {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await fetch(api.backup.exportUrl);
      if (res.status === 401) {
        // 与 api.ts 契约一致：会话过期交给外壳处理
        window.dispatchEvent(new Event('cn:unauthorized'));
        return;
      }
      if (!res.ok) throw new Error('导出失败，请稍后重试');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = EXPORT_FILENAME;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      // Content-Length 缺失或为 0 时回退 blob 实际大小
      const bytes = Number(res.headers.get('content-length')) || blob.size;
      setExportInfo('已下载 ' + formatKB(bytes));
    } catch (e) {
      notifyToast(e instanceof Error ? e.message : '导出失败，请稍后重试');
    } finally {
      setExporting(false);
    }
  }

  /** 读入备份文本：JSON 解析 → preflight；解析失败只提示，不发请求 */
  async function checkBackup(text: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      notifyToast('不是有效的 JSON 备份');
      return;
    }
    try {
      const pre = await api.backup.preflight(parsed);
      if (!pre.ok) {
        // validate 失败：错误明细只在这里拿得到（merge 阶段不带 current）
        setAlertBox({
          title: '这份备份无法导入',
          message: (pre.errors ?? []).join('\n') || '备份内容未通过校验',
        });
        return;
      }
      setPasteOpen(false);
      setPasteText('');
      setConfirmImport({ backup: parsed, pre });
    } catch (e) {
      notifyToast(e instanceof ApiError ? e.message : '预检失败，请稍后重试');
    }
  }

  async function onPickFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_BACKUP_BYTES) {
      notifyToast('备份文件超过 64MB，已拒绝读取');
      return;
    }
    try {
      await checkBackup(await readFileText(file));
    } catch {
      notifyToast('文件读取失败');
    }
  }

  function submitPaste() {
    const text = pasteText;
    if (!text.trim()) return;
    if (text.length > MAX_BACKUP_BYTES) {
      notifyToast('粘贴内容超过 64MB，已拒绝读取');
      return;
    }
    void checkBackup(text);
  }

  function doImport() {
    const item = confirmImport;
    if (!item || importing) return;
    setImporting(true);
    api.backup.merge(item.backup).then(
      (r) => {
        setImporting(false);
        setConfirmImport(null);
        setAlertBox({
          title: '导入完成',
          message: [
            countsText(r.created) ? '新增：' + countsText(r.created) : '没有新增内容',
            '跳过（内容相同）：' + r.skipped + ' 条',
            '另存为副本：' + r.conflictCopies + ' 条',
          ].join('\n'),
        });
        loadStats(); // 刷新统计卡
      },
      (e: unknown) => {
        setImporting(false);
        setConfirmImport(null);
        notifyToast(e instanceof ApiError ? e.message : '导入失败，请稍后重试');
      },
    );
  }

  const pre = confirmImport?.pre;
  const createsLine = pre ? countsText(pre.creates) : '';

  return (
    <div className="cj-page cj-narrow">
      <div className="cj-head">
        <div className="cj-head-title cj-serif">我的</div>
        <div className="cj-head-sub">账号、阅读偏好与数据备份。</div>
      </div>

      <div className="cj-card">
        <div className="cj-mehead">
          <div className="cj-meavatar">{username ? username.slice(0, 1) : '词'}</div>
          <div className="cj-meid">
            <div className="cj-item-title">{username || '私人写作空间'}</div>
            <div className="cj-item-meta">数据存于本服务器，仅登录后可见。</div>
          </div>
        </div>
      </div>

      <Section title="阅读字号">
        <div className="cj-card" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {FONT_SIZES.map((n) => (
            <button
              type="button"
              key={n}
              className={'cj-fontopt' + (n === font ? ' cj-fontopt-on' : '')}
              onClick={() => pickFont(n)}
            >
              {n}
            </button>
          ))}
        </div>
      </Section>

      <Section title="数据统计" aside={<a href="#/me/trash">回收站 ›</a>}>
        {statsError ? (
          <div className="cj-card">
            <EmptyState text={'统计暂时打不开（' + statsError + '）。'} />
            <div style={{ textAlign: 'center' }}>
              <button type="button" className="cn-btn cn-btn-ghost" onClick={loadStats}>重试</button>
            </div>
          </div>
        ) : !stats ? (
          <div className="cj-card">
            <EmptyState text="正在读取统计…" />
          </div>
        ) : (
          <div className="cj-card cj-stats" style={{ flexWrap: 'wrap', rowGap: 12 }}>
            {STAT_ITEMS.map((x) => (
              <div className="cj-stat" key={x.key} style={{ minWidth: 76 }}>
                <span className="cj-stat-num">{stats.counts[x.key]}</span>
                <span className="cj-stat-label">{x.label}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="备份">
        <div className="cj-card">
          <p className="cj-me-p">把全部内容下载成一个 JSON 文件，或从备份恢复。</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <button type="button" className="cn-btn cn-btn-primary" disabled={exporting} onClick={exportAll}>
              {exporting ? '正在导出…' : '导出全部数据'}
            </button>
            {exportInfo ? <span className="cj-item-meta">{exportInfo}</span> : null}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
            <button type="button" className="cn-btn cn-btn-ghost" onClick={() => fileRef.current?.click()}>
              从文件恢复
            </button>
            <button
              type="button"
              className="cn-btn cn-btn-ghost"
              onClick={() => {
                setPasteText('');
                setPasteOpen(true);
              }}
            >
              粘贴 JSON 恢复
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              void onPickFile(e.target.files?.[0]);
              e.target.value = ''; // 同名文件可重复选择
            }}
          />
        </div>
      </Section>

      <a className="cj-card cj-listitem" href="#/me/mcp-keys">
        <div className="cj-item-head">
          <div>
            <div className="cj-item-title">MCP 密钥</div>
            <div className="cj-item-meta">给 Claude Code 等客户端开一条 API 通道。</div>
          </div>
          <span className="cj-item-meta">›</span>
        </div>
      </a>

      <Section title="写作偏好">
        <div className="cj-card cj-prefcard">
          <div className="cj-pref-intro">这些只是界面上的提醒，不会替你改一个字。</div>
          {WRITING_PREFERENCES.map((t) => (
            <div className="cj-pref-item" key={t}>
              · {t}
            </div>
          ))}
        </div>
      </Section>

      {pasteOpen ? (
        <Modal title="粘贴备份 JSON" onClose={() => setPasteOpen(false)}>
          <p className="cn-modal-text">粘贴之前导出的备份内容，先做预检再决定是否导入。</p>
          <TextArea
            rows={8}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder='{"format":"ci-notes-backup", …}'
          />
          <div className="cn-modal-ops">
            <button type="button" className="cn-btn cn-btn-quiet" onClick={() => setPasteOpen(false)}>
              取消
            </button>
            <button type="button" className="cn-btn cn-btn-primary" disabled={!pasteText.trim()} onClick={submitPaste}>
              检查这份备份
            </button>
          </div>
        </Modal>
      ) : null}

      {confirmImport && pre ? (
        <ConfirmBox
          title="确认导入这份备份"
          message={
            <>
              {createsLine ? (
                <>将新增：{createsLine}<br /></>
              ) : (
                <>没有需要新增的内容<br /></>
              )}
              内容完全相同将跳过：{pre.duplicates} 条<br />
              同 id 但内容不同：{pre.conflicts.length} 条（导入时另存为副本）<br />
              悬空引用：{pre.dangling.length} 条<br />
              <br />
              导入不会删除已有内容；定稿和已发布的版本不会被覆盖。
            </>
          }
          onOk={doImport}
          onCancel={() => setConfirmImport(null)}
        />
      ) : null}

      {alertBox ? (
        <AlertBox title={alertBox.title} message={alertBox.message} onClose={() => setAlertBox(null)} />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 回收站                                                              */
/* ------------------------------------------------------------------ */

export function TrashView() {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [error, setError] = useState('');
  const [confirmItem, setConfirmItem] = useState<TrashItem | null>(null);
  const [purging, setPurging] = useState(false);

  function load(): () => void {
    let alive = true;
    setError('');
    setItems(null);
    api.trash.list().then(
      (d) => {
        if (alive) setItems(d);
      },
      (e: unknown) => {
        if (alive) setError(e instanceof ApiError ? e.message : '加载失败');
      },
    );
    return () => {
      alive = false;
    };
  }

  useEffect(load, []);

  function restore(item: TrashItem) {
    api.trash.restore(item.id).then(
      () => {
        // 同 id 已存在时服务端只清回收站项（幂等），对用户而言同样已回到库里
        notifyToast('已恢复');
        load();
      },
      (e: unknown) => notifyToast(e instanceof ApiError ? e.message : '恢复失败，请稍后重试'),
    );
  }

  function purge() {
    const item = confirmItem;
    if (!item || purging) return;
    setPurging(true);
    api.trash.purge(item.id).then(
      () => {
        setPurging(false);
        setConfirmItem(null);
        notifyToast('已永久删除');
        load();
      },
      (e: unknown) => {
        setPurging(false);
        setConfirmItem(null);
        notifyToast(e instanceof ApiError ? e.message : '删除失败，请稍后重试');
      },
    );
  }

  if (error) {
    return (
      <div className="cj-page cj-narrow">
        <EmptyState text={'回收站暂时打不开（' + error + '）。'} />
        <div style={{ textAlign: 'center' }}>
          <button type="button" className="cn-btn cn-btn-ghost" onClick={load}>重试</button>
        </div>
      </div>
    );
  }
  if (!items) {
    return (
      <div className="cj-page cj-narrow">
        <EmptyState text="正在打开回收站…" />
      </div>
    );
  }

  return (
    <div className="cj-page cj-narrow">
      <div className="cj-pagehead">
        <a className="cj-backlink" href="#/me">‹ 我的</a>
        <h1 className="cj-h1">回收站</h1>
      </div>

      {items.length ? (
        <div className="cj-list">
          {items.map((item) => (
            <div className="cj-card" key={item.id}>
              <div className="cj-item-title">{item.label}</div>
              <div className="cj-item-foot">
                <Chip tone={item.itemType === 'note' ? 'personal' : 'verified'}>
                  {item.itemType === 'note' ? '札记' : '词作'}
                </Chip>
                <span className="cj-item-time">删除于 {relTime(item.trashedAt)}</span>
              </div>
              {item.preview ? <div className="cj-item-excerpt">{item.preview}</div> : null}
              <div className="cj-item-foot">
                <button type="button" className="cn-btn cn-btn-primary cn-btn-sm" onClick={() => restore(item)}>
                  恢复
                </button>
                <button type="button" className="cn-btn cn-btn-danger cn-btn-sm" onClick={() => setConfirmItem(item)}>
                  永久删除
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState text="回收站是空的。" />
      )}

      {confirmItem ? (
        <ConfirmBox
          title="永久删除"
          danger
          message={
            confirmItem.itemType === 'note'
              ? '「' + confirmItem.label + '」将被永久删除，札记的历史版本会一并删除，不可恢复。'
              : '「' + confirmItem.label + '」将被永久删除，不可恢复。'
          }
          onOk={purge}
          onCancel={() => setConfirmItem(null)}
        />
      ) : null}
    </div>
  );
}
