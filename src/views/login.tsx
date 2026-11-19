/**
 * 登录视图：单用户用户名/密码表单，迁移自旧 App.tsx 内嵌登录页的文案与交互。
 *
 * 401 错误文案说明（Task 17 审查裁定）：api.login 密码错误时服务端返回 401，
 * api.ts 的 request 包装层会先派发 'cn:unauthorized' 事件（登录页本身处于未
 * 登录态，外壳对该事件的处理在此场景无副作用），再抛
 * ApiError('UNAUTHORIZED', '未登录')——message 是包装层固定文案，不是服务端
 * 返回的错误说明。因此本视图复用 api.login（免自行 fetch/解析 JSON），但
 * 不依赖其 message：按 err.status === 401 显示「用户名或密码不正确」，其余
 * 失败显示通用文案。
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import { ApiError } from '../types';
import { Field, Input } from '../components/editors';
import { navigate } from '../router';

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!username || !password || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.login(username, password);
      // 会话 Cookie 不回传用户名：按约定键记录，「我的」页账号卡读取（Task 34 裁定）
      localStorage.setItem('cn:username', username);
      navigate('/');
      // 登录态切换信号：外壳监听后刷新登录态与视图数据（Task 34 消费）
      window.dispatchEvent(new Event('cn:auth'));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? '用户名或密码不正确' : '登录失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cn-authpage">
      {/* cj-card / cj-btn-block：cn- 集未提供卡片底与通栏按钮工具类，取 cj- 同款 */}
      <form className="cj-card cn-authcard" onSubmit={submit}>
        <div className="cn-auth-title">词间</div>
        <p className="cn-auth-sub">诗词与寻常心事</p>
        {error ? <div className="cn-error">{error}</div> : null}
        <Field label="用户名">
          <Input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="密码">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <div className="cn-authops">
          <button
            type="submit"
            className="cn-btn cn-btn-primary cj-btn-block"
            disabled={busy || !username || !password}
          >
            {busy ? '登录中…' : '登录'}
          </button>
        </div>
        <p className="cn-auth-note">私人写作空间 · 请先登录</p>
      </form>
    </div>
  );
}
