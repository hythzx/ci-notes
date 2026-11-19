/**
 * 文本差异：行级 LCS 对齐，相邻的「删除 + 新增」合并为「修改」并给出字级子差异。
 * 逐函数翻译自词间参考实现 utils/diff.js（splitLines/lcsTable/align/mergeChanges/charDiff/mergeSegments/diffText），
 * MAX_CELLS 与 charDiff 的 400000 上限及退化行为保持一致。
 * 偏差：输出行只保留 {type, a, b, segments}（brief 的 rows 契约），内部对齐仍带 aIndex/bIndex。
 */

/** LCS 代价上限，超过则退化为整体替换，避免长文比较卡死 */
const MAX_CELLS = 1200000;

function splitLines(text) {
  const s = text === undefined || text === null ? '' : String(text);
  if (!s) return [];
  return s.replace(/\r\n/g, '\n').split('\n');
}

function lcsTable(a, b) {
  const n = a.length;
  const m = b.length;
  const table = new Array(n + 1);
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

function align(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n * m > MAX_CELLS) {
    const fallback = [];
    for (let x = 0; x < n; x++) fallback.push({ type: 'delete', a: a[x], b: null, aIndex: x, bIndex: -1 });
    for (let y = 0; y < m; y++) fallback.push({ type: 'insert', a: null, b: b[y], aIndex: -1, bIndex: y });
    return fallback;
  }
  const table = lcsTable(a, b);
  const out = [];
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
function mergeChanges(rows) {
  const out = [];
  let k = 0;
  while (k < rows.length) {
    const row = rows[k];
    if (row.type === 'delete') {
      const dels = [];
      const inss = [];
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
            segments: charDiff(dels[p].a, inss[p].b)
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
export function charDiff(a, b) {
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
  const segs = [];
  for (const r of rows) {
    if (r.type === 'equal') segs.push({ type: 'equal', text: r.a });
    else if (r.type === 'delete') segs.push({ type: 'delete', text: r.a });
    else segs.push({ type: 'insert', text: r.b });
  }
  return mergeSegments(segs);
}

function mergeSegments(segs) {
  const out = [];
  for (const s of segs) {
    if (!s.text) continue;
    const last = out[out.length - 1];
    if (last && last.type === s.type) last.text += s.text;
    else out.push({ type: s.type, text: s.text });
  }
  return out;
}

/** 输出行只保留 brief 契约字段 {type, a, b, segments} */
function toRow(row) {
  const out = { type: row.type, a: row.a, b: row.b };
  if (row.segments) out.segments = row.segments;
  return out;
}

/**
 * 比较两段文本
 * @returns {{rows: Array, stats: {added:number, removed:number, changed:number, same:number}}}
 */
export function diffText(oldText, newText) {
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
