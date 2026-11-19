/**
 * 应用外壳：登录态三态（检测中 / 未登录 / 已登录）、哈希路由分发、词间同款
 * 导航（桌面侧栏 + 移动端顶栏 / 底栏 / 抽屉）与 Toast 容器。
 *
 * 语义照词间 web/app.js buildShell：
 *   - 未登录只渲染登录页，不生成任何菜单 DOM（body.cj-no-nav 再兜一层隐藏）；
 *   - 登录态切换不靠路由猜测：启动用 api.stats() 探测，之后监听
 *     cn:auth（Login 登录成功派发）与 cn:unauthorized（api 层 401 派发）；
 *   - 路由分发按 brief 的 renderRoute 骨架，路径参数取 r.parts；
 *   - Home 以 navSeq（hashchange 计数）作 key：返回书架时强制重挂、重新拉数据；
 *   - 抽屉为独立结构（cj-drawer / cj-scrim），打开时锁背景滚动，Esc / 遮罩 / 跳转关闭。
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import { navigate, useHashRoute } from './router';
import type { RouteMatch } from './router';
import { ErrorBoundary, ToastHost, notifyToast } from './components/ui';
import { Home } from './views/home';
import { Login } from './views/login';
import { WorksList, WorkDetail, WorkEdit } from './views/works';
import { NotesList, NoteDetail, NoteEdit } from './views/notes';
import { HistoryList, HistoryCompare } from './views/history';
import { CompareList, ComparePick, CompareDetail } from './views/compare';
import { ImageryList, ImageryDetail, ImageryEdit } from './views/imagery';
import { AllusionList, AllusionDetail, AllusionEdit } from './views/allusions';
import { Me, TrashView } from './views/me';
import { McpKeys } from './views/mcpkeys';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 阅读字号七档：与 Me 视图（views/me.tsx）同源，缺省 17px 同 styles.css */
const FONT_SIZES = [15, 16, 17, 18, 20, 22, 24];

/** 导航主项：key 与 hash（词间 NAV_ITEMS 基础上补典故项） */
const NAV_ITEMS = [
  { key: 'home', label: '书架', hash: '#/' },
  { key: 'works', label: '词作', hash: '#/works' },
  { key: 'notes', label: '札记', hash: '#/notes' },
  { key: 'compare', label: '对照', hash: '#/compare' },
  { key: 'imagery', label: '意象', hash: '#/imagery' },
  { key: 'allusions', label: '典故', hash: '#/allusions' },
  { key: 'me', label: '我的', hash: '#/me' },
];

/** 移动底栏保留的四项（词间 TAB_KEYS） */
const TAB_KEYS = ['home', 'works', 'notes', 'me'];

/** 「我的」子项：侧栏与抽屉在「我的」之后缩进一级列出 */
const ME_SUB_ITEMS = [
  { key: 'trash', label: '回收站', hash: '#/me/trash' },
  { key: 'mcp-keys', label: 'MCP 密钥', hash: '#/me/mcp-keys' },
];

/** 导出文件名：与服务端 Content-Disposition 一致（Me 视图同款） */
const EXPORT_FILENAME = 'ci-notes-backup.json';

/* ------------------------------------------------------------------ */
/* 启动副作用：阅读字号                                                 */
/* ------------------------------------------------------------------ */

/** 启动时应用存储的阅读字号（Me 页只负责点击时写 localStorage） */
function applyStoredFontSize() {
  const n = parseInt(localStorage.getItem('cn:fontSize') ?? '', 10);
  if (FONT_SIZES.includes(n)) {
    document.documentElement.style.setProperty('--reading-size', n + 'px');
  }
}
applyStoredFontSize();

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

/** 由路由首段推导导航高亮键：me 的子路由都算「我的」，未知路由不高亮 */
function navKeyOf(r: RouteMatch): string {
  switch (r.parts[0]) {
    case undefined:
      return 'home';
    case 'home':
    case 'works':
    case 'notes':
    case 'compare':
    case 'imagery':
    case 'allusions':
    case 'me':
      return r.parts[0];
    default:
      return '';
  }
}

