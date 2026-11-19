/**
 * REST API 客户端：对 server/app.mjs 各端点的薄封装。
 * 错误契约：401 派发 cn:unauthorized 事件；其余非 2xx 抛 ApiError
 * （code/message 取自响应体 {error:{code,message,current?}}）。
 * 返回类型与 server/core 各模块的实际返回形状一致。
 */
import type {
  Allusion,
  AllusionCompare,
  AllusionDetail,
  AllusionFilter,
  AllusionImpact,
  AllusionList,
  AllusionUse,
  AllusionWorkFilter,
  Comparison,
  ComparisonDetail,
  ComparisonSummary,
  CreateMcpKeyResult,
  DeleteAllusionResult,
  DeleteImageryResult,
  HomeData,
  Imagery,
  ImageryCompare,
  ImageryDetail,
  ImageryFilter,
  ImageryImpact,
  ImageryList,
  ImageryUse,
  ImageryWorkFilter,
  McpKey,
  MergeAllusionResult,
  MergeImageryResult,
  MergeResult,
  Note,
  NoteDetail,
  NoteFilter,
  NoteSummary,
  Preflight,
  PurgeTrashResult,
  RestoredTrashItem,
  RevisionCompare,
  RevisionRecord,
  RevisionRow,
  SaveNoteResult,
  SearchResult,
  StatsData,
  TrashItem,
  UseListFilter,
  Work,
  WorkDetail,
  WorkFilter,
  WorkSummary,
} from './types';
import { ApiError } from './types';

/** 统一请求入口：JSON 头 + 401 事件 + 错误归一化 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init });
  if (res.status === 401) {
    window.dispatchEvent(new Event('cn:unauthorized'));
    throw new ApiError('UNAUTHORIZED', '未登录', 401);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      body?.error?.code ?? 'ERROR',
      body?.error?.message ?? `请求失败（${res.status}）`,
      res.status,
      body?.error?.current,
    );
  }
  return body as T;
}

/** 查询参数序列化：跳过 undefined/空串/null（入参为各筛选接口类型，无索引签名） */
const qs = (p: object) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (v !== undefined && v !== '' && v !== null) u.set(k, String(v));
  }
  const s = u.toString();
  return s ? '?' + s : '';
};

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const put = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body) });
const del: RequestInit = { method: 'DELETE' };

/** 乐观锁字段：与 app.mjs casArgs 约定一致（force 仅 true 时生效） */
interface CasFields {
  baseRevision?: number;
  force?: boolean;
}

