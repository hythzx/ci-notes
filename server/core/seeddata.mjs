import { readFileSync } from 'node:fs';
import { nextSeq } from './db.mjs';
import { snapshotOf } from './notes.mjs';

/**
 * 空库判定与种子数据。facade 在 seed=true 且四张实体表全空时调用 seedAll(db)。
 *
 * 种子内容（task-12-brief）：
 *   - 词作四首、札记两篇、对照一条：从词间 utils/seed.js 逐字搬运
 *     （固定 ID w_seed_*、n_seed_*、cp_seed_liu_zhou；claims 的 verified/pending
 *     混排与 citations 出处链接原样保留，札记正文留空标 pendingImport）；
 *   - 意象「月亮」、典故「庄周梦蝶」：本项目新增库条目（纯库条目，不虚构 use 记录）；
 *   - revisions：每篇札记派生一条 v1（reason='manual'，快照字段照 snapshotOf，
 *     seq 取全局计数器 nextSeq，事务内调用）。
 *
 * 写入方式：BEGIN IMMEDIATE 单事务 + INSERT OR IGNORE（主键固定 ID，重跑不重复）。
 * seeds.json 中 imageryUses/allusionUses 按契约固定为空数组，循环对其不产生写入。
 */

const SEED_TABLES = ['works', 'notes', 'imagery', 'allusions'];

const SEEDS = JSON.parse(readFileSync(new URL('../seeds.json', import.meta.url), 'utf8'));

/** works/notes/imagery/allusions 四表全空即视为空库 */
export function isEmpty(db) {
  for (const table of SEED_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    if (row.n > 0) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 写入（列清单照 backup.mjs insertRecord 抄写，加 OR IGNORE）           */
/* ------------------------------------------------------------------ */

function insertWork(db, c) {
  db.prepare('INSERT OR IGNORE INTO works(id,payload,revision,title,author,cipai,kind,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(c.id, JSON.stringify(c), c.revision || 1, c.title || '', c.author || '',
      c.cipai || '', c.kind || 'ci', c.updatedAt);
}

function insertNote(db, c) {
  db.prepare('INSERT OR IGNORE INTO notes(id,payload,revision,title,writing_status,publish_status,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(c.id, JSON.stringify(c), c.revision || 1, c.title || '',
      c.writingStatus || 'draft', c.publishStatus || 'unpublished', c.updatedAt);
}

/** 札记的 v1 版本：快照字段照 snapshotOf，seq 用全局计数器（须在事务内） */
function insertNoteRevision(db, note) {
  db.prepare('INSERT OR IGNORE INTO revisions(id,note_id,seq,snapshot,change_note,reason,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('rv_seed_' + note.id, note.id, nextSeq(db), JSON.stringify(snapshotOf(note)),
      note.changeNote || '', 'manual', note.createdAt);
}

function insertComparison(db, c) {
  db.prepare('INSERT OR IGNORE INTO comparisons(id,payload,work_a_id,work_b_id,updated_at) VALUES(?,?,?,?,?)')
    .run(c.id, JSON.stringify(c), c.workAId || '', c.workBId || '', c.updatedAt);
}

function insertImagery(db, c) {
  db.prepare('INSERT OR IGNORE INTO imagery(id,payload,revision,name,merged_into,updated_at) VALUES(?,?,?,?,?,?)')
    .run(c.id, JSON.stringify(c), c.revision || 1, c.name || '', c.mergedInto || '', c.updatedAt);
}

function insertImageryUse(db, c) {
  db.prepare('INSERT OR IGNORE INTO imagery_uses(id,payload,revision,imagery_id,target_type,target_id,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(c.id, JSON.stringify(c), c.revision || 1, c.imageryId, c.targetType || 'work', c.targetId, c.updatedAt);
}

function insertAllusion(db, c) {
  db.prepare('INSERT OR IGNORE INTO allusions(id,payload,revision,name,updated_at) VALUES(?,?,?,?,?)')
    .run(c.id, JSON.stringify(c), c.revision || 1, c.name || '', c.updatedAt);
}

function insertAllusionUse(db, c) {
  db.prepare('INSERT OR IGNORE INTO allusion_uses(id,payload,revision,allusion_id,target_type,target_id,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(c.id, JSON.stringify(c), c.revision || 1, c.allusionId, c.targetType || 'work', c.targetId, c.updatedAt);
}

/** seeds.json 集合 → 写入函数（顺序即依赖顺序：札记先于其版本） */
const INSERTERS = {
  works: insertWork,
  notes: insertNote,
  comparisons: insertComparison,
  imagery: insertImagery,
  imageryUses: insertImageryUse,
  allusions: insertAllusion,
  allusionUses: insertAllusionUse,
};

/**
 * 空库种子：按 seeds.json 逐集合写入，札记各派生一条 v1 版本。
 * 整体一个事务，任何一步失败整体回滚。
 */
export function seedAll(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [key, insert] of Object.entries(INSERTERS)) {
      for (const rec of SEEDS[key] || []) {
        insert(db, rec);
      }
    }
    for (const note of SEEDS.notes) {
      insertNoteRevision(db, note);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
