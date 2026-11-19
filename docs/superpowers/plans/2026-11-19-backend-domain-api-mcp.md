# ci-notes 后端重写（领域层 + API + MCP）实施计划 · Plan 1/2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ci-notes 现有 Node 24 零依赖栈上重写词间全部领域模型（词作/札记/版本/对照/意象/回收站/可信度标注/备份）+ 新增典故库，暴露 REST API 与 MCP 端点（32 工具），全部带 node:test 测试。

**Architecture:** 业务规则全部在 `server/core/*.mjs` 纯模块（各函数接收 `db` 句柄），`server/store.mjs` 组装为 facade；`server/app.mjs` 保留现有会话/安全机制、重写路由表为 REST；`server/mcp.mjs` 手写 Streamable HTTP JSON-RPC；SQLite 10+1 张表（payload JSON + 标量冗余列 + CAS 乐观锁），revisions 物理不可变。

**Tech Stack:** Node ≥24.14（`node:http`、`node:sqlite` DatabaseSync、node:test），零 npm 运行时依赖。语义参考实现（只读）：`/Users/zhaoyuan/Workbuddy/词间/utils/store-core.js`、`imagery-core.js`、`diff.js`、`seed.js`、`mcp/server.js`、`mcp/http-server.js`。规格：`docs/superpowers/specs/2026-11-19-cijian-feature-parity-design.md`。

## Global Constraints

- 后端运行时零 npm 依赖；只用 `node:http`/`node:sqlite`/`node:test`/`node:crypto`。
- Node 版本地板：`>=24.14.0 <25`（package.json engines 不变）。
- 所有 UI/错误文案为中文。测试命令：`npm test`（= `node --test test/*.test.mjs`）。
- 每个 Task 结束时 `npm test` 全绿、可提交（conventional commits：feat/fix/test/docs/chore）。
- SQLite：WAL、synchronous=FULL、foreign_keys=ON、busy_timeout 5000、写事务 `BEGIN IMMEDIATE`。
- ID 前缀：work=`w_`、note=`n_`、revision=`rv_`、comparison=`cp_`、trash=`t_`、claim=`cl_`、citation=`ct_`、imagery=`im_`、imageryUse=`iu_`、allusion=`al_`、allusionUse=`au_`、mcpKey=`mk_`。
- 错误统一 `{error:{code,message,current?}}`；CAS 冲突 code=`CONFLICT` 且附 `current`。
- 会话认证机制（HMAC 令牌、Cookie、防爆破、跨站检查）从现有 `server/app.mjs` 原样保留。
- 语义参考：不确定某条业务规则时，先读词间对应函数再实现，**不得自行发明语义**；词间与规格冲突时以规格为准。

---

### Task 1: 数据库层 `server/core/db.mjs`（建表 v2 + 迁移 + 旧库导出）

**Files:**
- Create: `server/core/db.mjs`
- Create: `test/db.test.mjs`
- Modify: 删除 `test/app.test.mjs` 中 SQLite 持久化/种子两个旧用例（HTTP 用例暂留，Task 10 重写）

**Interfaces (Produces):**
- `openDb(dbPath, {dataDir})` → `DatabaseSync`（完成迁移；旧 schema 自动导出 `ci-notes-legacy-backup.json` 后重建）
- `SCHEMA_VERSION = 2`
- `casUpdate(db, table, id, baseRevision, payload, updatedAt)` → `{ok:boolean, current:object|null}`
- `nextSeq(db)` → 全局递增整数（`counters` 表，事务内安全）

- [ ] **Step 1: 写失败测试** `test/db.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.mjs';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('openDb 建立全部新表且可重复打开', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cn-'));
  const p = join(dir, 't.sqlite');
  const db = openDb(p, { dataDir: dir });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['works','notes','revisions','comparisons','trash','imagery','imagery_uses','allusions','allusion_uses','mcp_keys','imports','counters','schema_migrations'])
    assert.ok(tables.includes(t), t);
  db.close();
  const db2 = openDb(p, { dataDir: dir }); // 幂等
  assert.equal(db2.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version=2').get().c, 1);
  db2.close();
});

test('旧 versions 库自动导出 legacy 备份并重建', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cn-'));
  const p = join(dir, 't.sqlite');
  const legacy = new (await import('node:sqlite')).DatabaseSync(p);
  legacy.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);INSERT INTO schema_migrations VALUES(1);CREATE TABLE versions(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL, import_key TEXT UNIQUE);INSERT INTO versions(id,data,created) VALUES('n1','{\"id\":\"n1\",\"title\":\"旧稿\"}','2026-01-01T00:00:00Z')");
  legacy.close();
  const db = openDb(p, { dataDir: dir });
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  assert.ok(!names.includes('versions')); // 旧表已删除
  const bak = join(dir, 'ci-notes-legacy-backup.json');
  assert.ok(existsSync(bak));
  const parsed = JSON.parse(readFileSync(bak, 'utf8'));
  assert.equal(parsed.format, 'ci-notes');
  assert.equal(parsed.versions.length, 1);
  assert.equal(parsed.notes[0].id, 'n1');
  db.close();
});
```

注意：测试文件是 ESM，顶层 `await import` 需放在 async 包装内——把第二条测试改为 `test('...', async () => { const { DatabaseSync } = await import('node:sqlite'); ... })`。

- [ ] **Step 2:** `npm test` 确认新用例 FAIL（模块不存在）。
- [ ] **Step 3: 实现** `server/core/db.mjs`：

```js
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS works(
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '',
  cipai TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'ci', updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_works_updated ON works(updated_at);
CREATE TABLE IF NOT EXISTS notes(
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL DEFAULT '', writing_status TEXT NOT NULL DEFAULT 'idea',
  publish_status TEXT NOT NULL DEFAULT 'unpublished', updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);
CREATE TABLE IF NOT EXISTS revisions(
  id TEXT PRIMARY KEY, note_id TEXT NOT NULL, seq INTEGER NOT NULL,
  snapshot TEXT NOT NULL, change_note TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_revisions_note ON revisions(note_id, seq);
CREATE TABLE IF NOT EXISTS comparisons(
  id TEXT PRIMARY KEY, payload TEXT NOT NULL,
  work_a_id TEXT NOT NULL DEFAULT '', work_b_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trash(
  id TEXT PRIMARY KEY, item_type TEXT NOT NULL, item_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '', snapshot TEXT NOT NULL, trashed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS imagery(
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL DEFAULT '', merged_into TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS imagery_uses(
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  imagery_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_imagery_uses_img ON imagery_uses(imagery_id);
CREATE INDEX IF NOT EXISTS idx_imagery_uses_target ON imagery_uses(target_type, target_id);
CREATE TABLE IF NOT EXISTS allusions(
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS allusion_uses(
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  allusion_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_allusion_uses_al ON allusion_uses(allusion_id);
CREATE INDEX IF NOT EXISTS idx_allusion_uses_target ON allusion_uses(target_type, target_id);
CREATE TABLE IF NOT EXISTS mcp_keys(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
  last_used_at TEXT, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS imports(
  id TEXT PRIMARY KEY, backup_hash TEXT NOT NULL, stats TEXT NOT NULL, imported_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY, value INTEGER NOT NULL);
`;

function hasLegacy(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='versions'").get();
  return !!row;
}

