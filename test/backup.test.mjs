import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, nextSeq } from '../server/core/db.mjs';
import { createWork } from '../server/core/works.mjs';
import { createNote } from '../server/core/notes.mjs';
import { createImagery, createImageryUse } from '../server/core/imagery.mjs';
import {
  buildBackup, parseBackup, validateBackup, preflightImport, mergeImport,
} from '../server/core/backup.mjs';
import { StoreError } from '../server/core/errors.mjs';

function setup() { return openDb(join(mkdtempSync(join(tmpdir(), 'cn-')), 't.sqlite')); }

const ZERO = {
  works: 0, notes: 0, revisions: 0, comparisons: 0, trash: 0,
  imagery: 0, imageryUses: 0, allusions: 0, allusionUses: 0,
};

/** 直接按指定 id 写入一条词作（构造同 id 冲突场景用） */
function insertRawWork(db, work) {
  db.prepare('INSERT INTO works(id,payload,revision,title,author,cipai,kind,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(work.id, JSON.stringify(work), work.revision || 1, work.title || '', work.author || '',
      work.cipai || '', work.kind || 'ci', work.updatedAt || new Date().toISOString());
}

/** 直接按指定 id 写入一条札记 */
function insertRawNote(db, note) {
  db.prepare('INSERT INTO notes(id,payload,revision,title,writing_status,publish_status,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(note.id, JSON.stringify(note), note.revision || 1, note.title || '',
      note.writingStatus || 'draft', note.publishStatus || 'unpublished',
      note.updatedAt || new Date().toISOString());
}

function tableCounts(db) {
  const out = {};
  for (const t of ['works', 'notes', 'revisions', 'comparisons', 'trash', 'imagery', 'imagery_uses', 'allusions', 'allusion_uses', 'imports']) {
    out[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  }
  return out;
}

function payloadOf(db, table, id) {
  return JSON.parse(db.prepare(`SELECT payload FROM ${table} WHERE id=?`).get(id).payload);
}

/* ------------------------------------------------------------------ */
/* 场景 1：buildBackup 形状 + validate/parse                            */
/* ------------------------------------------------------------------ */

test('buildBackup 导出全集合，validate 通过，tags/links/counts 正确', () => {
  const db = setup();
  const w = createWork(db, {
    title: '雨霖铃', author: '柳永', tags: ['parting', 'autumn'],
    claims: [{ kind: 'verified', text: '背景已核实', citations: [{ book: '乐章集' }] }],
    citations: [{ book: '乐章集', page: '12' }],
  });
  const { note: n } = createNote(db, { title: '读柳永', workIds: [w.id], tags: ['autumn'] });
  const im = createImagery(db, { name: '月亮', tags: ['moon'] });
  createImageryUse(db, { imageryId: im.id, targetType: 'work', targetId: w.id, quote: '杨柳岸', fn: '烘托离愁' });

  const bak = buildBackup(db);
  assert.equal(bak.format, 'ci-notes-backup');
  assert.equal(bak.formatVersion, 2);
  assert.equal(typeof bak.exportedAt, 'string');
  assert.equal(bak.data.works.length, 1);
  assert.equal(bak.data.notes.length, 1);
  assert.equal(bak.data.revisions.length, 1);
  assert.deepEqual(bak.data.comparisons, []);
  assert.deepEqual(bak.data.trash, []);
  assert.equal(bak.data.imagery.length, 1);
  assert.equal(bak.data.imageryUses.length, 1);
  assert.deepEqual(bak.data.allusions, []);
  assert.deepEqual(bak.data.allusionUses, []);
  // links 由 notes.workIds 展开
  assert.deepEqual(bak.data.links, [{ workId: w.id, noteId: n.id }]);
  // tags 全集去重（works+notes+imagery+allusions）localeCompare 排序
  assert.deepEqual(bak.data.tags, ['autumn', 'moon', 'parting']);
  // counts：各集合长度 + claims/citations 总数
  assert.deepEqual(bak.counts, {
    works: 1, notes: 1, revisions: 1, comparisons: 0, trash: 0,
    imagery: 1, imageryUses: 1, allusions: 0, allusionUses: 0,
    links: 1, tags: 3,
    claims: 1, // work.claims 1 条（词间语义：claims 按条数计）
    citations: 1, // work.citations 1 条（claim 内嵌出处不计入总数）
  });

  const v = validateBackup(bak);
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.dangling, []);

  // parseBackup：合法文本与坏文本
  const parsed = parseBackup(JSON.stringify(bak));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.backup, bak);
  assert.equal(parseBackup('').ok, false);
  assert.equal(parseBackup('not json').ok, false);
  assert.equal(parseBackup('[1,2]').ok, false);
});

