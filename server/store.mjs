import { openDb } from './core/db.mjs';
import { StoreError } from './core/errors.mjs';
import { isEmpty, seedAll } from './core/seeddata.mjs';
import { listWorks, getWork, createWork, updateWork } from './core/works.mjs';
import {
  listNotes, getNote, createNote, saveNote,
  listRevisions, compareRevisions, restoreRevision, unprotectNote,
} from './core/notes.mjs';
import { listComparisons, getComparison, saveComparison, deleteComparison } from './core/comparisons.mjs';
import {
  listImagery, getImagery, createImagery, updateImagery,
  deleteImagery, mergeImagery, imageryImpact,
  listImageryUses, createImageryUse, updateImageryUse, deleteImageryUse,
  compareImagery,
} from './core/imagery.mjs';
import {
  listAllusions, getAllusion, createAllusion, updateAllusion,
  deleteAllusion, mergeAllusion, allusionImpact,
  listAllusionUses, createAllusionUse, updateAllusionUse, deleteAllusionUse,
  compareAllusions,
} from './core/allusions.mjs';
import { listTrash, trashWork, trashNote, restoreTrash, purgeTrash } from './core/trash.mjs';
import { getHome, globalSearch, getStats } from './core/stats.mjs';
import { buildBackup, parseBackup, validateBackup, preflightImport, mergeImport } from './core/backup.mjs';
import {
  createMcpKey, findMcpKey, listMcpKeys,
  revokeMcpKey, enableMcpKey, touchMcpKey,
} from './core/mcpkeys.mjs';

/**
 * store facade：把全部领域模块组装成单一入口对象（app.mjs 与 mcp.mjs 唯一入口）。
 * 接口命名见 .superpowers/sdd/task-11-brief.md「Store 接口总表」，须逐字一致；
 * 各函数第一个参数 db 在此预绑，不导出 db 句柄本身。
 */

// 接口名 → 领域函数（均以 db 为第一参数）
const DOMAIN = {
  listWorks, getWork, createWork, updateWork,
  listNotes, getNote, createNote, saveNote,
  listRevisions, compareRevisions, restoreRevision, unprotectNote,
  listComparisons, getComparison, saveComparison, deleteComparison,
  listImagery, getImagery, createImagery, updateImagery,
  deleteImagery, mergeImagery, imageryImpact,
  listImageryUses, createImageryUse, updateImageryUse, deleteImageryUse,
  compareImagery,
  listAllusions, getAllusion, createAllusion, updateAllusion,
  deleteAllusion, mergeAllusion, allusionImpact,
  listAllusionUses, createAllusionUse, updateAllusionUse, deleteAllusionUse,
  compareAllusions,
  listTrash, trashWork, trashNote, restoreTrash, purgeTrash,
  getHome, globalSearch, getStats,
  buildBackup, parseBackup, validateBackup, preflightImport, mergeImport,
  listMcpKeys, createMcpKey, findMcpKey, revokeMcpKey, enableMcpKey, touchMcpKey,
};

export function createStore(dbPath, { seed = true, dataDir } = {}) {
  const db = openDb(dbPath, { dataDir });
  if (seed && isEmpty(db)) seedAll(db);

  let closed = false;
  const store = {};
  for (const [name, fn] of Object.entries(DOMAIN)) {
    store[name] = (...args) => {
      if (closed) throw new StoreError('INVALID', 'store 已关闭');
      return fn(db, ...args);
    };
  }
  store.close = () => {
    if (closed) return; // 幂等：优雅关闭路径可能多次触发
    closed = true;
    db.close();
  };
  return store;
}