// 旧库导出：沿用旧 store.mjs 的导出格式，保证数据可回读
function exportLegacy(db, dataDir) {
  const rows = db.prepare('SELECT seq,id,data,created FROM versions ORDER BY seq').all();
  const latest = new Map();
  for (const r of rows) latest.set(r.id, JSON.parse(r.data));
  const backup = {
    format: 'ci-notes', version: 1, exportedAt: new Date().toISOString(),
    notes: [...latest.values()], versions: rows,
  };
  mkdirSync(dataDir, { recursive: true });
  const target = join(dataDir, 'ci-notes-legacy-backup.json');
  if (existsSync(target)) throw new Error('legacy 备份已存在，拒绝覆盖：' + target);
  writeFileSync(target, JSON.stringify(backup));
}

export function openDb(dbPath, { dataDir } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)');
  if (hasLegacy(db)) {
    exportLegacy(db, dataDir || dirname(dbPath));
    db.exec('DROP TABLE versions');
    db.prepare('DELETE FROM schema_migrations').run();
  }
  db.exec(DDL);
  db.prepare("INSERT OR IGNORE INTO counters(name,value) VALUES('revision_seq',0)").run();
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version) VALUES(?)').run(SCHEMA_VERSION);
  return db;
}

export function nextSeq(db) {
  db.prepare('UPDATE counters SET value=value+1 WHERE name=?').run('revision_seq');
  return db.prepare('SELECT value FROM counters WHERE name=?').get('revision_seq').value;
}

// 通用 CAS 更新：WHERE id AND revision；未命中返回当前 payload 供冲突提示
export function casUpdate(db, table, id, baseRevision, payload, updatedAt) {
  const r = db.prepare(`UPDATE ${table} SET payload=?, revision=revision+1, updated_at=? WHERE id=? AND revision=?`)
    .run(JSON.stringify(payload), updatedAt, id, baseRevision);
  if (r.changes === 1) return { ok: true, current: null };
  const row = db.prepare(`SELECT payload FROM ${table} WHERE id=?`).get(id);
  return { ok: false, current: row ? JSON.parse(row.payload) : null };
}
```

- [ ] **Step 4:** `npm test`（新用例 PASS；旧 HTTP 用例可能仍 PASS——旧 server 未动）。
- [ ] **Step 5:** `git add -A && git commit -m "feat(server): multi-entity schema v2 with legacy auto-export"`

---

### Task 2: ID 与共享归一化 `server/core/ids.mjs` + `server/core/normalize.mjs` + `server/core/errors.mjs`

**Files:**
- Create: `server/core/ids.mjs`、`server/core/normalize.mjs`、`server/core/errors.mjs`
- Create: `test/normalize.test.mjs`

**Interfaces (Produces):**
- `errors.mjs`: `class StoreError extends Error { code; current }`，构造 `new StoreError(code, message, current?)`
- `ids.mjs`: `newId(prefix)`、`derivedId(prefix, ...parts)`、`digest(str)`（sha256 hex）
- `normalize.mjs`:
  - `normalizeTags(v): string[]`（去空白、去重保序）
  - `normalizeClaims(v): Claim[]`（id 缺省生成 `cl_`；kind∈verified/pending/personal 默认 pending；paragraph 整数 ≥-1 默认 -1；递归 normalizeCitations；**verified 必须自带 citations 至少一条，否则 StoreError('INVALID','已核实的资料需要至少一条出处')**）
  - `normalizeCitations(v): Citation[]`（字段 book/edition/page/url/note/verified 全字符串，verified 默认 'pending'）
  - `normalizeUsages(v): {text, kind}[]`（字符串项 → `{text, kind:'pending'}`）
  - `normalizeAliases(v, name): string[]`（顿号/逗号/空格分隔字符串或数组；去空、去重、剔除与 name 相同项）
  - `sameContent(a, b): boolean`（深比较，忽略 `updatedAt`/`revision` 两键）
  - `excerpt(text, n=60)`、`charCount(text)`（去空白计数）、`plainText(md)`（Markdown 转纯文本：去 #/*/>/\` 标记，供摘要与搜索——完整规则见词间 `utils/util.js` 的 plain 实现，逐行翻译）
  - `excerptOfNote(note)`：content 空则返回 `'（正文待导入）'`，否则 `plainText(content).slice(0,80)`

- [ ] **Step 1: 写失败测试** `test/normalize.test.mjs`（关键断言）：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClaims, normalizeUsages, normalizeAliases, sameContent, excerptOfNote, plainText } from '../server/core/normalize.mjs';
import { newId, derivedId } from '../server/core/ids.mjs';

test('verified claim 无出处报错', () => {
  assert.throws(() => normalizeClaims([{ kind: 'verified', text: 'x' }]), /已核实/);
});
test('claim 归一化补 id 与默认值', () => {
  const [c] = normalizeClaims([{ text: '系年待查', paragraph: 2, citations: [{ book: '全宋词' }] }]);
  assert.equal(c.kind, 'pending'); assert.equal(c.paragraph, 2);
  assert.match(c.id, /^cl_/);
  assert.equal(c.citations[0].verified, 'pending');
});
test('usages 字符串转对象；aliases 剔除主名', () => {
  assert.deepEqual(normalizeUsages(['蟾宫折桂', { text: '折桂', kind: 'verified' }]),
    [{ text: '蟾宫折桂', kind: 'pending' }, { text: '折桂', kind: 'verified' }]);
  assert.deepEqual(normalizeAliases('玉兔、月轮, 月亮 月亮', '月亮'), ['玉兔', '月轮']);
});
test('sameContent 忽略 updatedAt/revision', () => {
  assert.ok(sameContent({ id: 'a', title: 't', updatedAt: '1', revision: 3 }, { id: 'a', title: 't', updatedAt: '9', revision: 8 }));
  assert.ok(!sameContent({ id: 'a', title: 't' }, { id: 'a', title: 'x' }));
});
test('excerptOfNote 与 plainText', () => {
  assert.equal(excerptOfNote({ content: '', pendingImport: true }), '（正文待导入）');
  assert.equal(plainText('## 标题\n**粗**体'), '标题粗体');
});
test('id 生成稳定', () => {
  assert.match(newId('w_'), /^w_[0-9a-f]{12}$/);
  assert.equal(derivedId('w_', 'a', 'b'), derivedId('w_', 'a', 'b'));
  assert.notEqual(derivedId('w_', 'a', 'b'), derivedId('w_', 'a', 'c'));
});
```

- [ ] **Step 2:** `npm test` 确认 FAIL。**Step 3:** 实现（`plainText` 与 `excerptOfNote` 逐行翻译词间 `utils/util.js` 对应函数；`newId` 用 `crypto.randomBytes`+计数器+时间，照词间 `utils/hash.js`/`util.js` 语义）。**Step 4:** `npm test` PASS。**Step 5:** `git commit -m "feat(server): shared ids, normalize rules, store errors"`

---

### Task 3: 词作 `server/core/works.mjs`

**Files:**
- Create: `server/core/works.mjs`、`test/works.test.mjs`

