/**
 * 书架（首页）：统计卡、快捷入口、最近札记、写作偏好。
 *
 * 结构与文案照词间 web/views/library.js home 视图；差异两处：
 *   - 统计卡由词间的四项扩为 ci-notes 六实体（词作/札记/历史版本/对照/意象/典故）；
 *   - 有续稿徽章取 NoteSummary.draftOf（词间为 hasDraft），渲染复用 ui.StatusChip。
 *
 * 布局类名用 cj-*（styles.css 仅 cj- 前缀提供首页布局样式，Task 23 全量移植），
 * 徽章/时间/空态/节标题复用 components/ui 的 cn-* 组件。
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import { ApiError, type HomeData } from '../types';
import { EmptyState, Section, StatusChip, notifyToast, relTime } from '../components/ui';
import { navigate } from '../router';

/** 统计卡六项：key 对应 HomeData.stats 字段，标签沿用词间中文文案 */
const STAT_ITEMS: { key: keyof HomeData['stats']; label: string }[] = [
  { key: 'works', label: '词作' },
  { key: 'notes', label: '札记' },
  { key: 'revisions', label: '历史版本' },
  { key: 'comparisons', label: '对照' },
  { key: 'imagery', label: '意象' },
  { key: 'allusions', label: '典故' },
];

/** 快捷入口三卡：标题与说明文案逐字照词间 library.js actionCard */
const QUICK_ACTIONS = [
  { label: '写札记', desc: '接着上次的思路写', to: '/notes/new' },
  { label: '收词作', desc: '诗与词，词牌可留空', to: '/works/new' },
  { label: '作对照', desc: '两首并排看', to: '/compare/new' },
];

/** 写作偏好五条：逐字照搬词间 utils/constants.js WRITING_PREFERENCES */
const WRITING_PREFERENCES = [
  '自然、轻快，像随笔。',
  '赏析简洁，但要留一点讨论的余地。',
  '不要过于严肃、官方。',
  '不堆砌辞藻，避免「AI 味」的表达。',
  '不把所有怀念都解释成遗憾。',
];

export function Home() {
  const [home, setHome] = useState<HomeData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api.home().then(
      (d) => {
        if (alive) setHome(d);
      },
      (e: unknown) => {
        if (!alive) return;
        const msg = e instanceof ApiError ? e.message : '加载失败';
        setError(msg);
        notifyToast('书架加载失败：' + msg);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <div className="cj-page">
        <EmptyState text={'书架暂时打不开（' + error + '），请稍后重试。'} />
      </div>
    );
  }
  if (!home) {
    return (
      <div className="cj-page">
        <EmptyState text="正在打开书架…" />
      </div>
    );
  }

  const s = home.stats;
  const recent = home.recent;

  return (
    <div className="cj-page">
      <div className="cj-head">
        <div className="cj-head-title cj-serif">词间</div>
        <div className="cj-head-sub">整理词作，写下札记，看得见自己怎么改的。</div>
      </div>

      <div className="cj-card cj-stats">
        {STAT_ITEMS.map((x) => (
          <div className="cj-stat" key={x.key}>
            <span className="cj-stat-num">{s[x.key]}</span>
            <span className="cj-stat-label">{x.label}</span>
          </div>
        ))}
      </div>

      <div className="cj-actions">
        {QUICK_ACTIONS.map((a) => (
          <button type="button" className="cj-action" key={a.to} onClick={() => navigate(a.to)}>
            <div className="cj-action-label">{a.label}</div>
            <div className="cj-action-desc">{a.desc}</div>
          </button>
        ))}
      </div>

      <Section title="最近改的札记" aside={<a href="#/notes">全部 ›</a>}>
        {recent.length ? (
          <div className="cj-list">
            {recent.map((n) => (
              <a className="cj-card cj-listitem" href={'#/notes/' + n.id} key={n.id}>
                <div className="cj-item-title">{n.title}</div>
                <div className="cj-item-excerpt">{n.excerpt}</div>
                <div className="cj-item-foot">
                  <StatusChip
                    writingStatus={n.writingStatus}
                    publishStatus={n.publishStatus}
                    pendingImport={n.pendingImport}
                    draftOf={n.draftOf}
                  />
                  <span className="cj-item-time">{relTime(n.updatedAt)}</span>
                </div>
              </a>
            ))}
          </div>
        ) : (
          <EmptyState text="还没有札记，点上方「写札记」开一篇。" />
        )}
      </Section>

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
    </div>
  );
}
