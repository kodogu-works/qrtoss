import {spawn} from 'node:child_process';
const run=(args,options={})=>spawn(process.execPath,args,{stdio:'inherit',...options});
const build=run(['node_modules/vite/bin/vite.js','build','--config','web/vite.config.ts']);
build.on('exit',code=>{
  if(code!==0){process.exitCode=code??1;return;}
  const env={...process.env,NODE_ENV:'development',PUBLIC_ORIGIN:process.env.PUBLIC_ORIGIN??'http://127.0.0.1:8080'};
  const server=run(['--import','tsx','server/src/main.ts'],{env});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.kill(signal));
  server.on('exit',code=>{process.exitCode=code??0;});
  console.error(`Local: ${env.PUBLIC_ORIGIN}`);
});
