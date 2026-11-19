# ci-notes 功能对齐词间 + 典故解释功能 · 设计文档

日期：2026-11-19
状态：已与用户逐节确认（架构/数据模型、API/MCP、前端/备份/测试三节均获确认）

## 1. 背景与目标

ci-notes 是单用户自托管的古典诗词写作空间（React 19 + TypeScript + Vite 前端、Node 24 原生 http + node:sqlite 零 npm 运行时依赖后端、Docker 部署、GitHub Actions CI）。当前功能有限：仅一张 `versions` 追加表、扁平字段札记、四个视图。

词间（/Users/zhaoyuan/Workbuddy/词间）是同领域功能完整的参考项目，包含：词作、札记（版本历史与 diff）、七维对照、意象系统、回收站、三级可信度标注（claims/citations）、Markdown 渲染、定稿保护派生草稿、备份合并导入、MCP 智能体接入。

**目标**：在 ci-notes 现有技术栈上重写词间的全部领域功能（方案 A），并新增「典故解释」功能——完整典故库系统。

## 2. 范围决策（已确认）

| 决策点 | 结论 |
| --- | --- |
| 实现方案 | 方案 A：ci-notes 栈上重写词间领域模型与视图 |
| 新功能 | 典故解释 = 完整典故库系统（典故库实体 + 作品/札记中的使用记录，两层解释） |
| 平台层 | 保持单用户自托管；**不搬** WorkBuddy 云同步、IndexedDB 本机模式、多用户 OTP 注册 |
| MCP | 实现（本地密钥鉴权，照词间协议语义） |
| 旧数据 | 不迁移；用词间种子数据初始化 |

**明确不做**（out of scope）：多用户与账号注册、云端同步、本机 IndexedDB 存储模式、邮箱/手机号 OTP、忘记密码流程、微信小程序 legacy。

## 3. 总体架构

| 层 | 现状 | 改造后 |
| --- | --- | --- |
| 前端 | React 19 + TS 单文件 App.tsx（28 行） | 拆分为 `src/views/*` 多视图 + 自写哈希路由 hook（约 50 行，不引 react-router），沿用米白纸感样式体系 |
| 后端 | Node 原生 http + node:sqlite，零 npm 运行时依赖 | 保持零依赖；`server/store.mjs` 重写为多表模型；新增 `server/mcp.mjs`（MCP 端点） |
| 认证 | 单用户 APP_USERNAME/APP_PASSWORD + HMAC 会话 Cookie（sha256 摘要、timingSafeEqual、失败延迟 800ms、登出水印） | 不变；新增 MCP 密钥鉴权（独立通道） |
| 部署 | Docker 多阶段构建（非 root、HEALTHCHECK）+ compose 强化 + CI | 结构不变，冒烟测试扩展 |

**核心语义照搬词间**：revision 乐观锁（六类实体 CAS 更新）；仅札记有不可变历史版本；定稿/已发布札记修改自动派生新草稿（`draftOf`/`draftNoteId` 双向指针）；删除进回收站；对照笔记不进回收站、无历史。

## 4. 数据模型

### 4.1 SQLite 表（10 张）

```sql
schema_migrations(version INTEGER PRIMARY KEY)

works(id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL)
notes(id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL)
revisions(id TEXT PRIMARY KEY, note_id TEXT NOT NULL, seq INTEGER NOT NULL,
          snapshot TEXT NOT NULL, change_note TEXT, reason TEXT NOT NULL,
          created_at TEXT NOT NULL)
-- seq 为全局递增序号（跨札记共享计数器，用独立计数表或 AUTOINCREMENT 实现），
-- 保证同一毫秒连续保存的时间排序可靠（照词间语义）
comparisons(id TEXT PRIMARY KEY, payload TEXT NOT NULL,
            work_a_id TEXT, work_b_id TEXT, updated_at TEXT NOT NULL)
trash(id TEXT PRIMARY KEY, item_type TEXT NOT NULL, item_id TEXT NOT NULL,
      label TEXT, snapshot TEXT NOT NULL, trashed_at TEXT NOT NULL)
imagery(id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL,
        name TEXT NOT NULL, merged_into TEXT DEFAULT '', updated_at TEXT NOT NULL)
imagery_uses(id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL,
             imagery_id TEXT NOT NULL, target_type TEXT NOT NULL,
             target_id TEXT NOT NULL, updated_at TEXT NOT NULL)
allusions(id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL,
          name TEXT NOT NULL, updated_at TEXT NOT NULL)
allusion_uses(id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL,
              allusion_id TEXT NOT NULL, target_type TEXT NOT NULL,
              target_id TEXT NOT NULL, updated_at TEXT NOT NULL)
mcp_keys(id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
         prefix TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
         created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT)
```

