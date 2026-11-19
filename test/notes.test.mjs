import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.mjs';
import { createWork } from '../server/core/works.mjs';
import {
  listNotes, getNote, createNote, saveNote,
  listRevisions, compareRevisions, restoreRevision,
  unprotectNote, snapshotOf,
} from '../server/core/notes.mjs';
import { diffText, charDiff } from '../server/core/diffcore.mjs';
import { StoreError } from '../server/core/errors.mjs';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';

function setup() { return openDb(join(mkdtempSync(join(tmpdir(), 'cn-')), 't.sqlite')); }

/* ------------------------------------------------------------------ */
/* 版本生成                                                            */
/* ------------------------------------------------------------------ */

test('创建生成 v1 版本', () => {
  const db = setup();
  const { note, revision } = createNote(db, { title: '读柳永', content: '衣带渐宽终不悔', tags: ['读词'], changeNote: '初建' });
  assert.match(note.id, /^n_/);
  assert.equal(note.revision, 1);
  assert.equal(note.writingStatus, 'draft');
  assert.equal(note.publishStatus, 'unpublished');
  // v1 版本记录：reason=manual，快照与札记内容一致
  assert.match(revision.id, /^rv_/);
  assert.equal(revision.noteId, note.id);
  assert.equal(revision.seq, 1);
  assert.equal(revision.reason, 'manual');
  assert.equal(revision.changeNote, '初建');
  assert.equal(revision.snapshot.title, '读柳永');
  assert.equal(revision.snapshot.content, '衣带渐宽终不悔');
  assert.deepEqual(revision.snapshot.tags, ['读词']);
  const revs = listRevisions(db, note.id);
  assert.equal(revs.length, 1);
  assert.equal(revs[0].charCount, 7);
  assert.equal(revs[0].writingStatus, 'draft');
  // 摘要行携带快照的正文与标题（历史页看内容 / 导出这一版使用）
  assert.equal(revs[0].content, '衣带渐宽终不悔');
  assert.equal(revs[0].title, '读柳永');
});

test('标题必填非空', () => {
  const db = setup();
  assert.throws(() => createNote(db, { title: '  ', content: 'x' }), e => e instanceof StoreError && e.code === 'INVALID');
  assert.throws(() => createNote(db, { title: '', content: 'x' }), /标题不能为空/);
});

test('正常保存版本递增', () => {
  const db = setup();
  let { note } = createNote(db, { title: 'T', content: '第一版' });
  note = saveNote(db, note.id, { content: '第二版', changeNote: '修订' }, { baseRevision: note.revision }).note;
  assert.equal(note.revision, 2);
  assert.equal(note.content, '第二版');
  assert.equal(note.changeNote, '修订');
  const revs = listRevisions(db, note.id);
  assert.equal(revs.length, 2);
  assert.equal(revs[0].reason, 'manual');
  assert.equal(revs[0].changeNote, '修订');
  assert.equal(revs[0].seq, 2);
  // 快照存的是保存后的新内容
  const snap = JSON.parse(db.prepare('SELECT snapshot FROM revisions WHERE seq=?').get(2).snapshot);
  assert.equal(snap.content, '第二版');
});

/* ------------------------------------------------------------------ */
/* CAS 冲突                                                            */
/* ------------------------------------------------------------------ */

test('CONFLICT 附 current', () => {
  const db = setup();
  const { note } = createNote(db, { title: 'T', content: 'v1' });
  saveNote(db, note.id, { content: 'v2' }, { baseRevision: note.revision });
  assert.throws(
    () => saveNote(db, note.id, { content: '过期版' }, { baseRevision: note.revision }),
    (e) => {
      assert.ok(e instanceof StoreError);
      assert.equal(e.code, 'CONFLICT');
      assert.match(e.message, /这条札记在别处被改过/);
      // current 是库中最新内容，且带当前 revision 供续写
      assert.equal(e.current.content, 'v2');
      assert.equal(e.current.revision, 2);
      return true;
    },
  );
  assert.throws(() => getNote(db, 'n_none'), /札记不存在/);
});

