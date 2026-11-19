/**
 * 实体与接口返回类型。字段与 server/core 各模块的实际返回形状一一对应，
 * 后续视图层统一从这里取类型；src/api.ts 为薄封装。
 *
 * 两处与任务简报的偏差（以服务端实际返回为准）：
 *   - RevisionRow 采用 listRevisions 的列表摘要形状（无 snapshot/noteId，多 charCount/writingStatus），
 *     简报中的完整版本行形状保留为 RevisionRecord（createNote 返回值与备份导出使用）；
 *   - Allusion 补充 mergedInto 字段（服务端 payload 含该字段，合并语义与 Imagery 相同）。
 */

/* ------------------------------------------------------------------ */
/* 标注与出处                                                          */
/* ------------------------------------------------------------------ */

/** 可信度等级：verified 级资料必须自带至少一条出处（服务端强制） */
export type ClaimKind = 'verified' | 'pending' | 'personal';

export interface Citation {
  id: string;
  book: string;
  edition: string;
  page: string;
  url: string;
  note: string;
  verified: ClaimKind;
}

export interface Claim {
  id: string;
  kind: ClaimKind;
  text: string;
  paragraph: number;
  citations: Citation[];
  createdAt?: string;
  updatedAt?: string;
}

/** 常见表达用途（Imagery/Allusion 通用资料上的条目） */
export interface UsageEntry {
  text: string;
  kind: ClaimKind;
}

/* ------------------------------------------------------------------ */
/* 词作                                                                */
/* ------------------------------------------------------------------ */

export type WorkKind = 'ci' | 'poem';

