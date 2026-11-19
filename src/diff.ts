/**
 * 词间 · 文本差异（ci-notes 前端版）
 *
 * 逐函数翻译自词间参考实现 utils/diff.js，以 server/core/diffcore.mjs（Task 4 审查版）
 * 为翻译底本：行级 LCS（Uint32Array 表）对齐 → 相邻「删除 + 新增」按序配对合并为
 * 「修改」并生成字级子差异。MAX_CELLS = 1,200,000：行数乘积超限则退化为「整段删 +
 * 整段增」，避免长文比较卡死；charDiff 字级 LCS 另有 400,000 格上限，超限退化为
 * 「整句删 + 整句增」。
 *
 * 结果与 server/core/diffcore.mjs 严格一致（test/diff.test.mjs 对拍保证）：
 * toRow 剥离内部 aIndex/bIndex，行形状 {type, a, b, segments?}，a/b 键恒在、缺失为 null
 * （前端对比页兜底与导出场景须与服务端 compare API 输出可互换）。
 *
 * 与 brief 接口的一处偏差：brief 草拟 Row 为 { a?: string; b?: string }；实际运行时
 * 契约（对拍 deepEqual、服务端输出形状）要求 a/b 键恒在且缺失值为 null，故类型标注
 * 为 string | null。形状以服务端 diffcore 为准。
 *
 * 模块自含（零相对依赖、零新增依赖）：node:test 可直接 import（Node 24 原生
 * type-stripping），亦可被 Vite 直接打包。
 */

export type Seg = { type: 'equal' | 'insert' | 'delete'; text: string };

export type Row = {
  type: 'equal' | 'delete' | 'insert' | 'change';
  /** 甲文本行；insert 行为 null（键恒在，与 server diffcore 输出形状一致） */
  a: string | null;
  /** 乙文本行；delete 行为 null（键恒在，与 server diffcore 输出形状一致） */
  b: string | null;
  /** 仅 change 行携带：字级子差异 */
  segments?: Seg[];
};

/** 内部对齐行：带 aIndex/bIndex 供按序配对，输出前由 toRow 剥离 */
type AlignedRow = {
  type: 'equal' | 'delete' | 'insert' | 'change';
  a: string | null;
  b: string | null;
  aIndex: number;
  bIndex: number;
  segments?: Seg[];
};

/** LCS 代价上限，超过则退化为整体替换，避免长文比较卡死 */
const MAX_CELLS = 1200000;

function splitLines(text: string): string[] {
  const s = text === undefined || text === null ? '' : String(text);
  if (!s) return [];
  return s.replace(/\r\n/g, '\n').split('\n');
}

function lcsTable(a: string[], b: string[]): Uint32Array[] {
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) table[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        table[i][j] = table[i + 1][j + 1] + 1;
      } else {
        table[i][j] = table[i + 1][j] > table[i][j + 1] ? table[i + 1][j] : table[i][j + 1];
      }
    }
  }
  return table;
}

function align(a: string[], b: string[]): AlignedRow[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n * m > MAX_CELLS) {
    const fallback: AlignedRow[] = [];
    for (let x = 0; x < n; x++) fallback.push({ type: 'delete', a: a[x], b: null, aIndex: x, bIndex: -1 });
    for (let y = 0; y < m; y++) fallback.push({ type: 'insert', a: null, b: b[y], aIndex: -1, bIndex: y });
    return fallback;
  }
  const table = lcsTable(a, b);
  const out: AlignedRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'equal', a: a[i], b: b[j], aIndex: i, bIndex: j });
      i++; j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ type: 'delete', a: a[i], b: null, aIndex: i, bIndex: -1 });
      i++;
    } else {
      out.push({ type: 'insert', a: null, b: b[j], aIndex: -1, bIndex: j });
      j++;
    }
  }
  while (i < n) { out.push({ type: 'delete', a: a[i], b: null, aIndex: i, bIndex: -1 }); i++; }
  while (j < m) { out.push({ type: 'insert', a: null, b: b[j], aIndex: -1, bIndex: j }); j++; }
  return out;
}