**Interfaces (Produces):**
- `listWorks(db, {q, author, cipai, tag, kind})` → 摘要数组 `{id,title,author,dynasty,cipai,kind,excerpt,firstLine,tags,pendingClaims,noteCount,updatedAt}`（updatedAt 倒序；q 匹配 title/content/author/dynasty/cipai/background/tags/claims 文本/citations 文本——照词间 `workMatchesText`）
- `getWork(db, id)` → `{work, relatedWorks[], linkedNotes[], imagery:{entries:[{imagery,uses}],allusions:{entries:[...]}}}`（work 不存在抛 `StoreError('NOT_FOUND')`；imagery/allusions entries 由 uses 模块提供，Task 6/7 再接入——本 Task 返回 `imagery:{entries:[]}` 空占位并在 Task 7 补装配）
- `createWork(db, input)` → work（校验：title 与 content 至少一项非空，否则 `StoreError('INVALID','至少填写标题或原文')`；kind∈ci|poem 默认 ci；claims/citations/tags/aliases 归一化）
- `updateWork(db, id, input, {baseRevision, force})` → `{work}`；CAS 未命中且 force=false 抛 `StoreError('CONFLICT','这条词作在别处被改过', current)`；force=true 直接覆盖
- `workRowToRecord(row)` → payload 对象（内部）

实现要点（照词间 `store-core.js` 的 works 段）：标量列同步（title/author/cipai/kind/updated_at）；create 用 `BEGIN IMMEDIATE`；`noteCount` 由 `notes.payload->workIds` 聚合（SQL 读 notes 全量过滤即可，数据量小）。

- [ ] **Step 1: 写失败测试** `test/works.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.mjs';
import { createWork, updateWork, listWorks, getWork } from '../server/core/works.mjs';
import { StoreError } from '../server/core/errors.mjs';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';

function setup() { return openDb(join(mkdtempSync(join(tmpdir(), 'cn-')), 't.sqlite')); }

test('创建/读取词作', () => {
  const db = setup();
  const w = createWork(db, { title: '凤栖梧', author: '柳永', cipai: '凤栖梧', content: '伫倚危楼风细细', tags: ['春愁', '春愁'], claims: [{ text: '异文待核' }] });
  assert.match(w.id, /^w_/); assert.deepEqual(w.tags, ['春愁']);
  const detail = getWork(db, w.id);
  assert.equal(detail.work.title, '凤栖梧');
  assert.equal(detail.work.claims.length, 1);
  assert.throws(() => getWork(db, 'w_x'), StoreError);
});

test('空标题与原文拒绝', () => {
  const db = setup();
  assert.throws(() => createWork(db, { title: '  ', content: '' }), /至少填写/);
});

test('CAS 冲突与 force', () => {
  const db = setup();
  const w = createWork(db, { title: 'A', content: 'a' });
  const w2 = updateWork(db, w.id, { ...w, title: 'B' }, { baseRevision: w.revision });
  assert.equal(w2.work.revision, 2);
  assert.throws(() => updateWork(db, w.id, { ...w2.work, title: 'C' }, { baseRevision: w.revision }),
    e => e.code === 'CONFLICT' && e.current.title === 'B');
  const forced = updateWork(db, w.id, { ...w2.work, title: 'C' }, { baseRevision: w.revision, force: true });
  assert.equal(forced.work.title, 'C');
});

test('列表筛选与搜索', () => {
  const db = setup();
  createWork(db, { title: '凤栖梧', author: '柳永', cipai: '凤栖梧', content: '伫倚危楼', tags: ['春愁'] });
  createWork(db, { title: '浣溪沙', author: '周邦彦', kind: 'poem', content: '楼上晴天' });
  assert.equal(listWorks(db, { author: '柳永' }).length, 1);
  assert.equal(listWorks(db, { kind: 'poem' })[0].title, '浣溪沙');
  assert.equal(listWorks(db, { q: '危楼' })[0].title, '凤栖梧');
  assert.equal(listWorks(db, { q: '周邦彦' })[0].title, '浣溪沙');
  assert.equal(listWorks(db, { tag: '春愁' }).length, 1);
});
```

- [ ] **Step 2:** FAIL 确认。**Step 3:** 实现（翻译词间 store-core.js works 段 + 本计划接口）。**Step 4:** PASS。**Step 5:** `git commit -m "feat(server): works CRUD with CAS, search and facets"`

---

### Task 4: 札记与版本 `server/core/notes.mjs`（saveNote 全语义 + revisions + diffcore）

**Files:**
- Create: `server/core/notes.mjs`、`server/core/diffcore.mjs`、`test/notes.test.mjs`

**Interfaces (Produces):**
- `listNotes(db, {q, writingStatus, publishStatus, workId, tag})` → 摘要 `{id,title,excerpt,tags,writingStatus,publishStatus,pendingImport,draftOf,draftNoteId,updatedAt,charCount}`
- `getNote(db, id)` → `{note, linkedWorks:[{work, claimGroups}], imagery/allusion 装配同 works（Task 7 接入）}`，NOT_FOUND 抛错
- `createNote(db, input)` → `{note, revision}`：title 必填非空（`StoreError('INVALID','标题不能为空')`）；自动生成 v1 revision（reason='manual'）
- `saveNote(db, id, input, {baseRevision, force})` → 三种结果：
  1. 正常 → `{note, revision}`
  2. CAS 未命中 force=false → 抛 `StoreError('CONFLICT', '这条札记在别处被改过。可以保留你的版本覆盖，或采用对方的版本。', current)`
  3. **protected（writingStatus==='final' || publishStatus==='published'）→ 不改原稿**：创建派生草稿（新 id；writingStatus='draft'、publishStatus='unpublished'、publish 清空、`draftOf=原id`、changeNote 前缀「基于定稿继续修改」；原稿 `draftNoteId=新id`），返回 `{createdDraft:true, note:原稿(已更新 draftNoteId), draft}`；生成 reason='draft-from-final' 版本
  - force=true 时：**先把服务器当前内容存一条 reason='conflict-overwrite' 的版本**，再覆盖保存
  - 正常保存 reason='manual'，changeNote 取 input.changeNote
- `listRevisions(db, noteId)` → `{id,seq,createdAt,changeNote,reason,charCount,writingStatus}[]`（seq 倒序）
- `compareRevisions(db, noteId, aId, bId)` → `{a:{id,seq,createdAt,changeNote,title}, b:{...}, rows:[{type:'equal'|'delete'|'insert'|'change', a, b, segments}], stats:{added,removed,changed,same}}`（title 与 content 分别 diff，行合并展示——照词间 compareRevisions 输出）
- `restoreRevision(db, noteId, revId)` → `{draft}`：复制为新 note（新 id；draft/unpublished、清 publish、`draftOf=原id`、原稿 `draftNoteId=新id`、changeNote=`由版本「<changeNote 或 v{seq}>」复制为草稿`），生成 reason='restore' 版本
- `unprotectNote(db, id)` → note（final→draft、published→unpublished，就地清保护；生成 manual 版本记录变更）
- `snapshotOf(note)` → 快照对象（字段见规格 4.2 revision）
- `diffcore.mjs`: `diffText(a, b)` → 行级 rows + `charDiff(a, b)` → `[{type,text}]`（**逐行翻译词间 `utils/diff.js`**：LCS Uint32Array、MAX_CELLS 上限退化、delete+insert 合并 change、字级段）

