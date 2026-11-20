# ci-notes SQLite 自动备份实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 135 上的 ci-notes 建立「每日 01:00 SQLite 快照 + 02:00 目录备份推送 MinIO」的自动备份链路，并完成快照完整性校验与真实恢复演练。

**Architecture:** 应用零代码改动。compose 增加 `/app/backups` bind mount 使快照落到宿主机；两个 1Panel v2 计划任务经 API 创建：shell 任务调容器内现有 `scripts/backup.mjs`（node:sqlite backup API，WAL 一致性在线快照）并本地轮转 7 份；目录备份任务把快照目录打包推送到既有「ZSpace」MinIO 存储账号，保留 30 份。

**Tech Stack:** Docker Compose、1Panel v2.5.1 API（1Panel-Timestamp + 1Panel-Token=md5("1panel"+ts+key) 签名）、现有 `scripts/backup.mjs`、SSH。

## Global Constraints

- **不构建镜像**：本计划零应用代码改动，「部署」= compose 变更 + 容器重建。无 `docker build`、无 git 代码提交（计划与规格文档提交除外）。
- 所有服务器操作经 `ssh root@192.168.3.135`（免密已配）。
- **API_KEY 不写入任何会提交到 git 的文件**（计划文档、脚本、输出文件）。密钥由调度者在派发子代理时注入，子代理只能用于 135 本机 `127.0.0.1` 的 curl。
- 计划任务时间：快照 `0 1 * * *`，目录备份 `0 2 * * *`。
- 存储账号：复用 1Panel 既有「ZSpace」（MINIO 类型），不新建账号、不动其配置。
- 数据卷 `ci-notes_ci-notes-data` 绝不删除；compose 仅新增一行挂载，其余字段（read_only、cap_drop、tmpfs 等）不动。
- 1Panel 面板端口 29789，面板路径前缀 `/agile`（UI 路径；API 前缀待 Task 2 探测，可能是 `/api/v1` 或 `/api/v2`）。
- 1Panel API 签名（已核实面板内配置为 v2.5.1）：请求头 `1Panel-Timestamp: <unix秒>`、`1Panel-Token: md5("1panel" + <unix秒> + <API_KEY>)`。授权 IP 需含 `127.0.0.1`。

## 服务器事实（已侦察核实，勿重复探测）

| 项 | 值 |
|---|---|
| ci-notes 目录 | `/opt/ci-notes`，服务名 `ci-notes`，容器名 `ci-notes`，端口 `30136:3000` |
| 数据卷 | `ci-notes_ci-notes-data` 挂载于 `/app/data`，库文件 `ci-notes.sqlite`（WAL 模式，约 352KB） |
| 备份脚本 | 容器内 `node scripts/backup.mjs [target]`（WORKDIR=/app），默认输出 `backups/ci-notes-<ISO时间戳>.sqlite`；目标已存在则报错退出 |
| 1Panel 数据库 | `/opt/1panel/db/agent.db`（cronjobs、backup_accounts 表）；宿主机无 sqlite3 CLI，可用 `docker run --rm -v /opt/1panel/db:/db:ro node:24.22.1-bookworm-slim node -e "…"` 读取 |
| 存储账号 | id=1 LOCAL「localhost」；id=2 MINIO「ZSpace」bucket `backup`、backupPath `/1panel`；id=3 WebDAV（勘误：初稿误记 bucket 为 `1panel`，经 Task 2 实测修正） |
| 健康检查 | `curl http://127.0.0.1:30136/api/health` → `{"ok":true}` |

---

### Task 1: compose 挂载备份目录并重建容器

**Files:**
- Modify（135 侧）: `/opt/ci-notes/docker-compose.yml`（volumes 列表加一行）

**Interfaces:**
- Produces: 宿主机目录 `/opt/ci-notes/backups`（node 用户可写，容器内路径 `/app/backups`），后续任务的快照落地点。

- [ ] **Step 1: 确认容器内 node 用户 uid**

```bash
ssh root@192.168.3.135 'docker exec ci-notes id node'
```
期望输出 `uid=1000(node) gid=1000(node)`。若不是 1000，后续 chown 用实际 uid。

