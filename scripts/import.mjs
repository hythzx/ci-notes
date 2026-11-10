import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {openStore} from '../server/store.mjs';
if(!process.argv[2])throw new Error('用法：npm run import -- /path/to/词间-完整备份.json');
const payload=JSON.parse(readFileSync(process.argv[2],'utf8'));
const store=openStore(resolve(process.env.DATA_DIR||'data','ci-notes.sqlite'),{seed:false});
try{console.log(`导入 ${store.import(payload)} 个版本；重复导入会自动跳过。`);}finally{store.close();}
