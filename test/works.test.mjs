import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.mjs';
import { createWork, updateWork, listWorks, getWork } from '../server/core/works.mjs';
import { StoreError } from '../server/core/errors.mjs';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';

function setup() { return openDb(join(mkdtempSync(join(tmpdir(), 'cn-')), 't.sqlite')); }

test('创建/读取词作', () => {
  const db = setup();
  const w = createWork(db, { title: '凤栖梧', author: '柳永', cipai: '凤栖梧', content: '伫倚危楼风细细', tags: ['春愁', '春愁'], claims: [{ text: '异文待核' }] });
  assert.match(w.id, /^w_/); assert.deepEqual(w.tags, ['春愁']);
  const detail = getWork(db, w.id);
  assert.equal(detail.work.title, '凤栖梧');
  assert.equal(detail.work.claims.length, 1);
  assert.throws(() => getWork(db, 'w_x'), StoreError);
});

test('空标题与原文拒绝', () => {
  const db = setup();
  assert.throws(() => createWork(db, { title: '  ', content: '' }), /至少填写/);
});

test('CAS 冲突与 force', () => {
  const db = setup();
  const w = createWork(db, { title: 'A', content: 'a' });
  const w2 = updateWork(db, w.id, { ...w, title: 'B' }, { baseRevision: w.revision });
  assert.equal(w2.work.revision, 2);
  assert.throws(() => updateWork(db, w.id, { ...w2.work, title: 'C' }, { baseRevision: w.revision }),
    e => e.code === 'CONFLICT' && e.current.title === 'B');
  const forced = updateWork(db, w.id, { ...w2.work, title: 'C' }, { baseRevision: w.revision, force: true });
  assert.equal(forced.work.title, 'C');
});

test('列表筛选与搜索', () => {
  const db = setup();
  createWork(db, { title: '凤栖梧', author: '柳永', cipai: '凤栖梧', content: '伫倚危楼', tags: ['春愁'] });
  createWork(db, { title: '浣溪沙', author: '周邦彦', kind: 'poem', content: '楼上晴天' });
  assert.equal(listWorks(db, { author: '柳永' }).length, 1);
  assert.equal(listWorks(db, { kind: 'poem' })[0].title, '浣溪沙');
  assert.equal(listWorks(db, { q: '危楼' })[0].title, '凤栖梧');
  assert.equal(listWorks(db, { q: '周邦彦' })[0].title, '浣溪沙');
  assert.equal(listWorks(db, { tag: '春愁' }).length, 1);
});