- [ ] **Step 2: 创建宿主机备份目录并授权**

```bash
ssh root@192.168.3.135 'mkdir -p /opt/ci-notes/backups && chown 1000:1000 /opt/ci-notes/backups && ls -ld /opt/ci-notes/backups'
```
期望 `drwxr-xr-x ... node node ... /opt/ci-notes/backups`。

- [ ] **Step 3: 修改 compose 增加挂载**

```bash
ssh root@192.168.3.135 'cd /opt/ci-notes && cp docker-compose.yml /tmp/docker-compose.yml.bak && sed -i "s|      - ci-notes-data:/app/data|      - ci-notes-data:/app/data\n      - ./backups:/app/backups|" docker-compose.yml && cat docker-compose.yml'
```
校验输出：volumes 下两行均在、其余字段与备份一致（read_only: true、cap_drop: ALL、端口 30136 等未变）。

- [ ] **Step 4: 重建容器并验证健康与写权限**

```bash
ssh root@192.168.3.135 'cd /opt/ci-notes && docker compose up -d && sleep 8 && docker ps --filter name=ci-notes --format "{{.Image}}  {{.Status}}" && curl -s http://127.0.0.1:30136/api/health && echo && docker exec ci-notes touch /app/backups/.write-test && docker exec ci-notes rm /app/backups/.write-test && docker exec ci-notes ls -ld /app/backups'
```
期望：`Up ... (healthy)`、`{"ok":true}`、touch/rm 成功、`/app/backups` 属主 node。数据完整性：`docker exec ci-notes node -e "const{DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync('/app/data/ci-notes.sqlite',{readOnly:true}).prepare('SELECT COUNT(*) c FROM works').get().c)"` 有输出即可（种子里 works 非零）。

### Task 2: 1Panel API 连通性与接口形状探测

**Files:** 无（仅探测，输出结论供 Task 3/4 使用）。

**Interfaces:**
- Consumes: API_KEY（调度者注入，下文以 `$KEY` 表示，执行时替换为真实值）。
- Produces: ① 可用的 API 基址（`API_BASE`，形如 `http://127.0.0.1:29789/api/v2`）；② 能用的签名头函数；③ ZSpace 账号 id（预期 2）；④ 计划任务创建所需字段的实际形状。

- [ ] **Step 1: 构造签名头并探测 API 版本**

在 135 上执行（签名每次请求都要新鲜生成）：

```bash
ssh root@192.168.3.135 'KEY=<API_KEY>; TS=$(date +%s); TOKEN=$(printf "1panel%s%s" "$TS" "$KEY" | md5sum | cut -d" " -f1); for v in v2 v1; do echo "== /api/$v =="; curl -s -o /dev/null -w "%{http_code}\n" -X POST "http://127.0.0.1:29789/api/$v/cronjobs/search" -H "1Panel-Timestamp: $TS" -H "1Panel-Token: $TOKEN" -H "Content-Type: application/json" -d "{\"page\":1,\"pageSize\":10}"; done'
```
期望：某一版本返回 200（JSON body `code:200`）。若全部 401/403，检查面板 API 设置：授权 IP 需含 `127.0.0.1`；时间戳偏差过大也会拒绝（与面板机时钟一致即可）。

- [ ] **Step 2: 确认 ZSpace 账号 id**

```bash
ssh root@192.168.3.135 'KEY=<API_KEY>; TS=$(date +%s); TOKEN=$(printf "1panel%s%s" "$TS" "$KEY" | md5sum | cut -d" " -f1); curl -s -X POST "http://127.0.0.1:29789/api/v2/backups/search" -H "1Panel-Timestamp: $TS" -H "1Panel-Token: $TOKEN" -H "Content-Type: application/json" -d "{\"page\":1,\"pageSize\":20}"'
```
期望：返回含 `name:"ZSpace"` 的记录，记录其 `id`（预期 2）。端点 404 时改用 `/api/v1/backups`（以 Step 1 探得的版本为准）。

- [ ] **Step 3: 摸清计划任务字段形状**

查现有任务做参照（1Panel 自建任务若存在即为最佳参照；无任务则以 agent.db 表列名为准）：

