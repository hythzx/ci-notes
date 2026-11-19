/**
 * 意象 / 典故区块组件：词作与札记详情页共用的关联展示与使用记录编辑。
 *
 * 语义与文案翻译自词间 web 版（web/components/imagery.js），类名沿用
 * Task 23 的 cj-imagery-* 样式段。两类实体同构，差异只有四处，全部收敛在
 * UseSectionConfig 里参数化：
 *   - 实体字段：Imagery.description ↔ Allusion.explanation（选择器描述行）；
 *   - 使用记录表达作用字段：ImageryUse.fn ↔ AllusionUse.interpretation，
 *     组件内部统一按 fn 读写，边界处（适配器）做映射；
 *   - 详情页链接：#/imagery/:id ↔ #/allusions/:id；
 *   - 文案：表达作用（在这件作品中的表达作用）↔ 此处的典故解释。
 *
 * 数据策略：Section 组件独立拉取（uses + 实体全量列表并行），不消费详情页
 * 已装配的 imagery.entries —— 单一数据源在组件内，编辑后本地刷新即可，
 * 详情页装配字段保留（MCP / 备份导出用途）。写操作后 reload({keep:true})
 * 保留旧数据避免整块闪空；删除与保存均走 notifyToast 反馈。
 *
 * 「新建意象/典故并关联」跳 #/imagery/new?link=<targetType>:<targetId>，
 * 由 Task 29/30 的编辑页消费（保存成功后回原目标并续接 use 编辑）。
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { ApiError } from '../types';
import type { AllusionList, AllusionUse, ClaimKind, Claim, Citation, ImageryList, ImageryUse } from '../types';
import { Chip, ConfirmBox, EmptyState, Modal, notifyToast } from './ui';
import { CitationsEditor, ClaimsEditor, Field, Input, TextArea } from './editors';
import { Md } from './md';
import { citationLine } from '../exporter';
import { navigate } from '../router';

/* ------------------------------------------------------------------ */
/* 归一形状与配置（两类实体的差异边界）                                  */
/* ------------------------------------------------------------------ */

/** use 挂载目标类型（work / note 详情页共用） */
type UseTargetType = 'work' | 'note';

/** 三档可信度的角标简称（editors 未导出的 KIND_SHORT 同款） */
const CLAIM_SHORT: Record<ClaimKind, string> = {
  verified: '已核实',
  pending: '待核实',
  personal: '理解',
};

/** 出处是否有实际内容（备注不算，与编辑器门禁一致） */
function citationHasContent(c: Citation): boolean {
  return !!(c.book || c.edition || c.page || c.url);
}

/** 选择器与组头用的实体摘要：表达作用之外的第二处差异（描述字段）已折平 */
interface EntityInfo {
  id: string;
  name: string;
  aliases: string[];
  /** 描述（意象）/ 释义（典故） */
  desc: string;
  counts: { works: number; notes: number; uses: number; quotes: number };
}

/** 两类使用记录的归一形状：表达作用统一读作 fn */
interface NormalUse {
  id: string;
  /** imageryId / allusionId */
  entityId: string;
  quote: string;
  context: string;
  fn: string;
  understanding: string;
  claims: Claim[];
  citations: Citation[];
  /** 乐观锁基准（uses.update 的 baseRevision） */
  revision: number;
}

/** use 编辑表单（fn 字段名与 ImageryUse 对齐；典故侧由适配器映射） */
interface UseForm {
  quote: string;
  context: string;
  fn: string;
  understanding: string;
  claims: Claim[];
  citations: Citation[];
}

const EMPTY_USE_FORM: UseForm = {
  quote: '', context: '', fn: '', understanding: '', claims: [], citations: [],
};

/** 正在编辑 / 新建的 use 落点；use 为 null 表示新建 */
interface EditTarget {
  entityId: string;
  entityName: string;
  use: NormalUse | null;
}

/**
 * 两类区块的差异配置。读写函数在边界处完成 API 形状 ↔ 归一形状的映射，
 * 组件主体只面对归一形状，不再出现字段分叉。
 */