- 标量冗余列（name/author 等高频筛选项从 payload 提取入列）供索引与 CAS 更新：`UPDATE … SET payload=?, revision=revision+1 WHERE id=? AND revision=?`。
- `revisions` 表建 UPDATE/DELETE 触发器 `RAISE(ABORT)` 保证历史版本物理不可变（沿用 ci-notes 现有手法）。
- PRAGMA：`journal_mode=WAL`、`synchronous=FULL`、`foreign_keys=ON`、busy timeout 5000ms；写操作 `BEGIN IMMEDIATE` 显式事务。
- **旧库处理**：现有部署的库含旧 `versions` 表数据。迁移策略：启动检测到旧 schema（存在 `versions` 表且无新表）时，先把旧数据导出为 `ci-notes-legacy-backup.json` 存入数据目录（含全部历史版本），再按新 schema 重建并写入种子；不做字段级自动迁移（用户已确认放弃迁移）。
- ID 约定沿用词间前缀：work=`w_`、note=`n_`、revision=`rv_`、comparison=`cp_`、trash=`t_`、claim=`cl_`、citation=`ct_`、imagery=`im_`、imageryUse=`iu_`、allusion=`al_`、allusionUse=`au_`、mcpKey=`mk_`。生成方式：前缀 + sha256(时间+计数器+随机) 前 12 位；冲突副本用 `derivedId(prefix, backupHash+id+后缀)` 保证导入幂等。

### 4.2 实体字段（payload JSON）

**work（词作）**：`id, kind('ci'|'poem'), title, author, dynasty, cipai(可空), content(原文，换行原样保留), background(Markdown), claims[], citations[], tags[], relatedWorkIds[], createdAt, updatedAt, revision`

**note（札记）**：`id, title, content(正文 Markdown), note(附记 Markdown), workIds[], claims[], citations[], tags[], writingStatus('idea'|'research'|'draft'|'final'), publishStatus('unpublished'|'pending'|'published'), publish{platform, publishedAt, url}(纯登记), changeNote, pendingImport, draftOf, draftNoteId, createdAt, updatedAt, revision`
- 写作状态与发布状态互相独立。`isProtected = writingStatus==='final' || publishStatus==='published'`。

**claim**：`{id, kind('verified'|'pending'|'personal'), text, paragraph(-1=不挂段落), citations[], createdAt, updatedAt}`。`paragraph` 与 Markdown 空行分段严格绑定。
**citation**：`{id, book, edition, page, url, note, verified}`。verified 级 claim 必须带 book/edition/page/url 之一（编辑器强制校验）。

**revision（札记版本）**：`{id, noteId, seq, snapshot{title, content, note, workIds, claims, citations, tags, writingStatus, publishStatus, publish, changeNote, pendingImport}, changeNote, reason('manual'|'draft-from-final'|'restore'|'conflict-overwrite'), createdAt}`。

**comparison（对照）**：`{id, title, workAId, workBId, dimensions{7}, createdAt, updatedAt}`
- 7 维度 key：`context 人物与情境 / imagery 意象 / allusion 典故及出处 / expression 表达方式 / similarity 相同点 / difference 不同点 / understanding 自己的阅读理解`。
- 每维：`{text(总结 Markdown), kind, citations[], sides{a,b}}`；前 4 维有 sides，后 3 维只有 text。

**imagery（意象）**：`{id, name, aliases[](去重、不含主名), description(Markdown), usages[{text, kind}], claims[], citations[], tags[], note(Markdown), mergedInto(空串=未合并), createdAt, updatedAt, revision}`
**imageryUse**：`{id, imageryId, targetType('work'|'note'), targetId, quote(不解析逐字保留), context, function, understanding, claims[], citations[], createdAt, updatedAt, revision}`
- 设计原则：意象≠主题标签；通用资料与具体使用严格分离；改通用资料不碰 usage；同一意象同一作品可多条使用记录。

