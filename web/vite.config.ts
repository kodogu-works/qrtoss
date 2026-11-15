import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
let commit=process.env.SOURCE_COMMIT??'unknown';
if(commit==='unknown')try{commit=execFileSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{/* Source archives may omit Git metadata. */}

export default defineConfig({
  define:{__APP_VERSION__:JSON.stringify(version),__SOURCE_COMMIT__:JSON.stringify(commit)},
  root: resolve(import.meta.dirname),
  build: { outDir: resolve(import.meta.dirname, '../dist/web'), emptyOutDir: true,
    rollupOptions: { input: { receiver: resolve(import.meta.dirname, 'index.html'), sender: resolve(import.meta.dirname, 'send/index.html') } } },
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:8787', '/ws': { target: 'ws://127.0.0.1:8787', ws: true } } },
});
