// Read-only smoke of the delivered application; no credentials or economic writes.
import assert from 'node:assert/strict';
import vm from 'node:vm';

const origin=new URL(process.argv[2]||'http://127.0.0.1:8771');
assert(['http:','https:'].includes(origin.protocol));
const get=route=>fetch(new URL(route,origin),{signal:AbortSignal.timeout(15000)});
const health=await get('/health');assert.equal(health.status,200);
assert.equal((await health.json()).databaseConfigured,true);
const home=await get('/');assert.equal(home.status,200);
const html=await home.text();assert(html.includes('function createReconciliationUI'));
let inlineScripts=0;
for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
  if(/\bsrc\s*=|\btype\s*=\s*["']application\/json/i.test(match[1]))continue;
  new vm.Script(match[2],{filename:'delivered-inline-'+(++inlineScripts)+'.js'});
}
assert(inlineScripts>0);
for(const route of ['/api/erp/banking/status','/api/erp/query?query=erp3.receipt.list&id_comunidad=7']){
  assert.equal((await get(route)).status,401,'Unauthenticated route: '+route);
}
const query=await fetch(new URL('/api/erp/banking/query',origin),{method:'POST',
  headers:{'Content-Type':'application/json',Origin:origin.origin},
  body:JSON.stringify({query:'erp5.workspace.get',id_comunidad:999999,filters:{}}),signal:AbortSignal.timeout(15000)});
assert.equal(query.status,401,'A foreign community must not bypass authentication');
console.log(JSON.stringify({ok:true,origin:origin.origin,health:true,reconciliationDelivered:true,
  inlineScriptsValid:inlineScripts,unauthenticatedRoutesDenied:true,economicWrites:false}));