**allusion（典故）★新增**：`{id, name, aliases[], source(出处典籍，如《庄子·齐物论》), original(典故原文), explanation(典故释义：通用层——这个典故讲什么、通常表达什么), usages[{text, kind}], claims[], citations[], tags[], note(Markdown 阅读札记), mergedInto(被合并后指向目标典故 ID；空串=未合并；仅存 payload 无标量列), createdAt, updatedAt, revision}`
**allusionUse（典故使用）★新增**：`{id, allusionId, targetType('work'|'note'), targetId, quote(对应词句，逐字保留), context(该处情境), interpretation(此处解释：具体层——在该作品中指什么), understanding(我的理解), claims[], citations[], createdAt, updatedAt, revision}`
- 典故解释分两层：库内通用 `explanation` + 每处使用的 `interpretation`，与意象系统「通用资料/具体使用」分离原则一致。结构完全镜像意象系统（列表/详情/合并/影响计算/对照衔接）。

## 5. 后端 API

统一错误格式 `{error:{code, message, current?}}`。除 health/login 外全部需会话（Cookie）或 MCP 密钥。沿用现有安全机制：CSP、nosniff、X-Frame-Options、跨站检查（Sec-Fetch-Site + Origin 校验）、JSON Content-Type 校验 415、body 上限 413。

```
POST /api/login | POST /api/logout | GET /api/health（公开，沿用现有）

/api/works    GET ?q&author&cipai&tag&kind（列表，updatedAt 倒序）
              POST | GET /:id（详情：关联札记、意象/典故使用、claims 分组）
              PUT /:id {baseRevision, …}（CAS；409 附 current）
              DELETE /:id（进回收站；自动解除相关札记 workIds 关联）

/api/notes    GET ?q&writingStatus&publishStatus&workId&tag
              POST | GET /:id | PUT /:id | DELETE /:id
              PUT 语义 = saveNote：新建生成 v1；CAS 冲突 409 附 current；
              protected → 不改原稿，创建派生草稿（draft/unpublished、清空 publish、
              draftOf/draftNoteId 双向指针），返回 {createdDraft, note, draft}
              force=true 覆盖前先把对方当前内容存 conflict-overwrite 版本
              GET /:id/revisions（seq 倒序列表）
              GET /:id/revisions/compare?a&b（行级+字级 diff + 统计）
              POST /:id/revisions/:rid/restore（复制为独立新草稿）

/api/comparisons  GET（可 ?workA&workB 查重）| POST | GET /:id | PUT /:id | DELETE /:id
                  （直接删除，不进回收站）

/api/imagery      GET ?q&tag（含索引计数）| POST | GET /:id（详情+uses+counts）
                  PUT /:id（只动通用资料，不碰 usage）| DELETE /:id（先 impact 校验）
                  POST /:id/merge {intoId}
/api/imagery-uses GET ?targetType&targetId | POST | PUT /:id | DELETE /:id
                  （POST 校验 imageryId/targetId 存在；CAS 更新）
GET /api/imagery/compare?a&b（共同/各自意象 + 双方 uses）

/api/allusions    结构与 imagery 完全一致（列表/详情/CRUD/merge/uses/compare）
                  GET /api/allusions/compare?a&b（两作品共同/各自典故）★新增

GET  /api/home   统计 + 最近 8 条札记
GET  /api/search?q=    全局搜索（词作+札记）
GET  /api/stats        计数 + authors/cipais/tags/kinds facets
GET  /api/export       完整备份 JSON（attachment 下载）
POST /api/import       {mode:'preflight'|'merge', backup}
GET  /api/trash | POST /api/trash/:id/restore | DELETE /api/trash/:id
                      （永久删除：札记连带删其全部 revisions；无「清空全部」入口）

/api/mcp-keys    GET 列表 | POST（生成，明文仅返回一次）
                 POST /:id/revoke | POST /:id/enable
```

## 6. MCP 端点（/mcp）

- **传输**：Streamable HTTP（照词间语义）：POST JSON-RPC（Accept 协商 JSON/SSE）+ GET SSE（心跳）+ DELETE 204；请求体 4MB 上限；`MCP-Protocol-Version` 头校验（400）；Origin 白名单校验（无 Origin 的命令行客户端放行）。
- **鉴权**：`X-CiNotes-Key` 头优先、`Authorization: Bearer` 兜底（忽略 `eyJ` 开头的 JWT）；密钥 `cin_` + 64 hex（Web Crypto 随机）；库中只存 SHA-256；INVALID_KEY 返回 401 带诊断信息（keyLen/keyHead/keyTail，不泄露密钥）；撤销即时生效（每次查询 status）；每次调用刷新 `last_used_at`。
- **无状态**：每次调用直接事务读写 SQLite（与词间「pull 整库→改→写回」不同——服务器本就在库旁，直接读写更简单可靠；业务规则不变）。
- **协议方法**：initialize（serverInfo `{name:'ci-notes', version}` + instructions，沿用词间写作原则文案：不代写正文、不把怀念都解释成遗憾、定稿不能就地改）、tools/list（带 readOnlyHint）、tools/call、ping、resources/list（空）、prompts/list（空）；未知工具 -32602、未知方法 -32601。
- **工具清单（34 个；2026-11-20 修订：初版计数 32 为笔误——意象侧漏计 delete_imagery，实现按意象/典故对称各 8 个工具采纳 34）**：