测试需覆盖（全部写完整断言）：创建生成 v1；正常保存版本递增；CONFLICT 附 current；protected 派生草稿（原稿不变、双向指针、状态字段）；force 覆盖前留档 conflict-overwrite；restore 生成独立新草稿；unprotect 就地解除；revisions seq 全局递增且倒序；compare 行/统计正确性（含 change 合并与字级 segments 存在）；revisions 表 UPDATE/DELETE 被触发器阻断（`assert.throws(..., /immutable/)`——**db.mjs 需补触发器**）。

**db.mjs 补充**（本 Task 一并完成）：DDL 追加

```sql
CREATE TRIGGER IF NOT EXISTS preserve_revision_update BEFORE UPDATE ON revisions
BEGIN SELECT RAISE(ABORT,'revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS preserve_revision_delete BEFORE DELETE ON revisions
BEGIN SELECT RAISE(ABORT,'revisions are immutable'); END;
```

- [ ] **Step 1: 写失败测试** `test/notes.test.mjs`（按上述断言清单完整编写；示例核心段）：

```js
test('protected 保存派生草稿', () => {
  const db = setup();
  let { note } = createNote(db, { title: '读柳永', content: '初稿' });
  note = saveNote(db, note.id, { ...note, writingStatus: 'final' }, { baseRevision: note.revision }).note;
  assert.equal(note.writingStatus, 'final');
  const r = saveNote(db, note.id, { ...note, content: '想改' }, { baseRevision: note.revision });
  assert.ok(r.createdDraft);
  assert.equal(r.note.content, '初稿');                 // 原稿一字不动
  assert.equal(r.draft.draftOf, note.id);
  assert.equal(r.draft.writingStatus, 'draft');
  assert.equal(r.draft.publishStatus, 'unpublished');
  assert.equal(getNote(db, note.id).note.draftNoteId, r.draft.id);
});

test('force 覆盖前留档', () => {
  const db = setup();
  let { note } = createNote(db, { title: 'T', content: '服务器版' });
  saveNote(db, note.id, { ...note, content: '客户端版' }, { baseRevision: note.revision, force: true });
  const revs = listRevisions(db, note.id);
  assert.equal(revs[0].reason, 'manual');
  assert.equal(revs[1].reason, 'conflict-overwrite');
  assert.equal(JSON.parse(db.prepare('SELECT snapshot FROM revisions WHERE reason=?').get('conflict-overwrite').snapshot).content, '服务器版');
});

test('compare 两版 diff', () => {
  const db = setup();
  const { note } = createNote(db, { title: 'T', content: '春风又绿江南岸' });
  saveNote(db, note.id, { ...note, content: '春风又绿江南岸，明月何时照我还' }, { baseRevision: note.revision });
  const revs = listRevisions(db, note.id);           // seq 倒序：revs[0] 新，revs[1] 旧
  assert.equal(revs.length, 2);
  const cmp = compareRevisions(db, note.id, revs[1].id, revs[0].id);
  assert.equal(cmp.rows.some(r => r.type === 'insert' || r.type === 'change'), true);
  assert.ok(cmp.stats.added >= 1 || cmp.stats.changed >= 1);
});

test('revisions 物理不可变', () => {
  const db = setup();
  createNote(db, { title: 'T', content: 'x' });
  assert.throws(() => db.exec('DELETE FROM revisions'), /immutable/);
  assert.throws(() => db.exec("UPDATE revisions SET change_note='x'"), /immutable/);
});
```

- [ ] **Step 2:** FAIL。**Step 3:** 实现 `diffcore.mjs`（照词间 `utils/diff.js` 逐函数翻译：`diffLines`、`charDiff`、`MAX_CELLS`、行合并）与 `notes.mjs`（事务包裹：CAS 失败回滚；protected 分支先建草稿再回写原稿 draftNoteId）。**Step 4:** PASS。**Step 5:** `git commit -m "feat(server): notes with version history, draft derivation, force-overwrite archive, line+char diff"`

---

### Task 5: 对照 `server/core/comparisons.mjs`

**Files:**
- Create: `server/core/comparisons.mjs`、`test/comparisons.test.mjs`

**Interfaces (Produces):**
- `COMPARE_DIMENSIONS` = `[['context','人物与情境'],['imagery','意象'],['allusion','典故及出处'],['expression','表达方式'],['similarity','相同点'],['difference','不同点'],['understanding','自己的阅读理解']]`
- `SIDE_DIMENSIONS` = `['context','imagery','allusion','expression']`
- `emptyDimensions()` → 7 维全空（`{text:'',kind:'pending',citations:[],sides:{a:'',b:''}}`，understanding kind 默认 'personal'）
- `listComparisons(db)` → 摘要（含 workATitle/workBTitle，作品已删显示 `'（已删除的词作）'`）
- `getComparison(db, id)` → `{comparison, workA, workB}`（作品缺失为 null）
- `saveComparison(db, input)` → comparison；无 id 新建（校验 workAId/workBId 存在且不同，否则 INVALID）；有 id 整体覆盖（dimensions 重建归一化）
- `deleteComparison(db, id)`（直接删除）

- [ ] **Step 1:** 测试：新建/维度计数/更新整体覆盖/删除/甲乙作品校验（`assert.throws(/同一首/)` 当 a===b）。**Step 2–5:** FAIL → 实现（照词间 store-core comparisons 段）→ PASS → `git commit -m "feat(server): 7-dimension comparisons"`

---

### Task 6: 意象 `server/core/imagery.mjs`

**Files:**
- Create: `server/core/imagery.mjs`、`test/imagery.test.mjs`

**Interfaces (Produces):**
- `listImagery(db, {q, tag, includeMerged})` → `{entries:[{imagery, counts:{works,notes,uses,quotes}}]}`（默认排除 mergedInto 非空；q 匹配 name/aliases/description/note/usages 文本/tags；名称 localeCompare 排序，同名 updatedAt 倒序）
- `imageryIndex(db)` → Map(id→counts)（内部）
- `getImagery(db, id)` → `{imagery, uses:[], works:[{work,uses:[]}], notes:[{note,uses:[]}], counts}`
- `createImagery(db, input)`（name 必填；usages/claims/citations/tags/aliases 归一化）
- `updateImagery(db, id, input, {baseRevision, force})`（**只动通用资料，不碰任何 usage**；CAS 同 works）
- `imageryImpact(db, id)` → `{uses, works, notes, workIds, noteIds}`
- `deleteImagery(db, id)`（连带删全部 uses）
- `mergeImagery(db, fromId, toId)`（from 全部 uses 改挂 to 并各自 revision+1；from 标记 mergedInto=to；自合并报 INVALID）
- `listImageryUses(db, {targetType, targetId})`（targetType∈work|note；校验目标存在，NOT_FOUND）
- `createImageryUse(db, input)`（imageryId 存在、target 存在；**payload 字段名为 `fn`**（不是 `function`——跨计划契约，前端类型用 fn），入参可传 `function` 或 `fn`，归一化到 `fn`；quote/context/understanding 字符串）
- `updateImageryUse(db, id, input, {baseRevision, force})` / `deleteImageryUse(db, id)`
- `compareImagery(db, workAId, workBId)` → `{shared:[{imagery, usesA, usesB}], onlyA:[{imagery, usesA}], onlyB:[...]}`
- 同时：`getWork`/`getNote` 装配 imagery entries（改 works.mjs/notes.mjs 的 detail 组装，调用 imagery.mjs）

