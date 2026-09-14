// Isolated full-app HTTPS acceptance gateway. No systemd or production configuration.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=path.resolve(process.argv[2]||'');
if(process.platform!=='linux'||!path.basename(base).startsWith('organizador-web-erp4-validation-')||root!==path.join(base,'app'))throw new Error('Isolated Linux directory required');
const port=18873,tlsPort=18874;
const log=fs.openSync(path.join(base,'acceptance-server.log'),'a',0o600);
const child=spawn('node',['server/index.js'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),
  PYTHON_BIN:path.join(base,'runtime/bin/python'),DATABASE_PATH:path.join(root,'data/acceptance.db'),DATA_DIR:path.join(root,'data'),
  ERP4_BANKING_ENABLED:'1',ERP4_HTTPS_READY:'1',ERP4_KEY_FILE:path.join(base,'test-custody.key'),ERP4_LIVE_BANKING_ENABLED:'0',
  ERP4_PUBLIC_ORIGIN:`https://127.0.0.1:${tlsPort}`,ERP4_TRUST_LOOPBACK_PROXY:'1',AI_PROVIDER:'local'},stdio:['ignore',log,log]});
const proxy=https.createServer({key:fs.readFileSync(path.join(base,'tls.key')),cert:fs.readFileSync(path.join(base,'tls.crt'))},(req,res)=>{
  const upstream=http.request({host:'127.0.0.1',port,path:req.url,method:req.method,headers:{...req.headers,'x-forwarded-proto':'https'}},r=>{
    res.writeHead(r.statusCode,r.headers);r.pipe(res);
  });upstream.on('error',()=>{res.writeHead(502);res.end('Acceptance upstream unavailable');});req.pipe(upstream);
});
let stopping=false;
function stop(){if(stopping)return;stopping=true;proxy.close();child.kill('SIGTERM');setTimeout(()=>process.exit(0),1500).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);child.on('exit',stop);proxy.on('error',stop);
proxy.listen(tlsPort,'127.0.0.1',()=>console.log('ISOLATED_ERP4_HTTPS_READY'));
setTimeout(stop,15*60*1000).unref();