| 类别 | 工具 |
| --- | --- |
| 词作 | list_works, get_work, create_work, update_work, delete_work |
| 札记 | list_notes, get_note, create_note, update_note, delete_note |
| 版本 | list_revisions, compare_revisions, restore_revision |
| 对照 | list_comparisons, save_comparison |
| 意象 | list_imagery, get_imagery, create_imagery, update_imagery, delete_imagery, link_imagery, list_imagery_of, compare_imagery |
| 典故★ | list_allusions, get_allusion, create_allusion, update_allusion, link_allusion, list_allusions_of, compare_allusions |
| 其他 | search, get_stats, export_backup |

- 工具描述沿用词间文案原则（如 create_note 强调「正文写用户自己的文字，不要代写」、create_imagery 强调「不要给意象定死含义」）；典故工具相应强调「释义是通用解释，具体到作品的理解记在 link_allusion」。
- 冲突协议：CONFLICT 错误文本明确指示「把两版都读给用户听，由用户决定，不要自己挑一个覆盖」。
- delete_note/delete_work 移入回收站（可恢复）。

## 7. 前端

### 7.1 路由与文件结构

自写 `useHashRoute` hook（哈希路由，支持 `:param` 与 `?query`），路由表：

```
#/                     书架
#/login                登录（独立界面，不渲染菜单 DOM）
#/works[/new|/:id|/:id/edit]
#/notes[/new|/:id|/:id/edit|/:id/history|/:id/history/:a/:b]
#/compare[/new|/:id]
#/imagery[/new|/:id|/:id/edit]
#/allusions[/new|/:id|/:id/edit]      ★ 典故
#/me  #/me/trash  #/me/mcp-keys
```

文件拆分：`src/router.ts`、`src/api.ts`（fetch 封装 + 错误处理）、`src/markdown.ts`、`src/diff.ts`、`src/exporter.ts`、`src/types.ts`、`src/seed.ts`（登录前占位与新建模板）、`src/components/*`（claimsEditor、citationsEditor、imagerySection、allusionSection、markdown 渲染、chips/badges、modal/toast/confirm/choose 对话框、statusSwitcher）、`src/views/*`（home、login、works、workDetail、workEdit、notes、noteDetail、noteEdit、history、historyCompare、compare、comparePick、compareDetail、imagery、imageryDetail、imageryEdit、allusions、allusionDetail、allusionEdit、me、trash、mcpKeys）。现有 28 行 App.tsx 重构为路由外壳（登录态决定外壳 DOM、抽屉、错误边界）。

### 7.2 各视图功能（照词间语义）

