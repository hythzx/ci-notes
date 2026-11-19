# 词间 · CI Notes

单用户自托管的古典诗词写作空间：词作、随笔札记、意象与典故四类资料互相链接，全部数据保存在自己的服务器上。React + TypeScript + Vite 前端，Node.js 24 HTTP 服务，Node 内置 SQLite 数据库。无需 Cloudflare、Sites 或外部数据库服务。

## 功能总览

- **词作**：按作者、词牌、体裁、主题标签浏览，支持全文关键词搜索；原文、背景、引用出处随条目保存；修改生成新版本，旧版本保留可回看。
- **随笔与阅读札记**：写作状态（idea / research / draft / final）与发布状态管理；每次保存追加一个不可变版本；行级 + 字级双粒度版本对比；恢复历史版本或从定稿继续写作时另派生新草稿，原稿逐字保留；同一篇札记的并发修改用乐观并发检查拦截，不静默覆盖。
- **词作对照**：按人物情境、意象、典故、表达方式、相同点、不同点、自己的理解七个维度并排对照两首词作，每个维度可单独标注可信度与出处。
- **意象库**：月亮、芳草这类承载情感的事物单独建档；通过「使用记录」挂到具体作品或札记的具体词句上（对应原文、情境、表达作用、自己的理解）；支持两个作品的意象对照，以及意象合并。
- **典故库**：与意象对称，但解释分两层——条目上的 `explanation` 是通用释义，具体到某首作品的解读记在使用记录的 `interpretation` 里，互不混淆。
- **回收站**：删除词作 / 札记 / 意象 / 典故先入回收站，可恢复；札记进回收站时其历史版本一并保留，恢复即还原；确认后才真正清除。
- **可信度标注**：资料条目分三级（`verified` 已核实 / `pending` 待核实 / `personal` 个人理解），每条可附引用出处（书名、版本、页码、网址、备注）。
- **Markdown**：札记与对照正文按段落渲染，安全转义，支持字级修订痕迹。
- **备份与合并导入**：一键导出完整 JSON 备份；导入先预检再合并，兼容词间 `cijian-backup` 格式（详见下文）。
- **单用户认证**：登录页 + HttpOnly 会话 Cookie（30 天），用户名与密码经环境变量配置；没有内置默认密码。
- **MCP 智能体接入**：内置 MCP 服务器（Streamable HTTP），34 个工具覆盖全部实体，API 密钥在网页端生成（见下文）。

「已发布」是写作管理状态，不会自动向博客或其他服务发布文章。

### 初始内容

首次以空库启动时写入一组示例资料：柳永《凤栖梧》三阕、周邦彦《浣溪沙·楼上晴天碧四垂》，两篇待继续整理的札记（写作状态 research / idea，`pendingImport` 标记），一份《凤栖梧·其二》×《浣溪沙》七维对照，意象「月亮」与典故「庄周梦蝶」。原文出处随条目保存，阅读提示标为个人理解，待核实项明确注明。

## Docker Compose 部署

需要 Docker Engine 和 Compose v2。

```bash
git clone https://github.com/hythzx/ci-notes.git
cd ci-notes
cp .env.example .env
```

编辑 `.env`，填写 `APP_USERNAME` 和至少 8 位的 `APP_PASSWORD`。没有内置默认密码，密码不符合要求时应用会拒绝启动。包含 `$`、`#` 等字符时用单引号包围密码值。

```bash
docker compose up -d --build
docker compose logs -f ci-notes
```

打开 `http://服务器地址:3000`，在登录页输入 `.env` 中的用户名与密码。登录态保存在 HttpOnly 会话 Cookie（30 天），侧边栏「退出登录」即时失效；修改密码并重建容器会使所有旧会话失效。