export interface Work {
  id: string;
  kind: WorkKind;
  title: string;
  author: string;
  dynasty: string;
  cipai: string;
  content: string;
  background: string;
  claims: Claim[];
  citations: Citation[];
  tags: string[];
  relatedWorkIds: string[];
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 列表摘要（GET /api/works 与全局搜索复用） */
export interface WorkSummary {
  id: string;
  title: string;
  author: string;
  dynasty: string;
  cipai: string;
  kind: WorkKind;
  excerpt: string;
  firstLine: string;
  tags: string[];
  pendingClaims: number;
  noteCount: number;
  updatedAt: string;
}

/** 列表筛选参数（全部可选，空值由 api 层剔除） */
export interface WorkFilter {
  q?: string;
  author?: string;
  cipai?: string;
  tag?: string;
  kind?: WorkKind;
}

/** 词作详情里关联词作的精简引用 */
export interface SimpleWorkRef {
  id: string;
  title: string;
  author: string;
}

/* ------------------------------------------------------------------ */
/* 札记                                                                */
/* ------------------------------------------------------------------ */

export type WritingStatus = 'idea' | 'research' | 'draft' | 'final';
export type PublishStatus = 'unpublished' | 'pending' | 'published';

/** 发布登记：纯字符串三元组 */
export interface PublishInfo {
  platform: string;
  publishedAt: string;
  url: string;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  note: string;
  workIds: string[];
  claims: Claim[];
  citations: Citation[];
  tags: string[];
  writingStatus: WritingStatus;
  publishStatus: PublishStatus;
  publish: PublishInfo;
  changeNote: string;
  pendingImport?: boolean;
  draftOf?: string;
  draftNoteId?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 列表摘要（GET /api/notes、搜索、首页 recent 复用） */
export interface NoteSummary {
  id: string;
  title: string;
  excerpt: string;
  tags: string[];
  writingStatus: WritingStatus;
  publishStatus: PublishStatus;
  pendingImport?: boolean;
  draftOf?: string;
  draftNoteId?: string;
  updatedAt: string;
  charCount?: number;
}

/** 列表筛选参数 */
export interface NoteFilter {
  q?: string;
  writingStatus?: WritingStatus;
  publishStatus?: PublishStatus;
  workId?: string;
  tag?: string;
}

/** 词作详情里关联札记的摘要形状（works.mjs noteSummary，与列表摘要不同构） */
export interface LinkedNoteSummary {
  id: string;
  title: string;
  tags: string[];
  writingStatus: WritingStatus;
  publishStatus: PublishStatus;
  createdAt: string;
  updatedAt: string;
  excerpt: string;
  wordCount: number;
  workIds: string[];
}

/** work.claims 按 kind 分组（getNote 装配） */
export interface ClaimGroups {
  verified: Claim[];
  pending: Claim[];
  personal: Claim[];
}

/** 札记详情里关联词作：payload + 分组后的可信度资料 */
export interface LinkedWorkEntry {
  work: Work;
  claimGroups: ClaimGroups;
}

/* ------------------------------------------------------------------ */
/* 版本                                                                */
/* ------------------------------------------------------------------ */

export type RevisionReason = 'manual' | 'draft-from-final' | 'restore' | 'conflict-overwrite';

/**
 * 版本列表行（GET /api/notes/:id/revisions）：
 * 摘要形状，随行携带快照的 title/content（历史页「看内容」展开
 * 与「导出这一版」使用）。
 */
export interface RevisionRow {
  id: string;
  seq: number;
  createdAt: string;
  changeNote: string;
  reason: RevisionReason;
  charCount: number;
  writingStatus: WritingStatus;
  title: string;
  content: string;
}

/** 完整版本行：createNote 返回值与备份导出 data.revisions 使用 */
export interface RevisionRecord {
  id: string;
  noteId: string;
  seq: number;
  snapshot: Partial<Note>;
  changeNote: string;
  reason: RevisionReason;
  createdAt: string;
}

/** 版本比较时两侧版本的元信息 */
export interface RevisionMeta {
  id: string;
  seq: number;
  createdAt: string;
  changeNote: string;
  title: string;
}

/** 字级差异片段 */
export interface CharSegment {
  type: 'equal' | 'delete' | 'insert';
  text: string;
}

/** 行级差异行：change 行附字级 segments */
export interface DiffRow {
  type: 'equal' | 'delete' | 'insert' | 'change';
  a: string | null;
  b: string | null;
  segments?: CharSegment[];
}

export interface DiffStats {
  added: number;
  removed: number;
  changed: number;
  same: number;
}

/** 版本比较结果（GET .../revisions/compare） */
export interface RevisionCompare {
  a: RevisionMeta;
  b: RevisionMeta;
  rows: DiffRow[];
  stats: DiffStats;
}

/**
 * 保存札记的两种结果：
 *   - 正常保存：{ note, revision, createdDraft: false }
 *   - 定稿/已发布保护：原稿一字不动，另起派生草稿
 */
export type SaveNoteResult =
  | { note: Note; revision: RevisionRecord; createdDraft: false }
  | { createdDraft: true; note: Note; draft: Note };

/* ------------------------------------------------------------------ */
/* 词作对照                                                            */
/* ------------------------------------------------------------------ */

export type CompareDimKey =
  | 'context'
  | 'imagery'
  | 'allusion'
  | 'expression'
  | 'similarity'
  | 'difference'
  | 'understanding';

export interface CompareDimension {
  text: string;
  kind: ClaimKind;
  citations: Citation[];
  sides?: { a: string; b: string };
}

export interface Comparison {
  id: string;
  title: string;
  workAId: string;
  workBId: string;
  dimensions: Record<CompareDimKey, CompareDimension>;
  createdAt: string;
  updatedAt: string;
}

/** 对照列表摘要：含已写维度计数与双侧标题（已删词作显示占位文案） */
export interface ComparisonSummary {
  id: string;
  title: string;
  workAId: string;
  workBId: string;
  workATitle: string;
  workBTitle: string;
  writtenCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 对照详情：甲乙词作已删时为 null */
export interface ComparisonDetail {
  comparison: Comparison;
  workA: Work | null;
  workB: Work | null;
}

/* ------------------------------------------------------------------ */
/* 意象库                                                              */
/* ------------------------------------------------------------------ */

export interface Imagery {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  usages: UsageEntry[];
  claims: Claim[];
  citations: Citation[];
  tags: string[];
  note: string;
  /** 被合并到的目标意象 id；空串表示未被合并 */
  mergedInto: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 意象使用记录：表达作用字段前后端统一为 fn */
export interface ImageryUse {
  id: string;
  imageryId: string;
  targetType: 'work' | 'note';
  targetId: string;
  quote: string;
  context: string;
  fn: string;
  understanding: string;
  claims: Claim[];
  citations: Citation[];
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 使用记录计数：works/notes 为去重目标数 */
export interface ImageryCounts {
  works: number;
  notes: number;
  uses: number;
  quotes: number;
}

/** 详情装配条目：某目标下按意象分组的使用记录 */
export interface ImageryEntry {
  imagery: Imagery;
  uses: ImageryUse[];
}

/** 意象列表条目 */
export interface ImageryListItem {
  imagery: Imagery;
  counts: ImageryCounts;
}

export interface ImageryList {
  entries: ImageryListItem[];
}

/** 意象详情：通用资料 + 全部使用记录 + 关联作品/札记（各自带对应 uses） */
export interface ImageryDetail {
  imagery: Imagery;
  uses: ImageryUse[];
  works: { work: Work; uses: ImageryUse[] }[];
  notes: { note: Note; uses: ImageryUse[] }[];
  counts: ImageryCounts;
}

/** 双作品意象对照：只统计已记录的关联 */
export interface ImageryCompare {
  shared: { imagery: Imagery; usesA: ImageryUse[]; usesB: ImageryUse[] }[];
  onlyA: { imagery: Imagery; usesA: ImageryUse[] }[];
  onlyB: { imagery: Imagery; usesB: ImageryUse[] }[];
}

/** 删除/合并影响：只删实体与使用记录，不连带删作品或札记 */
export interface ImageryImpact {
  uses: number;
  works: number;
  notes: number;
  workIds: string[];
  noteIds: string[];
}

export interface MergeImageryResult {
  from: Imagery;
  to: Imagery;
  movedUses: number;
}

export interface DeleteImageryResult {
  id: string;
  removed: ImageryImpact;
}

/** 意象列表筛选 */
export interface ImageryFilter {
  q?: string;
  tag?: string;
  includeMerged?: boolean;
}

/** 详情里筛关联作品 */
export interface ImageryWorkFilter {
  author?: string;
  cipai?: string;
  tag?: string;
}

/** 使用记录列表查询：targetType/targetId 必填（服务端强校验） */
export interface UseListFilter {
  targetType: 'work' | 'note';
  targetId: string;
}

/* ------------------------------------------------------------------ */
/* 典故库（与意象同构，表达作用字段为 interpretation）                  */
/* ------------------------------------------------------------------ */

export interface Allusion {
  id: string;
  name: string;
  aliases: string[];
  /** 出处典籍 */
  source: string;
  /** 典故原文 */
  original: string;
  /** 通用释义 */
  explanation: string;
  usages: UsageEntry[];
  claims: Claim[];
  citations: Citation[];
  tags: string[];
  note: string;
  /** 被合并到的目标典故 id；空串表示未被合并 */
  mergedInto: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 典故使用记录：表达作用字段为 interpretation */
export interface AllusionUse {
  id: string;
  allusionId: string;
  targetType: 'work' | 'note';
  targetId: string;
  quote: string;
  context: string;
  interpretation: string;
  understanding: string;
  claims: Claim[];
  citations: Citation[];
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface AllusionCounts {
  works: number;
  notes: number;
  uses: number;
  quotes: number;
}

export interface AllusionEntry {
  allusion: Allusion;
  uses: AllusionUse[];
}

export interface AllusionListItem {
  allusion: Allusion;
  counts: AllusionCounts;
}

export interface AllusionList {
  entries: AllusionListItem[];
}

export interface AllusionDetail {
  allusion: Allusion;
  uses: AllusionUse[];
  works: { work: Work; uses: AllusionUse[] }[];
  notes: { note: Note; uses: AllusionUse[] }[];
  counts: AllusionCounts;
}

export interface AllusionCompare {
  shared: { allusion: Allusion; usesA: AllusionUse[]; usesB: AllusionUse[] }[];
  onlyA: { allusion: Allusion; usesA: AllusionUse[] }[];
  onlyB: { allusion: Allusion; usesB: AllusionUse[] }[];
}

export interface AllusionImpact {
  uses: number;
  works: number;
  notes: number;
  workIds: string[];
  noteIds: string[];
}

export interface MergeAllusionResult {
  from: Allusion;
  to: Allusion;
  movedUses: number;
}

export interface DeleteAllusionResult {
  id: string;
  removed: AllusionImpact;
}

export interface AllusionFilter {
  q?: string;
  tag?: string;
  includeMerged?: boolean;
}

export interface AllusionWorkFilter {
  author?: string;
  cipai?: string;
  tag?: string;
}

/* ------------------------------------------------------------------ */
/* 实体详情聚合                                                        */
/* ------------------------------------------------------------------ */

/** getWork 返回：imagery 下同时装配意象与典故两组条目 */
export interface WorkDetail {
  work: Work;
  relatedWorks: SimpleWorkRef[];
  linkedNotes: LinkedNoteSummary[];
  imagery: {
    entries: ImageryEntry[];
    allusions: { entries: AllusionEntry[] };
  };
}

/** getNote 返回 */
export interface NoteDetail {
  note: Note;
  linkedWorks: LinkedWorkEntry[];
  imagery: {
    entries: ImageryEntry[];
    allusions: { entries: AllusionEntry[] };
  };
}

/* ------------------------------------------------------------------ */
/* 回收站                                                              */
/* ------------------------------------------------------------------ */

export interface TrashItem {
  id: string;
  itemType: 'work' | 'note';
  itemId: string;
  label: string;
  preview: string;
  trashedAt: string;
}

/** 恢复成功返回的回收站项（无 preview 字段）；同 id 已存在时仅删除回收站项（幂等） */
export interface RestoredTrashItem {
  id: string;
  itemType: 'work' | 'note';
  itemId: string;
  label: string;
  trashedAt: string;
}

/** 永久删除：itemType 为 note 时 removedVersions 为连带删除的版本记录数 */
export interface PurgeTrashResult {
  id: string;
  removedVersions: number;
}

/* ------------------------------------------------------------------ */
/* 聚合 / 统计 / 搜索                                                  */
/* ------------------------------------------------------------------ */

export interface HomeData {
  stats: {
    works: number;
    notes: number;
    revisions: number;
    comparisons: number;
    imagery: number;
    allusions: number;
    draft: number;
    final: number;
    published: number;
    pendingImport: number;
  };
  recent: NoteSummary[];
}

/** 筛选面板数据：tags 为词作与札记标签合集 */
export interface Facets {
  authors: string[];
  cipais: string[];
  tags: string[];
  kinds: WorkKind[];
  writingStatus: WritingStatus[];
  publishStatus: PublishStatus[];
}

/** 统计面板计数：六个实体表 + 两个使用记录表 */
export interface StatsCounts {
  works: number;
  notes: number;
  revisions: number;
  comparisons: number;
  imagery: number;
  allusions: number;
  imageryUses: number;
  allusionUses: number;
}

export interface StatsData {
  counts: StatsCounts;
  facets: Facets;
}

export interface SearchResult {
  works: WorkSummary[];
  notes: NoteSummary[];
}

/* ------------------------------------------------------------------ */
/* 备份与导入                                                          */
/* ------------------------------------------------------------------ */

/** 备份数据集合名（backup.mjs SETS，preflight/merge 计数的键） */
export type BackupSetKey =
  | 'works'
  | 'notes'
  | 'revisions'
  | 'comparisons'
  | 'trash'
  | 'imagery'
  | 'imageryUses'
  | 'allusions'
  | 'allusionUses';

/** 回收站导出行：snapshot 为入站时的实体 payload */
export interface TrashSnapshotItem {
  id: string;
  itemType: 'work' | 'note';
  itemId: string;
  label: string;
  snapshot: Work | Note;
  trashedAt: string;
}

export interface BackupLink {
  workId: string;
  noteId: string;
}

export interface BackupData {
  works: Work[];
  notes: Note[];
  revisions: RevisionRecord[];
  comparisons: Comparison[];
  trash: TrashSnapshotItem[];
  imagery: Imagery[];
  imageryUses: ImageryUse[];
  allusions: Allusion[];
  allusionUses: AllusionUse[];
  links: BackupLink[];
  tags: string[];
}

export interface BackupCounts {
  works: number;
  notes: number;
  revisions: number;
  comparisons: number;
  trash: number;
  imagery: number;
  imageryUses: number;
  allusions: number;
  allusionUses: number;
  links: number;
  tags: number;
  claims: number;
  citations: number;
}

/** GET /api/export 返回的完整备份对象 */
export interface Backup {
  format: string;
  formatVersion: number;
  exportedAt: string;
  attachmentsSupported: boolean;
  counts: BackupCounts;
  data: BackupData;
}

/** 冲突副本：同 id 不同内容时另存的确定性副本 */
export interface PreflightConflict {
  type: BackupSetKey;
  id: string;
  copyId: string;
}

/** 悬空引用警告：uses 指向集合内不存在的意象/典故/目标 */
export interface PreflightDangling {
  type: 'imageryUse' | 'allusionUse';
  id: string;
  ref: string;
}

/** 导入预检。ok=false 时 errors 为硬错误清单，不可导入 */
export interface Preflight {
  ok: boolean;
  errors?: string[];
  creates: Record<BackupSetKey, number>;
  duplicates: number;
  conflicts: PreflightConflict[];
  dangling: PreflightDangling[];
}

/** 合并导入结果：只有 INSERT，不覆盖任何已有内容 */
export interface MergeResult {
  created: Record<BackupSetKey, number>;
  skipped: number;
  conflictCopies: number;
}

/* ------------------------------------------------------------------ */
/* MCP 密钥                                                            */
/* ------------------------------------------------------------------ */

export interface McpKey {
  id: string;
  name: string;
  prefix: string;
  status: 'active' | 'revoked';
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** 新建密钥返回：明文 key 仅此一次下发 */
export interface CreateMcpKeyResult {
  key: string;
  record: McpKey;
}

/* ------------------------------------------------------------------ */
/* API 错误                                                            */
/* ------------------------------------------------------------------ */

/** 统一错误：HTTP 状态 + 业务错误码；CONFLICT 时 current 为服务端当前记录 */
export class ApiError extends Error {
  code: string;
  status: number;
  current?: unknown;

  constructor(code: string, message: string, status: number, current?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.current = current;
  }
}