/* ------------------------------------------------------------------ */
/* 场景 2：新库 merge 计数 + 二次导入幂等 + preflight                   */
/* ------------------------------------------------------------------ */

test('新库 merge 计数正确；同一备份二次导入全部跳过（幂等）', () => {
  const src = setup();
  const w = createWork(src, { title: '凤栖梧', tags: ['love'] });
  const { note: n } = createNote(src, { title: '札记', workIds: [w.id] });
  const bak = buildBackup(src);

  const dst = setup();
  const r1 = mergeImport(dst, bak);
  assert.deepEqual(r1.created, { works: 1, notes: 1, revisions: 1, comparisons: 0, trash: 0, imagery: 0, imageryUses: 0, allusions: 0, allusionUses: 0 });
  assert.equal(r1.skipped, 0);
  assert.equal(r1.conflictCopies, 0);
  // 内容按原 id 落库，标量列同步
  const got = payloadOf(dst, 'works', w.id);
  assert.equal(got.title, '凤栖梧');
  assert.equal(dst.prepare('SELECT title FROM works WHERE id=?').get(w.id).title, '凤栖梧');
  const gotNote = payloadOf(dst, 'notes', n.id);
  assert.deepEqual(gotNote.workIds, [w.id]);
  // revision 落到 notes 名下
  assert.equal(dst.prepare('SELECT COUNT(*) c FROM revisions WHERE note_id=?').get(n.id).c, 1);

  // preflight 再检：全部按重复跳过
  const pf = preflightImport(dst, bak);
  assert.equal(pf.ok, true);
  assert.deepEqual(pf.creates, ZERO);
  assert.equal(pf.duplicates, 3);
  assert.deepEqual(pf.conflicts, []);
  assert.deepEqual(pf.dangling, []);

  // 二次 merge：全部跳过，计数不增长
  const r2 = mergeImport(dst, bak);
  assert.deepEqual(r2.created, ZERO);
  assert.equal(r2.skipped, 3);
  assert.equal(r2.conflictCopies, 0);
  // 第三次依然稳定
  const r3 = mergeImport(dst, bak);
  assert.equal(r3.skipped, 3);
  // 每次导入各记一行 imports
  assert.equal(dst.prepare('SELECT COUNT(*) c FROM imports').get().c, 3);
  const imp = dst.prepare('SELECT backup_hash, stats, imported_at FROM imports ORDER BY rowid DESC').get();
  assert.equal(typeof imp.backup_hash, 'string');
  assert.deepEqual(JSON.parse(imp.stats).skipped, 3);
  assert.equal(typeof imp.imported_at, 'string');
});

/* ------------------------------------------------------------------ */
/* 场景 3：冲突副本 + 引用重映射                                        */
/* ------------------------------------------------------------------ */

