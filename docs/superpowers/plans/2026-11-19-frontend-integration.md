# ci-notes 前端重写与集成实施计划 · Plan 2/2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 React 19 + TS 重写前端为词间全部视图（书架/词作/札记/版本/对照/意象/**典故**/我的/回收站/MCP 密钥/登录），并完成种子联动、容器冒烟、README 与最终验证。

**Architecture:** 自写哈希路由 hook；`src/api.ts` 封装 Plan 1 的 REST；纯逻辑（markdown/diff/exporter）为无相对依赖的 TS 模块（可用 `node --test` 直接测——Node 24 原生类型剥离）；视图组件按职责拆分 `src/components/*` 与 `src/views/*`；最后一次性切换 `App.tsx` 外壳。

**Tech Stack:** React 19 + TypeScript(strict) + Vite 8；不新增任何 npm 依赖。UI 视觉照搬词间米白/墨绿主题（翻译 `styles/app.css`）。语义参考（只读）：`/Users/zhaoyuan/Workbuddy/词间/web/views/*.js`、`web/components/*.js`、`utils/markdown.js`、`utils/diff.js`、`utils/exporter.js`、`styles/app.css`。规格：`docs/superpowers/specs/2026-11-19-cijian-feature-parity-design.md`；后端接口：Plan 1「Store 接口总表」与 Task 13 路由表。

## Global Constraints

- 零新增 npm 依赖；TS strict 全绿（`npx tsc --noEmit`）；`npm run build` 每个视图 Task 结束时必须通过。
- Markdown 渲染禁止 innerHTML（组件渲染 DOM 节点后由 React 容器挂载）；href 白名单。
- 所有文案中文；ID/字段名与 Plan 1 完全一致（camelCase payload）。
- 纯逻辑模块（`src/markdown.ts`、`src/diff.ts`、`src/exporter.ts`）**不得 import 其它本地模块**（保证 node:test 直测）；类型可用 `import type` 无——它们自含类型或内联结构类型。
- 每个 Task 结束：`npm test && npm run build` 全绿 + conventional commit。
- 未保存防护：编辑态 `beforeunload` + 路由离开确认（ConfirmBox）。
- 401 统一处理：api.ts 派发 `window.dispatchEvent(new Event('cn:unauthorized'))`，外壳监听后切登录页。

---

### Task 17: 类型与 API 客户端 `src/types.ts` + `src/api.ts`

**Files:**
- Create: `src/types.ts`、`src/api.ts`

**Interfaces (Produces):**

`src/types.ts`（完整定义，后续所有 Task 消费）：

```ts
export type ClaimKind = 'verified' | 'pending' | 'personal';
export interface Citation { id: string; book: string; edition: string; page: string; url: string; note: string; verified: ClaimKind; }
export interface Claim { id: string; kind: ClaimKind; text: string; paragraph: number; citations: Citation[]; createdAt?: string; updatedAt?: string; }
export type WorkKind = 'ci' | 'poem';
export interface Work { id: string; kind: WorkKind; title: string; author: string; dynasty: string; cipai: string; content: string; background: string; claims: Claim[]; citations: Citation[]; tags: string[]; relatedWorkIds: string[]; createdAt: string; updatedAt: string; revision: number; }
export type WritingStatus = 'idea' | 'research' | 'draft' | 'final';
export type PublishStatus = 'unpublished' | 'pending' | 'published';
export interface Note { id: string; title: string; content: string; note: string; workIds: string[]; claims: Claim[]; citations: Citation[]; tags: string[]; writingStatus: WritingStatus; publishStatus: PublishStatus; publish: { platform: string; publishedAt: string; url: string }; changeNote: string; pendingImport?: boolean; draftOf?: string; draftNoteId?: string; createdAt: string; updatedAt: string; revision: number; }
export interface RevisionRow { id: string; noteId: string; seq: number; snapshot: Partial<Note>; changeNote: string; reason: 'manual' | 'draft-from-final' | 'restore' | 'conflict-overwrite'; createdAt: string; }
export type CompareDimKey = 'context' | 'imagery' | 'allusion' | 'expression' | 'similarity' | 'difference' | 'understanding';
export interface CompareDimension { text: string; kind: ClaimKind; citations: Citation[]; sides?: { a: string; b: string } }
export interface Comparison { id: string; title: string; workAId: string; workBId: string; dimensions: Record<CompareDimKey, CompareDimension>; createdAt: string; updatedAt: string; }
export interface Imagery { id: string; name: string; aliases: string[]; description: string; usages: { text: string; kind: ClaimKind }[]; claims: Claim[]; citations: Citation[]; tags: string[]; note: string; mergedInto: string; createdAt: string; updatedAt: string; revision: number; }
export interface ImageryUse { id: string; imageryId: string; targetType: 'work' | 'note'; targetId: string; quote: string; context: string; fn: string; understanding: string; claims: Claim[]; citations: Citation[]; createdAt: string; updatedAt: string; revision: number; }
export interface Allusion { id: string; name: string; aliases: string[]; source: string; original: string; explanation: string; usages: { text: string; kind: ClaimKind }[]; claims: Claim[]; citations: Citation[]; tags: string[]; note: string; createdAt: string; updatedAt: string; revision: number; }
export interface AllusionUse { id: string; allusionId: string; targetType: 'work' | 'note'; targetId: string; quote: string; context: string; interpretation: string; understanding: string; claims: Claim[]; citations: Citation[]; createdAt: string; updatedAt: string; revision: number; }
export interface TrashItem { id: string; itemType: 'work' | 'note'; itemId: string; label: string; preview: string; trashedAt: string; }
export interface McpKey { id: string; name: string; prefix: string; status: 'active' | 'revoked'; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; }
export interface HomeData { stats: { works: number; notes: number; revisions: number; comparisons: number; imagery: number; allusions: number; draft: number; final: number; published: number; pendingImport: number }; recent: NoteSummary[] }
export interface NoteSummary { id: string; title: string; excerpt: string; tags: string[]; writingStatus: WritingStatus; publishStatus: PublishStatus; pendingImport?: boolean; draftOf?: string; draftNoteId?: string; updatedAt: string; charCount?: number }
export interface WorkSummary { id: string; title: string; author: string; dynasty: string; cipai: string; kind: WorkKind; excerpt: string; firstLine: string; tags: string[]; pendingClaims: number; noteCount: number; updatedAt: string }
export class ApiError extends Error { code: string; status: number; current?: unknown }
```

