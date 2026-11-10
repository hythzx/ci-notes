# 词间 · CI Notes

古典诗词随笔与阅读札记的私人写作空间。React + TypeScript + Vite 前端，Node.js 24 HTTP 服务，Node 内置 SQLite 数据库。无需 Cloudflare、Sites 或外部数据库服务。

## 功能

- 按作者、词牌、作品、主题、写作状态浏览，支持全文关键词搜索。
- 记录原文、背景、正文、附记、出处、资料核实说明和发布状态。
- 并排对照人物情境、意象、典故和表达方式。
- 每次保存追加一个不可变版本；定稿 / 已发布版本另建草稿继续写。
- 检测同一篇札记的并发修改，拒绝静默覆盖。
- SQLite 持久化、JSON 导出、Sites 旧版 JSON 导入、在线 SQLite 备份。
- HTTP Basic 登录，用户名与密码通过环境变量配置。

初始内容包括柳永《凤栖梧》三阕、周邦彦《浣溪沙·楼上晴天碧四垂》、待导入的柳永随笔及和凝阅读线索。原文出处随条目保存，阅读提示标为个人理解，待核实项明确注明。随笔完整定稿未取得，正文留空；已有附记保留原文。

“已发布”是写作管理状态，不会自动向博客或其他服务发布文章。

## Docker Compose 部署

需要 Docker Engine 和 Compose v2。

```bash
git clone https://github.com/hythzx/ci-notes.git
cd ci-notes
cp .env.example .env
```

编辑 `.env`，填写 `APP_USERNAME` 和至少 12 位的 `APP_PASSWORD`。没有内置默认密码，密码不符合要求时应用会拒绝启动。包含 `$`、`#` 等字符时用单引号包围密码值。

```bash
docker compose up -d --build
docker compose logs -f ci-notes
```

打开 `http://服务器地址:3000`，在浏览器登录提示框中输入 `.env` 中的用户名与密码。Basic 登录由浏览器管理；修改密码并重建容器可使原凭据失效。

- 对外端口由 `.env` 的 `PORT` 控制；容器内固定为 3000。
- 默认监听所有网卡；仅本机反向代理访问时设 `BIND_ADDRESS=127.0.0.1`。
- **公网访问请通过 HTTPS 反向代理**，Basic 凭据需要 TLS 保护。代理应保留原始 `Host`（如 Nginx 的 `proxy_set_header Host $http_host;`），以便同源写入检查正常工作。
- 数据位于命名卷 `ci-notes-data` 内的 `/app/data/ci-notes.sqlite`。重建、更新、重启容器保留数据；`docker compose down -v` 会删除卷，勿用于普通升级。
- 容器以非 root 用户运行，根文件系统只读；仅数据卷和 `/tmp` 可写。

### 更新

```bash
git pull --ff-only
docker compose up -d --build
```

### 备份

页面左侧“导出全部文字”会下载含完整历史版本的 JSON。

在线生成 SQLite 一致性快照（使用 SQLite backup API，包含 WAL 中已提交的数据）：

```bash
docker compose exec ci-notes node scripts/backup.mjs /app/data/manual-backup.sqlite
docker compose cp ci-notes:/app/data/manual-backup.sqlite ./ci-notes-backup.sqlite
```

每次使用新的备份文件名，脚本不会覆盖已有文件。不要在运行时只复制主 `.sqlite` 文件而遗漏 WAL。

恢复 SQLite：先停止服务，保留当前数据库与 `-wal`、`-shm` 文件的完整副本，再以备份替换数据卷中的 `ci-notes.sqlite`，移走旧 WAL/SHM，确保文件归容器 `node` 用户（UID 1000）所有，再启动。恢复后先核对札记及历史版本。

### 从原 Sites 迁移内容

源码仓库不含原 Sites 的运行数据库，也不会自动读取其私人数据。

1. 登录原 Sites，点击“导出全部文字”，得到 JSON。
2. 先备份目标数据，再把文件复制到容器并运行导入：

```bash
docker compose cp ./词间-完整备份.json ci-notes:/app/data/import.json
docker compose exec ci-notes node scripts/import.mjs /app/data/import.json
```

刷新页面即可。导入支持原 Sites 的 `{notes, versions}` 格式及本项目导出格式；保留文字、状态和原时间，版本编号会由新数据库重新分配。重复导入同一文件会跳过重复版本。导入会把源版本追加到当前历史末尾，建议在开始新写作前迁移；它不会删除目标已有历史。

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
npm run dev:server
npm run dev
```

Vite 将 `/api` 代理到 `127.0.0.1:3000`；开发时先访问 `http://localhost:5173/api/notes` 完成浏览器 Basic 登录，再返回首页。不要使用开发服务器作为公网部署。

本地默认数据路径为 `./data/ci-notes.sqlite`；通过 `DATA_DIR` 修改。Compose 使用固定容器路径，不受宿主机 `.env` 中 `DATA_DIR` 影响。

```bash
npm run backup -- ./backups/my-backup.sqlite
npm run import -- ./词间-完整备份.json
```

## 配置

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `APP_USERNAME` | 登录用户名，不能包含冒号 | Compose 为 `admin`；Node 直接运行必填 |
| `APP_PASSWORD` | 登录密码，至少 12 位 | 必填 |
| `PORT` | Node 服务端口 / Compose 宿主机映射端口 | `3000` |
| `HOST` | Node 监听地址 | `0.0.0.0` |
| `BIND_ADDRESS` | Compose 宿主机监听地址 | `0.0.0.0` |
| `DATA_DIR` | Node 数据目录 | `./data` |

## API 与版本语义

除 `/api/health` 外，页面和 API 均要求 Basic 认证。

| 接口 | 用途 |
| --- | --- |
| `GET /api/health` | 不含札记信息的健康检查 |
| `GET /api/notes` | 按版本顺序返回所有札记版本 |
| `POST /api/notes` | 追加版本；请求为札记字段加 `expectedSeq`，新建用 `0` |
| `GET /api/export` | 导出所有当前札记和历史版本 |

保存成功返回 `201`；版本冲突返回 `409`，不会丢弃编辑框内容。SQLite 使用 WAL、busy timeout 和事务；数据库触发器禁止 UPDATE / DELETE 历史版本。初始化仅在空数据库中写入初始条目。修改状态不会改写以前的定稿。

这是单人应用，GET 会读取全部历史，适合个人札记。不要运行多个容器副本共用网络文件系统上的 SQLite；大规模使用应另加分页并迁移数据层。

## 项目结构

```text
src/                   React 界面与样式
server/app.mjs         HTTP、认证、输入验证与静态资源
server/store.mjs       SQLite、版本保存、导出与导入
server/seeds.json      初始资料
scripts/               备份、导入及容器验证
Dockerfile             多阶段构建，独立 Node.js 运行
docker-compose.yml    单服务和持久化数据卷
```

GitHub Actions 在每次推送和 PR 时运行测试、前端构建、Compose 校验、Docker 构建及容器重启持久化检查。不会推送镜像到 Docker Hub 或其他注册表。
