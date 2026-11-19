import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.mjs';
import { createWork } from '../server/core/works.mjs';
import { createNote, saveNote } from '../server/core/notes.mjs';
import { listTrash, trashWork, trashNote, restoreTrash, purgeTrash } from '../server/core/trash.mjs';
import { StoreError } from '../server/core/errors.mjs';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';

function setup() { return openDb(join(mkdtempSync(join(tmpdir(), 'cn-')), 't.sqlite')); }

/* ------------------------------------------------------------------ */
/* trashWork                                                           */
/* ------------------------------------------------------------------ */

test('trashWork：词作入回收站，札记保留且 workIds 剥除', () => {
  const db = setup();
  const work = createWork(db, { title: '雨霖铃', content: '寒蝉凄切' });
  const { note } = createNote(db, { title: '读雨霖铃', content: '词', workIds: [work.id] });
  trashWork(db, work.id);
  // 词作行已删
  assert.equal(db.prepare('SELECT COUNT(*) c FROM works').get().c, 0);
  // 札记仍在，workIds 已剥除；updatedAt/revision 不动（照词间 deleteWork）
  const row = db.prepare('SELECT payload FROM notes WHERE id=?').get(note.id);
  assert.ok(row);
  const kept = JSON.parse(row.payload);
  assert.deepEqual(kept.workIds, []);
  assert.equal(kept.updatedAt, note.updatedAt);
  assert.equal(kept.revision, note.revision);
  // 回收站一项，label 取标题
  const [item] = listTrash(db);
  assert.equal(item.itemType, 'work');
  assert.equal(item.itemId, work.id);
  assert.equal(item.label, '雨霖铃');
});

test('trashWork：不存在的词作抛 NOT_FOUND；无标题时 label 兜底', () => {
  const db = setup();
  assert.throws(
    () => trashWork(db, 'w_missing'),
    (e) => e instanceof StoreError && e.code === 'NOT_FOUND',
  );
  const work = createWork(db, { content: '只有原文' });
  trashWork(db, work.id);
  assert.equal(listTrash(db)[0].label, '（未命名词作）');
});

/* ------------------------------------------------------------------ */
/* trashNote                                                           */
/* ------------------------------------------------------------------ */

test('trashNote：入回收站时版本记录保留在库中', () => {
  const db = setup();
  const { note } = createNote(db, { title: '读词', content: '初稿' });
  saveNote(db, note.id, { content: '二稿' });
  trashNote(db, note.id);
  // 札记行已删
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notes').get().c, 0);
  // 版本记录未删（照词间 deleteNote：purge 才连带删）
  assert.equal(db.prepare('SELECT COUNT(*) c FROM revisions WHERE note_id=?').get(note.id).c, 2);
  const [item] = listTrash(db);
  assert.equal(item.itemType, 'note');
  assert.equal(item.itemId, note.id);
  assert.equal(item.label, '读词');
});

test('trashNote：不存在的札记抛 NOT_FOUND', () => {
  const db = setup();
  assert.throws(
    () => trashNote(db, 'n_missing'),
    (e) => e instanceof StoreError && e.code === 'NOT_FOUND',
  );
});

/* ------------------------------------------------------------------ */
/* restore                                                             */
/* ------------------------------------------------------------------ */

test('restore：词作恢复，标量列与快照一致', () => {
  const db = setup();
  const work = createWork(db, { title: '雨霖铃', author: '柳永', cipai: '雨霖铃', kind: 'ci', content: '寒蝉凄切' });
  trashWork(db, work.id);
  const [item] = listTrash(db);
  restoreTrash(db, item.id);
  assert.equal(listTrash(db).length, 0);
  const row = db.prepare('SELECT * FROM works WHERE id=?').get(work.id);
  assert.ok(row);
  const restored = JSON.parse(row.payload);
  assert.equal(restored.content, '寒蝉凄切');
  assert.equal(row.title, '雨霖铃');
  assert.equal(row.author, '柳永');
  assert.equal(row.cipai, '雨霖铃');
  assert.equal(row.kind, 'ci');
  assert.equal(row.revision, work.revision);
  assert.equal(row.updated_at, work.updatedAt);
});

