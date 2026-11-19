import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { createStore } from '../server/store.mjs';

// Store 接口总表（task-11-brief 唯一契约，命名逐字一致）
const INTERFACE = [
  'close',
  'listWorks', 'getWork', 'createWork', 'updateWork',
  'listNotes', 'getNote', 'createNote', 'saveNote',
  'listRevisions', 'compareRevisions', 'restoreRevision', 'unprotectNote',
  'listComparisons', 'getComparison', 'saveComparison', 'deleteComparison',
  'listImagery', 'getImagery', 'createImagery', 'updateImagery',
  'deleteImagery', 'mergeImagery', 'imageryImpact',
  'listImageryUses', 'createImageryUse', 'updateImageryUse', 'deleteImageryUse',
  'compareImagery',
  'listAllusions', 'getAllusion', 'createAllusion', 'updateAllusion',
  'deleteAllusion', 'mergeAllusion', 'allusionImpact',
  'listAllusionUses', 'createAllusionUse', 'updateAllusionUse', 'deleteAllusionUse',
  'compareAllusions',
  'listTrash', 'trashWork', 'trashNote', 'restoreTrash', 'purgeTrash',
  'getHome', 'globalSearch', 'getStats',
  'buildBackup', 'parseBackup', 'validateBackup', 'preflightImport', 'mergeImport',
  'listMcpKeys', 'createMcpKey', 'findMcpKey', 'revokeMcpKey', 'enableMcpKey', 'touchMcpKey',
];

function tempPath() { return join(mkdtempSync(join(tmpdir(), 'cn-store-')), 't.sqlite'); }

test('createStore 返回接口总表全部函数，且不暴露 db 句柄', () => {
  const store = createStore(tempPath());
  try {
    for (const name of INTERFACE) assert.equal(typeof store[name], 'function', name);
    assert.equal(Object.keys(store).length, INTERFACE.length);
    assert.equal(store.db, undefined); // 封装：不导出 db 句柄
  } finally { store.close(); }
});

test('seed=true 空库不炸（seedAll 为桩）', () => {
  const store = createStore(tempPath(), { seed: true });
  try {
    assert.deepEqual(store.listWorks({}), []);
  } finally { store.close(); }
});

test('close 后再调报错', () => {
  const store = createStore(tempPath(), { seed: false });
  store.close();
  assert.throws(() => store.listWorks({}));
  assert.throws(() => store.listMcpKeys());
});

test('facade 预绑 db：域函数经 store 正常读写', () => {
  const store = createStore(tempPath(), { seed: false });
  try {
    const work = store.createWork({ title: '雨霖铃', content: '寒蝉凄切' });
    assert.deepEqual(store.listWorks({}).map((w) => w.id), [work.id]);
    const { key, record } = store.createMcpKey('k1');
    assert.equal(store.findMcpKey(key).id, record.id);
    assert.ok(store.getStats());
    assert.ok(store.buildBackup());
  } finally { store.close(); }
});
