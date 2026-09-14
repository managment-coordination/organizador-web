// UI batches send only typed domain fields; suggestion metadata is not a command.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const calls=[];
const buttons=['select-all','next','bulk'].map(action=>({dataset:{reconcile:action}}));
const root={innerHTML:'',setAttribute(){},querySelector:()=>null,
  querySelectorAll:selector=>selector==='[data-reconcile]'?buttons:[]};
const context=vm.createContext({crypto:globalThis.crypto,console});
vm.runInContext(fs.readFileSync(new URL('../server/reconciliation-ui.js',import.meta.url),'utf8'),context);
const ui=context.createReconciliationUI({html:String,root:()=>root,active:()=>true,communities:()=>[{id_comunidad:7,nombre:'Sintetica'}],
  moneyLabel:String,moneyCents:String,api:async(_url,request)=>{
    const r=JSON.parse(request.body);calls.push(r);let entity;
    const name=r.query||r.command;
    if(name==='erp5.workspace.get')entity={accounts:[{id:1,label:'Banco sintetico',kind:'banco'}],permissions:{read:true,propose:true,confirm:true},current_user_id:1};
    else if(name==='erp5.movement.list')entity={items:Array.from({length:r.filters.offset?2:50},(_,i)=>({id:i+1+(r.filters.offset||0),amount_cents:'10000',state:'pendiente'})),total:52};
    else if(name==='erp5.balances.get')entity={complete:false};
    else if(name==='erp5.closure.list')entity={items:[]};
    else if(name==='erp5.proposals.get')entity={items:[{action:'link_collection',fact_id:r.filters.movement_id+10,amount_cents:'10000',confidence:'alta',reason:'Referencia',rule:'typed-v1'}],truncated:false};
    else if(name==='erp5.match.preview'){
      for(const c of r.payload.components)assert.deepEqual(Object.keys(c).sort(),['action','amount_cents','fact_id','movement_id']);
      entity={id:1,version:1,components:r.payload.components};
    }else throw new Error('Unexpected '+name);
    return {ok:true,entity};
  }});
await ui.open(7);await buttons[0].onclick();await buttons[1].onclick();await buttons[0].onclick();await buttons[2].onclick();
const preview=calls.find(c=>c.command==='erp5.match.preview');assert(preview);
assert.equal(preview.payload.components.length,52);assert.equal(new Set(preview.payload.components.map(c=>c.movement_id)).size,52);assert(root.innerHTML.includes('Revisar antes de confirmar'));
console.log('ERP5 bulk UI passed: 52 movements across two pages, typed payload, human review, no economic confirmation.');
