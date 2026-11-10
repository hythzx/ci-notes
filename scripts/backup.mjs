import {DatabaseSync,backup} from 'node:sqlite';
import {resolve,dirname} from 'node:path';
import {mkdirSync,existsSync} from 'node:fs';
const source=resolve(process.env.DATA_DIR||'data','ci-notes.sqlite');
const target=resolve(process.argv[2]||`backups/ci-notes-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
if(!existsSync(source))throw new Error('数据库不存在，请先启动应用');
if(existsSync(target))throw new Error('备份目标已存在，请选择新文件名');
mkdirSync(dirname(target),{recursive:true});
const db=new DatabaseSync(source,{readOnly:true});try{await backup(db,target);console.log(`备份完成：${target}`);}finally{db.close();}