test('restore：札记恢复后版本历史仍在', () => {
  const db = setup();
  const { note } = createNote(db, { title: '读词', content: '初稿' });
  saveNote(db, note.id, { content: '二稿' }, { baseRevision: note.revision });
  trashNote(db, note.id);
  const [item] = listTrash(db);
  restoreTrash(db, item.id);
  const row = db.prepare('SELECT payload, revision FROM notes WHERE id=?').get(note.id);
  assert.ok(row);
  const restored = JSON.parse(row.payload);
  assert.equal(restored.content, '二稿');
  assert.equal(restored.revision, 2);
  assert.equal(row.revision, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM revisions WHERE note_id=?').get(note.id).c, 2);
  assert.equal(listTrash(db).length, 0);
});

test('restore：同 id 已存在时仅删除回收站项，不覆盖现存数据', () => {
  const db = setup();
  const work = createWork(db, { title: '甲', content: '原文' });
  trashWork(db, work.id);
  // 回收站期间同 id 重新出现（如导入）
  db.prepare('INSERT INTO works(id,payload,revision,title,author,cipai,kind,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(work.id, JSON.stringify({ ...work, title: '重新导入' }), work.revision, '重新导入', work.author, work.cipai, work.kind, work.updatedAt);
  const [item] = listTrash(db);
  restoreTrash(db, item.id);
  // 现存行未被快照覆盖
  assert.equal(db.prepare('SELECT title FROM works WHERE id=?').get(work.id).title, '重新导入');
  assert.equal(listTrash(db).length, 0);
});

test('restore：回收站里没有这一项抛 NOT_FOUND', () => {
  const db = setup();
  assert.throws(
    () => restoreTrash(db, 't_missing'),
    (e) => e instanceof StoreError && e.code === 'NOT_FOUND',
  );
});

/* ------------------------------------------------------------------ */
/* purge                                                               */
/* ------------------------------------------------------------------ */

test('purge：note 连带删除版本记录，触发器恢复仍拦 DELETE 与 UPDATE', () => {
  const db = setup();
  const { note } = createNote(db, { title: '读词', content: '初稿' });
  saveNote(db, note.id, { content: '二稿' });
  const other = createNote(db, { title: '别篇', content: '留着' });
  trashNote(db, note.id);
  const [item] = listTrash(db);
  const res = purgeTrash(db, item.id);
  assert.equal(res.removedVersions, 2);
  assert.equal(listTrash(db).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM revisions WHERE note_id=?').get(note.id).c, 0);
  // delete 触发器已按原 DDL 重建：删别篇的版本仍抛 immutable
  assert.throws(() => db.exec('DELETE FROM revisions'), /revisions are immutable/);
  // update 触发器未受影响
  assert.throws(() => db.exec("UPDATE revisions SET change_note='x'"), /revisions are immutable/);
  // 写路径不受影响：新札记照常生成版本
  const third = createNote(db, { title: '新篇', content: '正常' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM revisions WHERE note_id=?').get(third.note.id).c, 1);
});

test('purge：work 直接丢弃快照', () => {
  const db = setup();
  const work = createWork(db, { title: '甲' });
  trashWork(db, work.id);
  const [item] = listTrash(db);
  const res = purgeTrash(db, item.id);
  assert.equal(res.removedVersions, 0);
  assert.equal(listTrash(db).length, 0);
});

test('purge：回收站里没有这一项抛 NOT_FOUND', () => {
  const db = setup();
  assert.throws(
    () => purgeTrash(db, 't_missing'),
    (e) => e instanceof StoreError && e.code === 'NOT_FOUND',
  );
});

/* ------------------------------------------------------------------ */
/* listTrash                                                           */
/* ------------------------------------------------------------------ */

test('listTrash：trashedAt 倒序，preview 为纯文本前 120 字', () => {
  const db = setup();
  const long = '字'.repeat(150);
  const { note } = createNote(db, { title: '札记', content: '## 标题\n' + long });
  const work = createWork(db, { title: '词', content: '**寒蝉**' + long });
  trashNote(db, note.id);
  trashWork(db, work.id);
  // 控制时间戳制造明确顺序，避免同一毫秒并列
  db.prepare('UPDATE trash SET trashed_at=? WHERE item_id=?').run('2026-01-01T00:00:00.000Z', note.id);
  db.prepare('UPDATE trash SET trashed_at=? WHERE item_id=?').run('2026-01-02T00:00:00.000Z', work.id);
  const items = listTrash(db);
  assert.equal(items.length, 2);
  // 后入站（时间大者）在前
  assert.equal(items[0].itemId, work.id);
  assert.equal(items[1].itemId, note.id);
  // preview：Markdown 去标记后截 120 字
  assert.equal(items[0].preview, '寒蝉' + '字'.repeat(118));
  assert.equal(items[1].preview, '标题' + '字'.repeat(118));
});

test('listTrash：空正文札记 preview 提示待导入', () => {
  const db = setup();
  const { note } = createNote(db, { title: '空篇' });
  trashNote(db, note.id);
  assert.equal(listTrash(db)[0].preview, '（正文待导入）');
});