/* ------------------------------------------------------------------ */
/* 定稿保护与派生草稿                                                  */
/* ------------------------------------------------------------------ */

test('protected 保存派生草稿', () => {
  const db = setup();
  let { note } = createNote(db, { title: '读柳永', content: '初稿' });
  note = saveNote(db, note.id, { ...note, writingStatus: 'final' }, { baseRevision: note.revision }).note;
  assert.equal(note.writingStatus, 'final');
  const r = saveNote(db, note.id, { ...note, content: '想改' }, { baseRevision: note.revision });
  assert.ok(r.createdDraft);
  assert.equal(r.note.content, '初稿');                 // 原稿一字不动
  assert.equal(r.draft.draftOf, note.id);
  assert.equal(r.draft.writingStatus, 'draft');
  assert.equal(r.draft.publishStatus, 'unpublished');
  assert.equal(getNote(db, note.id).note.draftNoteId, r.draft.id);
});

test('派生草稿细节：状态重置、changeNote 前缀、原稿内容与版本不动', () => {
  const db = setup();
  let { note } = createNote(db, { title: 'T', content: '正文', publish: { platform: '博客', url: 'https://x' } });
  note = saveNote(db, note.id, { ...note, writingStatus: 'final', changeNote: '定为终稿' }, { baseRevision: note.revision }).note;
  const beforeRevs = listRevisions(db, note.id);
  const r = saveNote(db, note.id, { ...note, content: '续写', changeNote: '补一段' }, { baseRevision: note.revision });
  const draft = r.draft;
  // 草稿承接 patch 内容，publish 清空，changeNote 带固定前缀
  assert.equal(draft.content, '续写');
  assert.deepEqual(draft.publish, { platform: '', publishedAt: '', url: '' });
  assert.equal(draft.draftNoteId, '');
  assert.match(draft.changeNote, /^基于定稿继续修改/);
  assert.match(draft.changeNote, /补一段/);
  // 草稿有自己的 draft-from-final 版本
  const draftRevs = listRevisions(db, draft.id);
  assert.equal(draftRevs.length, 1);
  assert.equal(draftRevs[0].reason, 'draft-from-final');
  assert.equal(draftRevs[0].writingStatus, 'draft');
  // 原稿内容与既有版本不变，仅多出 draftNoteId 指针
  assert.equal(r.note.id, note.id);
  assert.equal(r.note.content, '正文');
  assert.equal(r.note.draftNoteId, draft.id);
  assert.deepEqual(listRevisions(db, note.id), beforeRevs);
});

test('published 也算 protected', () => {
  const db = setup();
  let { note } = createNote(db, { title: 'T', content: '已发布正文' });
  note = saveNote(db, note.id, { ...note, publishStatus: 'published' }, { baseRevision: note.revision }).note;
  const r = saveNote(db, note.id, { ...note, content: '再改' }, { baseRevision: note.revision });
  assert.ok(r.createdDraft);
  assert.equal(r.note.content, '已发布正文');
  assert.equal(r.draft.publishStatus, 'unpublished');
  assert.equal(r.draft.draftOf, note.id);
});

/* ------------------------------------------------------------------ */
/* force 覆盖                                                          */
/* ------------------------------------------------------------------ */

test('force 覆盖前留档', () => {
  const db = setup();
  let { note } = createNote(db, { title: 'T', content: '服务器版' });
  saveNote(db, note.id, { ...note, content: '客户端版' }, { baseRevision: note.revision, force: true });
  const revs = listRevisions(db, note.id);
  assert.equal(revs[0].reason, 'manual');
  assert.equal(revs[1].reason, 'conflict-overwrite');
  assert.equal(JSON.parse(db.prepare('SELECT snapshot FROM revisions WHERE reason=?').get('conflict-overwrite').snapshot).content, '服务器版');
});

