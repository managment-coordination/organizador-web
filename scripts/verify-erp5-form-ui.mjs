// Exercise the actual form handlers with an unsigned shared money converter.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const calls=[],buttons=['manual','detail','correction','confirm','component','stage-component','review-components'].map(action=>({dataset:{reconcile:action,id:'1'}}));
const form={values:{},querySelectorAll:()=>[]};
const root={innerHTML:'',busy:false,setAttribute(name,value){if(name==='aria-busy')this.busy=value==='true';},querySelector(selector){return selector==='[data-reconciliation-form]'&&this.innerHTML.includes('data-reconciliation-form')?form:null;},
  querySelectorAll:selector=>selector==='[data-reconcile]'?buttons:[]};
class FormData {constructor(form){this.values=form.values;}[Symbol.iterator](){return Object.entries(this.values)[Symbol.iterator]();}}
const context=vm.createContext({crypto:globalThis.crypto,FormData,console});
vm.runInContext(fs.readFileSync(new URL('../server/reconciliation-ui.js',import.meta.url),'utf8'),context);
let rejectPreview=false;
const ui=context.createReconciliationUI({html:String,root:()=>root,active:()=>true,communities:()=>[],moneyLabel:String,
  moneyCents:value=>{assert(!String(value).startsWith('-'),'Shared converter rejects negative values');const [a,b='']=String(value).split('.');return (BigInt(a)*100n+BigInt(b.padEnd(2,'0'))).toString();},
  api:async(_url,request)=>{
    const r=JSON.parse(request.body);calls.push(r);const name=r.query||r.command;let entity;
    if(name==='erp5.workspace.get')entity={accounts:[{id:1,label:'Synthetic',kind:'banco'}],permissions:{read:true,import:true,propose:true,correct:true,confirm:true},current_user_id:1};
    else if(name==='erp5.movement.list')entity={items:[{id:1,amount_cents:'9800'},{id:2,amount_cents:'9800'}],total:2};
    else if(name==='erp5.balances.get')entity={complete:false};
    else if(name==='erp5.closure.list')entity={items:[]};
    else if(name==='erp5.movement.get')entity={id:1,version:9,operation_on:'2026-09-01',amount_cents:'9800',remaining_cents:'9800',history:[]};
    else if(name==='erp5.proposals.get')entity={items:[]};
    else if(name==='erp5.facts.list')entity={items:[],receipts:[],collections:[]};
    else if(name==='erp5.statement.preview')entity={id:1,version:1,rows:[]};
    else if(name==='erp5.movement.correct'){assert.equal(r.expected_version,9);entity={id:1};}
    else if(name==='erp5.match.preview'){
      if(rejectPreview){rejectPreview=false;throw new Error('Synthetic review conflict');}
      entity={id:2,version:1,components:r.payload.components,remaining:[{movement_id:1,after_cents:'0'}]};
    }else if(name==='erp5.match.confirm')entity={id:3};
    else throw new Error('Unexpected '+name);
    return {ok:true,entity};
  }});
const click=async action=>buttons.find(b=>b.dataset.reconcile===action).onclick();
const submit=async values=>{form.values=values;form.onsubmit({preventDefault(){}});while(root.busy)await new Promise(setImmediate);};
await ui.open(7);await click('manual');await submit({on:'2026-09-01',amount:'-20.00',concept:'Synthetic outflow'});
assert.equal(calls.find(c=>c.command==='erp5.statement.preview').payload.rows[0].amount_cents,'-2000');
await ui.open(7);await click('detail');await click('correction');await submit({replacement:'2',kind:'duplicate'});await click('confirm');
assert(calls.some(c=>c.command==='erp5.movement.correct'&&c.expected_version===9));
await ui.open(7);await click('detail');await click('component');rejectPreview=true;
const ordinary={action:'record_collection',amount:'60.00'};await submit(ordinary);await submit(ordinary);
const attempts=calls.filter(c=>c.command==='erp5.match.preview');assert.deepEqual(attempts.map(c=>c.payload.components.length),[1,1],'Failed preview must not append duplicate draft components');
await ui.open(7);await click('detail');await click('component');
const count=calls.length;form.values={action:'record_collection',amount:'100.00',net_evidence:'SYNTHETIC-NET'};await click('stage-component');
form.values={action:'record_outflow',amount:'2.00',kind:'commission',description:'Synthetic bank fee',net_evidence:'SYNTHETIC-NET'};await click('stage-component');
assert.equal(calls.length,count,'Draft breakdown sends no domain command');await click('review-components');
const preview=calls.at(-1);assert.equal(preview.command,'erp5.match.preview');assert.equal(preview.payload.net_evidence,'SYNTHETIC-NET');
assert.deepEqual(preview.payload.components.map(c=>c.amount_cents),['10000','-200']);assert(root.innerHTML.includes('Pendiente despues de confirmar'));
await click('confirm');assert.equal(calls.filter(c=>c.command==='erp5.match.confirm').length,1);
console.log('ERP5 form UI passed: signed manual input, correction version, safe preview retry, net draft without effects, exact typed signs, explicit confirmation.');
