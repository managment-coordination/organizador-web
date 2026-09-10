import assert from 'node:assert/strict';
import { meetingChunks, analyzeMeeting } from '../server/ai-meetings.js';
const long = ('Texto con intervenciones.\n'.repeat(6500));
assert.equal(meetingChunks(long).join(''),long);
assert.throws(() => meetingChunks('x'.repeat(180001)),/180.000/);
const catalog = [{type:'project',id:7,titulo:'Badenes',estado:'En curso',responsable:'Luis',version:'v1',id_comunidad:1}];
const text = 'Paquito estima tres horas por baden. Si se aprueba el presupuesto iremos a Valeriano. La puerta no cierra.';
let count = 0;
const values = [
  {asuntos:[{titulo:'Badenes',citas:['Paquito estima tres horas por baden. Si se aprueba el presupuesto iremos a Valeriano.']},{titulo:'Puerta',citas:['La puerta no cierra.']}]},
  {grupos:[{titulo:'Badenes',fragmentos:[0],tipo:'project',id:7},{titulo:'Puerta',fragmentos:[1],tipo:'pendiente',pregunta:'Que puerta es?'}]},
  {comentario:'Se estima una duracion de tres horas por baden.',proximo_paso:'Visitar Valeriano una vez aprobado el presupuesto.',evidencias:{}},
  {comentario:'Se comunica una incidencia en el cierre de una puerta.',proximo_paso:'',evidencias:{}}
];
const result = await analyzeMeeting({text,catalog,callAi:async args => { assert.equal(args.timeoutMs,120000); assert.equal(args.purpose,'meeting_v2'); return values[count++]; }});
assert.equal(result.proposals.length,2);
assert.equal(result.proposals[0].entity.id,7);
assert.equal(result.proposals[0].payload.responsable_proximo_paso,'Administracion');
assert.match(result.proposals[0].payload.proximo_paso,/una vez aprobado/);
assert.equal(result.proposals[1].action,'revisar_manual');
assert.ok(result.proposals[1].payload.comentario);
assert.equal(result.proposals[1].payload.proximo_paso,'');
assert.equal(result.proposals[1].selected,false);
assert.ok(!result.proposals[0].payload.comentario.includes('Criterio'));
await assert.rejects(analyzeMeeting({text,catalog,callAi:async () => ({asuntos:[{titulo:'Inventado',citas:['Texto inexistente']} ]})}),/citas/);
let calls=0;
await assert.rejects(analyzeMeeting({text,catalog,callAi:async () => calls++ ? {grupos:[{fragmentos:[0,0],tipo:'project',id:7}]} : values[0]}),/omitido o repetido/);
await assert.rejects(analyzeMeeting({text,catalog:Array(1001).fill(catalog[0]),callAi:async () => {throw new Error('No debe llamar');}}),/catalogo/);
console.log('Meeting contracts: full input coverage, verified sources, complete grouping, existing target, formal fields, clarification, bounded capacity OK');
