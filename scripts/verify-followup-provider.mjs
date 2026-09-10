// Explicit, synthetic-only provider probe. Never reads business tables or writes records.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { analyzeTargetedFollowup } from '../server/ai-followup.js';
import { analyzeMeeting } from '../server/ai-meetings.js';
const config={...process.env};
const envFile=process.argv[2];
if(envFile) for(const line of fs.readFileSync(path.resolve(envFile),'utf8').split(/\r?\n/)){
  const match=line.match(/^([A-Z_]+)=(.*)$/);
  if(match && !config[match[1]]) config[match[1]]=match[2].trim().replace(/^['"]|['"]$/g,'');
}
const key=config.AI_API_KEY || config.NVIDIA_API_KEY || config.ORGANIZADOR_NVIDIA_API_KEY || config.OPENAI_API_KEY;
assert.ok(key,'External provider key not configured');
const provider=config.AI_PROVIDER || 'nvidia';
const model=config.AI_MODEL || 'nvidia/nemotron-3-super-120b-a12b';
const base=config.AI_BASE_URL || 'https://integrate.api.nvidia.com/v1';
if(process.argv.includes('--list-models')){
  const response=await fetch(base.replace(/\/$/,'')+'/models',{headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200,'Provider catalog HTTP '+response.status);
  const data=await response.json();
  console.log(JSON.stringify((data.data || []).map(row=>row.id).filter(id=>/nemotron|qwen|deepseek|gpt-oss|mistral/i.test(id)),null,2));
  process.exit(0);
}
const input='Hoy he hablado con Paquito. Dice que no tiene problema en hacer los badenes fuera de su horario del campo. Calcula unas tres horas por unidad porque lo que mas tarda es el replanteo. Tampoco tiene problema en hacerlo en una hora de poco trafico. Si aceptamos el presupuesto, el siguiente paso seria ir a Valeriano a ver el material antes de pedirlo.';
const callAi=async request=>{
  const response=await fetch(base.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
    signal:AbortSignal.timeout(request.timeoutMs),body:JSON.stringify({model,temperature:0.1,max_tokens:request.maxTokens,...(/^openai\/gpt-oss-/.test(model)?{reasoning_effort:request.reasoningEffort}:{}),response_format:{type:'json_object'},messages:[{role:'system',content:request.system},{role:'user',content:request.user}]})});
  assert.equal(response.status,200,'Provider HTTP '+response.status);
  const data=await response.json();
  assert.notEqual(data.choices?.[0]?.finish_reason,'length','Incomplete response');
  const content=data.choices?.[0]?.message?.content || '';
  const start=content.indexOf('{'), end=content.lastIndexOf('}');
  const parsed=JSON.parse(content.slice(start,end+1));
  if(process.argv.includes('--trace')) console.log(JSON.stringify({synthetic_provider_output:parsed}));
  return {...parsed,source:provider,ai_model:model};
};
if(process.argv.includes('--meeting-only')) {
  const meeting=await analyzeMeeting({text:input+'\nElena: La farola de entrada ya funciona tras cambiar el fusible. Quedan otras dos sin reparar. Juan revisara la que esta dentro de la obra manana.\nLuis: Volviendo a los badenes, no se ha aprobado aun el presupuesto.\nElena: Hay una nueva gotera en el almacen que no hemos registrado. No sabemos quien la revisara.',sourceDate:'2026-09-10',
    catalog:[{type:'project',id:1,titulo:'Instalacion de badenes',estado:'Pendiente',responsable:'Coordinacion',id_comunidad:1},
      {type:'task',id:2,titulo:'Incidencias de alumbrado',estado:'En curso',responsable:'Coordinacion',id_comunidad:1}],callAi,
    progress:async (percent,message)=>console.log(JSON.stringify({percent,message}))});
  console.log(JSON.stringify({synthetic_only:true,meeting},null,2));
  const speed=meeting.proposals.find(p=>p.entity?.type==='project' && p.entity.id===1);
  const lighting=meeting.proposals.find(p=>p.entity?.type==='task' && p.entity.id===2);
  assert.ok(speed && lighting,'Both existing topics must be found');
  assert.match(speed.payload.proximo_paso,/presupuesto/i);
  assert.equal(speed.payload.fecha_objetivo_proximo_paso,'','Date of conversation is not the deadline');
  assert.equal(lighting.payload.estado_nuevo,'En curso');
  assert.ok(meeting.proposals.some(p=>p.action==='crear_tarea' || p.action==='revisar_manual'));
  assert.ok(meeting.proposals.every(p=>p.payload.comentario));
  console.log('Synthetic meeting provider check passed');
  process.exit(0);
}
if(!process.argv.includes('--partial-only')){
const result=await analyzeTargetedFollowup({text:input,target:{type:'project',id:1},item:{nombre:'Proyecto ficticio de badenes',estado_general:'Pendiente',responsable_principal:'Coordinacion',prioridad:'Media'},callAi});
assert.equal(result.action,'seguimiento_proyecto');
assert.equal(result.payload.estado_nuevo,'Pendiente');
assert.equal(result.payload.responsable_nuevo,'Coordinacion');
assert.equal(result.payload.responsable_proximo_paso,'Administracion');
assert.equal(result.payload.fecha_objetivo_proximo_paso,'');
assert.match(result.payload.proximo_paso,/presupuesto/i);
assert.match(result.payload.comentario,/tres|3/);
console.log(JSON.stringify({ok:true,synthetic_only:true,source:result.source,model:result.ai_model,payload:result.payload,warnings:result.warnings},null,2));
}
if(process.argv.includes('--extended') || process.argv.includes('--partial-only')){
  const partial=await analyzeTargetedFollowup({text:'La farola de la entrada ya funciona tras cambiar el fusible. Quedan dos farolas sin reparar, una sin bloque optico y otra dentro de la obra. Juan revisara la farola de la obra manana; el encargado ya ha autorizado el acceso.',
    sourceDate:'2026-09-09',target:{type:'task',id:2},item:{titulo:'Incidencias de alumbrado',estado:'En curso',responsable:'Coordinacion'},callAi});
  console.log(JSON.stringify({case:'partial_repair_raw_proposal',proposal:partial},null,2));
  assert.equal(partial.payload.estado_nuevo,'En curso');
  assert.match(partial.payload.comentario,/fusible/);
  assert.equal(partial.payload.responsable_proximo_paso,'Juan');
  assert.equal(partial.payload.fecha_objetivo_proximo_paso,'2026-09-10');
  console.log(JSON.stringify({ok:true,case:'partial_repair_and_relative_date',payload:partial.payload,warnings:partial.warnings},null,2));
  const vague=await analyzeTargetedFollowup({text:'Eso que hablamos el otro dia, ya sabes.',target:{type:'project',id:3},item:{nombre:'Proyecto ficticio',estado_general:'En curso',responsable_principal:'Coordinacion'},callAi});
  assert.equal(vague.requires_clarification,true);
  console.log(JSON.stringify({ok:true,case:'insufficient_input',questions:vague.questions},null,2));
}