export const api = {
  home: () => request<HomeData>('/api/home'),
  stats: () => request<StatsData>('/api/stats'),
  search: (q: string) => request<SearchResult>('/api/search' + qs({ q })),

  /* ---------------- 词作 ---------------- */
  works: {
    list: (p: WorkFilter = {}) => request<WorkSummary[]>('/api/works' + qs(p)),
    get: (id: string) => request<WorkDetail>('/api/works/' + id),
    // 服务端 201 直接返回 work 对象（createWork 不包 {work}）
    create: (input: Partial<Work>) => request<Work>('/api/works', post(input)),
    update: (id: string, input: Partial<Work> & CasFields) =>
      request<{ work: Work }>('/api/works/' + id, put(input)),
    remove: (id: string) => request<{ trashed: boolean }>('/api/works/' + id, del),
  },

  /* ---------------- 札记与版本 ---------------- */
  notes: {
    list: (p: NoteFilter = {}) => request<NoteSummary[]>('/api/notes' + qs(p)),
    get: (id: string) => request<NoteDetail>('/api/notes/' + id),
    create: (input: Partial<Note>) =>
      request<{ note: Note; revision: RevisionRecord }>('/api/notes', post(input)),
    // 定稿/已发布保护：服务端改为创建派生草稿并返回 {createdDraft:true, note, draft}
    update: (id: string, input: Partial<Note> & CasFields) =>
      request<SaveNoteResult>('/api/notes/' + id, put(input)),
    remove: (id: string) => request<{ trashed: boolean }>('/api/notes/' + id, del),
    revisions: (id: string) => request<RevisionRow[]>('/api/notes/' + id + '/revisions'),
    compare: (id: string, a: string, b: string) =>
      request<RevisionCompare>('/api/notes/' + id + '/revisions/compare' + qs({ a, b })),
    // 恢复为独立新草稿，201 返回 {draft}
    restore: (id: string, revisionId: string) =>
      request<{ draft: Note }>('/api/notes/' + id + '/revisions/' + revisionId + '/restore', post()),
    // 服务端直接返回解除保护后的 note 对象
    unprotect: (id: string) => request<Note>('/api/notes/' + id + '/unprotect', post()),
  },

  /* ---------------- 词作对照 ---------------- */
  comparisons: {
    list: () => request<ComparisonSummary[]>('/api/comparisons'),
    get: (id: string) => request<ComparisonDetail>('/api/comparisons/' + id),
    // payload 含 workAId/workBId/title/dimensions；无 id 新建（201）
    create: (input: Partial<Comparison>) => request<Comparison>('/api/comparisons', post(input)),
    update: (id: string, input: Partial<Comparison>) =>
      request<Comparison>('/api/comparisons/' + id, put(input)),
    remove: (id: string) => request<{ id: string }>('/api/comparisons/' + id, del),
  },

  /* ---------------- 意象库 ---------------- */
  imagery: {
    list: (p: ImageryFilter = {}) => request<ImageryList>('/api/imagery' + qs(p)),
    get: (id: string, p: ImageryWorkFilter = {}) => request<ImageryDetail>('/api/imagery/' + id + qs(p)),
    create: (input: Partial<Imagery>) => request<Imagery>('/api/imagery', post(input)),
    update: (id: string, input: Partial<Imagery> & CasFields) =>
      request<Imagery>('/api/imagery/' + id, put(input)),
    remove: (id: string) => request<DeleteImageryResult>('/api/imagery/' + id, del),
    merge: (id: string, intoId: string) =>
      request<MergeImageryResult>('/api/imagery/' + id + '/merge', post({ intoId })),
    impact: (id: string) => request<ImageryImpact>('/api/imagery/' + id + '/impact'),
    compare: (a: string, b: string) => request<ImageryCompare>('/api/imagery/compare' + qs({ a, b })),
    uses: {
      list: (p: UseListFilter) => request<ImageryUse[]>('/api/imagery-uses' + qs(p)),
      create: (input: Partial<ImageryUse>) => request<ImageryUse>('/api/imagery-uses', post(input)),
      update: (id: string, input: Partial<ImageryUse> & CasFields) =>
        request<ImageryUse>('/api/imagery-uses/' + id, put(input)),
      remove: (id: string) => request<{ id: string }>('/api/imagery-uses/' + id, del),
    },
  },

  /* ---------------- 典故库（与意象同构） ---------------- */
  allusions: {
    list: (p: AllusionFilter = {}) => request<AllusionList>('/api/allusions' + qs(p)),
    get: (id: string, p: AllusionWorkFilter = {}) => request<AllusionDetail>('/api/allusions/' + id + qs(p)),
    create: (input: Partial<Allusion>) => request<Allusion>('/api/allusions', post(input)),
    update: (id: string, input: Partial<Allusion> & CasFields) =>
      request<Allusion>('/api/allusions/' + id, put(input)),
    remove: (id: string) => request<DeleteAllusionResult>('/api/allusions/' + id, del),
    merge: (id: string, intoId: string) =>
      request<MergeAllusionResult>('/api/allusions/' + id + '/merge', post({ intoId })),
    impact: (id: string) => request<AllusionImpact>('/api/allusions/' + id + '/impact'),
    compare: (a: string, b: string) => request<AllusionCompare>('/api/allusions/compare' + qs({ a, b })),
    uses: {
      list: (p: UseListFilter) => request<AllusionUse[]>('/api/allusion-uses' + qs(p)),
      create: (input: Partial<AllusionUse>) => request<AllusionUse>('/api/allusion-uses', post(input)),
      update: (id: string, input: Partial<AllusionUse> & CasFields) =>
        request<AllusionUse>('/api/allusion-uses/' + id, put(input)),
      remove: (id: string) => request<{ id: string }>('/api/allusion-uses/' + id, del),
    },
  },

  /* ---------------- 回收站 ---------------- */
  trash: {
    list: () => request<TrashItem[]>('/api/trash'),
    restore: (id: string) => request<RestoredTrashItem>('/api/trash/' + id + '/restore', post()),
    purge: (id: string) => request<PurgeTrashResult>('/api/trash/' + id, del),
  },

  /* ---------------- 备份与导入 ---------------- */
  backup: {
    /** GET 端点带附件头，导出走 window.open / <a download> */
    exportUrl: '/api/export',
    preflight: (backup: unknown) => request<Preflight>('/api/import', post({ mode: 'preflight', backup })),
    merge: (backup: unknown) => request<MergeResult>('/api/import', post({ mode: 'merge', backup })),
  },

  /* ---------------- MCP 密钥 ---------------- */
  mcpKeys: {
    list: () => request<McpKey[]>('/api/mcp-keys'),
    create: (name: string) => request<CreateMcpKeyResult>('/api/mcp-keys', post({ name })),
    revoke: (id: string) => request<{ ok: true }>('/api/mcp-keys/' + id + '/revoke', post()),
    enable: (id: string) => request<{ ok: true }>('/api/mcp-keys/' + id + '/enable', post()),
  },

  /* ---------------- 会话 ---------------- */
  login: (username: string, password: string) =>
    request<{ ok: true }>('/api/login', post({ username, password })),
  logout: () => request<{ ok: true }>('/api/logout', post()),
};
