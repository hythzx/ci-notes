import { createHash, randomBytes } from 'node:crypto';

/**
 * ID 生成，沿用词间 utils/hash.js + utils/util.js 的语义：
 * 前缀 + sha256 前 12 位小写 hex。前缀自带下划线（'w_'、'n_'、'cl_'、'ct_'…）。
 */

/** sha256 hex（UTF-8），对应词间 hash.sha256Hex */
export function digest(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex');
}

let idCounter = 0;

/** 新的唯一 ID：时间 + 计数器 + 随机，保证同一毫秒内也不重复 */
export function newId(prefix) {
  idCounter += 1;
  const seed = prefix + '|' + Date.now() + '|' + idCounter + '|' + randomBytes(8).toString('hex');
  return prefix + digest(seed).slice(0, 12);
}

/** 依据稳定输入派生确定性 ID：parts 以 | 串联后哈希，导入冲突副本可幂等重放 */
export function derivedId(prefix, ...parts) {
  return prefix + digest(parts.join('|')).slice(0, 12);
}
