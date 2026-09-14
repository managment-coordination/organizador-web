// The main shell must retain the reconciliation view and invalidate old context.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const events=[];let active=true,ui;
const context=vm.createContext({console,crypto:globalThis.crypto,createReconciliationUI:ctx=>({
  open:async(...args)=>events.push(['open',...args]),
  render:()=>events.push(['render',ctx.active()]),cancel:()=>events.push(['cancel']),
})});
vm.runInContext(fs.readFileSync(new URL('../server/banking-ui.js',import.meta.url),'utf8'),context);
ui=context.createBankingUI({api:async()=>{throw new Error('Unexpected bank API request');},html:String,
  root:()=>({}),active:()=>active,communities:()=>[],moneyLabel:String,navigate:()=>ui.render()});
await ui.openReconciliation(7,{receipt_id:123,start_on:'2026-01-01'},'Recibo de prueba');
assert.equal(events.find(e=>e[0]==='open')[1],7);
ui.render();ui.ensure();assert.equal(events.at(-1)[0],'render');assert.equal(events.at(-1)[1],true);
active=false;const n=events.length;ui.render();assert.equal(events.length,n);
ui.reset();assert.equal(events.at(-1)[0],'cancel');
console.log('ERP5 shell state passed: contextual open, retained view, no legacy reload, cancellation on reset.');