```bash
ssh root@192.168.3.135 'KEY=<API_KEY>; TS=$(date +%s); TOKEN=$(printf "1panel%s%s" "$TS" "$KEY" | md5sum | cut -d" " -f1); curl -s -X POST "http://127.0.0.1:29789/api/v2/cronjobs/search" -H "1Panel-Timestamp: $TS" -H "1Panel-Token: $TOKEN" -H "Content-Type: application/json" -d "{\"page\":1,\"pageSize\":50}"'
```

并把 Task 1 的产物核对为已知事实（无需命令）。把三项结论写入派发回复：`API_BASE`、ZSpace id、search 返回的任务对象字段清单。

### Task 3: 创建「ci-notes 快照备份」计划任务（01:00）并验证

**Files:** 无（任务存于 1Panel）。

**Interfaces:**
- Consumes: Task 1 的 `/opt/ci-notes/backups`；Task 2 的 `API_BASE` 与签名方式。
- Produces: 1Panel 计划任务「ci-notes 快照备份」；每日 01:00 生成 `/opt/ci-notes/backups/ci-notes-<时间戳>.sqlite` 并保留最新 7 份。

- [ ] **Step 1: 经 API 创建 shell 计划任务**

任务脚本内容（原样写入 `script` 字段）：

```bash
# ci-notes SQLite 快照备份 + 本地轮转（保留最新 7 份）
set -e
docker exec ci-notes node scripts/backup.mjs
cd /opt/ci-notes/backups
# 按修改时间保留最新 7 份，删除更早快照
ls -1t ci-notes-*.sqlite 2>/dev/null | tail -n +8 | xargs -r rm -f
```

创建请求（字段名以 Task 2 Step 3 探得的形状为准；v1/v2 通用字段：`name`、`type:"shell"`、`spec:"0 1 * * *"`、`script`、`scriptMode`、`retryTimes:1`、`timeout` 默认、`ignoreErr:false`、`status:"Enable"`；type 枚举值若非 `"shell"` 以实测为准调整）：

```bash
ssh root@192.168.3.135 'KEY=<API_KEY>; TS=$(date +%s); TOKEN=$(printf "1panel%s%s" "$TS" "$KEY" | md5sum | cut -d" " -f1); curl -s -X POST "http://127.0.0.1:29789/api/v2/cronjobs" -H "1Panel-Timestamp: $TS" -H "1Panel-Token: $TOKEN" -H "Content-Type: application/json" -d "{\"name\":\"ci-notes 快照备份\",\"type\":\"shell\",\"spec\":\"0 1 * * *\",\"script\":\"# ci-notes SQLite 快照备份 + 本地轮转（保留最新 7 份）\\nset -e\\ndocker exec ci-notes node scripts/backup.mjs\\ncd /opt/ci-notes/backups\\nls -1t ci-notes-*.sqlite 2>/dev/null | tail -n +8 | xargs -r rm -f\\n\",\"retryTimes\":1,\"ignoreErr\":false,\"status\":\"Enable\"}"'
```
期望：返回 `code:200`。报参数错误时，读错误信息对照 search 字段调整后重试。

- [ ] **Step 2: 经 API 手动触发一次**

```bash
ssh root@192.168.3.135 'KEY=<API_KEY>; TS=$(date +%s); TOKEN=$(printf "1panel%s%s" "$TS" "$KEY" | md5sum | cut -d" " -f1); ID=$(curl -s -X POST "http://127.0.0.1:29789/api/v2/cronjobs/search" -H "1Panel-Timestamp: $TS" -H "1Panel-Token: $TOKEN" -H "Content-Type: application/json" -d "{\"page\":1,\"pageSize\":50}" | grep -o "\"id\":[0-9]*,\"name\":\"ci-notes 快照备份\"\\|\"name\":\"ci-notes 快照备份\",\"id\":[0-9]*" | grep -o "[0-9]*" | head -1); echo "task id=$ID"; curl -s -X POST "http://127.0.0.1:29789/api/v2/cronjobs/execute" -H "1Panel-Timestamp: $TS" -H "1Panel-Token: $TOKEN" -H "Content-Type: application/json" -d "{\"cronjobId\":$ID}"'
```
（执行端点字段名以实测为准，可能是 `cronjobId`/`id`。）

