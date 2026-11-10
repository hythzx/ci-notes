import {resolve} from 'node:path';
import {createApp} from './app.mjs';
const {server,store}=createApp({databasePath:resolve(process.env.DATA_DIR||'data','ci-notes.sqlite'),username:process.env.APP_USERNAME,password:process.env.APP_PASSWORD});
const port=Number(process.env.PORT||3000);
server.listen(port,process.env.HOST||'0.0.0.0',()=>console.log(`词间已启动，端口 ${port}`));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{server.close(()=>{store.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();});