test('baseRevision 命中时 force 也先留档', () => {
  const db = setup();
  const { note } = createNote(db, { title: 'T', content: 'v1' });
  const r = saveNote(db, note.id, { content: 'v2' }, { baseRevision: note.revision, force: true });
  assert.equal(r.createdDraft, false);
  // 倒序：覆盖保存 manual → conflict-overwrite 留档 → 创建 v1 manual
  const revs = listRevisions(db, note.id);
  assert.equal(revs.length, 3);
  assert.equal(revs[0].reason, 'manual');
  assert.equal(revs[1].reason, 'conflict-overwrite');
  assert.equal(revs[2].reason, 'manual');
});

/* ------------------------------------------------------------------ */
/* 版本恢复与解除保护                                                  */
/* ------------------------------------------------------------------ */

test('restore 生成独立新草稿', () => {
  const db = setup();
  let { note } = createNote(db, { title: '旧标题', content: '旧正文', changeNote: '初建' });
  const v1 = listRevisions(db, note.id)[0];
  note = saveNote(db, note.id, { title: '新标题', content: '新正文', changeNote: '改稿' }, { baseRevision: note.revision }).note;
  const r = restoreRevision(db, note.id, v1.id);
  const draft = r.draft;
  // 独立新札记：内容回到 v1，状态重置为草稿，draftOf 指回原稿
  assert.notEqual(draft.id, note.id);
  assert.match(draft.id, /^n_/);
  assert.equal(draft.title, '旧标题');
  assert.equal(draft.content, '旧正文');
  assert.equal(draft.writingStatus, 'draft');
  assert.equal(draft.publishStatus, 'unpublished');
  assert.deepEqual(draft.publish, { platform: '', publishedAt: '', url: '' });
  assert.equal(draft.draftOf, note.id);
  assert.equal(draft.changeNote, `由版本「初建」复制为草稿`);
  // 原稿挂上指针；restore 版本挂在草稿上
  assert.equal(getNote(db, note.id).note.draftNoteId, draft.id);
  const draftRevs = listRevisions(db, draft.id);
  assert.equal(draftRevs.length, 1);
  assert.equal(draftRevs[0].reason, 'restore');
  // 原稿版本数量不变
  assert.equal(listRevisions(db, note.id).length, 2);
  // changeNote 为空的版本用 v{seq} 命名
  const { note: n2 } = createNote(db, { title: 'N2', content: 'c' });
  const bare = listRevisions(db, n2.id)[0];
  assert.equal(restoreRevision(db, n2.id, bare.id).draft.changeNote, `由版本「v${bare.seq}」复制为草稿`);
});

test('restore 版本不存在报 NOT_FOUND', () => {
  const db = setup();
  const { note } = createNote(db, { title: 'T', content: 'c' });
  assert.throws(() => restoreRevision(db, note.id, 'rv_none'), /版本不存在/);
});

test('unprotect 就地解除', () => {
  const db = setup();
  let { note } = createNote(db, { title: 'T', content: 'c' });
  note = saveNote(db, note.id, { ...note, writingStatus: 'final', publishStatus: 'published' }, { baseRevision: note.revision }).note;
  const unprotected = unprotectNote(db, note.id);
  // 就地：id 不变、状态回落、revision 递增并生成 manual 版本
  assert.equal(unprotected.id, note.id);
  assert.equal(unprotected.writingStatus, 'draft');
  assert.equal(unprotected.publishStatus, 'unpublished');
  assert.equal(unprotected.revision, note.revision + 1);
  const revs = listRevisions(db, note.id);
  assert.equal(revs[0].reason, 'manual');
  assert.equal(revs[0].writingStatus, 'draft');
  // 解除后可直接就地保存，不再派生草稿
  const r = saveNote(db, note.id, { content: '就地改' }, { baseRevision: unprotected.revision });
  assert.equal(r.createdDraft, false);
  assert.equal(r.note.content, '就地改');
});

/* ------------------------------------------------------------------ */
/* seq 全局递增与倒序                                                  */
/* ------------------------------------------------------------------ */