注意：`ImageryUse.fn` —— 后端 payload 字段名为 `function`（保留字），Plan 1 存取 JSON 时原样用 `function`；前端类型用 `fn` 并在 api 层映射？**决定：前后端统一字段名 `fn`**——Plan 1 各 use 模块 payload 用 `fn` 键（JSON 合法，无冲突），本条为跨计划契约：**Plan 1 imagery.mjs/allusions.mjs 中 use payload 字段名必须是 `fn`（不是 function）**。Plan 1 Task 6/14 执行者注意同步（`link_imagery` 工具入参仍叫 `function`，映射到 payload 的 `fn`）。

`src/api.ts`（完整实现）：

```ts
import type { ... } from './types';   // 全部实体类型
import { ApiError } from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init });
  if (res.status === 401) { window.dispatchEvent(new Event('cn:unauthorized')); throw new ApiError('UNAUTHORIZED', '未登录', 401); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body?.error?.code ?? 'ERROR', body?.error?.message ?? `请求失败（${res.status}）`, res.status, body?.error?.current);
  return body as T;
}
const qs = (p: Record<string, unknown>) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '' && v !== null) u.set(k, String(v)); const s = u.toString(); return s ? '?' + s : ''; };

export const api = {
  home: () => request<HomeData>('/api/home'),
  stats: () => request<{counts: Record<string, number>; facets: Facets}>('/api/stats'),
  search: (q: string) => request<{ works: WorkSummary[]; notes: NoteSummary[] }>('/api/search' + qs({ q })),
  works: {
    list: (p: WorkFilter = {}) => request<WorkSummary[]>('/api/works' + qs(p)),
    get: (id: string) => request<WorkDetail>('/api/works/' + id),
    create: (input: Partial<Work>) => request<{ work: Work }>('/api/works', { method: 'POST', body: JSON.stringify(input) }),
    update: (id: string, input: Partial<Work> & { baseRevision?: number; force?: boolean }) => request<{ work: Work }>('/api/works/' + id, { method: 'PUT', body: JSON.stringify(input) }),
    remove: (id: string) => request<{ trashed: boolean }>('/api/works/' + id, { method: 'DELETE' }),
  },
  notes: { /* list/get/create/update/remove/revisions(id)/compare(id,a,b)/restore(id,rid)/unprotect(id) 同构 */ },
  comparisons: { list/get/create(payload 含 workAId/workBId)/update(id, payload)/remove(id) },
  imagery: { list(p)/get(id)/create/update(id,input)/remove(id)/merge(id, intoId)/impact(id)/uses.list({targetType,targetId})/uses.create/uses.update(id,input)/uses.remove(id)/compare(a,b) },
  allusions: { /* 与 imagery 完全同构 + uses 字段 interpretation */ },
  trash: { list()/restore(id)/purge(id) },
  backup: { exportUrl: '/api/export', preflight: (b: unknown) => request<Preflight>('/api/import', { method: 'POST', body: JSON.stringify({ mode: 'preflight', backup: b }) }), merge: (b: unknown) => request<MergeResult>('/api/import', { method: 'POST', body: JSON.stringify({ mode: 'merge', backup: b }) }) },
  mcpKeys: { list()/create(name) → {key, record}/revoke(id)/enable(id) },
  login: (username: string, password: string) => request<{ ok: true }>('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
};
```

（实现时把 `notes/imagery/allusions` 组补全为与上面注释一致的完整方法；类型 `WorkFilter/WorkDetail/WorkDetail/Preflight/MergeResult/Facets` 一并在 types.ts 定义。）

- [ ] **Step 1:** 实现两文件。**Step 2:** `npx tsc --noEmit` 全绿。**Step 3:** `git commit -m "feat(web): entity types and api client"`

---

### Task 18: Markdown 渲染 `src/markdown.ts`（翻译词间实现，TDD）

**Files:**
- Create: `src/markdown.ts`、`test/markdown.test.mjs`