/** 合并相邻的删除 + 插入为「修改」 */
function mergeChanges(rows: AlignedRow[]): AlignedRow[] {
  const out: AlignedRow[] = [];
  let k = 0;
  while (k < rows.length) {
    const row = rows[k];
    if (row.type === 'delete') {
      const dels: AlignedRow[] = [];
      const inss: AlignedRow[] = [];
      let m = k;
      while (m < rows.length && rows[m].type === 'delete') { dels.push(rows[m]); m++; }
      while (m < rows.length && rows[m].type === 'insert') { inss.push(rows[m]); m++; }
      if (inss.length && dels.length) {
        const pairCount = Math.min(dels.length, inss.length);
        for (let p = 0; p < pairCount; p++) {
          out.push({
            type: 'change',
            a: dels[p].a,
            b: inss[p].b,
            aIndex: dels[p].aIndex,
            bIndex: inss[p].bIndex,
            segments: charDiff(dels[p].a as string, inss[p].b as string)
          });
        }
        for (let p = pairCount; p < dels.length; p++) {
          out.push({ type: 'delete', a: dels[p].a, b: null, aIndex: dels[p].aIndex, bIndex: -1 });
        }
        for (let p = pairCount; p < inss.length; p++) {
          out.push({ type: 'insert', a: null, b: inss[p].b, aIndex: -1, bIndex: inss[p].bIndex });
        }
        k = m;
        continue;
      }
      for (const d of dels) {
        out.push({ type: 'delete', a: d.a, b: null, aIndex: d.aIndex, bIndex: -1 });
      }
      k = m;
      continue;
    }
    out.push(row);
    k++;
  }
  return out;
}

/** 字级差异，返回 [{type, text}] */
export function charDiff(a: string, b: string): Seg[] {
  const x = String(a === null || a === undefined ? '' : a);
  const y = String(b === null || b === undefined ? '' : b);
  if (x === y) return [{ type: 'equal', text: x }];
  if (x.length * y.length > 400000) {
    return [
      { type: 'delete', text: x },
      { type: 'insert', text: y }
    ];
  }
  const ax = x.split('');
  const by = y.split('');
  const rows = align(ax, by);
  const segs: Seg[] = [];
  for (const r of rows) {
    // align 契约：equal/delete 行恒有字符串 a，insert 行恒有字符串 b
    if (r.type === 'equal') segs.push({ type: 'equal', text: r.a as string });
    else if (r.type === 'delete') segs.push({ type: 'delete', text: r.a as string });
    else segs.push({ type: 'insert', text: r.b as string });
  }
  return mergeSegments(segs);
}

function mergeSegments(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    if (!s.text) continue;
    const last = out[out.length - 1];
    if (last && last.type === s.type) last.text += s.text;
    else out.push({ type: s.type, text: s.text });
  }
  return out;
}

/** 输出行只保留契约字段 {type, a, b, segments}（剥离内部 aIndex/bIndex） */
function toRow(row: AlignedRow): Row {
  const out: Row = { type: row.type, a: row.a, b: row.b };
  if (row.segments) out.segments = row.segments;
  return out;
}

/**
 * 比较两段文本
 */
export function diffText(oldText: string, newText: string): {
  rows: Row[];
  stats: { added: number; removed: number; changed: number; same: number };
} {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const rows = mergeChanges(align(a, b)).map(toRow);
  const stats = { added: 0, removed: 0, changed: 0, same: 0 };
  for (const row of rows) {
    const t = row.type;
    if (t === 'insert') stats.added++;
    else if (t === 'delete') stats.removed++;
    else if (t === 'change') stats.changed++;
    else stats.same++;
  }
  return { rows, stats };
}