interface UseSectionConfig {
  /** 实体名（按钮与提示文案用）：意象 / 典故 */
  kindLabel: string;
  /** 选择器描述行的字段名：描述 / 释义 */
  descLabel: string;
  /** 空态文案 */
  emptyText: string;
  /** 详情页链接前缀：#/imagery / #/allusions */
  basePath: string;
  /** 表达作用字段的使用侧 label 与提示 */
  fnLabel: string;
  fnHint: string;
  listEntries: () => Promise<EntityInfo[]>;
  listUses: (targetType: UseTargetType, targetId: string) => Promise<NormalUse[]>;
  createUse: (targetType: UseTargetType, targetId: string, entityId: string, form: UseForm) => Promise<unknown>;
  updateUse: (use: NormalUse, form: UseForm) => Promise<unknown>;
  removeUse: (id: string) => Promise<unknown>;
}

const IMAGERY_CONFIG: UseSectionConfig = {
  kindLabel: '意象',
  descLabel: '描述',
  emptyText: '还没有关联意象。',
  basePath: '#/imagery',
  fnLabel: '表达作用',
  fnHint: '在这件作品中的表达作用',
  listEntries: () =>
    api.imagery.list({}).then((d: ImageryList) =>
      d.entries.map((e) => ({
        id: e.imagery.id,
        name: e.imagery.name,
        aliases: e.imagery.aliases || [],
        desc: e.imagery.description,
        counts: e.counts,
      })),
    ),
  listUses: (targetType, targetId) =>
    api.imagery.uses.list({ targetType, targetId }).then((list) => list.map(mapImageryUse)),
  createUse: (targetType, targetId, entityId, f) =>
    api.imagery.uses.create({
      imageryId: entityId, targetType, targetId,
      quote: f.quote, context: f.context, fn: f.fn, understanding: f.understanding,
      claims: f.claims, citations: f.citations,
    }),
  updateUse: (u, f) =>
    api.imagery.uses.update(u.id, {
      quote: f.quote, context: f.context, fn: f.fn, understanding: f.understanding,
      claims: f.claims, citations: f.citations, baseRevision: u.revision,
    }),
  removeUse: (id) => api.imagery.uses.remove(id),
};

const ALLUSION_CONFIG: UseSectionConfig = {
  kindLabel: '典故',
  descLabel: '释义',
  emptyText: '还没有关联典故。',
  basePath: '#/allusions',
  fnLabel: '此处的典故解释',
  fnHint: '',
  listEntries: () =>
    api.allusions.list({}).then((d: AllusionList) =>
      d.entries.map((e) => ({
        id: e.allusion.id,
        name: e.allusion.name,
        aliases: e.allusion.aliases || [],
        desc: e.allusion.explanation,
        counts: e.counts,
      })),
    ),
  listUses: (targetType, targetId) =>
    api.allusions.uses.list({ targetType, targetId }).then((list) => list.map(mapAllusionUse)),
  createUse: (targetType, targetId, entityId, f) =>
    api.allusions.uses.create({
      allusionId: entityId, targetType, targetId,
      quote: f.quote, context: f.context, interpretation: f.fn, understanding: f.understanding,
      claims: f.claims, citations: f.citations,
    }),
  updateUse: (u, f) =>
    api.allusions.uses.update(u.id, {
      quote: f.quote, context: f.context, interpretation: f.fn, understanding: f.understanding,
      claims: f.claims, citations: f.citations, baseRevision: u.revision,
    }),
  removeUse: (id) => api.allusions.uses.remove(id),
};

function mapImageryUse(u: ImageryUse): NormalUse {
  return {
    id: u.id, entityId: u.imageryId, quote: u.quote, context: u.context,
    fn: u.fn, understanding: u.understanding,
    claims: u.claims || [], citations: u.citations || [], revision: u.revision,
  };
}

function mapAllusionUse(u: AllusionUse): NormalUse {
  return {
    id: u.id, entityId: u.allusionId, quote: u.quote, context: u.context,
    fn: u.interpretation, understanding: u.understanding,
    claims: u.claims || [], citations: u.citations || [], revision: u.revision,
  };
}

/* ------------------------------------------------------------------ */
/* 渲染小件                                                            */
/* ------------------------------------------------------------------ */

/** 字段行：中文 label + 行内 Markdown（空值整行不渲染） */
function UseField({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div className="cj-imagery-field">
      <span className="cj-imagery-field-label">{label}</span>
      <Md text={text} inline />
    </div>
  );
}