/** 路由分发（brief 骨架按实际组件签名适配）：路径参数取 r.parts */
function renderRoute(r: RouteMatch, navSeq: number) {
  const head: string | undefined = r.parts[0];
  const a = r.parts[1];
  const b = r.parts[2];
  switch (head) {
    case undefined:
      return <Home key={navSeq} />;
    case 'works':
      return !a ? <WorksList /> : a === 'new' ? <WorkEdit /> : b === 'edit' ? <WorkEdit id={a} /> : <WorkDetail id={a} />;
    case 'notes':
      return !a ? (
        <NotesList />
      ) : a === 'new' ? (
        <NoteEdit />
      ) : b === 'edit' ? (
        <NoteEdit id={a} />
      ) : b === 'history' ? (
        r.parts[3] ? <HistoryCompare id={a} a={r.parts[3]} b={r.parts[4]} /> : <HistoryList id={a} />
      ) : (
        <NoteDetail id={a} />
      );
    case 'compare':
      return !a ? <CompareList /> : a === 'new' ? <ComparePick /> : <CompareDetail id={a} />;
    case 'imagery':
      return !a ? <ImageryList /> : a === 'new' ? <ImageryEdit /> : b === 'edit' ? <ImageryEdit id={a} /> : <ImageryDetail id={a} />;
    case 'allusions':
      return !a ? <AllusionList /> : a === 'new' ? <AllusionEdit /> : b === 'edit' ? <AllusionEdit id={a} /> : <AllusionDetail id={a} />;
    case 'me':
      return a === 'trash' ? <TrashView /> : a === 'mcp-keys' ? <McpKeys /> : <Me />;
    default:
      return <Home key={navSeq} />;
  }
}

/* ------------------------------------------------------------------ */
/* 外壳                                                                */
/* ------------------------------------------------------------------ */

/** 当前是否在登录路由：登录页自身的 401（密码错误）触发的 cn:unauthorized 豁免 */
function onLoginRoute(): boolean {
  return location.hash.slice(1).split('/').filter(Boolean)[0] === 'login';
}