- **书架**：统计卡（词作/札记/版本/对照/意象/典故计数）、快捷入口（写札记/收词作/作对照）、最近 8 条札记（Markdown 转纯文本摘要 80 字 + 状态 chips + 相对时间）、写作偏好提示卡。
- **词作列表**：防抖搜索（标题/原文/作者/朝代/词牌/背景/标签/claims/citations）+ 四筛选（作者/词牌/主题/体裁，facets 动态聚合）+ 卡片（体裁角标、衬线原文预览 48 字、待核实 claim 数、关联札记数）。
- **词作详情**：编辑/加入对照/导出 Markdown/移入回收站；原文纯文本逐字展示（不解析）；背景 Markdown；claims 按 verified/pending/personal 三组；citations；相关作品；关联札记；意象 section；**典故 section**★。
- **词作编辑**：字段表单 + 标签输入（回车添加点删）+ claims/citations 编辑器 + 相关作品多选 + 700ms 防抖 localStorage 草稿暂存（自动恢复提示）+ 冲突确认覆盖流程。
- **札记列表**：搜索 + 写作/发布状态双筛选 + 卡片。
- **札记阅读**：编辑/版本历史/导出 Markdown/复制内容/撤销定稿（protected 时）/移入回收站；状态 chips（含待导入/有续稿）；Markdown 正文 + **段落级标注**（段落组挂 claims chips，点击弹窗）；关联原文卡；claims/citations 分组；发布记录；意象 section；**典故 section**★。
- **札记编辑**：关联作品多选 + 正文大 textarea（字号按钮 + Markdown 预览切换 + 用法提示）+ 附记 + claims/citations 编辑器 + 状态 switcher（发布非未发布时展开平台/时间/链接）+ 修改说明 + 「写之前看一眼」自检清单（不持久化）+ 草稿暂存；保存冲突弹**三选一对话框**（保留我的 force/采用对方的回填/先不处理）；protected 走派生草稿流程并弹「去看新草稿/留在原篇」。
- **版本历史**：seq 倒序 `v{n}` 列表（修改说明、reason 中文标签、字数）；选两版比较；导出这一版；复制为新草稿；行内看内容。
- **版本对比**：旧/新头部 + 统计 chips（增/删/改/未变）+ 行级 diff（change 行含字级高亮段）。
- **对照**：列表（维度已写计数）；选两首（点选 2 首，`?a=` 预选）；详情 = 已记录意象块（共同并排/各自分列）+ **已记录典故块**★（同构）+ 原文对照双卡 + 7 维度卡（前 4 维甲乙两侧 textarea，全部维度总结 + 可信度 + citations，逐卡编辑整体保存）+ 删除。
- **意象**：列表（搜索/标签筛选、被合并的默认隐藏、索引计数）；详情（通用资料 + uses 列表含编辑/删除 + 关联作品筛选 + 合并入/合并出）；编辑（名称必填、别名顿号逗号空格分隔、usages 一行一种）。
- **典故★**：与意象完全同构的列表/详情/编辑 + 字段差异（source 出处典籍、original 典故原文、explanation 释义）；详情页 uses 显示 quote/context/interpretation/understanding。
- **我的**：账号信息、阅读字号 7 档、数据统计卡 + 回收站入口、导出全部数据（下载，显示 KB）、导入（选文件/粘贴 → preflight → 确认明细 → merge → 结果弹窗）、MCP 密钥入口、写作偏好卡。
- **回收站**：列表卡（类型 chip、删除时间、预览 120 字）、恢复（同 ID 已存在则只清回收站项）、永久删除（确认说明札记连带删版本；无清空全部）。
- **MCP 密钥**：生成（明文只显示一次：复制/我已保存）、列表卡（状态/前缀/最近使用/撤销时间）、撤销/重新启用、端点地址展示 + curl 示例、四份客户端配置片段（Claude Code CLI 与 .mcp.json、Codex、通用 HTTP，均用 `X-CiNotes-Key` 头）、安全要点。
- **登录**：沿用现有单用户表单（用户名/密码），401 提示；未登录不渲染任何菜单元素。

### 7.3 共享能力

- **Markdown**：`src/markdown.ts` 自实现（翻译词间 markdown.js 逻辑，不引第三方库）：块级（标题 6 级、围栏代码、分隔线、引用嵌套、有序/无序列表嵌套、段落）、行内（粗体/斜体/删除线/行内代码/链接/转义/硬换行）、图片语法降级纯文字；**空行分段与 claim.paragraph 绑定**；渲染用 createElement/textNode（无 innerHTML）；safeHref 白名单（http/https/mailto/站内/锚点）；原始 HTML 当普通文字。词作原文与 quote 不解析。
- **diff**：`src/diff.ts` 翻译词间 diff.js：行级 LCS（Uint32Array，超限退化删+插），delete+insert 相邻合并 change + 字级 diff；服务端 compare 端点与前端复用同一逻辑（服务端实现一份用于 MCP/compare API，前端渲染用同算法的 TS 版）。
- **导出**：`src/exporter.ts`：noteToMarkdown（引言状态行、关联原文块含 claims `[已核实]` 标记、正文/附记/资料标注/引用出处/时间水印）、workToMarkdown、allusionToMarkdown★、版本导出（带版本时间）。文件名 `<标题>-YYYYMMDD-HHmm.md`。
- **防丢**：编辑防抖 700ms 写 localStorage（key 按实体+ID），进入自动恢复提示，保存成功清除。
- **弹窗体系**：toast/modal/confirm/alert/choose 组件；`beforeunload` 未保存拦截；切视图/返回确认。
- **无障碍/适配**：移动端底栏 4 项（书架/词作/札记/我的）+ 抽屉（遮罩/Esc 关闭）、阅读字号 15–24 七档存 localStorage、错误边界 + 重试框、长词断行。

## 8. 备份与导入导出

