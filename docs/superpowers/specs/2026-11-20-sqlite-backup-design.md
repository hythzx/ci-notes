# ci-notes SQLite 自动备份设计

日期：2026-11-20
状态：已确认（用户批准，调整项：备份时间定于每日 01:00）

## 背景与问题

ci-notes 生产实例部署在 192.168.3.135（docker compose，数据为 SQLite WAL 模式，
位于命名卷 `ci-notes_ci-notes-data`）。当前状况：

- 应用具备 JSON 备份导出/导入（`GET /api/export`、`POST /api/import`），但依赖用户手动操作；
- `scripts/backup.mjs` 提供 SQLite 物理备份 CLI（`node:sqlite` backup API，
  WAL 模式下生成事务一致性在线快照），但没有任何调度机制——服务器上
  `/app/backups` 目录为空，该脚本从未运行；
- 数据仅存在于 135 一台机器，无异地副本，机器故障即数据全丢；
- `/app/backups` 未挂载到宿主机，备份产物无法取出。

总数据量：主库约 352KB + WAL 约 98KB（约 500KB）。

## 需求（澄清结论）

| 项 | 结论 |
|---|---|
| 核心担忧 | 机器故障数据全丢；无自动备份流程；SQLite 备份过程安全性 |
| 备份目的地 | 用户 NAS 上的 MinIO（S3 兼容） |
| 执行方式 | 1Panel 计划任务（135 已运行 1Panel） |
| 备份形式 | 仅 SQLite 物理快照（不做 JSON 双格式） |
| 备份时间 | 快照生成每日 01:00，目录备份推送每日 02:00 |
| 不在范围 | 精细时点回滚（PITR）；应用代码改动 |

SQLite 备份安全性说明：`node:sqlite` 的 `backup()` 底层为 SQLite 官方
`sqlite3_backup_*` 在线备份接口，WAL 模式下对运行中的库生成事务一致性快照，
无需停服，无半成品文件风险。备份安全性由现有脚本保证，本设计不改动。

## 架构

```
ci-notes 容器 (SQLite, WAL)
   │ docker exec node scripts/backup.mjs        ← 事务一致性在线快照
   ▼
/opt/ci-notes/backups/（bind mount，本地保留 7 份）
   │ 1Panel 计划任务「目录备份」（tar.gz 打包）
   ▼
MinIO bucket ci-notes-backups（NAS，S3 兼容，保留 30 份）
```

## 变更内容

### 1. compose 增加备份目录挂载

`/opt/ci-notes/docker-compose.yml` 的 `ci-notes` 服务 volumes 增加：

```yaml
    volumes:
      - ci-notes-data:/app/data
      - ./backups:/app/backups
```

宿主机 `/opt/ci-notes/backups` 目录预先创建并 `chown 1000:1000`（容器内
node 用户可写）。重建容器：命名卷数据不受影响。

### 2. 计划任务一：快照生成（shell 脚本，每日 01:00）

内容：`docker exec ci-notes node scripts/backup.mjs` 生成
`ci-notes-<时间戳>.sqlite` 至容器 `/app/backups`（宿主机可见），随后本地轮转
——仅保留最新 7 份，删除更早的快照。脚本为容器复用现有 `scripts/backup.mjs`，
零代码改动；失败（容器未运行、库文件不存在、目标已存在）时退出码非 0，
1Panel 可标记任务失败并触发通知。

### 3. 计划任务二：目录备份推送（目录备份，每日 02:00)

1Panel「目录备份」类型计划任务，备份目录 `/opt/ci-notes/backups`，
推送目标为 MinIO 存储账号，保留 30 份。晚于任务一 1 小时，
保证每次推送包含当天 01:00 的新快照。

### 4. 1Panel 存储账号与 API（实施修订，2026-11-20）

实施侦察发现 1Panel（v2.5.1）中已配置 MinIO 存储账号「ZSpace」（MINIO 类型，
bucket `1panel`），**直接复用，不新建存储账号**；规格原定的
`ci-notes-backups` bucket 取消，ci-notes 备份落在 ZSpace 账号的备份路径下，
由目录备份任务名区分。两个计划任务经 1Panel API 创建（API 接口已由用户开启），
密钥仅在执行时经 SSH 于 135 本机使用，不落仓库。

## 容量估算

快照单份约 350KB。本地 7 份 + 远端 30 份合计约 13MB，增长无压力。

## 验证与恢复

### 部署后验证

1. 手动触发任务一与任务二；
2. 确认 MinIO 上出现 tar.gz 产物；
3. 下载解包，`PRAGMA quick_check` 校验快照完整性；
4. 用该快照对 135 做一次真实恢复演练。

### 恢复流程（写入文档）

停容器 → 用快照替换数据卷内 `ci-notes.sqlite`（同时删除 `-wal`/`-shm`）→
起容器 → `/api/health` 返回 200 即恢复完成。

### 失败场景测试

容器停止状态下手动触发任务一，确认退出码非 0 且 1Panel 记录失败。

## 实施注意事项

- MinIO 凭据经 1Panel UI 配置，不落仓库、不写入命令行历史；
- compose 变更只增一行挂载，其余服务定义（read_only、cap_drop 等）不动；
- 若 1Panel 重新生成站点反代配置，与本设计无关，不涉及。
