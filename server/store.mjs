import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
export const fields=['id','title','author','tune','theme','status','publication','original','background','body','appendix','sources','evidence','scene','imagery','allusion','expression','change'];
export const statuses=['待写','资料收集','待导入','草稿','定稿','已发布'];
export function validateNote(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('无效的札记');
 const note={};
 for(const field of fields){if(typeof value[field]!=='string')throw new Error(`字段 ${field} 必须为文本`);note[field]=value[field];}
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(note.id))throw new Error('无效的札记标识');
 if(!note.title.trim()||note.title.length>200)throw new Error('标题不能为空，且不得超过 200 字');
 if(!statuses.includes(note.status)||!['未发布','待发布','已发布'].includes(note.publication))throw new Error('无效的状态');
 if(Buffer.byteLength(JSON.stringify(note))>200000)throw new Error('单篇内容不能超过 200KB');
 return note;
}
export function openStore(path,{seed=true}={}){
 if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
 const db=new DatabaseSync(path,{timeout:5000});
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS versions(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,data TEXT NOT NULL,created TEXT NOT NULL,import_key TEXT UNIQUE);
 CREATE INDEX IF NOT EXISTS versions_id_seq ON versions(id,seq);
 CREATE TRIGGER IF NOT EXISTS preserve_version_update BEFORE UPDATE ON versions BEGIN SELECT RAISE(ABORT,'versions are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS preserve_version_delete BEFORE DELETE ON versions BEGIN SELECT RAISE(ABORT,'versions are immutable'); END;
 INSERT OR IGNORE INTO schema_migrations(version) VALUES(1);`);
 const list=()=>db.prepare('SELECT seq,id,data,created FROM versions ORDER BY seq').all();
 const latest=(id)=>db.prepare('SELECT seq,id,data,created FROM versions WHERE id=? ORDER BY seq DESC LIMIT 1').get(id);
 const insert=(note,created=new Date().toISOString(),key=null)=>db.prepare('INSERT INTO versions(id,data,created,import_key) VALUES(?,?,?,?) RETURNING seq,id,data,created').get(note.id,JSON.stringify(note),created,key);
 if(seed&&db.prepare('SELECT count(*) AS n FROM versions').get().n===0){
  const seeds=JSON.parse(readFileSync(new URL('./seeds.json',import.meta.url),'utf8'));
  db.exec('BEGIN IMMEDIATE');try{for(const n of seeds)insert(validateNote(n),'2026-11-10T01:15:49.569Z','seed:'+n.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 }
 return {db,list,latest,close:()=>db.close(),
  save(value,expectedSeq){const note=validateNote(value);if(!Number.isSafeInteger(expectedSeq)||expectedSeq<0)throw new Error('缺少版本号，请刷新后重试');db.exec('BEGIN IMMEDIATE');try{
   const previous=latest(note.id);if((previous?.seq??0)!==expectedSeq){const e=new Error('另一处已有新版本。当前文字仍在编辑框中，请先导出或复制，再刷新合并。');e.status=409;throw e;}
   const row=insert(note);db.exec('COMMIT');return row;
  }catch(e){db.exec('ROLLBACK');throw e;}},
  export(){const versions=list();const notes=Object.values(Object.fromEntries(versions.map(r=>[r.id,JSON.parse(r.data)])));return {format:'ci-notes',version:1,exportedAt:new Date().toISOString(),notes,versions};},
  import(payload){
   if(!payload||!Array.isArray(payload.notes)||!Array.isArray(payload.versions))throw new Error('需要词间导出的 notes / versions JSON');
   const records=[];
   // Baselines precede history, so the final history revision stays current.
   const historyIds=new Set(payload.versions.map(r=>r.id));
   for(const n of payload.notes){const note=validateNote(n);if(!historyIds.has(note.id))records.push({note,created:'2026-11-10T00:00:00.000Z'});}
   for(const r of payload.versions){const note=validateNote(typeof r.data==='string'?JSON.parse(r.data):r.data);if(r.id!==note.id||typeof r.created!=='string'||!Number.isFinite(Date.parse(r.created)))throw new Error('历史版本格式不正确');records.push({note,created:r.created});}
   db.exec('BEGIN IMMEDIATE');let count=0;try{for(const {note,created} of records){const key=createHash('sha256').update(JSON.stringify([note,created])).digest('hex');
    if(db.prepare('SELECT 1 FROM versions WHERE import_key=? OR (id=? AND data=? AND created=?)').get(key,note.id,JSON.stringify(note),created))continue;
    insert(note,created,key);count++;
   }db.exec('COMMIT');return count;}catch(e){db.exec('ROLLBACK');throw e;}
  }
 };
}