- 对外端口由 `.env` 的 `PORT` 控制；容器内固定为 3000。
- 默认监听所有网卡；仅本机反向代理访问时设 `BIND_ADDRESS=127.0.0.1`。
- **公网访问请通过 HTTPS 反向代理**，登录凭据与会话 Cookie 需要 TLS 保护（经 HTTPS 访问时 Cookie 自动附加 `Secure`）。代理应保留原始 `Host`（如 Nginx 的 `proxy_set_header Host $http_host;`），以便同源写入检查正常工作。
- 数据位于命名卷 `ci-notes-data` 内的 `/app/data/ci-notes.sqlite`。重建、更新、重启容器保留数据；`docker compose down -v` 会删除卷，勿用于普通升级。
- 容器以非 root 用户运行，根文件系统只读；仅数据卷和 `/tmp` 可写。

### 更新

```bash
git pull --ff-only
docker compose up -d --build
```

### 配置

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `APP_USERNAME` | 登录用户名，不能包含冒号 | Compose 为 `admin`；Node 直接运行必填 |
| `APP_PASSWORD` | 登录密码，至少 8 位 | 必填 |
| `PORT` | Node 服务端口 / Compose 宿主机映射端口 | `3000` |
| `HOST` | Node 监听地址 | `0.0.0.0` |
| `BIND_ADDRESS` | Compose 宿主机监听地址 | `0.0.0.0` |
| `DATA_DIR` | Node 数据目录 | `./data` |

## MCP 智能体接入

词间内置 MCP 服务器，智能体（Claude Code、Codex 等）可以直接读写词库。要点：

- 端点：`http://你的地址:3000/mcp`，Streamable HTTP 上的 JSON-RPC；兼容协议版本 `2025-06-18` / `2025-03-26` / `2024-11-05`。
- 认证：`X-CiNotes-Key` 请求头（也接受非 JWT 的 `Authorization: Bearer` 值），与网页登录会话是两条独立通道。
- 密钥：登录网页后在 **「我的」→「MCP 密钥」**（`#/me/mcp-keys`）生成。明文只在生成那一刻显示一次，服务器只存 SHA-256 哈希；撤销即时生效。
- 工具：共 **34 个**，覆盖全部实体：
  - 词作 5：`list_works` / `get_work` / `create_work` / `update_work` / `delete_work`
  - 札记 5 + 版本 3：`list_notes` / `get_note` / `create_note` / `update_note` / `delete_note`；`list_revisions` / `compare_revisions` / `restore_revision`
  - 对照 2：`list_comparisons` / `save_comparison`
  - 意象 8：`list_imagery` / `get_imagery` / `create_imagery` / `update_imagery` / `delete_imagery` / `link_imagery` / `list_imagery_of` / `compare_imagery`
  - 典故 8：`list_allusions` / `get_allusion` / `create_allusion` / `update_allusion` / `delete_allusion` / `link_allusion` / `list_allusions_of` / `compare_allusions`
  - 聚合 3：`search` / `get_stats` / `export_backup`

### 客户端配置摘要

```bash
# Claude Code · 命令行添加（先 export CI_NOTES_MCP_KEY=明文密钥）
claude mcp add --transport http ci-notes http://你的地址:3000/mcp \
  --header "X-CiNotes-Key: ${CI_NOTES_MCP_KEY}"
```

```jsonc
// Claude Code · .mcp.json（引用环境变量，文件本身不含明文）
{
  "mcpServers": {
    "ci-notes": {
      "type": "http",
      "url": "http://你的地址:3000/mcp",
      "headers": { "X-CiNotes-Key": "${CI_NOTES_MCP_KEY}" }
    }
  }
}
```

```toml
# Codex · config.toml（http_headers 写入密钥明文，注意别提交进仓库）
[mcp_servers.ci-notes]
url = "http://你的地址:3000/mcp"
http_headers = { "X-CiNotes-Key" = "<密钥>" }
```

