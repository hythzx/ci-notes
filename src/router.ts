/**
 * 哈希路由：解析 location.hash 为 { path, parts, query }，
 * useHashRoute 订阅 hashchange 供外壳切换视图。
 *
 * 匹配示例：parts[0]==='works' && parts.length===2 → work 详情（parts[1]）；
 * 带参数跳转用 navigate('/notes?workId=xx')，query 以 URLSearchParams 提供。
 */
import { useEffect, useState } from 'react';

export interface RouteMatch { path: string; parts: string[]; query: URLSearchParams }

function current(): RouteMatch {
  const raw = location.hash.slice(1) || '/';
  const [path, q = ''] = raw.split('?');
  return { path, parts: path.split('/').filter(Boolean), query: new URLSearchParams(q) };
}

export function navigate(to: string) { location.hash = to; }

export function useHashRoute(): RouteMatch {
  const [m, setM] = useState(current);
  useEffect(() => {
    const on = () => setM(current());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return m;
}