测试覆盖：创建/别名归一化/更新不动 uses（先建 use，再 update 通用资料，断言 use 的 updatedAt/revision 不变）/merge 后 uses 挂到 to 且 from 隐藏/impact 计数/uses CRUD 校验目标存在/compare shared-onlyA-onlyB 正确性。

- [ ] **Step 1:** 完整测试（照上述清单）。**Step 2–5:** FAIL → 实现（照词间 `utils/imagery-core.js` 逐函数翻译，把「db 内存对象」改为 SQLite payload 列读写）→ PASS → `git commit -m "feat(server): imagery library with uses, merge, impact, compare"`

---

### Task 7: 典故 `server/core/allusions.mjs`（★新功能，镜像意象）

**Files:**
- Create: `server/core/allusions.mjs`、`test/allusions.test.mjs`

**Interfaces (Produces):** 与 imagery.mjs 完全同构，函数名 `listAllusions/getAllusion/createAllusion/updateAllusion/allusionImpact/deleteAllusion/mergeAllusion/listAllusionUses/createAllusionUse/updateAllusionUse/deleteAllusionUse/compareAllusions`。字段差异：
- allusion payload：`{id, name, aliases[], source, original, explanation, usages[], claims[], citations[], tags[], note, createdAt, updatedAt, revision}`（`source` 出处典籍、`original` 典故原文、`explanation` 通用释义）
- allusionUse payload：`{id, allusionId, targetType, targetId, quote, context, interpretation, understanding, claims[], citations[], createdAt, updatedAt, revision}`
- 校验文案：「释义是通用解释，具体到作品的理解记录在使用条目中」类风格不强制；校验规则同意象（name 必填、自合并 INVALID、目标存在）。

实现方式：**镜像 `server/core/imagery.mjs`**（表名 allusions/allusion_uses、字段如上、`function→interpretation`）。同时改 works.mjs/notes.mjs detail 装配接入 allusions（Task 6 留的空占位补齐：`allusions:{entries:[...]}`）。

- [ ] **Step 1:** 测试（镜像 imagery 测试 + 典故特有字段：source/original/explanation 归一化为字符串、use 的 interpretation 读写）。**Step 2–5:** FAIL → 实现 → PASS → `git commit -m "feat(server): allusion library (two-layer interpretation) mirroring imagery"`

---

### Task 8: 回收站与跨实体删除 `server/core/trash.mjs`

**Files:**
- Create: `server/core/trash.mjs`、`test/trash.test.mjs`

**Interfaces (Produces):**
- `listTrash(db)` → `{id, itemType, itemId, label, preview, trashedAt}[]`（trashedAt 倒序）
- `trashWork(db, id)`：work 快照入 trash → 删 work 行 → **剥除相关札记 workIds 中的该 id**（札记保留）→ 其余引用（relatedWorkIds/comparisons）保留悬空
- `trashNote(db, id)`：note 快照入 trash → 删 note 行 + 该 noteId 全部 revisions
- `restoreTrash(db, trashId)`：按快照重插原表（若同 id 已存在 → 仅删除 trash 项）
- `purgeTrash(db, trashId)`：删除 trash 项；itemType==='note' 时连带 `DELETE FROM revisions WHERE note_id=?`（在删除前先删 revisions——**注意 revisions 有不可变触发器**，purge 前需 `DROP TRIGGER` 临时禁用？不行——正确做法：触发器改为允许特定删除？**采用方案：触发器仅拦 UPDATE 与「无事务标记」的 DELETE**——实现为：db.mjs 给连接设私有标记不可行，SQLite 触发器无法读连接变量。**改为：purgeTrash 中 `DROP TRIGGER preserve_revision_delete; DELETE...; CREATE TRIGGER preserve_revision_delete ...`** 在同一事务内执行，保证原子且其余路径仍受保护。)
- 回收站无「清空全部」入口（不提供该函数）。

- [ ] **Step 1:** 测试：trashWork 后 note.workIds 已剥除且札记还在；trashNote 后 revisions 一并消失（直接查表）；restore 往返（含同 id 已存在分支）；purge note 连带 revisions 且触发器恢复（purge 后再尝试 DELETE 仍抛 immutable）。**Step 2–5:** FAIL → 实现 → PASS → `git commit -m "feat(server): trash with restore and purge (note revisions cascade)"`

---

### Task 9: 统计/搜索/首页 `server/core/stats.mjs`

**Files:**
- Create: `server/core/stats.mjs`、`test/stats.test.mjs`

**Interfaces (Produces):**
- `getHome(db)` → `{stats:{works,notes,revisions,comparisons,imagery,allusions,draft,final,published,pendingImport}, recent:[8×note 摘要]}`
- `globalSearch(db, q)` → `{works:[摘要], notes:[摘要]}`（q 空返回两组空）
- `getStats(db)` → `{counts:{...同上}, facets:{authors, cipais, tags, kinds, writingStatus, publishStatus}}`（collectFacets 语义，去重排序）

- [ ] **Step 1:** 测试：混合数据各计数正确、recent 截 8 条按 updatedAt 倒序、facets 去重。**Step 2–5:** FAIL → 实现 → PASS → `git commit -m "feat(server): home stats, global search, facets"`

---

### Task 10: 备份与合并导入 `server/core/backup.mjs`

**Files:**
- Create: `server/core/backup.mjs`、`test/backup.test.mjs`

**Interfaces (Produces):**
- `buildBackup(db)` → `{format:'ci-notes-backup', formatVersion:2, exportedAt, counts, data:{works, notes, revisions, comparisons, trash, imagery, imageryUses, allusions, allusionUses, links:[{workId,noteId}], tags:[]}}`（tags 全集去重排序；counts 各集合长度 + claims/citations 总数）
- `parseBackup(text)` → `{ok:true, backup}` 或 `{ok:false, error}`（空/非 JSON/体积由调用方先行限制）
- `validateBackup(backup)` → `{ok, errors:[], dangling:[{type,id,ref}]}`（format 必须为 `ci-notes-backup` **或 `cijian-backup`**（词间兼容）；formatVersion ≤ 2；必需集合缺失按空处理（词间 v1 无 imagery/allusions）；每条必须有 id；uses 引用不存在的 imagery/allusion 或 target 记入 dangling）
- `preflightImport(db, backup)` → `{creates:{works,notes,...各集合数}, duplicates:n, conflicts:[{type,id}], dangling}`（sameContent 分类；冲突即同 id 不同内容）
- `mergeImport(db, backup)` → `{created:{...}, skipped, conflictCopies}`：
  - 整体单事务；**不删除/不覆盖任何已有内容**；同 id 同内容跳过；同 id 不同内容 → 备份方存为冲突副本（`derivedId(前缀, backupHash, id, 'conflict')`，payload 附 `conflictOf:id, importedFrom:'backup'`）
  - 引用重映射：revisions.noteId、comparisons.workAId/workBId、notes.workIds、imageryUses.imageryId/targetId、allusionUses 同理、works.relatedWorkIds 全部跟随 idMap（旧 id→新 id，含冲突副本）
  - **定稿/已发布保护**：若目标库已有同 id 且 isProtected，备份方一律存冲突副本（绝不覆盖）
  - 完成后写 `imports` 表一行（backupHash=sha256(原始文本)、stats JSON、时间）
  - 幂等：同一备份重复导入 → 全部按同内容跳过或派生副本 id 稳定（derivedId 确定性），二次导入 duplicates 计数不增长地跳过