/**
 * 单条使用记录：quote <pre> 逐字 + 情境/表达作用/我的理解各行 +
 * 条目级 claims 徽章（claim 自带出处行）+ use 顶层出处行 + 编辑/删除。
 */
function UseItem({ cfg, use, onEdit, onDelete }: {
  cfg: UseSectionConfig;
  use: NormalUse;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="cj-imagery-use">
      {use.quote ? <pre className="cj-imagery-quote">{use.quote}</pre> : null}
      <UseField label="情境" text={use.context} />
      <UseField label={cfg.fnLabel} text={use.fn} />
      <UseField label="我的理解" text={use.understanding} />
      {use.claims.length || use.citations.length ? (
        <div className="cj-imagery-claims">
          {use.claims.map((c, i) => (
            <div className="cj-imagery-claim" key={c.id || `claim-${i}`}>
              <Chip tone={c.kind}>{CLAIM_SHORT[c.kind]}</Chip>
              <div className="cj-imagery-claim-text">
                <Md text={c.text} inline />
                {c.citations.filter(citationHasContent).map((x, j) => (
                  <div key={x.id || `cite-${j}`}>出处：{citationLine(x)}</div>
                ))}
              </div>
            </div>
          ))}
          {use.citations.map((x, j) => (
            <div className="cj-imagery-claim" key={x.id || `usecite-${j}`}>
              <Chip tone={x.verified}>{CLAIM_SHORT[x.verified]}</Chip>
              <div className="cj-imagery-claim-text">出处：{citationLine(x)}</div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="cj-imagery-entry-ops">
        <button type="button" className="cn-op" onClick={onEdit}>编辑这处</button>
        <button type="button" className="cn-op cn-op-danger" onClick={onDelete}>删除</button>
      </div>
    </div>
  );
}

/** 按实体分组：组头名称链接 + 别名，组内逐条使用记录 */
function EntityGroup({ cfg, entity, uses, onEdit, onDelete }: {
  cfg: UseSectionConfig;
  entity: EntityInfo;
  uses: NormalUse[];
  onEdit: (use: NormalUse) => void;
  onDelete: (use: NormalUse) => void;
}) {
  return (
    <div className="cj-imagery-entry">
      <div className="cj-imagery-entry-head">
        <div>
          <a className="cj-imagery-name" href={cfg.basePath + '/' + entity.id}>{entity.name}</a>
          {entity.aliases.length ? (
            <span className="cj-imagery-picker-alias">别名：{entity.aliases.join('、')}</span>
          ) : null}
        </div>
      </div>
      {uses.map((u) => (
        <UseItem
          key={u.id}
          cfg={cfg}
          use={u}
          onEdit={() => onEdit(u)}
          onDelete={() => onDelete(u)}
        />
      ))}
    </div>
  );
}

/** 描述 / 释义首行（选择器条目用），超长截断 */
function firstLine(text: string, max = 80): string {
  const s = (text || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/* ------------------------------------------------------------------ */
/* 区块主体                                                            */
/* ------------------------------------------------------------------ */

/**
 * 意象 / 典故区块（两类实体的共享实现，不自带 Section 外壳——由详情页
 * 的 <Section title="意象|典故"> 包裹）。自身拉取 uses 与实体列表并分组
 * 展示；提供「关联已有 / 新建并关联」入口与 use 级编辑、删除。
 */
function UseSection({ cfg, targetType, targetId }: {
  cfg: UseSectionConfig;
  targetType: UseTargetType;
  targetId: string;
}) {
  const [uses, setUses] = useState<NormalUse[] | null>(null);
  const [entities, setEntities] = useState<EntityInfo[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQ, setPickerQ] = useState('');
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [form, setForm] = useState<UseForm>(EMPTY_USE_FORM);
  const [saving, setSaving] = useState(false);
  const [confirmUse, setConfirmUse] = useState<NormalUse | null>(null);

  /**
   * 拉取 uses 与实体全量列表（组头名称 + 选择器数据共用）。
   * keep 为 true 时保留旧数据（编辑 / 删除后的静默刷新），否则进入加载态。
   */
  function load(opts?: { keep?: boolean }): () => void {
    let alive = true;
    if (!opts?.keep) setUses(null);
    Promise.all([cfg.listUses(targetType, targetId), cfg.listEntries()]).then(
      ([us, es]) => {
        if (!alive) return;
        setUses(us);
        setEntities(es);
      },
      (e: unknown) => {
        if (!alive) return;
        if (!opts?.keep) setUses([]);
        notifyToast(e instanceof ApiError ? e.message : cfg.kindLabel + '区块加载失败');
      },
    );
    return () => {
      alive = false;
    };
  }

  useEffect(() => load(), [targetType, targetId]);

  /** 按 entityId 分组（uses 已按创建时间升序返回） */
  const groups = useMemo(() => {
    if (!uses) return [];
    const byId = new Map(entities.map((e) => [e.id, e]));
    const map = new Map<string, NormalUse[]>();
    for (const u of uses) {
      const list = map.get(u.entityId);
      if (list) list.push(u);
      else map.set(u.entityId, [u]);
    }
    return [...map.entries()]
      .map(([id, us]) => ({ entity: byId.get(id), uses: us }))
      .filter((g): g is { entity: EntityInfo; uses: NormalUse[] } => !!g.entity);
  }, [uses, entities]);

  /** 选择器过滤：名称 / 别名 / 描述包含匹配（不区分大小写） */
  const pickerEntries = useMemo(() => {
    const k = pickerQ.trim().toLowerCase();
    if (!k) return entities;
    return entities.filter(
      (e) =>
        e.name.toLowerCase().includes(k) ||
        e.aliases.some((a) => a.toLowerCase().includes(k)) ||
        e.desc.toLowerCase().includes(k),
    );
  }, [entities, pickerQ]);

  function openCreate(entity: EntityInfo) {
    setForm(EMPTY_USE_FORM);
    setEditTarget({ entityId: entity.id, entityName: entity.name, use: null });
  }

  function openEdit(entity: EntityInfo, u: NormalUse) {
    setForm({
      quote: u.quote,
      context: u.context,
      fn: u.fn,
      understanding: u.understanding,
      claims: u.claims.slice(),
      citations: u.citations.slice(),
    });
    setEditTarget({ entityId: entity.id, entityName: entity.name, use: u });
  }

  /** 保存：新建 uses.create / 编辑 uses.update（乐观锁 baseRevision） */
  async function save() {
    const t = editTarget;
    if (!t || saving) return;
    setSaving(true);
    try {
      if (t.use) await cfg.updateUse(t.use, form);
      else await cfg.createUse(targetType, targetId, t.entityId, form);
      setEditTarget(null);
      notifyToast('已保存');
      load({ keep: true });
    } catch (e) {
      notifyToast(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function removeUse() {
    const u = confirmUse;
    setConfirmUse(null);
    if (!u) return;
    try {
      await cfg.removeUse(u.id);
      notifyToast('已删除这一处使用记录');
      load({ keep: true });
    } catch (e) {
      notifyToast(e instanceof ApiError ? e.message : '删除失败');
    }
  }

  function goNew() {
    navigate(cfg.basePath + '/new?link=' + targetType + ':' + targetId);
  }

  return (
    <div className="cj-card cj-imagery-card">
      <div className="cj-imagery-add">
        <button
          type="button"
          className="cn-btn cn-btn-ghost cn-btn-sm"
          onClick={() => {
            setPickerQ('');
            setPickerOpen(true);
          }}
        >
          关联已有{cfg.kindLabel}
        </button>
        <button type="button" className="cn-btn cn-btn-ghost cn-btn-sm" onClick={goNew}>
          新建{cfg.kindLabel}并关联
        </button>
      </div>

      <div className="cj-imagery-list">
        {!uses ? (
          <EmptyState text={'正在打开' + cfg.kindLabel + '…'} />
        ) : !groups.length ? (
          <EmptyState text={cfg.emptyText} />
        ) : (
          groups.map((g) => (
            <EntityGroup
              key={g.entity.id}
              cfg={cfg}
              entity={g.entity}
              uses={g.uses}
              onEdit={(u) => openEdit(g.entity, u)}
              onDelete={setConfirmUse}
            />
          ))
        )}
      </div>

      {pickerOpen ? (
        <Modal title={'关联已有' + cfg.kindLabel} onClose={() => setPickerOpen(false)}>
          <Input
            placeholder={'搜名称、别名或' + cfg.descLabel}
            value={pickerQ}
            onChange={(e) => setPickerQ(e.target.value)}
          />
          <div className="cj-imagery-picker-list">
            {!entities.length ? (
              <EmptyState text={cfg.kindLabel + '库还是空的，先「新建' + cfg.kindLabel + '并关联」建一个。'} />
            ) : !pickerEntries.length ? (
              <EmptyState text={'没有匹配的' + cfg.kindLabel + '。'} />
            ) : (
              pickerEntries.map((e) => (
                <button
                  type="button"
                  className="cj-imagery-picker-item"
                  key={e.id}
                  onClick={() => {
                    setPickerOpen(false);
                    openCreate(e);
                  }}
                >
                  <span className="cj-imagery-picker-name">{e.name}</span>
                  {e.aliases.length ? (
                    <span className="cj-imagery-picker-alias">别名：{e.aliases.join('、')}</span>
                  ) : null}
                  {e.desc ? (
                    <span className="cj-imagery-picker-desc">{cfg.descLabel}：{firstLine(e.desc)}</span>
                  ) : null}
                  <span className="cj-imagery-picker-desc">
                    作品 {e.counts.works} · 札记 {e.counts.notes} · 使用 {e.counts.uses} 条
                  </span>
                </button>
              ))
            )}
          </div>
        </Modal>
      ) : null}

      {editTarget ? (
        <Modal
          title={editTarget.use ? '编辑这处使用' : '关联「' + editTarget.entityName + '」'}
          onClose={() => setEditTarget(null)}
        >
          <Field label="对应原文或具体词句">
            <TextArea
              rows={3}
              placeholder="把这一处出现的原句贴进来"
              value={form.quote}
              onChange={(e) => setForm({ ...form, quote: e.target.value })}
            />
          </Field>
          <Field label="该处的情境与描述">
            <TextArea
              rows={3}
              placeholder="这一处在写什么情境"
              value={form.context}
              onChange={(e) => setForm({ ...form, context: e.target.value })}
            />
          </Field>
          <Field label={cfg.fnLabel} hint={cfg.fnHint || undefined}>
            <TextArea
              rows={3}
              placeholder={cfg.fnLabel}
              value={form.fn}
              onChange={(e) => setForm({ ...form, fn: e.target.value })}
            />
          </Field>
          <Field label="我的理解">
            <TextArea
              rows={3}
              placeholder="你对这一处的理解"
              value={form.understanding}
              onChange={(e) => setForm({ ...form, understanding: e.target.value })}
            />
          </Field>
          <Field label="资料标注">
            <ClaimsEditor value={form.claims} onChange={(claims) => setForm({ ...form, claims })} />
          </Field>
          <Field label="引用出处">
            <CitationsEditor value={form.citations} onChange={(citations) => setForm({ ...form, citations })} />
          </Field>
          <div className="cn-modal-ops">
            <button type="button" className="cn-btn cn-btn-quiet" onClick={() => setEditTarget(null)}>
              取消
            </button>
            <button type="button" className="cn-btn cn-btn-primary" disabled={saving} onClick={save}>
              保存
            </button>
          </div>
        </Modal>
      ) : null}

      {confirmUse ? (
        <ConfirmBox
          title="删除这一处使用记录"
          message={'只删除这一处使用记录，不影响' + cfg.kindLabel + '本身。'}
          danger
          onOk={removeUse}
          onCancel={() => setConfirmUse(null)}
        />
      ) : null}
    </div>
  );
}

/** 词作 / 札记详情页的意象区块 */
export function ImagerySection({ targetType, targetId }: { targetType: UseTargetType; targetId: string }) {
  return <UseSection cfg={IMAGERY_CONFIG} targetType={targetType} targetId={targetId} />;
}

/** 词作 / 札记详情页的典故区块 */
export function AllusionSection({ targetType, targetId }: { targetType: UseTargetType; targetId: string }) {
  return <UseSection cfg={ALLUSION_CONFIG} targetType={targetType} targetId={targetId} />;
}
