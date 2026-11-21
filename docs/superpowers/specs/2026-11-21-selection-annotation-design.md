# 划选标注与虚线回显 · 设计文档

日期：2026-11-21
状态：已与用户确认三项关键决策（保存路径、锚点格式、功能范围），设计整体获批，用户指示直接进入实施计划。

## 1. 背景与目标

札记详情页点段落会弹 Modal 查看该段资料标注（claims），没有标注时提示「这一段还没有资料标注。」，但阅读页**没有创建标注的入口**——创建只能进编辑页在 ClaimsEditor 里手填「挂靠段落」数字。

目标：

1. 阅读页划选正文文字 → 浮出「标注」入口，就地写标注并保存；
2. 标注可以挂在**任意文字范围**（一段、一句、一个词、一个字），由用户划选决定，不再受段落粒度限制；
3. 再次进入详情页时，已标注的文字以**虚线**显示，点击虚线可回看该条标注。

## 2. 范围决策（已确认）

| 决策点 | 结论 |
| --- | --- |
| 保存路径 | 阅读页直接保存：划选 → Modal 填写 → 调现有 update API。定稿/已发布札记沿用现有保护逻辑（派生新草稿），与编辑页保存行为一致 |
| 锚点格式 | 引文式锚点（quote + prefix + suffix），定位失配时优雅降级，不画错位置 |
| 功能范围 | 札记详情页**和**词作详情页都做（词作页需补齐锚点渲染基础设施） |

**明确不做**（out of scope）：编辑页 textarea 内联高亮（textarea 无法做富文本渲染）； ClaimsEditor 锚点编辑（锚点只来自划选）；阅读页保存冲突的三选一处理（toast 提示刷新重试即可）；词作详情页的段落 Modal（词作原文无段落概念）。

## 3. 数据模型

### 3.1 类型（`src/types.ts`）

```ts
/** 文字范围锚点：引文 + 前后文各 16 字，用于重渲染时定位 */
export interface ClaimAnchor {
  quote: string;   // 选中的原文，原样保留
  prefix: string;  // 选中文字之前最多 16 字
  suffix: string;  // 选中文字之后最多 16 字
}

export interface Claim {
  // ...现有字段不变（id / kind / text / paragraph / citations / createdAt / updatedAt）
  anchor?: ClaimAnchor;  // 有 anchor = 文字范围标注；无 = 整段 / 不挂段落（兼容旧数据）
}
```

### 3.2 服务端归一化（`server/core/normalize.mjs`）

`normalizeClaims`（notes/works 共用，一处改动）新增 anchor 处理：

- `anchor.quote` trim 后非空才保留整个 anchor；否则丢弃（视为无锚点）；
- `prefix` / `suffix` 各截前 16 字；
- anchor 非对象时视为无锚点；
- `paragraph` 语义不变：札记锚点标注记段落组号（现有 `paragraphs(text)` 下标约定）；词作锚点标注记 `-1`（整篇锚定）。

旧数据没有 anchor 字段，归一化后自然不变；备份统计、导出不感知 anchor。

## 4. 锚点定位与虚线绘制（新增 `src/annotate.ts`）

纯函数 + DOM 工具模块，两个详情页共用，不引第三方库：

- `locateAnchor(text: string, anchor: ClaimAnchor): [number, number] | null`
  在容器纯文本里枚举 `quote` 出现位置，用 prefix/suffix 消歧：优先两端都匹配的位置，其次单端匹配，再取第一个 quote 命中；全部失配返回 `null`（降级：不画虚线，标注仍在资料区与段落 Modal 可见）。
- `collectTextNodes(root: HTMLElement): { node: Text; start: number; end: number }[]`
  TreeWalker 收集容器内文本节点及累计偏移表，绘制与选区捕获共用。
- `drawMarks(root, containerText, claims)`
  对带锚点的 claims 逐条定位并包 `<span class="cj-mark cj-mark-{kind}">`；按起始偏移升序处理，与已标注区间重叠的后一条跳过（前一条优先），避免嵌套包裹打乱偏移表。

CSS（`src/styles.css`）：`.cj-mark-verified / -pending / -personal` 三色虚线下划线，色系跟随现有 chip 的 verified/pending/personal。

行内元素（粗体/代码等）不影响：定位基于纯文本，绘制按偏移切文本节点。

## 5. 划选交互

- 标注容器（札记 `cj-article` / 词作原文 `pre`）监听 `pointerup`：`window.getSelection()` 非空且完整落在容器内 → 在选区末尾附近浮出「标注」小按钮（绝对定位）；选区塌陷或落在容器外 → 按钮消失。
- 札记页限制选区必须完整落在**同一段落组**内，跨段 toast「请在一段之内选择」；词作 `<pre>` 无段落边界，任意范围可标。
- 点「标注」→ 创建 Modal：顶部灰底只读显示选中引文（确认标注对象），下方为 ClaimPanel 同款字段（可信度三档 / 内容 / 出处；「已核实」必填出处的门禁复用）。
- 现有「点段落弹段落 Modal」保持不变，但 click 时若选区非空则不弹（避免划选误触）。

## 6. 保存路径

- 保存调 `api.notes.update` / `api.works.update`，payload 只带 `claims`（当前数组 + 新条）与 `baseRevision`（详情响应的 revision）。
- 定稿/已发布札记：自然走进现有 createdDraft 分支 → ChooseBox「去看新草稿 / 留在原篇」（与编辑页一致）；此时留在原篇需重新 load 刷新（原稿未变，虚线不增）。
- 乐观锁 CONFLICT：toast「内容在别处被改过，请刷新后重试」。
- 成功：刷新详情、重画虚线、toast「已标注」。

## 7. 点击回看

- 点虚线 span → 单条标注 Modal（ClaimRow 同款：可信度徽章 + 内容 + 出处行；札记内另附「标注范围」引文行）。
- 重叠锚点不嵌套渲染（绘制时后一条跳过，见 §4），被跳过的条目仍可在资料区 / 段落 Modal 查看。
- 段落 Modal（札记）保持现有行为；其中带锚点的条目在 ClaimRow 下补一行「标注范围：…」。

## 8. 编辑页联动（最小改动）

- ClaimsEditor 收起行对带锚点条目加一行小字「标注范围：“…”」（只读）。
- ClaimPanel 不提供锚点编辑；现有 `{...initial, ...}` 展开天然保留 anchor 字段，透传到服务端。

## 9. 测试

- `src/annotate.ts` 定位算法单测（现有 test 目录沿用同款 node:test 约定）：唯一命中 / 多次出现靠 prefix 消歧 / 单端匹配 / 全失配降级 / 16 字截断边界 / 偏移→文本节点切割。
- 服务端 `normalizeClaims` anchor 归一化单测（quote 空丢弃、prefix/suffix 截断、非对象丢弃、旧数据透传）。
- 手动验收：两详情页划选 → 保存 → 刷新虚线回显 → 点虚线看标注 → 改正文后降级不画错位置 → 定稿札记划选保存派生草稿。

## 10. 发布

- `package.json` version 2.0.5 → **2.1.0**。
- 流程（2026-11-20 起既定惯例）：本地改码推送 GitHub → 192.168.3.17 构建并推阿里云 `registry.cn-hangzhou.aliyuncs.com/nj-agile-io/ci-notes:2.1.0`（同时打 latest）→ 135 改 compose image tag → `docker compose pull && up -d` → 验证 healthy + `/api/health` 200。