**Interfaces (Produces):**
- `render(text: string, opts?: { onGroup?: (el: HTMLElement, group: number) => void; onBlock?: (el: HTMLElement) => void }): DocumentFragment`
- `renderInline(text: string): DocumentFragment`
- `plain(text: string): string`（去标记纯文本）
- `paragraphs(text: string): string[][]`（空行分段；段内按单换行拆行——claims.paragraph 依赖此函数，**必须与词间 `utils/util.js toParagraphs` 规则一致**）
- 块级支持：h1-h6 / ``` 围栏代码（带语言，原样保留）/ --- 分隔线 / > 引用（嵌套）/ 无序有序列表（缩进嵌套）/ 段落；行内：**粗**、*斜*、~~删~~、`code`、[文字](url)、转义、单换行硬换行；图片语法降级纯文字；原始 HTML 当文字；safeHref 只放行 http/https/mailto/站内/锚点。
- 渲染全部 createElement/TextNode；外链 `target=_blank rel=noopener noreferrer`；标题级别 clamp(level+2, 3, 6)。

- [ ] **Step 1: 写失败测试** `test/markdown.test.mjs`（jsdom 不可用——用 Node 内置无 DOM；**渲染断言改为对输出 fragment 序列化**：`frag.firstChild.outerHTML` 比对字符串。纯 Node 环境无 document！**决定：测试只测 `plain()` 与 `paragraphs()`（纯字符串函数）+ `parse` 内部结构不导出；渲染函数的 DOM 行为不写 node 测试，由 tsc + 词间实现翻译保证**）：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plain, paragraphs } from '../src/markdown.ts';

test('plain 去除常见标记', () => {
  assert.equal(plain('## 标题\n**粗**体与*斜*体'), '标题粗体与斜体');
  assert.equal(plain('> 引用句'), '引用句');
  // 列表符的转换符号以词间 utils/markdown.js 的 plain 实现为准，先读参考实现再定断言
  assert.ok(!plain('- 甲\n- 乙').includes('- '));
});
test('paragraphs 按空行分段带序号', () => {
  const p = paragraphs('第一段第一行\n第一段第二行\n\n第二段');
  assert.equal(p.length, 2);
  assert.deepEqual(p[0], ['第一段第一行', '第一段第二行']);
});
test('claim 段号与段落对齐（核心约束）', () => {
  const text = '段一\n\n段二';
  const p = paragraphs(text);
  assert.equal(p.length, 2); // paragraph=1 → p[1]
});
test('代码块内空行不分段', () => {
  assert.equal(paragraphs('```js\na\n\nb\n```').length, 1);
});
```

- [ ] **Step 2:** FAIL。**Step 3:** 实现：**逐函数翻译词间 `/Users/zhaoyuan/Workbuddy/词间/utils/markdown.js`**（parse/render/plain 与 `utils/util.js` 的 toParagraphs），TS 化（类型标注、无 any），DOM API 用 `document`（仅浏览器执行路径调用 render；node 测试只碰纯函数——render/renderInline 不在测试中调用即可，但代码需通过 tsc：DOM 类型来自 @types/react 附带的 lib.dom）。**Step 4:** `npm test && npx tsc --noEmit` 全绿。**Step 5:** `git commit -m "feat(web): markdown renderer translated from cijian (safe, paragraph-aligned)"`

---

### Task 19: Diff `src/diff.ts`（翻译词间实现）

**Files:**
- Create: `src/diff.ts`、`test/diff.test.mjs`

**Interfaces (Produces):**
- `type Seg = { type: 'equal' | 'insert' | 'delete'; text: string }`
- `type Row = { type: 'equal' | 'delete' | 'insert' | 'change'; a?: string; b?: string; segments?: Seg[] }`
- `diffText(a: string, b: string): { rows: Row[]; stats: { added: number; removed: number; changed: number; same: number } }`
- 翻译词间 `utils/diff.js`：行级 LCS（Uint32Array、MAX_CELLS=1,200,000 超限退化）、delete+insert 相邻合并 change、`charDiff`（40 万格上限）生成字级 segments。

- [ ] **Step 1:** 测试：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffText, charDiff } from '../src/diff.ts';

test('行级增删改统计', () => {
  const r = diffText('甲\n乙\n丙', '甲\n丁\n丙');
  assert.equal(r.stats.changed, 1); assert.equal(r.stats.same, 2);
  const row = r.rows.find(x => x.type === 'change');
  assert.ok(row && row.segments && row.segments.length >= 2);
});
test('纯插入与纯删除', () => {
  assert.equal(diffText('甲', '甲\n乙').stats.added, 1);
  assert.equal(diffText('甲\n乙', '甲').stats.removed, 1);
});
test('字级 diff', () => {
  const segs = charDiff('春风又绿', '春风又绿了');
  assert.ok(segs.some(s => s.type === 'insert' && s.text === '了'));
});
test('大文本退化不崩', () => {
  const a = Array.from({ length: 3000 }, (_, i) => '行' + i).join('\n');
  const b = Array.from({ length: 3000 }, (_, i) => '行' + i * 2).join('\n');
  assert.ok(diffText(a, b).rows.length > 0);
});
```

- [ ] **Step 2:** FAIL。**Step 3:** 逐行翻译词间 `utils/diff.js` 为 TS。**Step 4:** `npm test` PASS。**Step 5:** `git commit -m "feat(web): line+char diff translated from cijian"`

---

### Task 20: 路由与 UI 基件 `src/router.ts` + `src/components/ui.tsx`

**Files:**
- Create: `src/router.ts`、`src/components/ui.tsx`

**Interfaces (Produces):**

`src/router.ts`（完整实现）：

```ts
import { useEffect, useState, useCallback } from 'react';