export default function App() {
  /** null=检测中；登录态由启动探测与事件驱动，不靠路由猜测 */
  const [authed, setAuthed] = useState<boolean | null>(null);
  const route = useHashRoute();
  /** hashchange 计数：作 Home 的 key，返回书架时强制重挂以重新拉数据 */
  const [navSeq, setNavSeq] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  /* 启动探测登录态：成功→已登录；401→登录页（api 层同时派发 cn:unauthorized） */
  useEffect(() => {
    let alive = true;
    api.stats().then(
      () => {
        if (alive) setAuthed(true);
      },
      () => {
        if (alive) setAuthed(false);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  /* 登录成功信号（Login 视图派发） */
  useEffect(() => {
    const onAuth = () => setAuthed(true);
    window.addEventListener('cn:auth', onAuth);
    return () => window.removeEventListener('cn:auth', onAuth);
  }, []);

  /* 会话过期信号（api 层派发）；登录路由上的 401 豁免，避免重复渲染登录态 */
  useEffect(() => {
    const onUnauthorized = () => {
      if (onLoginRoute()) return;
      setAuthed(false);
    };
    window.addEventListener('cn:unauthorized', onUnauthorized);
    return () => window.removeEventListener('cn:unauthorized', onUnauthorized);
  }, []);

  /* 路由切换：Home 重挂计数、回页首、收起抽屉 */
  useEffect(() => {
    const on = () => {
      setNavSeq((n) => n + 1);
      setDrawerOpen(false);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  /* 抽屉打开时锁背景滚动，Esc 关闭 */
  useEffect(() => {
    document.body.classList.toggle('cj-drawer-lock', drawerOpen);
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  /* body.cj-no-nav：登录 / 检测态兜底隐藏菜单（词间 buildShell 同款保险） */
  useEffect(() => {
    document.body.classList.toggle('cj-no-nav', authed !== true);
  }, [authed]);

  async function logout() {
    try {
      await api.logout();
    } catch {
      // 会话已失效也照常回到登录页
    }
    localStorage.removeItem('cn:username');
    navigate('/');
    setAuthed(false);
  }

  /** 抽屉快捷导出：与 Me 页备份同款下载流程 */
  async function exportAll() {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await fetch(api.backup.exportUrl);
      if (res.status === 401) {
        setAuthed(false);
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
    } catch (e) {
      notifyToast(e instanceof Error ? e.message : '导出失败，请稍后重试');
    } finally {
      setExporting(false);
    }
  }

  /* ---------------- 三态渲染 ---------------- */

  if (authed === null) {
    return (
      <div className="cj-app cj-app-auth">
        <div className="cj-content">
          <div className="cj-boot">正在进入词间…</div>
        </div>
      </div>
    );
  }

  if (authed === false) {
    /* 未登录：登录页是独立界面，不渲染任何菜单 DOM */
    return (
      <div className="cj-app cj-app-auth">
        <div className="cj-content">
          <Login />
        </div>
      </div>
    );
  }

  const key = navKeyOf(route);
  const active = NAV_ITEMS.find((x) => x.key === key) ?? null;
  /* 不在底栏的分区（对照 / 意象 / 典故），顶栏显示当前位置 */
  const whereOn = !TAB_KEYS.includes(key) && !!active;
  const meSub = route.parts[0] === 'me' ? route.parts[1] ?? '' : '';

  const drawerLink = (item: { key: string; label: string; hash: string }) => (
    <a
      key={item.key}
      className={'cj-navlink cj-drawerlink' + (key === item.key || meSub === item.key ? ' cj-nav-on' : '')}
      href={item.hash}
      onClick={() => setDrawerOpen(false)}
    >
      <span className="cj-navdot" />
      {item.label}
    </a>
  );

  return (
    <div className="cj-app">
      {/* 桌面侧栏（≥900px 常驻） */}
      <aside className="cj-sidebar">
        <div className="cj-brand">
          <span className="cj-brand-mark cj-serif">词间</span>
          <span className="cj-brand-sub">古典诗词阅读札记</span>
        </div>
        <nav className="cj-sidenav">
          {NAV_ITEMS.map((item) => (
            <a key={item.key} className={'cj-navlink' + (key === item.key ? ' cj-nav-on' : '')} href={item.hash}>
              <span className="cj-navdot" />
              {item.label}
            </a>
          ))}
          {ME_SUB_ITEMS.map((item) => (
            <a
              key={item.key}
              className={'cj-navlink' + (meSub === item.key ? ' cj-nav-on' : '')}
              href={item.hash}
              style={{ paddingLeft: 28 }}
            >
              <span className="cj-navdot" />
              {item.label}
            </a>
          ))}
        </nav>
        <button type="button" className="cj-navlink" style={{ marginTop: 'auto' }} onClick={logout}>
          <span className="cj-navdot" />
          退出登录
        </button>
      </aside>

      {/* 移动端抽屉（<900px；桌面隐藏） */}
      <aside className={'cj-drawer' + (drawerOpen ? ' cj-drawer-open' : '')} aria-hidden={!drawerOpen}>
        <div className="cj-drawer-head">
          <span className="cj-brand-mark cj-serif">词间</span>
          <button type="button" className="cj-drawer-close" aria-label="收起菜单" onClick={() => setDrawerOpen(false)}>
            ×
          </button>
        </div>
        <nav className="cj-sidenav cj-drawer-nav">
          {NAV_ITEMS.map(drawerLink)}
          {ME_SUB_ITEMS.map(drawerLink)}
        </nav>
        <div className="cj-drawer-foot">
          <button type="button" className="cn-btn cn-btn-ghost cn-btn-sm" disabled={exporting} onClick={exportAll}>
            {exporting ? '导出中…' : '导出'}
          </button>
          <button type="button" className="cn-btn cn-btn-quiet cn-btn-sm" onClick={logout}>
            退出
          </button>
        </div>
      </aside>
      <div className={'cj-scrim' + (drawerOpen ? ' cj-scrim-on' : '')} onClick={() => setDrawerOpen(false)} />

      <div className="cj-content">
        {/* 顶栏（移动端）：菜单按钮 + 品牌 + 当前位置 */}
        <header className="cj-topbar">
          <div className="cj-topbar-left">
            <button type="button" className="cj-menubtn" aria-label="展开菜单" onClick={() => setDrawerOpen(true)}>
              <span className="cj-menubtn-bars" />
            </button>
            <div className="cj-topbar-brand cj-serif">词间</div>
            <span className={'cj-topbar-where' + (whereOn ? ' cj-topbar-where-on' : '')}>
              {whereOn ? active?.label : ''}
            </span>
          </div>
          <div className="cj-topbar-right" />
        </header>

        <main className="cj-view">
          <ErrorBoundary>{renderRoute(route, navSeq)}</ErrorBoundary>
        </main>
      </div>

      {/* 移动底栏四项 */}
      <nav className="cj-tabbar">
        {NAV_ITEMS.filter((x) => TAB_KEYS.includes(x.key)).map((item) => (
          <a key={item.key} className={'cj-tablink' + (key === item.key ? ' cj-nav-on' : '')} href={item.hash}>
            <span className="cj-tabdot" />
            {item.label}
          </a>
        ))}
      </nav>

      <ToastHost />
    </div>
  );
}
