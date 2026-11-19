/**
 * MCP 密钥管理视图：生成 / 撤销 / 重新启用密钥，端点说明与客户端配置片段。
 *
 * 照词间 mcp-keys 页语义，适配本服务（brief 为准），实现取舍：
 *   - freshCard：create 成功后的明文只存在组件 state 里，「我已保存，隐藏」
 *     清空，刷新 / 离开视图即丢失；服务端只存 SHA-256 哈希，无二次获取。
 *   - 复制走 navigator.clipboard.writeText，成功失败都给 toast。
 *   - 客户端示例不嵌入真实密钥：curl / Codex / 通用 JSON 用 <密钥> 占位，
 *     Claude Code 两种示例按 brief 用 CI_NOTES_MCP_KEY 环境变量携带明文。
 *   - curl 手测说明的工具数按服务端实况标注（34 个，test/mcp.test.mjs
 *     断言一致）；brief 中的「32」为工具表扩充前的旧数。
 *
 * 加载模式与 me.tsx / history.tsx 对齐：load() 返回清理函数做 alive 守卫；
 * 增删改后的列表刷新走 refresh()（不整页置空，避免闪加载态）。
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import { ApiError } from '../types';
import type { McpKey } from '../types';
import { Chip, ConfirmBox, EmptyState, notifyToast, relTime, Section } from '../components/ui';
import { Input } from '../components/editors';

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 复制到剪贴板，成功失败均 toast（ insecure 上下文 clipboard 不可用时给兜底文案） */
function copyText(text: string, okMsg = '已复制到剪贴板') {
  navigator.clipboard.writeText(text).then(
    () => notifyToast(okMsg),
    () => notifyToast('复制失败，请手动选择复制'),
  );
}

/* ------------------------------------------------------------------ */
/* 配置片段模板                                                        */
/* ------------------------------------------------------------------ */

/** Claude Code · 命令行：环境变量存明文，--header 引用（密钥不落文件） */
function claudeCliSnippet(endpoint: string): string {
  return [
    'claude mcp add --transport http ci-notes ' + endpoint + ' \\',
    '  --header "X-CiNotes-Key: ${CI_NOTES_MCP_KEY}"',
  ].join('\n');
}

/** Claude Code · .mcp.json：headers 里同样引用环境变量 */
function claudeJsonSnippet(endpoint: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        'ci-notes': {
          type: 'http',
          url: endpoint,
          headers: { 'X-CiNotes-Key': '${CI_NOTES_MCP_KEY}' },
        },
      },
    },
    null,
    2,
  );
}

/** Codex · config.toml：http_headers 需要写入密钥明文，注意别提交进仓库 */
function codexSnippet(endpoint: string): string {
  return [
    '[mcp_servers.ci-notes]',
    'url = "' + endpoint + '"',
    'http_headers = { "X-CiNotes-Key" = "<密钥>" }',
  ].join('\n');
}

/** 通用 HTTP 客户端：url + headers 两项 */
function httpSnippet(endpoint: string): string {
  return JSON.stringify(
    { url: endpoint, headers: { 'X-CiNotes-Key': '<密钥>' } },
    null,
    2,
  );
}

/* ------------------------------------------------------------------ */
/* 片段卡                                                              */
/* ------------------------------------------------------------------ */