- [ ] **Step 3: 验证快照产物与轮转**

```bash
ssh root@192.168.3.135 'sleep 10; ls -lt /opt/ci-notes/backups/'
```
期望：出现一个 `ci-notes-*.sqlite`，大小 >100KB。再验证任务详情状态成功：search 返回中该任务 `status` 为成功（或查 job_records）。失败则取 1Panel 任务日志（`/api/v2/cronjobs/...` 日志端点或面板 UI）排障。

- [ ] **Step 4: 失败场景测试（规格要求）**

容器停止状态下手动触发任务，确认任务记录失败（退出码非 0 路径），随后恢复容器：

```bash
ssh root@192.168.3.135 'cd /opt/ci-notes && docker compose stop ci-notes && sleep 3'
# 经 API 再次 execute 该任务（同 Step 2 的命令）
ssh root@192.168.3.135 'cd /opt/ci-notes && docker compose up -d && sleep 8 && curl -s http://127.0.0.1:30136/api/health'
```
期望：停止期间触发的那次执行在 1Panel 任务记录里为失败状态（search/job_records 可见）；容器恢复后 health 正常。

### Task 4: 创建「ci-notes 备份推送」目录备份任务（02:00）并验证

**Files:** 无（任务存于 1Panel）。

**Interfaces:**
- Consumes: Task 1 的 `/opt/ci-notes/backups`；Task 2 的 `API_BASE`、ZSpace 账号 id。
- Produces: 1Panel 计划任务「ci-notes 备份推送」；每日 02:00 将快照目录打包 tar.gz 推送 ZSpace（MinIO），保留 30 份。

- [ ] **Step 1: 经 API 创建目录备份计划任务**

类型为目录备份（v1 枚举 `type:"directory"`，is_dir/source_dir/download_account_id/retain_copies 对应表列；字段名以 Task 2 探测为准）：

```bash
ssh root@192.168.3.135 'KEY=<API_KEY>; TS=$(date +%s); TOKEN=$(printf "1panel%s%s" "$TS" "$KEY" | md5sum | cut -d" " -f1); curl -s -X POST "http://127.0.0.1:29789/api/v2/cronjobs" -H "1Panel-Timestamp: $TS" -H "1Panel-Token: $TOKEN" -H "Content-Type: application/json" -d "{\"name\":\"ci-notes 备份推送\",\"type\":\"directory\",\"spec\":\"0 2 * * *\",\"isDir\":true,\"sourceDir\":\"/opt/ci-notes/backups\",\"downloadAccountId\":<ZSpace_id>,\"retainCopies\":30,\"retryTimes\":1,\"ignoreErr\":false,\"status\":\"Enable\"}"'
```
期望 `code:200`。若 type 枚举或字段名不匹配导致报错：改用 search 里同类任务的字段形状重试；若两次尝试仍失败，**降级路径**：请用户在 1Panel UI 手动创建——计划任务 → 创建计划任务 → 类型「目录备份」→ 名称 `ci-notes 备份推送` → 执行周期「每天 02:00」→ 备份目录 `/opt/ci-notes/backups` → 备份账号 ZSpace → 保留 30 份，创建后跳到 Step 2。

- [ ] **Step 2: 经 API 手动触发并验证推送**

```bash
ssh root@192.168.3.135 'KEY=<API_KEY>; TS=$(date +%s); TOKEN=$(printf "1panel%s%s" "$TS" "$KEY" | md5sum | cut -d" " -f1); curl -s -X POST "http://127.0.0.1:29789/api/v2/cronjobs/execute" -H "1Panel-Timestamp: $TS" -H "1Panel-Token: $TOKEN" -H "Content-Type: application/json" -d "{\"cronjobId\":<Task4_id>}"; sleep 25'
```

验证两条证据：① agent.db `backup_records` 出现本任务记录（本地缓存包 + 上传状态成功）：