test('同 id 不同内容存冲突副本，备份方引用重映射到副本', () => {
  const dst = setup();
  // 目标库已有 work A（同 id，不同背景）
  insertRawWork(dst, {
    id: 'w_A', title: '雨霖铃', background: '目标库版本', revision: 2,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const bak = {
    format: 'ci-notes-backup', formatVersion: 2, exportedAt: '2026-06-01T00:00:00.000Z',
    counts: {}, data: {
      works: [{
        id: 'w_A', kind: 'ci', title: '雨霖铃', background: '备份版本', tags: [],
        relatedWorkIds: [], revision: 1, updatedAt: '2026-05-01T00:00:00.000Z', createdAt: '2026-05-01T00:00:00.000Z',
      }],
      notes: [{
        id: 'n_B', title: '读雨霖铃', content: '笔记正文', workIds: ['w_A'], tags: [],
        revision: 1, updatedAt: '2026-05-01T00:00:00.000Z', createdAt: '2026-05-01T00:00:00.000Z',
      }],
      revisions: [], comparisons: [], trash: [],
    },
  };

  // preflight 分类：works 冲突、notes 新增
  const pf = preflightImport(dst, bak);
  assert.equal(pf.ok, true);
  assert.deepEqual(pf.creates, { ...ZERO, works: 0, notes: 1 });
  assert.equal(pf.conflicts.length, 1);
  assert.equal(pf.conflicts[0].type, 'works');
  assert.equal(pf.conflicts[0].id, 'w_A');
  assert.equal(typeof pf.conflicts[0].copyId, 'string');
  assert.equal(pf.duplicates, 0);

  const r1 = mergeImport(dst, bak);
  assert.deepEqual(r1.created, { ...ZERO, notes: 1 });
  assert.equal(r1.conflictCopies, 1);
  assert.equal(r1.skipped, 0);

  // 冲突副本：derivedId 派生、payload 附 conflictOf/importedFrom，原稿一字不动
  const rows = dst.prepare('SELECT id, payload FROM works').all();
  assert.equal(rows.length, 2);
  const original = payloadOf(dst, 'works', 'w_A');
  assert.equal(original.background, '目标库版本');
  assert.equal(original.revision, 2);
  const copy = rows.map((x) => JSON.parse(x.payload)).find((x) => x.id !== 'w_A');
  assert.notEqual(copy.id, 'w_A');
  assert.equal(copy.background, '备份版本');
  assert.equal(copy.conflictOf, 'w_A');
  assert.equal(copy.importedFrom, 'backup');

  // 备份方 note B 的 workIds 重映射指向副本 A'
  const gotB = payloadOf(dst, 'notes', 'n_B');
  assert.deepEqual(gotB.workIds, [copy.id]);

  // 二次导入：A 走「副本已存在且同内容」跳过（idMap 一致），B 同内容跳过
  const r2 = mergeImport(dst, bak);
  assert.deepEqual(r2.created, ZERO);
  assert.equal(r2.skipped, 2);
  assert.equal(r2.conflictCopies, 0);
  assert.equal(dst.prepare('SELECT COUNT(*) c FROM works').get().c, 2);
});

/* ------------------------------------------------------------------ */
/* 场景 4：protected（final/published）不被覆盖                         */
/* ------------------------------------------------------------------ */

test('protected 札记不被覆盖：备份方存冲突副本，原稿一字不动', () => {
  const dst = setup();
  insertRawNote(dst, {
    id: 'n_F', title: '定稿札记', content: '定稿内容', writingStatus: 'final',
    revision: 3, updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const before = payloadOf(dst, 'notes', 'n_F');

  const bak = {
    format: 'ci-notes-backup', formatVersion: 2, exportedAt: '2026-06-01T00:00:00.000Z',
    counts: {}, data: {
      works: [], notes: [{
        id: 'n_F', title: '定稿札记', content: '备份修改后的内容', workIds: [], tags: [],
        writingStatus: 'draft', revision: 1,
        updatedAt: '2026-05-01T00:00:00.000Z', createdAt: '2026-05-01T00:00:00.000Z',
      }],
      revisions: [], comparisons: [], trash: [],
    },
  };
  const r = mergeImport(dst, bak);
  assert.deepEqual(r.created, { ...ZERO, notes: 0 });
  assert.equal(r.conflictCopies, 1);
  assert.equal(r.skipped, 0);

  // 原稿一字不动（含 revision 与 updatedAt）
  const after = payloadOf(dst, 'notes', 'n_F');
  assert.deepEqual(after, before);
  assert.equal(dst.prepare('SELECT revision, writing_status FROM notes WHERE id=?').get('n_F').revision, 3);
  assert.equal(dst.prepare('SELECT writing_status FROM notes WHERE id=?').get('n_F').writing_status, 'final');

  // 副本承接备份内容
  const rows = dst.prepare("SELECT payload FROM notes WHERE id!='n_F'").all();
  assert.equal(rows.length, 1);
  const copy = JSON.parse(rows[0].payload);
  assert.equal(copy.content, '备份修改后的内容');
  assert.equal(copy.conflictOf, 'n_F');
  assert.equal(copy.writingStatus, 'draft');

  // published 同理受保护：preflight 标记冲突而不建议覆盖
  dst.prepare("UPDATE notes SET publish_status='published' WHERE id='n_F'").run();
  const bak2 = JSON.parse(JSON.stringify(bak));
  bak2.data.notes[0].content = '又一份不同内容';
  const pf = preflightImport(dst, bak2);
  assert.equal(pf.conflicts.length, 1);
  assert.equal(pf.conflicts[0].id, 'n_F');
});

/* ------------------------------------------------------------------ */
/* 场景 5：词间 cijian-backup 兼容（剥账号键 + function→fn）            */
/* ------------------------------------------------------------------ */

test('词间备份兼容：cijian-backup 导入成功，剥账号键，imageryUse function→fn', () => {
  const db = setup();
  const backup = {
    format: 'cijian-backup', formatVersion: 2, app: '词间',
    exportedAt: '2026-01-01T00:00:00.000Z',
    owner: { ownerId: 'u_1', displayName: '我' },
    data: {
      works: [{
        id: 'w_cj', kind: 'ci', title: '相见欢', author: '李煜', content: '无言独上西楼',
        tags: ['ci'], revision: 2, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-06-01T00:00:00.000Z',
        ownerId: 'u_1', app_id: 'cijian', owner_name: '我',
      }],
      notes: [], revisions: [], comparisons: [], trash: [],
      imagery: [{
        id: 'im_cj', name: '梧桐', aliases: [], usages: [], tags: [], note: '',
        revision: 1, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-06-01T00:00:00.000Z',
        ownerId: 'u_1', app_id: 'cijian',
      }],
      imageryUses: [{
        id: 'iu_cj', imageryId: 'im_cj', targetType: 'work', targetId: 'w_cj',
        quote: '寂寞梧桐深院锁清秋', context: '下阕', function: '渲染孤寂', understanding: '',
        revision: 1, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-06-01T00:00:00.000Z',
        ownerId: 'u_1',
      }],
    },
  };
  assert.equal(validateBackup(backup).ok, true);
  const pf = preflightImport(db, backup);
  assert.equal(pf.ok, true);
  assert.deepEqual(pf.creates, { ...ZERO, works: 1, imagery: 1, imageryUses: 1 });

  const r = mergeImport(db, backup);
  assert.deepEqual(r.created, { ...ZERO, works: 1, imagery: 1, imageryUses: 1 });
  assert.equal(r.conflictCopies, 0);

  // 词作落库且剥离账号键（ownerId/app_id/owner_name）
  const w = payloadOf(db, 'works', 'w_cj');
  assert.equal(w.title, '相见欢');
  assert.equal(w.ownerId, undefined);
  assert.equal(w.app_id, undefined);
  assert.equal(w.owner_name, undefined);
  assert.equal(db.prepare('SELECT title, author FROM works WHERE id=?').get('w_cj').title, '相见欢');

  // 意象使用记录：function 改名为 fn，账号键剥离
  const u = payloadOf(db, 'imagery_uses', 'iu_cj');
  assert.equal(u.fn, '渲染孤寂');
  assert.equal(u.function, undefined);
  assert.equal(u.ownerId, undefined);

  // 二次导入同一词间备份：全部跳过（幂等）
  const r2 = mergeImport(db, backup);
  assert.deepEqual(r2.created, ZERO);
  assert.equal(r2.skipped, 3);

  // v1 备份无 imagery/allusions 集合：按空处理，合法可导入
  const v1 = {
    format: 'cijian-backup', formatVersion: 1, exportedAt: '2024-01-01T00:00:00.000Z',
    data: { works: [], notes: [], revisions: [], comparisons: [], trash: [] },
  };
  assert.equal(validateBackup(v1).ok, true);
  const r3 = mergeImport(db, v1);
  assert.deepEqual(r3.created, ZERO);
  assert.equal(r3.skipped, 0);
});

/* ------------------------------------------------------------------ */
/* 场景 6：validate 悬空 uses 清单 + 坏备份报错                         */
/* ------------------------------------------------------------------ */

test('validate 对悬空 uses 报 dangling 清单；坏备份报 errors', () => {
  const backup = {
    format: 'ci-notes-backup', formatVersion: 2, data: {
      works: [{ id: 'w_1' }],
      notes: [],
      revisions: [], comparisons: [], trash: [],
      imagery: [{ id: 'im_1' }],
      imageryUses: [
        { id: 'iu_1', imageryId: 'im_missing', targetType: 'work', targetId: 'w_1' },
        { id: 'iu_2', imageryId: 'im_1', targetType: 'note', targetId: 'n_missing' },
      ],
      allusions: [],
      allusionUses: [{ id: 'au_1', allusionId: 'al_missing', targetType: 'work', targetId: 'w_1' }],
    },
  };
  const v = validateBackup(backup);
  // 悬空引用是警告清单，不算校验失败
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.dangling, [
    { type: 'imageryUse', id: 'iu_1', ref: 'im_missing' },
    { type: 'imageryUse', id: 'iu_2', ref: 'n_missing' },
    { type: 'allusionUse', id: 'au_1', ref: 'al_missing' },
  ]);

  // 缺 id
  const badId = {
    format: 'ci-notes-backup', formatVersion: 2,
    data: { works: [{ title: '没有 id' }], notes: [], revisions: [], comparisons: [], trash: [] },
  };
  const vb = validateBackup(badId);
  assert.equal(vb.ok, false);
  assert.match(vb.errors[0], /词作/);
  assert.match(vb.errors[0], /缺少 id/);

  // format 不符
  const vf = validateBackup({ format: 'other-app', formatVersion: 1, data: { works: [], notes: [], revisions: [], comparisons: [], trash: [] } });
  assert.equal(vf.ok, false);
  assert.match(vf.errors[0], /format/);

  // 版本过高 / 缺 data / 缺必需集合
  assert.equal(validateBackup({ format: 'ci-notes-backup', formatVersion: 3, data: { works: [], notes: [], revisions: [], comparisons: [], trash: [] } }).ok, false);
  assert.equal(validateBackup({ format: 'ci-notes-backup', formatVersion: 2 }).ok, false);
  assert.equal(validateBackup({ format: 'ci-notes-backup', formatVersion: 2, data: { works: [] } }).ok, false);
  // 意象集合存在但不是数组
  assert.equal(validateBackup({ format: 'ci-notes-backup', formatVersion: 2, data: { works: [], notes: [], revisions: [], comparisons: [], trash: [], imagery: 'x' } }).ok, false);
});

/* ------------------------------------------------------------------ */
/* 场景 7：merge 坏数据整体回滚                                         */
/* ------------------------------------------------------------------ */

test('merge 坏数据整体回滚：计数不变，不写 imports，不留半套', () => {
  const db = setup();
  createWork(db, { title: '已有词作' });
  createNote(db, { title: '已有札记' });
  nextSeq(db); // 让计数器非零，验证回滚后 seq 也不前移
  const before = tableCounts(db);
  const seqBefore = db.prepare("SELECT value FROM counters WHERE name='revision_seq'").get().value;

  const backup = {
    format: 'ci-notes-backup', formatVersion: 2, data: {
      works: [{ id: 'w_ok', kind: 'ci', title: '好数据', tags: [], revision: 1, updatedAt: '2026-05-01T00:00:00.000Z' }],
      notes: [],
      revisions: [],
      comparisons: [],
      trash: [{ id: 't_bad' }], // 缺 itemType/snapshot：INSERT 阶段抛错
    },
  };
  assert.throws(() => mergeImport(db, backup));

  // 全部表计数不变（坏 work 已回滚），imports 未记录，seq 未前移
  assert.deepEqual(tableCounts(db), before);
  assert.equal(db.prepare("SELECT value FROM counters WHERE name='revision_seq'").get().value, seqBefore);
  assert.equal(db.prepare("SELECT 1 FROM works WHERE id='w_ok'").get(), undefined);

  // 未通过 validate 的备份：merge 直接拒绝并抛 INVALID
  const invalid = { format: 'nope', formatVersion: 2, data: {} };
  assert.throws(() => mergeImport(db, invalid), (e) => e instanceof StoreError && e.code === 'INVALID');
  assert.deepEqual(tableCounts(db), before);
});