/** 单份配置片段：标题 + 复制按钮 + 可选说明 + 代码框 */
function Snippet({ title, hint, code }: { title: string; hint?: string; code: string }) {
  return (
    <div className="cj-mcp-snippet">
      <div className="cj-item-head">
        <div className="cj-item-title" style={{ fontSize: 14 }}>{title}</div>
        <button type="button" className="cn-btn cn-btn-ghost cn-btn-sm" onClick={() => copyText(code)}>
          复制
        </button>
      </div>
      {hint ? <p className="cj-field-hint">{hint}</p> : null}
      <div className="cj-codebox">{code}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 视图                                                                */
/* ------------------------------------------------------------------ */

export function McpKeys() {
  const [keys, setKeys] = useState<McpKey[] | null>(null);
  const [error, setError] = useState('');

  /* 生成表单 */
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  /* freshCard：明文一次性，仅存于本组件 state */
  const [fresh, setFresh] = useState<{ key: string; record: McpKey } | null>(null);

  /* 撤销确认与进行中操作（busyId 防重复提交） */
  const [confirmRevoke, setConfirmRevoke] = useState<McpKey | null>(null);
  const [busyId, setBusyId] = useState('');

  /** 首次加载：置空列表进入加载态，返回清理函数做 alive 守卫 */
  function load(): () => void {
    let alive = true;
    setError('');
    setKeys(null);
    api.mcpKeys.list().then(
      (d) => {
        if (alive) setKeys(d);
      },
      (e: unknown) => {
        if (alive) setError(e instanceof ApiError ? e.message : '加载失败');
      },
    );
    return () => {
      alive = false;
    };
  }

  /** 静默刷新（生成 / 撤销 / 启用之后）：不整页置空 */
  function refresh() {
    api.mcpKeys.list().then(setKeys, () => notifyToast('刷新列表失败，请稍后重试'));
  }

  useEffect(load, []);

  function create() {
    const trimmed = name.trim();
    // 空名称前端先行拦截（服务端同语义 400「密钥名称不能为空」）
    if (!trimmed || creating) return;
    setCreating(true);
    api.mcpKeys.create(trimmed).then(
      (r) => {
        setCreating(false);
        setName('');
        setFresh({ key: r.key, record: r.record });
        notifyToast('密钥已生成，请立即复制保存');
        refresh();
      },
      (e: unknown) => {
        setCreating(false);
        notifyToast(e instanceof ApiError ? e.message : '生成失败，请稍后重试');
      },
    );
  }

  function doRevoke() {
    const key = confirmRevoke;
    if (!key || busyId) return;
    setBusyId(key.id);
    api.mcpKeys.revoke(key.id).then(
      () => {
        setBusyId('');
        setConfirmRevoke(null);
        notifyToast('已撤销「' + key.name + '」');
        refresh();
      },
      (e: unknown) => {
        setBusyId('');
        setConfirmRevoke(null);
        notifyToast(e instanceof ApiError ? e.message : '撤销失败，请稍后重试');
      },
    );
  }

  function enable(key: McpKey) {
    if (busyId) return;
    setBusyId(key.id);
    api.mcpKeys.enable(key.id).then(
      () => {
        setBusyId('');
        notifyToast('已启用「' + key.name + '」');
        refresh();
      },
      (e: unknown) => {
        setBusyId('');
        notifyToast(e instanceof ApiError ? e.message : '启用失败，请稍后重试');
      },
    );
  }

  const endpoint = location.origin + '/mcp';
  const curl = [
    'curl -s -X POST ' + endpoint + " -H 'Content-Type: application/json' -H 'X-CiNotes-Key: <密钥>' \\",
    "  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' | head -c 300",
  ].join('\n');

  return (
    <div className="cj-page cj-narrow">
      <div className="cj-pagehead">
        <a className="cj-backlink" href="#/me">‹ 我的</a>
        <h1 className="cj-h1">MCP 密钥</h1>
      </div>

      <Section title="生成新密钥">
        <div className="cj-card cj-mcp-item">
          <div className="cn-coderow">
            <div className="cn-field">
              <span className="cn-field-label">名称</span>
              <Input
                value={name}
                placeholder="给密钥起个名字，比如「我的笔记本」"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="cn-btn cn-btn-primary"
              disabled={!name.trim() || creating}
              onClick={create}
            >
              {creating ? '生成中…' : '生成新密钥'}
            </button>
          </div>
          <p className="cn-field-hint">明文只在生成时显示一次，请准备好粘贴的地方再点生成。</p>
        </div>
      </Section>

      {fresh ? (
        <div className="cj-card cj-mcp-item cj-mcp-fresh">
          <div className="cj-item-head">
            <div className="cj-item-title">新密钥已生成：{fresh.record.name}</div>
            <Chip tone="verified">生效中</Chip>
          </div>
          <div className="cj-codebox cj-mono" style={{ marginTop: 12 }}>{fresh.key}</div>
          <p className="cn-field-hint">
            这是密钥明文，只显示这一次。请立即复制保存；刷新或离开本页后将无法找回，服务器只保存哈希。
          </p>
          <div className="cj-item-foot">
            <button type="button" className="cn-btn cn-btn-primary cn-btn-sm" onClick={() => copyText(fresh.key, '密钥已复制')}>
              复制密钥
            </button>
            <button type="button" className="cn-btn cn-btn-quiet cn-btn-sm" onClick={() => setFresh(null)}>
              我已保存，隐藏
            </button>
          </div>
        </div>
      ) : null}

      <Section title="我的密钥">
        {error ? (
          <div className="cj-card">
            <EmptyState text={'密钥列表暂时打不开（' + error + '）。'} />
            <div style={{ textAlign: 'center' }}>
              <button type="button" className="cn-btn cn-btn-ghost" onClick={load}>重试</button>
            </div>
          </div>
        ) : !keys ? (
          <div className="cj-card">
            <EmptyState text="正在读取密钥列表…" />
          </div>
        ) : !keys.length ? (
          <div className="cj-card">
            <EmptyState text="还没有密钥。生成一个，给智能体开一条访问通道。" />
          </div>
        ) : (
          <div className="cj-list">
            {keys.map((k) => (
              <div className="cj-card cj-mcp-item" key={k.id}>
                <div className="cj-item-head">
                  <div>
                    <div className="cj-item-title">{k.name}</div>
                    <div className="cj-item-meta cj-mono">{k.prefix}…</div>
                  </div>
                  {k.status === 'active' ? <Chip tone="verified">生效中</Chip> : <Chip tone="muted">已撤销</Chip>}
                </div>
                <div className="cj-item-foot">
                  <span className="cj-item-time">创建于 {relTime(k.createdAt)}</span>
                  <span className="cj-item-time">
                    最近使用 {k.lastUsedAt ? relTime(k.lastUsedAt) : '还没有被使用过'}
                  </span>
                  {k.revokedAt ? <span className="cj-item-time">撤销于 {relTime(k.revokedAt)}</span> : null}
                </div>
                <div className="cj-item-foot">
                  {k.status === 'active' ? (
                    <button
                      type="button"
                      className="cn-btn cn-btn-danger cn-btn-sm"
                      disabled={busyId === k.id}
                      onClick={() => setConfirmRevoke(k)}
                    >
                      撤销
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="cn-btn cn-btn-ghost cn-btn-sm"
                      disabled={busyId === k.id}
                      onClick={() => enable(k)}
                    >
                      重新启用
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="服务端点">
        <div className="cj-card cj-mcp-item">
          <p className="cj-me-p">
            智能体通过 MCP 端点访问本库，认证一律走 <code>X-CiNotes-Key</code> 请求头（不使用登录会话）。
          </p>
          <div className="cj-codebox cj-mono">{endpoint}</div>
          <p className="cn-field-hint" style={{ marginTop: 10 }}>手测：把 <code>&lt;密钥&gt;</code> 换成任一生效中密钥的明文，应返回 JSON，其中 tools 数组包含全部工具（当前 34 个）。</p>
          <div className="cj-codebox">{curl}</div>
        </div>
      </Section>

      <Section title="客户端配置">
        <div className="cj-card cj-mcp-item cj-mcp-snippets">
          <Snippet
            title="Claude Code · 命令行添加"
            hint="先用 export CI_NOTES_MCP_KEY=明文密钥 设好环境变量再执行；密钥不落任何文件。"
            code={claudeCliSnippet(endpoint)}
          />
          <Snippet
            title="Claude Code · .mcp.json"
            hint="同样引用 CI_NOTES_MCP_KEY 环境变量，.mcp.json 本身不含明文，可放心入库。"
            code={claudeJsonSnippet(endpoint)}
          />
          <Snippet
            title="Codex · config.toml"
            hint="http_headers 里需写入密钥明文；config.toml 通常在个人目录，注意别提交进仓库。"
            code={codexSnippet(endpoint)}
          />
          <Snippet
            title="通用 HTTP 客户端"
            hint="任何能发 JSON-RPC 的 HTTP 客户端都行，关键是带上 X-CiNotes-Key 头。"
            code={httpSnippet(endpoint)}
          />
        </div>
      </Section>

      <Section title="关于安全">
        <div className="cj-card cj-mcp-item">
          <ul className="cj-ul">
            <li>服务器只保存密钥的 SHA-256 哈希，无法帮你找回明文。</li>
            <li>明文只在生成那一刻显示一次，离开本页即不可再取。</li>
            <li>撤销即时生效，使用该密钥的智能体随即便失去访问权限。</li>
            <li>服务端校验请求 Origin 与主机一致，防 DNS 重绑定。</li>
            <li>登录会话与 MCP 密钥是两条独立通道：网页走会话 Cookie，智能体走 X-CiNotes-Key 头。</li>
          </ul>
        </div>
      </Section>

      {confirmRevoke ? (
        <ConfirmBox
          title={'撤销「' + confirmRevoke.name + '」'}
          danger
          message="撤销后使用该密钥的智能体将立即失去访问权限。"
          onOk={doRevoke}
          onCancel={() => setConfirmRevoke(null)}
        />
      ) : null}
    </div>
  );
}
