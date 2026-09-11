import assert from 'node:assert/strict';
import {bankingTransport,createBankingHttp} from '../server/banking-http.js';

const config={enabled:true,publicOrigin:'https://bank.test',trustLoopbackProxy:true};
const session={id_usuario:7,auth_version:3,nombre:'Synthetic',comunidades:[{id_comunidad:1}]};
const base=()=>({method:'POST',headers:{host:'bank.test',origin:'https://bank.test','content-type':'application/json',
  'x-forwarded-proto':'https','sec-fetch-site':'same-origin',cookie:'session-synthetic'},socket:{remoteAddress:'127.0.0.1'}});
let calls=[],readCount=0,now=Date.now();
let response;
const handler=createBankingHttp(config,{
  readSession:()=>session,clock:()=>now,readBody:async req=>{readCount++;return req.body;},
  sendJson:(res,status,body)=>{response={status,body,headers:res.headers};},
  verifyPassword:async (_,value)=>value==='synthetic-password',
  runBanking:async (s,a,e)=>{calls.push({session:s,action:a,envelope:e});return a==='download'?{ok:true,content_base64:Buffer.from('<xml/>').toString('base64')}:{ok:true,entity:{}};},
});
async function request(action,body={},alter=()=>{}) {
  const req={...base(),body:{id_comunidad:1,...body}};alter(req);
  const res={headers:{},setHeader(k,v){this.headers[k]=v;},writeHead(status,headers){response={status,headers:{...this.headers,...headers}};},end(bytes){response.bytes=bytes;}};
  response=null;
  assert.equal(await handler(req,res,new URL('https://bank.test/api/erp/banking/'+action)),true);
  return response;
}

assert.equal(bankingTransport(base(),config),true);
assert.equal(bankingTransport({...base(),socket:{remoteAddress:'198.51.100.1'}},config),false);
assert.equal(bankingTransport(base(),{...config,trustLoopbackProxy:false}),false);
assert.equal(bankingTransport({...base(),headers:{...base().headers,host:'evil.test'}},config),false);
assert.equal(bankingTransport({...base(),headers:{...base().headers,origin:'https://evil.test'}},config),false);
assert.equal(bankingTransport({...base(),socket:{encrypted:true,remoteAddress:'198.51.100.1'}},{...config,trustLoopbackProxy:false}),true);
let result=await request('command',{command:'erp4.account.create'},req=>{delete req.headers['x-forwarded-proto'];});
assert.equal(result.status,403);assert.equal(readCount,0);assert.equal(calls.length,0);
result=await request('command',{command:'erp4.account.create',id_comunidad:2});
assert.equal(result.status,403);assert.equal(calls.length,0);
result=await request('reauthenticate',{password:'wrong'});assert.equal(result.status,401);
result=await request('reauthenticate',{password:'synthetic-password'});assert.equal(result.status,200);
await request('command',{command:'erp4.remittance.export',origin:'agent',banking_reauthenticated_at:'forged'});
assert.equal(calls.at(-1).session.banking_reauthenticated_at,new Date(now).toISOString());
assert.equal(calls.at(-1).envelope.origin,'web');
await request('command',{command:'erp4.remittance.export'},req=>{req.headers.cookie='different-session';});
assert.equal(calls.at(-1).session.banking_reauthenticated_at,null);
now+=300001;
await request('command',{command:'erp4.remittance.export'});
assert.equal(calls.at(-1).session.banking_reauthenticated_at,null);
result=await request('download',{token:'synthetic'});
assert.equal(result.bytes.toString(),'<xml/>');assert.match(result.headers['Cache-Control'],/no-store/);
assert.equal(result.body,undefined);assert.equal(result.headers['Content-Type'],'application/xml; charset=utf-8');
for(let i=0;i<5;i++) assert.equal((await request('reauthenticate',{password:'wrong'})).status,401);
assert.equal((await request('reauthenticate',{password:'synthetic-password'})).status,429);
assert.equal((await request('query',{query:'erp3.receipt.list'})).status,400);
console.log('ERP4 HTTP checks passed (HTTPS, proxy, origin, tenant, reauthentication, expiry, session binding, rate limit, private download).');