```bash
# 通用 HTTP 客户端手测（应返回 tools 数组，共 34 个）
curl -s -X POST http://你的地址:3000/mcp \
  -H 'Content-Type: application/json' -H 'X-CiNotes-Key: <密钥>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

智能体侧的行为约定已写进服务端说明（INSTRUCTIONS）：札记正文是用户自己的文字，不代写；定稿不被就地改写；冲突时把两版都呈现给用户决定。

## API 简表

除 `/api/health`、`/api/login`、`/api/logout` 与 `/mcp`（密钥鉴权）外，全部接口要求登录会话 Cookie。错误统一为 `{error:{code,message}}`：校验失败 400、不存在 404、乐观并发冲突 409（响应附 `current` 当前内容）、跨站写入 403。

| 分组 | 接口 | 说明 |
| --- | --- | --- |
| 认证 | `POST /api/login`、`POST /api/logout`、`GET /api/health` | 会话 Cookie 下发与清除；健康检查 |
| 词作 | `GET/POST /api/works`，`GET/PUT/DELETE /api/works/:id` | 列表（q / author / cipai / tag / kind 筛选）、详情、CAS 更新、删除入回收站 |
| 札记 | `GET/POST /api/notes`，`GET/PUT/DELETE /api/notes/:id`，`POST /api/notes/:id/unprotect` | 保存返回 `{note,revision,createdDraft}`；对定稿 / 已发布保存自动派生草稿 |
| 版本 | `GET /api/notes/:id/revisions`、`GET .../revisions/compare?a=&b=`、`POST .../revisions/:rid/restore` | 历史列表、行级 + 字级对比、恢复为新草稿；版本不可改写不可删除（数据库触发器强制） |
| 对照 | `GET/POST /api/comparisons`，`GET/PUT/DELETE /api/comparisons/:id` | 七维对照笔记 |
| 意象 | `GET/POST /api/imagery`，`GET /api/imagery/compare?a=&b=`，`GET/PUT/DELETE /api/imagery/:id`，`POST /api/imagery/:id/merge`，`GET /api/imagery/:id/impact` | 条目、作品间对照、合并（删除用记录）、删除影响预览 |
| 意象使用 | `GET/POST /api/imagery-uses`，`PUT/DELETE /api/imagery-uses/:id` | 使用记录的表达作用字段名为 `fn` |
| 典故 | 与意象对称（`/api/allusions*`、`/api/allusion-uses*`） | 使用记录的解读字段为 `interpretation`（区别于条目通用释义 `explanation`） |
| 聚合 | `GET /api/home`、`GET /api/search?q=`、`GET /api/stats` | 书架统计、全局搜索、实体计数与 facets |
| 备份 | `GET /api/export`、`POST /api/import`（`mode=preflight` 或 `merge`） | 导出完整备份；导入先预检后合并 |
| 回收站 | `GET /api/trash`、`POST /api/trash/:id/restore`、`DELETE /api/trash/:id` | 列表 / 恢复 / 彻底清除 |
| MCP 密钥 | `GET/POST /api/mcp-keys`、`POST /api/mcp-keys/:id/revoke`、`POST /api/mcp-keys/:id/enable` | 明文仅在创建响应中出现一次 |

## 数据与备份

SQLite 单文件存储（WAL 模式、`synchronous=FULL`、busy timeout），数据库触发器禁止改写历史版本行。单用户场景下没有分页，不适合多人共用；也不要让多个容器副本共享网络文件系统上的同一个 SQLite 文件。

### 导出与恢复

- **JSON 导出**：网页「我的」→「导出全部数据」（或 `GET /api/export`）下载含全部实体与历史版本的备份。
- **SQLite 快照**：在线生成一致性快照（使用 SQLite backup API，包含 WAL 中已提交的数据）：

```bash
docker compose exec ci-notes node scripts/backup.mjs /app/data/manual-backup.sqlite
docker compose cp ci-notes:/app/data/manual-backup.sqlite ./ci-notes-backup.sqlite
```

每次使用新的备份文件名，脚本不会覆盖已有文件。不要在运行时只复制主 `.sqlite` 文件而遗漏 WAL。

恢复 SQLite：先停止服务，保留当前数据库与 `-wal`、`-shm` 文件的完整副本，再以备份替换数据卷中的 `ci-notes.sqlite`，移走旧 WAL/SHM，确保文件归容器 `node` 用户（UID 1000）所有，再启动。恢复后先核对札记及历史版本。

### 合并导入

网页「我的」→「导入数据」粘贴备份 JSON，**先预检（preflight）再合并（merge）**。合并语义：

- **不删除任何已有内容**：合并只做 INSERT，无 UPDATE / DELETE——定稿与已发布的版本因此不可能被覆盖。
- 同 id 且内容相同的记录跳过（同一备份可重复导入，幂等）；同 id 但内容不同的记录**另存为冲突副本**，不改动已有条目；新 id 的记录直接入库，引用关系按需重映射。
- **兼容词间格式**：`format='cijian-backup'` 的 v1 / v2 备份可直接导入（词间无意象 / 典故集合的按空处理；词间意象使用记录的 `function` 字段导入时改名为 `fn`）；单用户导入会剥去词间备份中的账号键。

### 旧库自动迁移

从旧版 ci-notes（单模型 `versions` 表）升级时，首次启动检测到旧库会先把全部旧数据导出为数据目录下的 `ci-notes-legacy-backup.json`（已存在同名文件则拒绝启动以免覆盖），再迁移到多实体 schema v2。升级后请核对这份 legacy 备份再做其他操作。

## 本地 Node.js 运行

需要 Node.js **24.14+（24.x）**；构建与镜像使用 24.22.1。SQLite 直接使用 `node:sqlite`，无需编译第三方原生扩展。运行时不依赖 npm 包，前端依赖只在构建时使用。

```bash
cp .env.example .env
# 编辑 .env 设置用户名和密码
npm ci
npm test
npm run build
npm start
```

开发时开两个终端：

```bash
npm run dev:server   # node --watch，修改后端自动重启
npm run dev          # Vite 开发服务器，/api 代理到 127.0.0.1:3000
```

打开 `http://localhost:5173`，页面会先要求登录（用户名密码即 `.env` 中的配置）。不要使用开发服务器作为公网部署。

