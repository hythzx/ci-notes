/**
 * 空库判定与种子数据。facade 在 seed=true 且四张实体表全空时调用 seedAll(db)。
 * seedAll 由 Task 12 填充空库种子，本任务仅建桩（空函数体）。
 */

const SEED_TABLES = ['works', 'notes', 'imagery', 'allusions'];

/** works/notes/imagery/allusions 四表全空即视为空库 */
export function isEmpty(db) {
  for (const table of SEED_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    if (row.n > 0) return false;
  }
  return true;
}

export function seedAll(db) {
  // Task 12 填充：空库种子
}
