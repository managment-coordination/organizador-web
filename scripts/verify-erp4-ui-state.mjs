// Deterministic stale-context and permission-bootstrap regression, using the real UI module.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const sandbox={crypto:globalThis.crypto};vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL('../server/banking-ui.js',import.meta.url),'utf8'),sandbox);
const flush=()=>new Promise(resolve=>setTimeout(resolve,20));
function harness(workspace){
  const calls=[];let ui;
  const root={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[],setAttribute:()=>{}};
  const ctx={root:()=>root,active:()=>true,html:v=>String(v??''),moneyLabel:v=>String(v),isSuperuser:()=>true,
    communities:()=>[{id_comunidad:1,nombre:'One'},{id_comunidad:2,nombre:'Two'}],navigate:()=>ui.ensure(),
    api:async(route,options)=>{
      if(route.endsWith('/status'))return {available:true};
      const body=JSON.parse(options.body);calls.push(body);
      if(body.query==='erp4.workspace.get')return {entity:await workspace(body.id_comunidad)};
      if(body.query==='erp4.permissions.get')return {entity:{users:[]}};
      return {entity:{items:[],total:0}};
    }};
  ui=sandbox.createBankingUI(ctx);return {ui,root,calls};
}
const data={permissions:{read_masked:true,prepare:true},counts:{},live_enabled:false};
let release;
const old=new Promise(resolve=>{release=resolve;});
const switching=harness(id=>id===1?old:data);
switching.ui.open(1);await flush();switching.ui.open(2);await flush();release(data);await flush();
assert.equal(switching.calls.filter(c=>c.query==='erp4.permissions.get').length,0);
assert(switching.root.innerHTML.includes('Preparar remesa'));
const technical=harness(()=>{const error=new Error('Temporary technical failure');error.status=400;throw error;});
technical.ui.open(1);await flush();assert.equal(technical.calls.filter(c=>c.query==='erp4.permissions.get').length,0);
assert(technical.root.innerHTML.includes('Temporary technical failure'));
const missing=harness(()=>{const error=new Error('No tienes permiso para esta operacion bancaria.');error.status=403;throw error;});
missing.ui.open(1);await flush();assert.equal(missing.calls.filter(c=>c.query==='erp4.permissions.get').length,1);
assert(missing.root.innerHTML.includes('Permisos bancarios por usuario'));
console.log('ERP4 UI state: stale context ignored, technical failures visible, explicit permission bootstrap preserved.');