- [ ] **Step 1:** 测试：
  1. buildBackup → validate ok；2. 新库 merge → 计数正确 → **再 merge 同一备份 → 全部跳过（幂等）**；3. 同 id 不同内容 → 冲突副本生成且引用重映射正确（构造：备份含 note 引用 work A，A 在目标库为冲突副本，断言副本 note.workIds 指向副本 A）；4. protected 不覆盖（目标库 note 为 final，备份同 id 不同 content → 冲突副本）；5. 词间兼容：构造 `{format:'cijian-backup', formatVersion:2, data:{works:[1条], notes:[], revisions:[], comparisons:[], trash:[]}}` merge 成功；6. validate 对悬空 uses 报 dangling；7. merge 坏数据整体回滚（计数不变）。
- [ ] **Step 2–5:** FAIL → 实现 → PASS → `git commit -m "feat(server): backup v2 with idempotent merge, cijian-backup compatibility"`

---

### Task 11: MCP 密钥 `server/core/mcpkeys.mjs` + store facade `server/store.mjs`

**Files:**
- Create: `server/core/mcpkeys.mjs`、`server/core/seeddata.mjs`（本 Task 仅建桩：`export function seedAll(db) { /* Task 12 填充：空库种子 */ }` 与 `export function isEmpty(db)` 判定 works/notes/imagery/allusions 四表全空）、`test/mcpkeys.test.mjs`
- Create: `server/store.mjs`（替换旧实现——旧 store.mjs 的 import 函数随旧模型废弃）