```bash
ssh root@192.168.3.135 'docker run --rm -v /opt/1panel/db:/db:ro node:24.22.1-bookworm-slim node -e "const{DatabaseSync}=require(\"node:sqlite\");const db=new DatabaseSync(\"/db/agent.db\",{readOnly:true});console.log(JSON.stringify(db.prepare(\"SELECT id,type,file_name,backup_account_id,status FROM backup_records ORDER BY id DESC LIMIT 5\").all(),null,1))"'
```
期望：`file_name` 形如 `directory-*.tar.gz`（或含 ci-notes 备份目录名），`status:"Success"`。② 本地缓存包存在：`ls -lt /opt/1panel/backup/directory/ 2>/dev/null | head`。上传目标侧不可直查 MinIO（无凭据），以 backup_records 状态为准。

### Task 5: 快照完整性校验 + 真实恢复演练

**Files:** 无（135 侧操作）。

**Interfaces:**
- Consumes: Task 3 产出的快照文件；Task 1 的 compose/容器状态。
- Produces: 完整性校验结论与恢复演练结论（写回调度者）。

- [ ] **Step 1: quick_check 校验最新快照**

```bash
ssh root@192.168.3.135 'SNAP=$(ls -1t /opt/ci-notes/backups/ci-notes-*.sqlite | head -1); echo "校验 $SNAP"; BASE=$(basename "$SNAP"); docker exec ci-notes node -e "const{DatabaseSync}=require(\"node:sqlite\");const db=new DatabaseSync(\"/app/backups/'$BASE'\",{readOnly:true});console.log(JSON.stringify(db.prepare(\"PRAGMA quick_check\").get()));console.log(\"works:\",db.prepare(\"SELECT COUNT(*) c FROM works\").get().c,\"notes:\",db.prepare(\"SELECT COUNT(*) c FROM notes\").get().c)"'
```
期望：`{"check":"ok"}`，works/notes 行数 ≥ 当前库内行数（与主库对比可再查一次主库同语句）。

- [ ] **Step 2: 真实恢复演练**

```bash
ssh root@192.168.3.135 '
set -e
SNAP=$(ls -1t /opt/ci-notes/backups/ci-notes-*.sqlite | head -1)
V=/var/lib/docker/volumes/ci-notes_ci-notes-data/_data
cd /opt/ci-notes
docker compose stop ci-notes
# 演练前留底（回退保险）
cp "$V/ci-notes.sqlite" /tmp/ci-notes.pre-drill.sqlite
[ -f "$V/ci-notes.sqlite-wal" ] && cp "$V/ci-notes.sqlite-wal" /tmp/ci-notes.pre-drill.sqlite-wal
# 用快照替换主库
cp "$SNAP" "$V/ci-notes.sqlite"
rm -f "$V/ci-notes.sqlite-wal" "$V/ci-notes.sqlite-shm"
chown 1000:1000 "$V/ci-notes.sqlite"
docker compose up -d
sleep 8
curl -s http://127.0.0.1:30136/api/health; echo
docker ps --filter name=ci-notes --format "{{.Status}}"
docker exec ci-notes node -e "const{DatabaseSync}=require(\"node:sqlite\");const db=new DatabaseSync(\"/app/data/ci-notes.sqlite\",{readOnly:true});console.log(\"works:\",db.prepare(\"SELECT COUNT(*) c FROM works\").get().c,\"notes:\",db.prepare(\"SELECT COUNT(*) c FROM notes\").get().c)"
'
```
期望：`{"ok":true}`、`(healthy)`、行数与 Step 1 快照一致。演练后的库即快照内容（几分钟前的当日数据，无实质损失）；`/tmp/ci-notes.pre-drill.*` 留底保留不删。

- [ ] **Step 3: 清理演练痕迹说明**

演练即最终态，无需回滚。向调度者汇报：快照文件名、quick_check 结果、演练前后健康与行数。

---

## 收尾（调度者执行，非子代理任务）

- 更新记忆 `ci-notes-135-deployment.md`：备份链路（01:00 快照/02:00 推送、目录、保留策略、ZSpace 账号）、恢复流程要点。
- 提交规格修订与计划文档（本文件；不含 API_KEY）。