test('revisions seq 全局递增且倒序', () => {
  const db = setup();
  const { note: a } = createNote(db, { title: 'A', content: 'a1' });
  const { note: b } = createNote(db, { title: 'B', content: 'b1' });
  saveNote(db, a.id, { content: 'a2' }, { baseRevision: a.revision });
  saveNote(db, b.id, { content: 'b2' }, { baseRevision: b.revision });
  saveNote(db, a.id, { content: 'a3' }, { baseRevision: 2 });
  // 跨札记的 seq 全局唯一且单调递增
  const all = db.prepare('SELECT seq FROM revisions ORDER BY seq').all().map(r => r.seq);
  assert.deepEqual(all, [1, 2, 3, 4, 5]);
  // 每篇札记内 seq 倒序（新的在前）
  const ra = listRevisions(db, a.id);
  assert.deepEqual(ra.map(r => r.seq), [5, 3, 1]);
  const rb = listRevisions(db, b.id);
  assert.deepEqual(rb.map(r => r.seq), [4, 2]);
});

/* ------------------------------------------------------------------ */
/* compare                                                             */
/* ------------------------------------------------------------------ */

test('compare 两版 diff', () => {
  const db = setup();
  const { note } = createNote(db, { title: 'T', content: '春风又绿江南岸' });
  saveNote(db, note.id, { ...note, content: '春风又绿江南岸，明月何时照我还' }, { baseRevision: note.revision });
  const revs = listRevisions(db, note.id);           // seq 倒序：revs[0] 新，revs[1] 旧
  assert.equal(revs.length, 2);
  const cmp = compareRevisions(db, note.id, revs[1].id, revs[0].id);
  assert.equal(cmp.rows.some(r => r.type === 'insert' || r.type === 'change'), true);
  assert.ok(cmp.stats.added >= 1 || cmp.stats.changed >= 1);
});

test('compare change 合并与字级 segments', () => {
  const db = setup();
  const { note } = createNote(db, { title: 'T', content: '第一行\n春风又绿江南岸\n第三行' });
  saveNote(db, note.id, { content: '第一行\n春风又绿江南岸上\n第三行' }, { baseRevision: note.revision });
  const revs = listRevisions(db, note.id);
  const cmp = compareRevisions(db, note.id, revs[1].id, revs[0].id);
  const change = cmp.rows.find(r => r.type === 'change');
  assert.ok(change, '相邻 delete+insert 应合并为 change');
  assert.equal(change.a, '春风又绿江南岸');
  assert.equal(change.b, '春风又绿江南岸上');
  // 字级子差异存在且能指出新增的「上」
  assert.ok(Array.isArray(change.segments) && change.segments.length >= 2);
  assert.ok(change.segments.some(s => s.type === 'insert' && s.text.includes('上')));
  assert.ok(change.segments.some(s => s.type === 'equal'));
  assert.deepEqual(cmp.stats, { added: 0, removed: 0, changed: 1, same: 2 });
  // a/b 元信息带版本标题
  assert.equal(cmp.a.title, 'T');
  assert.equal(cmp.b.title, 'T');
  assert.equal(cmp.a.seq, revs[1].seq);
  assert.equal(cmp.b.seq, revs[0].seq);
});

test('compare 标题差异并入 rows 头部', () => {
  const db = setup();
  const { note } = createNote(db, { title: '旧题', content: '正文不变' });
  saveNote(db, note.id, { title: '新题' }, { baseRevision: note.revision });
  const revs = listRevisions(db, note.id);
  const cmp = compareRevisions(db, note.id, revs[1].id, revs[0].id);
  assert.equal(cmp.rows[0].type, 'change');
  assert.equal(cmp.rows[0].a, '旧题');
  assert.equal(cmp.rows[0].b, '新题');
  assert.ok(Array.isArray(cmp.rows[0].segments));
  assert.equal(cmp.stats.changed, 1);
  assert.equal(cmp.stats.same, 1);
});

test('compare 校验版本归属与存在性', () => {
  const db = setup();
  const { note: n1 } = createNote(db, { title: 'N1', content: 'c' });
  const { note: n2 } = createNote(db, { title: 'N2', content: 'c' });
  const revs1 = listRevisions(db, n1.id);
  const revs2 = listRevisions(db, n2.id);
  assert.throws(() => compareRevisions(db, n1.id, revs1[0].id, revs2[0].id), /这两个版本不属于同一篇札记/);
  assert.throws(() => compareRevisions(db, n1.id, 'rv_x', revs1[0].id), /版本不存在/);
});