**Interfaces (Produces):**
- `createMcpKey(db, name)` → `{key:'cin_'+64hex(明文，仅此一次), record}`（record 不含明文；key_hash=sha256(key)；id=`mk_`；prefix=key 前 12 字符）
- `findMcpKey(db, rawKey)` → record 或 null（sha256 查找；仅 status='active' 命中）
- `listMcpKeys(db)` / `revokeMcpKey(db, id)`（置 revoked_at；find 立即失配）/ `enableMcpKey(db, id)`（清 revoked_at）
- `touchMcpKey(db, id)`（last_used_at=now）
- **`server/store.mjs` facade**：`createStore(dbPath, {seed=true})` → 聚合 core/* 全部函数的对象（命名见下「Store 接口总表」），`close()`；`seed=true` 且全部实体表为空时调用 `seedAll(db)`（Task 12 实现，先留空函数抛 NOT_IMPLEMENTED 除外——**本 Task 先接入 Task 12 会填充**：facade 里 `if (seed && isEmpty(db)) seedAll(db)`，`seedAll` 从 `./core/seeddata.mjs` 导入）。

**Store 接口总表**（app.mjs 与 mcp.mjs 唯一入口，命名必须一致）：

```
close()
listWorks(p) getWork(id) createWork(input) updateWork(id, input, opts)
listNotes(p) getNote(id) createNote(input) saveNote(id, input, opts)
listRevisions(noteId) compareRevisions(noteId, a, b) restoreRevision(noteId, revId) unprotectNote(id)
listComparisons() getComparison(id) saveComparison(input) deleteComparison(id)
listImagery(p) getImagery(id) createImagery(input) updateImagery(id, input, opts)
deleteImagery(id) mergeImagery(from, to) imageryImpact(id)
listImageryUses(p) createImageryUse(input) updateImageryUse(id, input, opts) deleteImageryUse(id)
compareImagery(a, b)
listAllusions(p) getAllusion(id) createAllusion(input) updateAllusion(id, input, opts)
deleteAllusion(id) mergeAllusion(from, to) allusionImpact(id)
listAllusionUses(p) createAllusionUse(input) updateAllusionUse(id, input, opts) deleteAllusionUse(id)
compareAllusions(a, b)
listTrash() trashWork(id) trashNote(id) restoreTrash(trashId) purgeTrash(trashId)
getHome() globalSearch(q) getStats()
buildBackup() parseBackup(text) validateBackup(b) preflightImport(b) mergeImport(b)
listMcpKeys() createMcpKey(name) findMcpKey(raw) revokeMcpKey(id) enableMcpKey(id) touchMcpKey(id)
```

- [ ] **Step 1:** mcpkeys 测试（明文仅返回一次、哈希查找、撤销即失配、启用恢复）。**Step 2–5:** FAIL → 实现 mcpkeys + store facade（简单转发）→ PASS → `git commit -m "feat(server): mcp key management + store facade"`

---

### Task 12: 种子数据 `server/core/seeddata.mjs` + `server/seeds.json`

**Files:**
- Create: `server/seeds.json`（重写）、`server/core/seeddata.mjs`
- Modify: 删除 `src/seed.ts`（前端占位——Task 34 一并处理，本 Task 仅后端）

**Interfaces (Produces):** `seedAll(db)`：空库时按 seeds.json 写入（固定 ID 幂等，`INSERT OR IGNORE`）。seeds.json 结构：

```json
{
  "works":  [{ "id": "w_seed_liu_1", "title": "...", "author": "柳永", "dynasty": "宋", "cipai": "凤栖梧", "kind": "ci", "content": "...", "background": "...", "tags": ["..."], "claims": [{"id":"cl_...","kind":"verified","text":"...","paragraph":-1,"citations":[{"id":"ct_...","book":"...","verified":"verified"}]}], "citations": [] }],
  "notes":  [{ "id": "n_seed_liu_notes", "title": "...", "content": "", "note": "", "workIds": ["w_seed_liu_1","w_seed_liu_2","w_seed_liu_3"], "writingStatus": "research", "publishStatus": "unpublished", "pendingImport": true, "changeNote": "初始条目，待导入原稿" }],
  "revisions": [{ "noteId": "n_seed_liu_notes", "reason": "manual", "changeNote": "初始条目，待导入原稿", "snapshot": {} }],
  "comparisons": [{ "id": "cp_seed_liu_zhou", "title": "柳永《凤栖梧》其二 × 周邦彦《浣溪沙》", "workAId": "w_seed_liu_2", "workBId": "w_seed_zhou_1", "dimensions": {} }],
  "imagery":    [{ "id": "im_seed_moon", "name": "月亮", "aliases": ["明月","玉盘","婵娟"], "description": "...", "usages": ["寄托相思","象征团圆与缺憾"], "note": "" }],
  "imageryUses": [],
  "allusions":  [{ "id": "al_seed_zhuangzhou", "name": "庄周梦蝶", "aliases": ["梦蝶","庄生晓梦"], "source": "《庄子·齐物论》", "original": "昔者庄周梦为胡蝶，栩栩然胡蝶也……俄然觉，则蘧蘧然周也。不知周之梦为胡蝶与，胡蝶之梦为周与？", "explanation": "庄子梦见自己化为蝴蝶，醒后分不清是庄周梦蝶还是蝶梦庄周，借以讨论物我界限与人生如梦。后世常用表达虚实难辨、人生如梦的怅惘。", "usages": ["抒发人生如梦之感", "表达物我两忘的境界"], "tags": ["哲思","梦境"], "note": "" }],
  "allusionUses": []
}
```

**内容要求**：
- 词作四首与两篇札记、一条对照：**从词间 `/Users/zhaoyuan/Workbuddy/词间/utils/seed.js` 逐字翻译**（保留固定 ID `w_seed_liu_1/2/3`、`w_seed_zhou_1`、`n_seed_liu_notes`、`n_seed_zhou_notes`、`cp_seed_liu_zhou`、全部原文/背景/claims/citations 文本，出处链接原样保留；claims 保留词间的 verified/pending 混排示范）。
- **不虚构 use 记录**：imageryUses 与 allusionUses 留空（种子文本中无可靠出处依据的引用不编造；意象/典故以纯库条目入库，供用户后续关联）。
- 意象「月亮」与典故「庄周梦蝶」两条按上面给定内容写入（含 aliases/usages/description）。
- revisions：两篇札记各一条 v1（snapshot 为空正文快照，seq 用 `nextSeq(db)`）。
- 空库判定：works/notes/imagery/allusions 四表全空。

- [ ] **Step 1:** 测试 `test/seed.test.mjs`：空库 createStore 后四首词作两篇札记一条对照一意象一典故存在且 ID 固定；`createWork` 加一条后重新 createStore（seed=true）不重复；快照/seq 正确。
- [ ] **Step 2–5:** FAIL → 实现（从词间 seed.js 翻译文本）→ PASS → `git commit -m "feat(server): seed data from cijian + moon imagery + Zhuangzi butterfly allusion"`

---

### Task 13: HTTP API 路由 `server/app.mjs` 重写

**Files:**
- Modify: `server/app.mjs`（保留：安全头、会话 HMAC、login/logout、防爆破、跨站检查、静态服务、body 读取；替换：/api 业务路由）
- Create: `test/http.test.mjs`（替换旧 `test/app.test.mjs`——删除旧文件）

**Interfaces (Consumes):** `createStore(...)`（Task 11 接口总表）；`StoreError`。
**Produces:** `createApp({dbPath, dataDir, username, password, sessionSecret?})` → `{server, store}`（测试用；现有导出签名若不同则以本签名重写 `server/index.mjs` 相应调用）。

**路由表**（全部 `/api/*` 需会话，除 health/login/logout；错误映射：StoreError.code NOT_FOUND→404、INVALID→400、CONFLICT→409 附 current、其他→400）：

```
GET    /api/health
POST   /api/login                    POST /api/logout
GET    /api/works?q&author&cipai&tag&kind          POST /api/works
GET    /api/works/:id                 PUT /api/works/:id      DELETE /api/works/:id
GET    /api/notes?q&writingStatus&publishStatus&workId&tag    POST /api/notes
GET    /api/notes/:id                 PUT /api/notes/:id      DELETE /api/notes/:id
GET    /api/notes/:id/revisions
GET    /api/notes/:id/revisions/compare?a&b
POST   /api/notes/:id/revisions/:rid/restore
POST   /api/notes/:id/unprotect
GET    /api/comparisons               POST /api/comparisons   (save 兼创建)
GET    /api/comparisons/:id           PUT /api/comparisons/:id  DELETE /api/comparisons/:id
GET    /api/imagery?q&tag&includeMerged   POST /api/imagery
GET    /api/imagery/:id               PUT /api/imagery/:id    DELETE /api/imagery/:id
POST   /api/imagery/:id/merge         {intoId}
GET    /api/imagery/:id/impact
GET    /api/imagery-uses?targetType&targetId   POST /api/imagery-uses
PUT    /api/imagery-uses/:id          DELETE /api/imagery-uses/:id
GET    /api/imagery/compare?a&b
GET    /api/allusions...              （与 imagery 完全对称，含 /merge /impact /compare、/allusion-uses）
GET    /api/home                      GET /api/search?q       GET /api/stats
GET    /api/export                    POST /api/import        {mode:'preflight'|'merge', backup}
GET    /api/trash                     POST /api/trash/:id/restore   DELETE /api/trash/:id
GET    /api/mcp-keys                  POST /api/mcp-keys      {name}  → 201 {key, record}
POST   /api/mcp-keys/:id/revoke       POST /api/mcp-keys/:id/enable
```

实现要点：
- 路由用 `[{method, pattern:/^\/api\/works\/([^/]+)$/, handler}]` 顺序匹配；`:id` 从捕获组取。
- body 上限：普通写 220KB、import 8MB、login 4KB（沿用现有 readBody 上限参数化）。
- PUT body 约定：`{...(payload 字段), baseRevision, force?}`——handler 拆出 baseRevision/force 后透传 store。
- POST /api/import：preflight 模式返回 preflight 结果不落库；merge 模式执行 mergeImport。
- POST /api/notes/:id（即 PUT /api/notes/:id）响应：createdDraft 时 200 `{createdDraft:true, note, draft}`；正常 200 `{note, revision}`；409 附 current。
- DELETE /api/works/:id 与 /api/notes/:id → trashWork/trashNote，返回 `{trashed:true}`。
- `/api/export` 带 `Content-Disposition: attachment; filename="ci-notes-backup.json"`。
- 静态服务与安全头不动。`server/index.mjs` 适配新 createStore 签名（`createApp` 内部建 store）。

- [ ] **Step 1: 写失败测试** `test/http.test.mjs`（用 createApp 临时库 + fetch；沿用旧测试的登录/Cookie 模式）：

```js
// 关键用例清单（全部实现为独立 test()）：
// 1 health 200；未登录 /api/works 401；错密码 401（且耗时≥800ms 可略）
// 2 登录 → POST /api/works 201 → GET 列表含之 → PUT baseRevision 过期 409 且 body.current.title 正确 → force PUT 成功
// 3 notes：POST 201（返回 revision）→ PUT 正常 → protected 流程：置 final 后 PUT 返回 createdDraft:true、GET 原 id 内容不变、draft.draftOf=id
// 4 revisions：GET 列表 ≥2 → compare?a&b 返回 stats → restore 201 返回新草稿
// 5 imagery：POST → POST uses(targetType=work) → GET /api/imagery/:id 含 uses → GET compare?a&b
// 6 allusions：同 5 对称（含 interpretation 字段往返）
// 7 trash：DELETE work → GET /api/trash 含项 → restore → 列表空
// 8 import：export GET 得备份 → POST import preflight 返回 creates 计数 → merge 幂等二次导入 duplicates 命中
// 9 mcp-keys：POST 201 返回 key（cin_ 前缀）→ 列表含记录且无明文 → revoke → 用该 key 调 /mcp 得 401
// 10 跨站/Content-Type/体积上限沿用旧断言（伪造 Origin 403、错误 CT 415、超限 413）
```

- [ ] **Step 2:** FAIL（旧 app.mjs 路由不存在这些端点）。**Step 3:** 实现新路由表（保留会话/静态代码）。**Step 4:** `npm test` 全绿（删除旧 app.test.mjs 后）。**Step 5:** `git commit -m "feat(server): REST API for works/notes/revisions/comparisons/imagery/allusions/trash/import/mcp-keys"`

---

### Task 14: MCP 端点 `server/mcp.mjs`（协议 + 32 工具）

**Files:**
- Create: `server/mcp.mjs`、`test/mcp.test.mjs`
- Modify: `server/app.mjs`（挂载 `/mcp` 路由：`handleMcp(req, res, store, body)`）

**Interfaces (Produces):**
- `handleMcp(req, res, store, rawBody)` → 处理一次 JSON-RPC 调用
- 鉴权（在 handleMcp 内部先于协议处理）：`x-cinotes-key` 头或 `Authorization: Bearer`（跳过 `eyJ` 开头 JWT）→ `store.findMcpKey`；无/无效 → HTTP 401 `{jsonrpc,error:{code:-32001,message:'未提供有效密钥'}}`（INVALID_KEY 附 keyLen/keyHead/keyTail 诊断，不回显完整密钥）；命中后 `touchMcpKey`
- Origin 校验：有 Origin 头且 host 不在 `req.headers.host` 白名单 → 403；无 Origin（命令行）放行
- `MCP-Protocol-Version` 头存在且不在允许集 → 400
- 协议方法：`initialize`（serverInfo `{name:'ci-notes', title:'词间笔记', version:'1.0.0'}` + instructions：不代写正文、定稿不能就地改、典故释义是通用解释等）、`tools/list`（32 个，带 `readOnlyHint`）、`tools/call`、`ping`、`resources/list`(空)、`prompts/list`(空)；未知方法 -32601；未知工具 -32602；传输：POST JSON（Accept 含 text/event-stream 时以 SSE 单消息响应）、GET → SSE 心跳流、DELETE → 204；body ≤4MB

**32 工具注册表**（name → store 调用；输入 schema 从简但完整）：

| 工具 | 参数 | 实现 |
| --- | --- | --- |
| list_works | q,author,cipai,tag,kind | store.listWorks |
| get_work | id | store.getWork |
| create_work | title* + 其余字段/claims/citations | store.createWork |
| update_work | id*, baseRevision*, force?, 字段 | store.updateWork |
| delete_work | id* | store.trashWork |
| list_notes | q,writingStatus,publishStatus,workId,tag | store.listNotes |
| get_note | id* | store.getNote |
| create_note | title*（描述强调「正文写用户自己的文字，不要代写」） | store.createNote |
| update_note | id*, baseRevision*, force?, 字段 | store.saveNote（createdDraft 时在返回文本说明新旧 ID） |
| delete_note | id* | store.trashNote |
| list_revisions | noteId* | store.listRevisions |
| compare_revisions | noteId*, a*, b* | store.compareRevisions |
| restore_revision | noteId*, revisionId* | store.restoreRevision |
| list_comparisons | — | store.listComparisons |
| save_comparison | title?, workAId, workBId, dimensions? 或 id* | store.saveComparison |
| list_imagery | q,tag | store.listImagery |
| get_imagery | id* | store.getImagery |
| create_imagery | name*（描述强调「不要给意象定死含义」） | store.createImagery |
| update_imagery | id*, baseRevision*, 字段（返回文案注明「作品里的具体解读未受影响」） | store.updateImagery |
| link_imagery | imageryId*, targetType*, targetId*, quote,context,function,understanding（入参 `function` 映射到 payload 字段 `fn`，见 Task 6 契约） | store.createImageryUse |
| list_imagery_of | targetType*, targetId* | store.listImageryUses |
| compare_imagery | workAId*, workBId* | store.compareImagery |
| list_allusions | q,tag | store.listAllusions |
| get_allusion | id* | store.getAllusion |
| create_allusion | name*, source?, original?, explanation?（描述强调「释义是通用解释，具体理解记在 link_allusion」） | store.createAllusion |
| update_allusion | id*, baseRevision*, 字段 | store.updateAllusion |
| delete_allusion | id* | store.trash? → **直接 deleteAllusion（先 impact 返回文本提示）**：实现为先 allusionImpact 拼入返回文本再删除 |
| link_allusion | allusionId*, targetType*, targetId*, quote,context,interpretation,understanding | store.createAllusionUse |
| list_allusions_of | targetType*, targetId* | store.listAllusionUses |
| compare_allusions | workAId*, workBId* | store.compareAllusions |
| search | q* | store.globalSearch |
| get_stats | — | store.getStats |
| export_backup | — | store.buildBackup（返回 JSON 文本） |

（34 个：works5 notes5 versions3 comparisons2 imagery8 allusions8 other3。）
- `delete_imagery`：同 delete_allusion 模式（impact 提示后删除）。
- 工具返回统一 `{content:[{type:'text', text:…}], isError?}`；对象结果 JSON.stringify(text, null, 2)；StoreError → isError:true + code/message；CONFLICT → 文本含「把两版都读给用户听，由用户决定，不要自己挑一个覆盖」+ current JSON。

- [ ] **Step 1: 写失败测试** `test/mcp.test.mjs`（直接调 handleMcp 或经 createApp fetch /mcp）：
  1. 无密钥 → 401/-32001；伪密钥 → 401 带诊断；撤销后原密钥 401
  2. initialize → serverInfo.name==='ci-notes'；tools/list → 32 个且含 list_allusions/compare_allusions；未知工具 -32602；ping → {}
  3. tools/call create_work → GET list_works 可见；update_work 传错 baseRevision → isError + CONFLICT 文案含「不要自己挑一个覆盖」
  4. create_note 正文工具描述含「不要代写」；update_note 对 final 札记返回文本含新旧草稿说明
  5. link_allusion + list_allusions_of + compare_allusions 往返
  6. export_backup 返回文本 JSON.parse 后 format==='ci-notes-backup'
- [ ] **Step 2:** FAIL。**Step 3:** 实现（JSON-RPC 解析、密钥鉴权、32 工具分发；SSE 响应可简化为单消息 event: message data: <json> 后关闭）。**Step 4:** `npm test` 全绿。**Step 5:** `git commit -m "feat(server): MCP endpoint with 32 tools and key auth"`

---

### Task 15: 容器冒烟与脚本清理

**Files:**
- Modify: `scripts/test-container.sh`（扩展断言）
- Delete: `scripts/import.mjs`；Modify: `package.json`（移除 `import` script；`backup` 保留——schema 无关）
- Modify: `server/index.mjs`（适配 createApp 新签名；SIGTERM 优雅关闭保留）

- [ ] **Step 1:** 扩展 `scripts/test-container.sh`：登录 → 创建词作 → 创建札记（关联词作）→ 创建意象 + link → 创建典故 + link → 生成 MCP 密钥 → 用密钥 tools/call `list_works` 断言 200 → `docker restart` → 重新登录断言词作/札记/意象/典故仍在。
- [ ] **Step 2:** 本地跑 `bash scripts/test-container.sh` PASS（需 Docker；输出每步结果）。
- [ ] **Step 3:** `git commit -m "test: extend container smoke to entities, links, mcp; drop legacy import script"`

---

### Task 16: Plan 1 收尾验证

- [ ] **Step 1:** `npm test` 全绿（db/normalize/works/notes/comparisons/imagery/allusions/trash/stats/backup/mcpkeys/seed/http/mcp 全部测试文件）。**Step 2:** `npm run build`（前端未动应仍绿）。**Step 3:** `docker build -t ci-notes:plan1 .` 成功。**Step 4:** `git log --oneline` 确认 15 个提交整洁。无遗漏则 Plan 1 完成，进入 Plan 2。

---

## Plan 1 规格差异说明

- `imports` 表为规格 §8「imports 日志」的落地（规格 §4.1 十张表之外的实现补充）。
- `delete_allusion`/`delete_imagery` 的 MCP 工具在删除前附 impact 提示文本（规格未细述，按词间语义补充）。
- SSE GET 心跳简化为 25s comment 心跳（照词间）；POST SSE 响应为单消息后关闭（无状态服务器不需要长连推流）。