export interface RouteMatch { path: string; parts: string[]; query: URLSearchParams }
function current(): RouteMatch {
  const raw = location.hash.slice(1) || '/';
  const [path, q = ''] = raw.split('?');
  return { path, parts: path.split('/').filter(Boolean), query: new URLSearchParams(q) };
}
export function navigate(to: string) { location.hash = to; }
export function useHashRoute(): RouteMatch {
  const [m, setM] = useState(current);
  useEffect(() => { const on = () => setM(current()); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  return m;
}
// 匹配示例：parts[0]==='works' && parts.length===2 → work 详情（parts[1]）
```

`src/components/ui.tsx`：函数组件集（Props 见名即义）：
- `Chip({tone: 'verified'|'pending'|'personal'|'status'|'muted', children})`
- `StatusChip({writingStatus?, publishStatus?, pendingImport?, draftOf?})`（组合徽章：写作/发布/待导入/有续稿）
- `RelTime({iso})`（刚刚/n 分钟前/昨天/n 天前/日期——翻译词间 util 相对时间）
- `Modal({title, children, onClose})`（遮罩 + Esc + 点遮罩关）
- `ConfirmBox({title, message, onOk, onCancel, danger?})`、`AlertBox({title, message})`、`ChooseBox({title, message, choices:[{key,label,danger?}], onPick, onCancel})`（冲突三选一用它）
- `Toast({msg})` + `useToasts()` hook（返回 `notify(msg)`；3 秒自动消失，容器 fixed 右下）
- `ErrorBoundary`（class 组件，捕获 render 错误显示「出错了 + 重试」按钮 reload）
- `EmptyState({text})`
- `Section({title, children, aside?})`（通用卡片节）

- [ ] **Step 1:** 实现两文件（样式类名沿用 `cn-` 前缀，与 Task 23 CSS 对应）。**Step 2:** `npx tsc --noEmit && npm run build` 绿。**Step 3:** `git commit -m "feat(web): hash router and ui primitives"`

---

### Task 21: 编辑器组件 `src/components/editors.tsx` + Md 渲染组件

**Files:**
- Create: `src/components/editors.tsx`、`src/components/md.tsx`

**Interfaces (Produces):**
- `Md({ text, inline?, onGroup? }: { text: string; inline?: boolean; onGroup?: (el: HTMLDivElement, group: number) => void })`：useRef 容器，useEffect 内调 `render/renderInline` 后 appendChild（React 不参与子节点 diff）；`overflow-wrap: break-word`。
- `TagInput({ value: string[], onChange })`：回车/顿号添加、点 chip 删除。
- `StatusSwitcher({ options: [key,label][], value, onChange })`（分段按钮组）
- `ClaimsEditor({ value: Claim[], onChange })`：列表 + 逐条编辑（kind 三档、text、paragraph 数字（-1=不挂段落）、citations 内嵌 CitationsEditor；kind=verified 且无出处时保存按钮禁用 + 提示「已核实的资料需要至少一条出处」）
- `CitationsEditor({ value: Citation[], onChange })`：列表 + 字段（book/edition/page/url/note/verified）
- `Field({ label, children })`、`TextArea({ rows, ... })` 等表单基件

- [ ] **Step 1:** 实现。**Step 2:** tsc/build 绿。**Step 3:** `git commit -m "feat(web): claims/citations editors, tag input, status switcher, md wrapper"`

---

### Task 22: 导出 `src/exporter.ts`（翻译词间实现，TDD）

**Files:**
- Create: `src/exporter.ts`、`test/exporter.test.mjs`

**Interfaces (Produces):**
- `noteToMarkdown(note: Note, linkedWorks: Work[], snapshotRev?: { createdAt: string }): string`（引言状态行、发布记录、「## 关联原文」（每首 `### 标题`、斜体 meta、`>` 引用原文、claims 带 `[已核实]` 标签与出处行）、「## 正文」（空则「（正文待导入）」）、「## 附记」、「## 资料标注」、「## 引用出处」、页脚时间 + 可选版本时间）
- `workToMarkdown(work: Work): string`
- `allusionToMarkdown(allusion: Allusion, uses: AllusionUse[]): string`（★典故导出：通用资料段含 source/original/explanation + 「## 使用记录」逐条 quote/context/interpretation/understanding）
- `download(filename, text)`（Blob + a[download]）
- 翻译词间 `utils/exporter.js`（去掉其 db 参数形态，改为显式传 linkedWorks/uses）。

- [ ] **Step 1:** 测试（断言产物包含关键节标题、`[已核实]` 标记、版本时间行、空正文占位、典故导出含 explanation 与 interpretation）。**Step 2:** FAIL → **Step 3:** 实现 → **Step 4:** PASS → **Step 5:** `git commit -m "feat(web): markdown exporters incl. allusion"`

---

### Task 23: 全局样式 `src/styles.css`（移植词间主题）

**Files:**
- Modify: `src/styles.css`（整文件替换）

做法：**翻译词间 `/Users/zhaoyuan/Workbuddy/词间/styles/app.css`** 为本项目样式（保留其 `cj-` 类名前缀不改名以减少翻译错误；主题色沿用词间米白/墨绿；断点 900px 桌面侧栏/移动底栏+抽屉；阅读字号 CSS 变量 `--reading-size`；`cj-md` 长词断行与代码块折行）。新增少量 `cn-` 类：登录页（沿用现有米白风格）与 toast 容器。文件头注释注明来源项目。

- [ ] **Step 1:** 替换 styles.css。**Step 2:** `npm run build` 绿。**Step 3:** `git commit -m "style(web): port cijian visual theme (paper/ink-green, responsive)"`

---

### Task 24: 视图 · 书架 + 登录 `src/views/home.tsx` + `src/views/login.tsx`

**Files:**
- Create: `src/views/home.tsx`、`src/views/login.tsx`

**功能清单（照词间 `web/views/library.js` 与 login 语义）**：
- home：统计卡（works/notes/revisions/comparisons/imagery/allusions 计数）；快捷入口三卡（写札记 `#/notes/new`、收词作 `#/works/new`、作对照 `#/compare/new`）；最近 8 条札记（excerpt、StatusChip、RelTime、点击 `#/notes/:id`）；写作偏好提示卡（5 条文案照词间）。数据 `api.home()`。
- login：用户名/密码表单（沿用现有提交逻辑）；401 显示「用户名或密码不正确」；成功后 `navigate('#/')` 并触发外壳刷新（`window.dispatchEvent(new Event('cn:auth'))`）。

- [ ] **Step 1:** 实现。**Step 2:** tsc/build 绿。**Step 3:** `git commit -m "feat(web): home and login views"`

---

### Task 25: 视图 · 词作 `src/views/works.tsx`（列表/详情/编辑三合一文件，内含三个导出组件）

**Files:**
- Create: `src/views/works.tsx`

**导出**：`WorksList`、`WorkDetail({id})`、`WorkEdit({id?})`。

**功能清单（照词间 `web/views/library.js`/`work-edit.js`/`workDetail` 语义）**：
- 列表：防抖 220ms 搜索框（q）；筛选四下拉（author/cipai/tag/kind，选项取 `api.stats().facets`）；卡片（体裁角标、`作者 · 朝代 · 词牌`（词牌空显示「词牌未填」）、firstLine 衬线 48 字、tags chips、待核实 claim 数、关联札记数、RelTime）；「＋ 收一首」。
- 详情：操作行（编辑/加入对照 `#/compare/new?a=:id`/导出 Markdown（`workToMarkdown` + download）/移入回收站（ConfirmBox：说明「相关札记不受影响」））；信息卡（标题/meta/tags/updatedAt）；「原文」（纯文本 `<pre>` 逐字）；「背景」（Md）；「资料与可信度」（claims 按 verified/pending/personal 三组）；「引用出处」；「相关作品」（relatedWorkIds 反查——用 `api.works.get` 返回的 relatedWorks）；「关联札记」（linkedNotes）；`ImagerySection({targetType:'work', targetId})`（Task 28）；`AllusionSection({targetType:'work', targetId})`（Task 28）——**本 Task 先以占位 `<div data-slot="imagery-section"/>` 预留，Task 28 接线**。
- 编辑：字段（标题/作者/朝代/体裁切换/词牌可空/原文 textarea 提示按句分行/背景）；TagInput；ClaimsEditor + CitationsEditor；相关作品多选（checkbox 列表来自 `api.works.list()`，排除自己）；**localStorage 草稿暂存**：key `draft:work:new:<ts>` 或 `draft:work:<id>`，700ms 防抖写入，进入时检测恢复 + 提示「有本机暂存，已恢复」，保存成功清除；**编辑态挂 `beforeunload` 拦截**（有未保存修改时提示）；保存校验「至少填写标题或原文」；冲突（ApiError code=CONFLICT）→ ChooseBox 三选一（「保留我的，覆盖过去」→ `api.works.update(id, {..., force:true})` /「采用对方的版本」→ 表单回填 `err.current` /「先不处理」）；保存后 `navigate('#/works/'+id)`。
- 导出/删除操作全部有 ConfirmBox/反馈 toast。

- [ ] **Step 1:** 实现（先占位 section 插槽）。**Step 2:** tsc/build 绿。**Step 3:** `git commit -m "feat(web): works list/detail/edit with drafts, conflict choose, export"`

---

### Task 26: 视图 · 札记 `src/views/notes.tsx`

**Files:**
- Create: `src/views/notes.tsx`（导出 `NotesList`、`NoteDetail({id})`、`NoteEdit({id?})`）

**功能清单（照词间 `web/views/notes.js`/`note-edit.js`/noteDetail）**：
- 列表：搜索 + 写作/发布状态双筛选（facets）；卡片（excerpt 80 字、StatusChip、RelTime）。
- 阅读：操作行（编辑/版本历史 `#/notes/:id/history`/导出 Markdown/复制内容（clipboard）/撤销定稿（protected 时，ConfirmBox → `api.notes.unprotect`）/移入回收站）；头部（标题、StatusChip、写于/改于、本次修改说明）；protected 通知「内容被保护，继续修改会另起新草稿」；pendingImport 通知「正文还没有导入」；正文 Md + **段落级标注**（`onGroup` 回调收集该段 claims chips，点击段落组开 Modal 列出该段全部标注与出处）；附记 Md；「关联原文」卡（每首：标题链接、meta、`<pre>` 原文、该作品 claims 分组摘要）；「资料与可信度」「引用出处」「发布记录」；ImagerySection / AllusionSection 占位（Task 28 接线）。
- 编辑：标题；关联作品多选 checkbox；正文大 textarea（衬线 + A−/A＋ 字号按钮 + 「预览」切换渲染 Md + Markdown 用法提示）；附记；ClaimsEditor/CitationsEditor；写作状态 StatusSwitcher（构思/资料收集/草稿/定稿）；发布状态（未发布/待发布/已发布，非未发布展开 platform/publishedAt/url 三字段）；修改说明；「写之前看一眼」自检清单卡（4 项勾选不持久化）；草稿暂存（key `draft:note:*`，同 Task 25 机制）；保存走 `api.notes.update`，createdDraft 响应 → Modal「已另起新草稿」+「去看新草稿 / 留在原篇」；CONFLICT → 三选一同 Task 25。

- [ ] **Step 1:** 实现。**Step 2:** tsc/build 绿。**Step 3:** `git commit -m "feat(web): notes list/read/edit with paragraph claims, preview, draft derivation"`

---

### Task 27: 视图 · 版本历史与对比 `src/views/history.tsx`

**Files:**
- Create: `src/views/history.tsx`（导出 `HistoryList({id})`、`HistoryCompare({id, a, b})`）

**功能清单（照词间 `web/views/history.js`）**：
- 列表：seq 倒序 `v{n}`（n=总数-索引）卡：完整时间、修改说明（无则「没有写修改说明」）、reason 中文标签映射 `{manual:'手动保存','draft-from-final':'定稿后派生草稿',restore:'由历史版本复制','conflict-overwrite':'冲突覆盖前留档'}`、字数与写作状态；每卡操作：**设为旧版/设为新版**（选中态高亮，两版齐后「比较两版」→ `#/notes/:id/history/:a/:b`）、「导出这一版」（noteToMarkdown(snapshot, linkedWorks, {createdAt})）、**「复制为新草稿」**（ConfirmBox → `api.notes.restore(id, revId)` → 跳新草稿编辑）、**「看内容」**（行内展开 snapshot 正文 `<pre>`）。
- 对比页：旧/新版头部（时间 + 修改说明）；统计 chips（增 n/删 n/改 n/未变 n，来自 `api.notes.compare(id,a,b).stats`）；diff 行渲染（`diffText` 服务端已算好 rows 直接渲染；change 行双行显示：旧行内删除字级段 `<del>`、新行内插入字级段 `<ins>`，类名 `cj-seg-del/cj-seg-ins`）。

- [ ] **Step 1:** 实现。**Step 2:** tsc/build 绿。**Step 3:** `git commit -m "feat(web): revision history with compare, export, restore-as-draft"`

---

### Task 28: 意象/典故区块组件 `src/components/sections.tsx`（核心复用件）

**Files:**
- Create: `src/components/sections.tsx`

**Interfaces (Produces):**
- `ImagerySection({ targetType, targetId }: { targetType: 'work'|'note'; targetId: string })`
- `AllusionSection({ targetType, targetId }: { targetType: 'work'|'note'; targetId: string })`

**功能清单（照词间 `web/components/imagery.js`）**——两个组件同构，字段差异标注：
- 加载 `api.imagery.uses.list({targetType, targetId})`（典故用 allusions.uses.list），按意象/典故分组展示：名称链接（`#/imagery/:id`、`#/allusions/:id`）+ 别名 + 每条 use（quote `<pre>` 逐字、情境、表达作用 `fn` / 典故解释 `interpretation`、我的理解，均 Md inline 渲染；claims chips；出处行）；每条「编辑这处/删除」（删除 ConfirmBox）。
- 「关联已有意象/典故」按钮 → Modal 选择器（列全部：名称+别名+描述/释义，搜索框过滤）→ 选中打开 use 编辑 Modal（字段：对应原文或具体词句、该处的情境与描述、在这件作品中的表达作用/**此处的典故解释**、我的理解；ClaimsEditor/CitationsEditor 可选折叠）→ 保存 `uses.create`。
- 「新建意象/典故并关联」按钮 → 跳 `#/imagery/new`/`#/allusions/new`（带 `?link=:targetType:targetId` query——Task 29/30 编辑页读取该 query，保存成功后自动回到原目标详情并打开 use 编辑）。
- 空 state：「还没有关联意象/典故」。

- [ ] **Step 1:** 实现。**Step 2:** tsc/build 绿。**Step 3:** `git commit -m "feat(web): imagery & allusion sections with use-record editing"`

---

### Task 29: 视图 · 意象 `src/views/imagery.tsx`

**Files:**
- Create: `src/views/imagery.tsx`（导出 `ImageryList`、`ImageryDetail({id})`、`ImageryEdit({id?})`）

**功能清单（照词间 imagery 列表/详情/编辑）**：
- 列表：搜索 q + 标签筛选 + 「显示已合并」开关（默认隐藏 mergedInto 非空）；卡（名称、别名、描述首行、uses 计数、tags）；「＋ 新意象」。
- 详情：通用资料卡（描述/常见表达用途/阅读札记，Md）；claims 三组 + citations；「出现在」：works 与 notes 分组（每组列出该目标下的 uses，复用 use 渲染）；被合并提示（mergedInto 指向链接）；操作：编辑/合并到另一意象（Modal 选目标 → ConfirmBox「其全部使用记录将转挂到目标名下」→ `api.imagery.merge`）/删除（先用 `api.imagery.impact(id)` 显示影响数再 ConfirmBox「作品与札记不受影响，只是少了索引条目」）。
- 编辑：名称必填；别名（TagInput）；体裁无；描述；usages（一行一种 textarea，逗号/换行分隔 → `{text,kind:'pending'}`）；我的阅读札记；TagInput 标签；ClaimsEditor/CitationsEditor；`?link=` query 处理（保存成功 → 回原目标并携带 `#link` 状态打开 use 编辑——用 sessionStorage 传 `{linkTarget}`，详情页挂载时检查）；草稿暂存同前；冲突三选一同前。

- [ ] **Step 1:** 实现。**Step 2:** tsc/build 绿。**Step 3:** `git commit -m "feat(web): imagery views with merge, impact, link-back"`

---

### Task 30: 视图 · 典故 `src/views/allusions.tsx` ★新功能

**Files:**
- Create: `src/views/allusions.tsx`（导出 `AllusionList`、`AllusionDetail({id})`、`AllusionEdit({id?})`）

**功能清单**（结构镜像 Task 29，字段差异）：
- 列表：搜索 + 标签筛选；卡（名称、aliases、`source` 出处典籍、explanation 首行、uses 计数）；「＋ 新典故」。
- 详情：**通用释义卡**——`source`（出处典籍）、`original`（典故原文 `<pre>` 逐字）、`explanation`（通用解释 Md，节标题「典故释义」）、usages、我的阅读札记；claims 三组 + citations；「出现在」（works/notes 分组 uses：quote/context/**interpretation（节标题「此处解释」）**/understanding）；操作：编辑/合并/删除（impact 确认）同构。
- 编辑：名称；别名 TagInput；**出处典籍 source（input，提示如《庄子·齐物论》）**；**典故原文 original（textarea，逐字保留不解析）**；**典故释义 explanation（textarea，提示：通用层解释——这个典故讲什么、通常表达什么）**；usages；tags；claims/citations；`?link=` 与草稿暂存/冲突三选一同构。

- [ ] **Step 1:** 实现。**Step 2:** tsc/build 绿。**Step 3:** `git commit -m "feat(web): allusion library views with two-layer interpretation"`

---

### Task 31: 视图 · 对照 `src/views/compare.tsx`

**Files:**
- Create: `src/views/compare.tsx`（导出 `CompareList`、`ComparePick`、`CompareDetail({id})`）

**功能清单（照词间 `web/views/compare.js`）**：
- 列表：说明卡 + 每条（标题、甲/乙标题、`n / 7 个维度已写`、时间）。
- 选两首：作品卡点选最多 2 首（`?a=` 预选第一首），「开始对照」→ `api.comparisons.create({workAId, workBId})` → `#/compare/:id`。
- 详情：
  - 「已记录的意象」块：`api.imagery.compare(workAId, workBId)`——shared 每条并排（甲 uses / 乙 uses：quote/情境/fn/理解）；onlyA/onlyB 分列（链接意象详情）；空态「到作品的意象区域关联后这里自动显示」。
  - **「已记录的典故」块★**：`api.allusions.compare(a, b)` 同构（字段 interpretation）。
  - 「原文对照」：甲乙两张卡上下排列（`<pre>`）。
  - 7 维度卡：未编辑态（前 4 维显示 sides.a/sides.b 两栏文本 + 总结 Md + kind chip + 出处）；「编辑」展开面板（前 4 维两侧 textarea；全部维度总结 textarea + StatusSwitcher 三档 kind + CitationsEditor）→「存下」整体 `api.comparisons.update(id, comparison)` 重绘。
  - 「删除对照」ConfirmBox（词作不受影响，直接删）。

- [ ] **Step 1:** 实现。**Step 2:** tsc/build 绿。**Step 3:** `git commit -m "feat(web): comparisons with 7 dimensions and imagery/allusion cross blocks"`

---

### Task 32: 视图 · 我的 + 回收站 `src/views/me.tsx`

**Files:**
- Create: `src/views/me.tsx`（导出 `Me`、`TrashView`）

**功能清单（照词间 `web/views/me.js`/trash）**：
- Me：账号卡（登录用户名 + 「数据存于本服务器」说明）；阅读字号 7 档按钮组（15–24，写 localStorage `cn:fontSize` → `document.documentElement.style.setProperty('--reading-size', n+'px')`）；数据统计卡（`api.stats()` counts + 回收站入口）；**导出全部数据**（`fetch('/api/export')` → blob 下载 `ci-notes-backup.json`，显示 KB）；**从备份恢复**（文件选择 + 粘贴 JSON 两种入口 → `api.backup.preflight` → ConfirmBox 明细（每类新增数/重复/冲突/悬空 + 「导入不会删除已有内容；定稿和已发布的版本不会被覆盖」）→ `api.backup.merge` → 结果 AlertBox）；MCP 密钥入口行（`#/me/mcp-keys`）；写作偏好卡。
- TrashView：列表卡（类型 chip、删除时间、label、预览 120 字）；「恢复」（`api.trash.restore`）/「永久删除」（ConfirmBox 说明札记历史版本一并删除 → `api.trash.purge`）；空态。

- [ ] **Step 1:** 实现。**Step 2:** tsc/build 绿。**Step 3:** `git commit -m "feat(web): me page with export/import/font-size, trash view"`

---

### Task 33: 视图 · MCP 密钥 `src/views/mcpkeys.tsx`

**Files:**
- Create: `src/views/mcpkeys.tsx`（导出 `McpKeys`）

**功能清单（照词间 mcp-keys 页，适配本服务）**：
- 生成表单（名称 + 「生成新密钥」）→ 成功后 **freshCard 只显示一次明文**（`cin_...`，按钮「复制密钥」「我已保存，隐藏」）。
- 列表卡：状态 chip（生效中/已撤销）、创建时间、名称、`prefix…`、最近使用（无则「还没有被使用过」）、撤销时间；操作：撤销（ConfirmBox）/重新启用。
- 端点卡：`location.origin + '/mcp'`；curl 手测示例（注明应返回 32 个工具）：
  ```bash
  curl -s -X POST <origin>/mcp -H 'Content-Type: application/json' -H 'X-CiNotes-Key: <密钥>' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 300
  ```
- 四份客户端配置片段卡（可复制）：Claude Code（`claude mcp add` + .mcp.json 两种，env `CI_NOTES_MCP_KEY` + `--header "X-CiNotes-Key: \${CI_NOTES_MCP_KEY}"`）、Codex（config.toml `http_headers`）、通用 HTTP 客户端 JSON。全部强调用 `X-CiNotes-Key` 头。
- 「关于安全」要点：SHA-256 存储、明文只显示一次、即时撤销、Origin 校验、会话与密钥两条独立通道。

- [ ] **Step 1:** 实现。**Step 2:** tsc/build 绿。**Step 3:** `git commit -m "feat(web): mcp key management page with client snippets"`

---

### Task 34: 外壳切换 `src/App.tsx` 重写 + 收尾

**Files:**
- Modify: `src/App.tsx`（整体替换）、`src/main.tsx`（如需）、Delete: `src/seed.ts`

**App.tsx 结构（照词间 app.js 外壳语义）**：
- 状态：`authed: boolean | null`（null=检测中）；`route = useHashRoute()`；全局监听 `cn:unauthorized`（置 false）与 `cn:auth`（置 true）。
- `authed === null`：全屏 loading；`authed === false`：仅渲染 `<Login/>`（**不渲染任何菜单 DOM**）。
- `authed === true`：外壳 = 顶栏（菜单按钮/面包屑/同步点）+ 桌面侧栏 6 项（书架 `#/`、词作 `#/works`、札记 `#/notes`、对照 `#/compare`、意象 `#/imagery`、**典故 `#/allusions`**）+「我的」（含回收站/MCP 密钥子入口）+ 移动底栏 4 项（书架/词作/札记/我的）+ 抽屉（≥900px 隐藏；含全部 8 项 + 导出/退出）；`<ErrorBoundary>` 包裹路由 switch：

```tsx
function renderRoute(r: RouteMatch) {
  const [head, a, b, c] = r.parts;
  switch (head) {
    case undefined: return <Home/>;
    case 'works': return !a ? <WorksList/> : a === 'new' ? <WorkEdit/> : b === 'edit' ? <WorkEdit id={a}/> : <WorkDetail id={a}/>;
    case 'notes': return !a ? <NotesList/> : a === 'new' ? <NoteEdit/> : b === 'edit' ? <NoteEdit id={a}/> : b === 'history' ? (r.parts[3] ? <HistoryCompare id={a} a={r.parts[3]} b={r.parts[4]}/> : <HistoryList id={a}/>) : <NoteDetail id={a}/>;
    case 'compare': return !a ? <CompareList/> : a === 'new' ? <ComparePick/> : <CompareDetail id={a}/>;
    case 'imagery': return !a ? <ImageryList/> : a === 'new' ? <ImageryEdit/> : b === 'edit' ? <ImageryEdit id={a}/> : <ImageryDetail id={a}/>;
    case 'allusions': return !a ? <AllusionList/> : a === 'new' ? <AllusionEdit/> : b === 'edit' ? <AllusionEdit id={a}/> : <AllusionDetail id={a}/>;
    case 'me': return a === 'trash' ? <TrashView/> : a === 'mcp-keys' ? <McpKeys/> : <Me/>;
    default: return <Home/>;
  }
}
```

- 阅读字号初始化（读 localStorage 设 CSS 变量）；`Toast` 容器挂载；登录后首屏 `api.home()` 失败 401 → 登录页。
- 删除 `src/seed.ts`（grep 确认无引用）。
- **接线 Task 25/26 留下的 section 占位**：WorkDetail/NoteDetail 中占位 div 替换为 `<ImagerySection/>` 与 `<AllusionSection/>`。

- [ ] **Step 1:** 重写 App.tsx 并接线。**Step 2:** `npm test && npm run build` 全绿；`grep -r "seed" src/` 无残留引用。**Step 3:** `git commit -m "feat(web): app shell with full navigation, auth gating, section wiring"`

---

### Task 35: 集成验证（容器冒烟 + README + 最终核对）

**Files:**
- Modify: `README.md`、`.env.example`（如需）、`scripts/test-container.sh`（本计划无改动则验证 Plan 1 已扩展版本）

**步骤**：
- [ ] **Step 1:** README 重写：功能总览（词作/札记/版本/对照/意象/**典故两层解释**/回收站/可信度标注/备份合并/单用户认证/MCP 32 工具）、API 简表、MCP 接入指引（含 X-CiNotes-Key 与 4 类客户端摘要）、备份与恢复（含词间 cijian-backup 兼容说明）、旧库自动导出 legacy 备份说明、开发与部署（不变部分保留）。
- [ ] **Step 2:** 全链路本地验证：`npm test` → `npm run build` → `docker build -t ci-notes:verify .` → `bash scripts/test-container.sh`（含 Plan 1 扩展的实体/链接/MCP/重启持久化断言）全绿。
- [ ] **Step 3:** 手工冒烟（本地起服 + 种子登录）：书架统计、新建典故→关联到种子词作、对照页典故块显示、版本历史对比渲染、导出备份→preflight→merge 结果提示。发现问题就地修复（修复提交）。
- [ ] **Step 4:** `git commit -m "docs: rewrite README for entity model, allusion feature, mcp onboarding"`；两份计划全部完成。

---

## Plan 2 规格差异说明

- `ImageryUse.function` 字段在 JSON payload 中命名为 `fn`（跨计划契约，见 Task 17），工具入参仍为 `function`（Plan 1 Task 14 映射）。
- 渲染类 DOM 函数（markdown render）不写 node 测试（无 DOM 环境），由逐行翻译 + tsc 保证；纯函数（plain/paragraphs/diff/exporter 字符串产物）有完整测试。
- 登录页沿用 ci-notes 现有单用户表单语义（无词间的注册/OTP/忘记密码——规格明确不做）。