/* ------------------------------------------------------------------ */
/* 触发器：revisions 物理不可变                                        */
/* ------------------------------------------------------------------ */

test('revisions 物理不可变', () => {
  const db = setup();
  createNote(db, { title: 'T', content: 'x' });
  assert.throws(() => db.exec('DELETE FROM revisions'), /immutable/);
  assert.throws(() => db.exec("UPDATE revisions SET change_note='x'"), /immutable/);
});

/* ------------------------------------------------------------------ */
/* getNote 装配                                                        */
/* ------------------------------------------------------------------ */

test('getNote 装配 linkedWorks claimGroups', () => {
  const db = setup();
  const w = createWork(db, {
    title: '凤栖梧', author: '柳永',
    claims: [
      { kind: 'verified', text: '已核资料', citations: [{ book: '乐章集' }] },
      { kind: 'pending', text: '异文待核' },
      { kind: 'personal', text: '个人理解' },
    ],
  });
  const { note } = createNote(db, { title: '读柳永', content: 'c', workIds: [w.id, 'w_gone'] });
  const detail = getNote(db, note.id);
  assert.equal(detail.note.title, '读柳永');
  // 不存在的 workId 跳过
  assert.equal(detail.linkedWorks.length, 1);
  const lw = detail.linkedWorks[0];
  assert.equal(lw.work.id, w.id);
  assert.equal(lw.work.title, '凤栖梧');
  assert.equal(lw.claimGroups.verified.length, 1);
  assert.equal(lw.claimGroups.pending.length, 1);
  assert.equal(lw.claimGroups.personal.length, 1);
});

/* ------------------------------------------------------------------ */
/* listNotes 筛选与摘要                                                */
/* ------------------------------------------------------------------ */

test('listNotes 筛选与摘要字段', () => {
  const db = setup();
  const w = createWork(db, { title: '凤栖梧' });
  createNote(db, { title: '甲', content: '衣带渐宽', tags: ['读词'], workIds: [w.id] });
  createNote(db, { title: '乙', content: '', note: '只有附记', pendingImport: true, writingStatus: 'idea' });
  const c = createNote(db, { title: '丙', content: '待发布', publishStatus: 'pending' }).note;
  assert.equal(listNotes(db, {}).length, 3);
  assert.equal(listNotes(db, { q: '渐宽' })[0].title, '甲');
  assert.equal(listNotes(db, { q: '只有附记' })[0].title, '乙');
  assert.equal(listNotes(db, { workId: w.id }).length, 1);
  assert.equal(listNotes(db, { tag: '读词' })[0].title, '甲');
  assert.equal(listNotes(db, { publishStatus: 'pending' })[0].title, '丙');
  assert.equal(listNotes(db, { writingStatus: 'idea' }).length, 1);
  const items = listNotes(db, {});
  const jia = items.find(i => i.title === '甲');
  assert.equal(jia.excerpt, '衣带渐宽');
  assert.equal(jia.charCount, 4);
  assert.deepEqual(jia.tags, ['读词']);
  assert.equal(jia.pendingImport, false);
  assert.equal(jia.draftOf, '');
  assert.equal(jia.draftNoteId, '');
  const yi = items.find(i => i.title === '乙');
  assert.equal(yi.pendingImport, true);
  assert.equal(yi.excerpt, '（正文待导入）');
  // 派生草稿后原稿摘要带指针，草稿摘要带 draftOf
  saveNote(db, c.id, { ...c, writingStatus: 'final' }, { baseRevision: c.revision });
  const r = saveNote(db, c.id, { writingStatus: 'draft', content: 'x' }, { baseRevision: undefined });
  assert.ok(r.createdDraft);
  const bingAll = listNotes(db, { q: '丙' });
  assert.equal(bingAll.find(i => i.id === c.id).draftNoteId, r.draft.id);
  assert.equal(bingAll.find(i => i.id === r.draft.id).draftOf, c.id);
});