- **备份格式 v2**：`{format:'ci-notes-backup', formatVersion:2, exportedAt, counts{…}, data:{works, notes, revisions, comparisons, trash, imagery, imageryUses, allusions, allusionUses, links:{workId,noteId}[], tags[]}}`。`attachmentsSupported:false`。
- **兼容**：词间备份（`format:'cijian-backup'`）v1/v2 可直接导入（缺 imagery/allusions 集合按空处理）——用户可借此把词间云端数据搬到 ci-notes。
- **导入链**：parseBackup（空/64MB/JSON 校验）→ validateBackup（format 标识、version 不高于本机、必需集合、每条有 id、悬空引用清单）→ preflight（按 sameContent——忽略 ownerId/updatedAt/revision——分类新增/重复/冲突）→ 确认框（明细 + 「导入不会删除已有内容；定稿和已发布不会被覆盖」）→ merge（整体事务；冲突副本 `derivedId` 幂等；revisions.noteId、comparisons.workAId/BId、notes.workIds、imagery/allusion uses 的 imageryId/allusionId/targetId 全部重映射；写入 imports 日志）。
- **导出途径**：Web 下载（/api/export attachment）+ MCP export_backup（同一格式）。

## 9. 错误处理

- 后端：`{error:{code,message,current?}}`；401/403/404/409/400/413；全部写操作 `BEGIN IMMEDIATE` 事务，失败回滚；CAS 未命中 409 附对方当前 payload。
- 前端：api.ts 统一解析错误；401 跳登录；409 冲突三选一；视图级错误边界；保存失败文字保留本机暂存。

## 10. 种子数据

`server/seeds.json` 换为词间 seed 语义（翻译为 ci-notes 格式，固定 ID 幂等）：柳永《凤栖梧》三阕 + 周邦彦《浣溪沙》（全文、背景、tags、citations 标 verified/pending、claims 混排示范）；两篇札记（正文附记留空、pendingImport:true、状态 research/idea、各带 v1）；一条对照（柳永×周邦彦，7 维空，understanding 预置 personal）；意象示例（如「月亮」通用资料 + 在柳永词中的使用记录）；**典故示例**★（如「巫山云雨」或「庄周梦蝶」通用释义 + 在某词中的使用记录，示范两层解释）。空库且 `seed=true` 时写入；有数据不重复。

## 11. 测试与部署

- **后端（node --test）**：
  - store 层：各实体 CRUD、CAS 冲突（409 + current）、定稿派生草稿、force 覆盖前留档、回收站往返（恢复/永久删除连带 revisions）、意象/典故双向索引与合并、对照衔接 compare、claims 段落绑定、备份导出→导入新库 deepEqual、幂等重复导入、坏数据原子回滚、mcp_keys 生成/哈希/撤销。
  - HTTP 端到端：沿用现有安全断言（401/403/415/413/Cookie 属性）+ 新端点往返 + preflight/merge 流程。
  - MCP：initialize/tools list/tools call 往返、无密钥 401、无效密钥 401 诊断、撤销即时生效、冲突工具返回文案。
- **前端**：`tsc --noEmit` + vite build（不引入 UI 测试框架——单人自托管场景，业务规则由后端测试覆盖；如需 UI 自动化另行立项）。
- **容器冒烟**：`scripts/test-container.sh` 扩展：登录 → 建 work/note → 意象关联 → 典故关联 → MCP 密钥生成与 tools/call → 重启持久化断言。
- **CI**：现有流程不变（npm ci → test → build → compose config → docker build → test-container）。
- **部署**：Dockerfile/compose 不变（密钥由 UI 生成存库，无新增环境变量）；数据卷沿用 `ci-notes-data`。

## 12. 关键取舍记录

1. **零依赖原则保持**：Markdown、diff、MCP 传输均自实现（翻译词间纯 JS 实现），不引 npm 运行时依赖。
2. **无状态 MCP**：与词间「pull 全库→改→写回」不同，直接事务读写——服务器与库同进程，语义等价且更简单。
3. **localStorage 替代 IndexedDB**：草稿暂存为小文本，5MB 足够，简化实现。
4. **词间备份兼容**：导入侧兼容 `cijian-backup` 格式，用户的词间云端数据可通过导出→导入搬迁，替代原本的数据迁移需求。
5. **版本模型采用词间语义**：放弃 ci-notes 原「一切皆 versions 追加」模型（旧数据不迁移，无兼容负担），仅札记有历史版本，其余实体 CAS 可变。