本地默认数据路径为 `./data/ci-notes.sqlite`；通过 `DATA_DIR` 修改。Compose 使用固定容器路径，不受宿主机 `.env` 中 `DATA_DIR` 影响。

```bash
npm run backup -- ./backups/my-backup.sqlite
```

## 项目结构与架构

```text
src/                        React 界面与样式
  src/views/                各视图：home / login / works / notes / history /
                            compare / imagery / allusions / me / mcpkeys
  src/components/           UI 基元、编辑器、Markdown 展示、分区组件
  src/api.ts, types.ts      API 客户端与实体类型；markdown.ts / diff.ts /
                            exporter.ts 为无 DOM 纯函数（可直接单测）
server/
  app.mjs                   HTTP 服务：安全头、HMAC 会话、REST 路由表、静态资源
  mcp.mjs                   MCP 端点：Streamable HTTP JSON-RPC、密钥鉴权、34 工具
  store.mjs                 store facade：领域模块的唯一组装入口
  core/                     纯领域模块（db / works / notes / comparisons /
                            imagery / allusions / trash / backup / stats /
                            mcpkeys / normalize / diffcore / errors / ids）
  seeds.json                初始示例资料
scripts/                    SQLite 快照备份、容器冒烟测试
test/                       node --test 单元与 HTTP 集成测试
Dockerfile                  多阶段构建，独立 Node.js 运行
docker-compose.yml          单服务和持久化数据卷
```

架构要点：`server/core/*` 是不依赖 HTTP 的纯函数模块，`store.mjs` 把它们组装成单一 facade，`app.mjs`（REST 路由）与 `mcp.mjs`（MCP 工具）都是它的消费者；前端视图只经 `src/api.ts` 访问后端。

## 测试与 CI

```bash
npm test                      # node --test，覆盖 core 纯模块、HTTP 集成、MCP 工具
bash scripts/test-container.sh  # 需 Docker：构建 ci-notes:test 镜像后容器内冒烟
```

容器冒烟脚本以安全加固配置启动容器，验证登录、词作 / 札记 / 意象 / 典故创建与链接、MCP 密钥与 `tools/call`、重启后的持久化与静态页面。GitHub Actions 在每次推送和 PR 时运行测试、前端构建、Compose 校验、Docker 构建及容器重启持久化检查。不会推送镜像到 Docker Hub 或其他注册表。