/* ------------------------------------------------------------------ */
/* snapshotOf 与 diffcore                                              */
/* ------------------------------------------------------------------ */

test('snapshotOf 只含内容字段', () => {
  const db = setup();
  const { note } = createNote(db, { title: 'T', content: 'c', tags: ['x'], workIds: ['w_1'] });
  const snap = snapshotOf(note);
  assert.deepEqual(Object.keys(snap).sort(),
    ['changeNote', 'citations', 'claims', 'content', 'note', 'pendingImport', 'publish', 'publishStatus', 'tags', 'title', 'workIds', 'writingStatus'].sort());
  assert.deepEqual(snap.workIds, ['w_1']);
  // 快照是副本：改原对象不影响快照
  note.tags.push('y');
  assert.deepEqual(snap.tags, ['x']);
});

test('diffText 行级 diff 与统计', () => {
  // 全等
  assert.deepEqual(diffText('a\nb', 'a\nb'), { rows: [{ type: 'equal', a: 'a', b: 'a' }, { type: 'equal', a: 'b', b: 'b' }], stats: { added: 0, removed: 0, changed: 0, same: 2 } });
  // 纯插入
  const ins = diffText('a\nc', 'a\nb\nc');
  assert.deepEqual(ins.rows, [{ type: 'equal', a: 'a', b: 'a' }, { type: 'insert', a: null, b: 'b' }, { type: 'equal', a: 'c', b: 'c' }]);
  assert.equal(ins.stats.added, 1);
  // 纯删除
  const del = diffText('a\nb\nc', 'a\nc');
  assert.equal(del.rows.filter(r => r.type === 'delete').length, 1);
  assert.equal(del.stats.removed, 1);
  // 相邻删除+插入合并为 change 且带字级 segments
  const chg = diffText('春眠不觉晓', '春眠不觉晓了');
  const change = chg.rows.find(r => r.type === 'change');
  assert.ok(change);
  assert.deepEqual(change.segments, [{ type: 'equal', text: '春眠不觉晓' }, { type: 'insert', text: '了' }]);
  assert.equal(chg.stats.changed, 1);
  // 空串
  assert.deepEqual(diffText('', '').rows, []);
  assert.equal(diffText('', 'x').stats.added, 1);
  assert.equal(diffText('x', '').stats.removed, 1);
  // \r\n 归一
  assert.equal(diffText('a\r\nb', 'a\nb').stats.same, 2);
});

test('charDiff 字级 diff', () => {
  assert.deepEqual(charDiff('相同', '相同'), [{ type: 'equal', text: '相同' }]);
  const segs = charDiff('春风又绿江南岸', '春风又绿江南岸，明月');
  assert.ok(segs.some(s => s.type === 'equal'));
  assert.deepEqual(segs[segs.length - 1], { type: 'insert', text: '，明月' });
  // 相邻同类型段已合并
  for (let i = 1; i < segs.length; i++) assert.notEqual(segs[i].type, segs[i - 1].type);
  // 超过 400000 上限退化为整体 delete + insert
  const big = charDiff('甲'.repeat(700), '乙'.repeat(700));
  assert.deepEqual(big, [{ type: 'delete', text: '甲'.repeat(700) }, { type: 'insert', text: '乙'.repeat(700) }]);
});

test('diffText 超过 MAX_CELLS 退化不再构建 LCS 表', () => {
  // 1101 x 1101 行 > 1200000 格，跳过 LCS 表直接整块输出；
  // 连续 delete 块与 insert 块随后按词间规则配对为 change（退化行为与词间一致）
  const n = 1101;
  const a = Array.from({ length: n }, (_, i) => '甲' + i).join('\n');
  const b = Array.from({ length: n }, (_, i) => '乙' + i).join('\n');
  const { rows, stats } = diffText(a, b);
  assert.equal(rows.filter(r => r.type === 'change').length, n);
  assert.equal(stats.changed, n);
  assert.equal(stats.same, 0);
});
